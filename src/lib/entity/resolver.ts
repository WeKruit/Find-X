import type { PersonMention, SearchQuery } from "@/types";
import { llmMatchNames } from "@/lib/llm/client";
import {
  consolidateMentionsBySource,
  normalizeMentions,
  normalizeSearchQuery,
  type NormalizedMention,
} from "./normalization";
import { generateCandidatePairs } from "./candidate-generation";
import { evaluateCandidatePair } from "./pairwise-model";
import { assembleClusters, type ClusterAssemblyStats } from "./cluster-assembly";
import { buildCanonicalEntities, type CanonicalEntity } from "./canonical-entity";
import { rankEntitiesForQuery } from "./query-ranking";
import { resolveEntitiesLegacy, type EntityCluster } from "./legacy-resolver";
import { bestNameMatchToQuery, jaroWinkler, nameScore } from "./matching";
import { scoreClusterTargetMatch } from "./target-ranking";

export type { EntityCluster } from "./legacy-resolver";
export { bestNameMatchToQuery, jaroWinkler, nameScore, scoreClusterTargetMatch, resolveEntitiesLegacy };

export interface ResolverDiagnostics {
  inputMentions: number;
  consolidatedMentions: number;
  candidatePairs: number;
  evaluatedPairs: number;
  clusterCount: number;
  stats: ClusterAssemblyStats;
  canonicalEntities: CanonicalEntity[];
}

export async function resolveEntities(
  mentions: PersonMention[],
  query: SearchQuery,
  precomputedLlmScores?: Map<string, number>
): Promise<EntityCluster[]> {
  const result = await resolveEntitiesWithDiagnostics(mentions, query, precomputedLlmScores);
  return result.clusters;
}

export async function resolveEntitiesWithDiagnostics(
  mentions: PersonMention[],
  query: SearchQuery,
  precomputedLlmScores?: Map<string, number>
): Promise<{ clusters: EntityCluster[]; diagnostics: ResolverDiagnostics }> {
  if (mentions.length === 0) {
    return {
      clusters: [],
      diagnostics: {
        inputMentions: 0,
        consolidatedMentions: 0,
        candidatePairs: 0,
        evaluatedPairs: 0,
        clusterCount: 0,
        stats: {
          evaluatedPairs: 0,
          hardPositivePairs: 0,
          hardNegativePairs: 0,
          autoMergedPairs: 0,
        },
        canonicalEntities: [],
      },
    };
  }

  const consolidatedMentions = consolidateMentionsBySource(mentions);
  const normalizedMentions = normalizeMentions(consolidatedMentions);
  const normalizedQuery = normalizeSearchQuery(query);
  const llmNameScores = await getNameScores(normalizedMentions, query, precomputedLlmScores);

  if (normalizedMentions.length === 1) {
    const cluster: EntityCluster = {
      mentions: [normalizedMentions[0].raw],
      isPrimaryTarget: bestNameMatchToQuery(normalizedMentions[0].raw, query.name, llmNameScores) >= 0.85,
    };
    return {
      clusters: [cluster],
      diagnostics: {
        inputMentions: mentions.length,
        consolidatedMentions: 1,
        candidatePairs: 0,
        evaluatedPairs: 0,
        clusterCount: 1,
        stats: {
          evaluatedPairs: 0,
          hardPositivePairs: 0,
          hardNegativePairs: 0,
          autoMergedPairs: 0,
        },
        canonicalEntities: [
          {
            id: "entity-0",
            mentionIndices: [0],
            canonicalName: normalizedMentions[0].primaryName,
            aliases: normalizedMentions[0].names,
            exactIds: normalizedMentions[0].exactIds,
            organizationKeys: normalizedMentions[0].employerKeys,
            currentOrganizationKeys: normalizedMentions[0].currentEmployerKeys,
            educationKeys: normalizedMentions[0].schoolKeys,
            locationKeys: normalizedMentions[0].locationKeys,
            contextTokens: normalizedMentions[0].contextTokens,
            completeness: normalizedMentions[0].completeness,
            confidence: normalizedMentions[0].raw.confidence,
          },
        ],
      },
    };
  }

  const candidatePairs = generateCandidatePairs(normalizedMentions);
  const pairwiseDecisions = candidatePairs.map((pair) =>
    evaluateCandidatePair(pair, normalizedMentions[pair.i], normalizedMentions[pair.j])
  );

  const { clusters: clusterIndexes, stats } = assembleClusters(normalizedMentions, pairwiseDecisions);
  const canonicalEntities = buildCanonicalEntities(clusterIndexes, normalizedMentions, pairwiseDecisions);
  const rankings = rankEntitiesForQuery(
    canonicalEntities,
    normalizedMentions,
    normalizedQuery,
    query,
    llmNameScores
  );

  const clusters = rankings.map((ranking) => ({
    mentions: canonicalEntities[ranking.entityIndex].mentionIndices.map(
      (memberIndex) => normalizedMentions[memberIndex].raw
    ),
    isPrimaryTarget: ranking.isPrimaryTarget,
  }));

  clusters.sort((a, b) => {
    if (a.isPrimaryTarget !== b.isPrimaryTarget) return a.isPrimaryTarget ? -1 : 1;
    return b.mentions.length - a.mentions.length;
  });

  return {
    clusters,
    diagnostics: {
      inputMentions: mentions.length,
      consolidatedMentions: consolidatedMentions.length,
      candidatePairs: candidatePairs.length,
      evaluatedPairs: pairwiseDecisions.length,
      clusterCount: clusters.length,
      stats,
      canonicalEntities,
    },
  };
}

async function getNameScores(
  normalizedMentions: NormalizedMention[],
  query: SearchQuery,
  precomputedLlmScores?: Map<string, number>
): Promise<Map<string, number> | undefined> {
  if (precomputedLlmScores && precomputedLlmScores.size > 0) {
    return precomputedLlmScores;
  }

  const names = new Set<string>();
  for (const mention of normalizedMentions) {
    for (const name of mention.names.slice(0, 5)) {
      if (name) names.add(name.trim());
    }
  }

  try {
    return await llmMatchNames(query.name, query.context, [...names]);
  } catch {
    return undefined;
  }
}
