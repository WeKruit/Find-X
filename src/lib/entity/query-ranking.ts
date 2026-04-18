import type { SearchQuery } from "@/types";
import { bestNameMatchToQuery } from "./matching";
import type { CanonicalEntity } from "./canonical-entity";
import type { NormalizedMention, NormalizedQuery } from "./normalization";

export interface EntityRanking {
  entityIndex: number;
  targetScore: number;
  isPrimaryTarget: boolean;
}

export function rankEntitiesForQuery(
  entities: CanonicalEntity[],
  mentions: NormalizedMention[],
  normalizedQuery: NormalizedQuery,
  query: SearchQuery,
  llmScores?: Map<string, number>
): EntityRanking[] {
  const rankings = entities.map((entity, entityIndex) => {
    const entityMentions = entity.mentionIndices.map((member) => mentions[member].raw);
    const bestNameMatch = Math.max(
      ...entityMentions.map((mention) => bestNameMatchToQuery(mention, query.name, llmScores))
    );

    let score = bestNameMatch * 0.55;

    const orgOverlap = overlapRatio(entity.organizationKeys, normalizedQuery.organizationKeys);
    const schoolOverlap = overlapRatio(entity.educationKeys, normalizedQuery.schoolKeys);
    const locationOverlap = overlapRatio(entity.locationKeys, normalizedQuery.locationKeys);
    const tokenOverlap = overlapRatio(entity.contextTokens, normalizedQuery.contextTokens);

    score += orgOverlap * 0.16;
    score += schoolOverlap * 0.18;
    score += locationOverlap * 0.07;
    score += tokenOverlap * 0.14;
    score += entity.confidence * 0.07;
    score += entity.completeness * 0.05;

    if (normalizedQuery.schoolKeys.length > 0 && entity.educationKeys.length > 0 && schoolOverlap === 0) {
      score -= 0.15;
    }
    if (
      normalizedQuery.organizationKeys.length + normalizedQuery.schoolKeys.length + normalizedQuery.locationKeys.length > 0 &&
      orgOverlap === 0 &&
      schoolOverlap === 0 &&
      locationOverlap === 0 &&
      tokenOverlap < 0.08
    ) {
      score -= 0.12;
    }

    return {
      entityIndex,
      targetScore: Math.max(0, Math.min(score, 1)),
      bestNameMatch,
    };
  });

  rankings.sort((a, b) => b.targetScore - a.targetScore);
  const threshold = query.context ? 0.42 : 0.35;
  const topScore = rankings[0]?.targetScore ?? 0;

  return rankings.map((ranking, index) => ({
    entityIndex: ranking.entityIndex,
    targetScore: ranking.targetScore,
    isPrimaryTarget:
      ranking.bestNameMatch >= 0.85 &&
      ranking.targetScore >= threshold &&
      (index === 0 || topScore - ranking.targetScore <= 0.02),
  }));
}

function overlapRatio(valuesA: string[], valuesB: string[]): number {
  if (valuesA.length === 0 || valuesB.length === 0) return 0;
  const setB = new Set(valuesB);
  let overlap = 0;
  for (const value of valuesA) {
    if (setB.has(value)) overlap++;
  }
  return overlap / Math.max(1, Math.min(valuesA.length, valuesB.length));
}
