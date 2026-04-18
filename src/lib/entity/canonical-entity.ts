import type { PairwiseDecision } from "./pairwise-model";
import type { NormalizedMention } from "./normalization";

export interface CanonicalEntity {
  id: string;
  mentionIndices: number[];
  canonicalName: string;
  aliases: string[];
  exactIds: string[];
  organizationKeys: string[];
  currentOrganizationKeys: string[];
  educationKeys: string[];
  locationKeys: string[];
  contextTokens: string[];
  completeness: number;
  confidence: number;
}

export function buildCanonicalEntities(
  clusters: number[][],
  mentions: NormalizedMention[],
  decisions: PairwiseDecision[]
): CanonicalEntity[] {
  const decisionMap = new Map<string, PairwiseDecision>();
  for (const decision of decisions) {
    decisionMap.set(pairKey(decision.i, decision.j), decision);
  }

  return clusters.map((cluster, index) => {
    const clusterMentions = cluster.map((member) => mentions[member]);
    const canonicalName = pickCanonicalName(clusterMentions);
    const aliases = dedupeStrings(clusterMentions.flatMap((mention) => mention.names));
    const exactIds = dedupeStrings(clusterMentions.flatMap((mention) => mention.exactIds));
    const organizationKeys = dedupeStrings(clusterMentions.flatMap((mention) => mention.employerKeys));
    const currentOrganizationKeys = dedupeStrings(
      clusterMentions.flatMap((mention) => mention.currentEmployerKeys)
    );
    const educationKeys = dedupeStrings(clusterMentions.flatMap((mention) => mention.schoolKeys));
    const locationKeys = dedupeStrings(clusterMentions.flatMap((mention) => mention.locationKeys));
    const contextTokens = dedupeStrings(clusterMentions.flatMap((mention) => mention.contextTokens));
    const completeness =
      clusterMentions.reduce((sum, mention) => sum + mention.completeness, 0) / clusterMentions.length;
    const confidence = computeEntityConfidence(cluster, mentions, decisionMap, completeness);

    return {
      id: `entity-${index}`,
      mentionIndices: cluster,
      canonicalName,
      aliases,
      exactIds,
      organizationKeys,
      currentOrganizationKeys,
      educationKeys,
      locationKeys,
      contextTokens,
      completeness,
      confidence,
    };
  });
}

function pickCanonicalName(mentions: NormalizedMention[]): string {
  const counts = new Map<string, number>();
  for (const mention of mentions) {
    for (const name of mention.names) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })[0]?.[0] ?? mentions[0]?.primaryName ?? "Unknown";
}

function computeEntityConfidence(
  cluster: number[],
  mentions: NormalizedMention[],
  decisionMap: Map<string, PairwiseDecision>,
  completeness: number
): number {
  const mentionConfidence =
    cluster.reduce((sum, member) => sum + mentions[member].raw.confidence, 0) / cluster.length;

  let internalSupport = 0.5;
  if (cluster.length > 1) {
    const pairScores: number[] = [];
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const decision = decisionMap.get(pairKey(cluster[i], cluster[j]));
        if (decision) pairScores.push(decision.probability);
      }
    }
    if (pairScores.length > 0) {
      internalSupport = pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
    }
  }

  return Math.max(
    0,
    Math.min(
      1,
      0.25 +
        mentionConfidence * 0.35 +
        completeness * 0.2 +
        internalSupport * 0.15 +
        Math.min(0.05, cluster.length * 0.02)
    )
  );
}

function pairKey(a: number, b: number): string {
  const left = Math.min(a, b);
  const right = Math.max(a, b);
  return `${left}:${right}`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
