import { bestNameSimilarity } from "./matching";
import type { CandidatePair } from "./candidate-generation";
import type { NormalizedMention } from "./normalization";

export interface MatchEvidence {
  kind: "positive" | "negative" | "hard_positive" | "hard_negative";
  feature: string;
  contribution: number;
  detail: string;
}

export interface PairwiseDecision {
  i: number;
  j: number;
  probability: number;
  rawScore: number;
  hardPositive: boolean;
  hardNegative: boolean;
  autoMerge: boolean;
  supportMerge: boolean;
  autoReject: boolean;
  blockingReasons: string[];
  evidence: MatchEvidence[];
}

export function evaluateCandidatePair(
  pair: CandidatePair,
  a: NormalizedMention,
  b: NormalizedMention
): PairwiseDecision {
  const evidence: MatchEvidence[] = [];
  const sharedExactIds = intersect(a.exactIds, b.exactIds);
  if (sharedExactIds.length > 0) {
    evidence.push({
      kind: "hard_positive",
      feature: "exact-id",
      contribution: 4,
      detail: `Shared exact identifier(s): ${sharedExactIds.join(", ")}`,
    });
    return finalizeDecision(pair, 6, evidence, true, false);
  }

  const linkedInA = new Set(a.socialHandles.linkedin ?? []);
  const linkedInB = new Set(b.socialHandles.linkedin ?? []);
  if (linkedInA.size > 0 && linkedInB.size > 0 && intersectSets(linkedInA, linkedInB).length === 0) {
    evidence.push({
      kind: "hard_negative",
      feature: "linkedin-conflict",
      contribution: -4,
      detail: "Conflicting LinkedIn handles",
    });
    return finalizeDecision(pair, -6, evidence, false, true);
  }

  let score = 0;
  const nameSim = bestNameSimilarity(a.names, b.names);
  const sameLastName =
    !!a.lastName &&
    !!b.lastName &&
    a.lastName === b.lastName;
  const sameFirstInitial =
    sameLastName &&
    !!a.firstInitial &&
    a.firstInitial === b.firstInitial;

  if (nameSim >= 0.99) {
    score += 2.6;
    evidence.push({
      kind: "positive",
      feature: "name-exact",
      contribution: 2.6,
      detail: "Exact or near-exact normalized name match",
    });
  } else if (nameSim >= 0.95) {
    score += 2.1;
    evidence.push({
      kind: "positive",
      feature: "name-strong",
      contribution: 2.1,
      detail: "Strong name similarity",
    });
  } else if (nameSim >= 0.90) {
    score += 1.4;
    evidence.push({
      kind: "positive",
      feature: "name-moderate",
      contribution: 1.4,
      detail: "Moderate name similarity",
    });
  } else if (sameFirstInitial) {
    score += 0.85;
    evidence.push({
      kind: "positive",
      feature: "name-initial-variant",
      contribution: 0.85,
      detail: "Same last name and first initial",
    });
  } else {
    score -= 2.2;
    evidence.push({
      kind: "negative",
      feature: "name-mismatch",
      contribution: -2.2,
      detail: "Names are too dissimilar to safely merge",
    });
  }

  const sharedSchools = intersect(a.schoolKeys, b.schoolKeys);
  if (sharedSchools.length > 0) {
    score += 1.0;
    evidence.push({
      kind: "positive",
      feature: "education",
      contribution: 1,
      detail: `Shared education signal(s): ${sharedSchools.join(", ")}`,
    });
  } else if (a.schoolKeys.length > 0 && b.schoolKeys.length > 0) {
    score -= 0.55;
    evidence.push({
      kind: "negative",
      feature: "education-conflict",
      contribution: -0.55,
      detail: "Both mentions have education, but with no school overlap",
    });
  }

  const sharedCurrentEmployers = intersect(a.currentEmployerKeys, b.currentEmployerKeys);
  if (sharedCurrentEmployers.length > 0) {
    score += 1.3;
    evidence.push({
      kind: "positive",
      feature: "current-employer",
      contribution: 1.3,
      detail: `Shared current employer key(s): ${sharedCurrentEmployers.join(", ")}`,
    });
  } else {
    const sharedEmployers = intersect(a.employerKeys, b.employerKeys);
    if (sharedEmployers.length > 0) {
      score += 0.8;
      evidence.push({
        kind: "positive",
        feature: "employer-history",
        contribution: 0.8,
        detail: `Shared employer history: ${sharedEmployers.join(", ")}`,
      });
    } else if (a.currentEmployerKeys.length > 0 && b.currentEmployerKeys.length > 0) {
      const penalty = sharedSchools.length > 0 ? -0.85 : -1.8;
      score += penalty;
      evidence.push({
        kind: "negative",
        feature: "current-employer-conflict",
        contribution: penalty,
        detail: "Different current employers with no overlap",
      });
    }
  }

  const sharedLocations = intersect(a.locationKeys, b.locationKeys);
  if (sharedLocations.length > 0) {
    score += 0.35;
    evidence.push({
      kind: "positive",
      feature: "location",
      contribution: 0.35,
      detail: `Shared location signal(s): ${sharedLocations.join(", ")}`,
    });
  }

  const contextOverlap = jaccard(a.contextTokens, b.contextTokens);
  if (contextOverlap >= 0.25) {
    score += 0.55;
    evidence.push({
      kind: "positive",
      feature: "context-overlap",
      contribution: 0.55,
      detail: `High contextual overlap (${contextOverlap.toFixed(2)})`,
    });
  } else if (contextOverlap >= 0.10) {
    score += 0.2;
    evidence.push({
      kind: "positive",
      feature: "context-overlap",
      contribution: 0.2,
      detail: `Moderate contextual overlap (${contextOverlap.toFixed(2)})`,
    });
  } else if (nameSim >= 0.95 && sharedCurrentEmployers.length === 0 && sharedSchools.length === 0) {
    score -= 0.85;
    evidence.push({
      kind: "negative",
      feature: "common-name-trap",
      contribution: -0.85,
      detail: "Strong name match but almost no corroborating context",
    });
  }

  if (
    nameSim >= 0.95 &&
    a.currentEmployerKeys.length > 0 &&
    b.currentEmployerKeys.length > 0 &&
    sharedCurrentEmployers.length === 0 &&
    sharedSchools.length === 0 &&
    sharedExactIds.length === 0
  ) {
    score -= 1.6;
    evidence.push({
      kind: "negative",
      feature: "conflicting-current-identity",
      contribution: -1.6,
      detail: "Exact-name mentions point to different active employers with no corroboration",
    });
  }

  if (
    nameSim >= 0.95 &&
    sharedCurrentEmployers.length === 0 &&
    intersect(a.employerKeys, b.employerKeys).length === 0 &&
    sharedSchools.length === 0 &&
    sharedExactIds.length === 0 &&
    contextOverlap < 0.08
  ) {
    score -= 1.6;
    evidence.push({
      kind: "negative",
      feature: "uncorroborated-common-name",
      contribution: -1.6,
      detail: "Exact-name match without corroborating employer, school, identifier, or context overlap",
    });
  }

  const sharedSocialPlatforms = intersect(Object.keys(a.socialHandles), Object.keys(b.socialHandles));
  if (sharedSocialPlatforms.length > 0) {
    const sharedPlatformHandles = sharedSocialPlatforms.flatMap((platform) =>
      intersect(a.socialHandles[platform] ?? [], b.socialHandles[platform] ?? [])
    );
    if (sharedPlatformHandles.length > 0) {
      score += 0.75;
      evidence.push({
        kind: "positive",
        feature: "shared-social-handle",
        contribution: 0.75,
        detail: `Shared social handle(s): ${sharedPlatformHandles.join(", ")}`,
      });
    }
  }

  score += (a.completeness + b.completeness) * 0.1;

  return finalizeDecision(pair, score, evidence, false, false);
}

function finalizeDecision(
  pair: CandidatePair,
  rawScore: number,
  evidence: MatchEvidence[],
  hardPositive: boolean,
  hardNegative: boolean
): PairwiseDecision {
  const probability = hardPositive
    ? 0.995
    : hardNegative
      ? 0.005
      : sigmoid(rawScore);

  return {
    i: pair.i,
    j: pair.j,
    probability,
    rawScore,
    hardPositive,
    hardNegative,
    autoMerge: hardPositive || probability >= 0.78,
    supportMerge: hardPositive || probability >= 0.62,
    autoReject: hardNegative || probability <= 0.2,
    blockingReasons: pair.reasons,
    evidence,
  };
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function intersect(valuesA: string[], valuesB: string[]): string[] {
  const setB = new Set(valuesB);
  return [...new Set(valuesA.filter((value) => setB.has(value)))];
}

function intersectSets(valuesA: Set<string>, valuesB: Set<string>): string[] {
  const result: string[] = [];
  for (const value of valuesA) {
    if (valuesB.has(value)) result.push(value);
  }
  return result;
}

function jaccard(valuesA: string[], valuesB: string[]): number {
  if (valuesA.length === 0 || valuesB.length === 0) return 0;
  const union = new Set([...valuesA, ...valuesB]);
  const intersection = intersect(valuesA, valuesB).length;
  return union.size === 0 ? 0 : intersection / union.size;
}
