import type { PersonMention, SearchQuery } from "@/types";
import { llmDisambiguate, llmMatchNames, llmClusterMentions } from "@/lib/llm/client";
import {
  bestNameMatchToQuery,
  bestNameSimilarity,
} from "./matching";
import {
  buildSimilarityGraph,
  CLUSTERING_THRESHOLD,
  COHESION_THRESHOLD,
  NAME_GATE,
  NAME_MATCH_FOR_PRIMARY,
} from "./pairwise-scoring";
import { findConnectedComponents, splitWeakClusters } from "./clustering";
import { scoreClusterTargetMatch } from "./target-ranking";

export type EntityCluster = {
  mentions: PersonMention[];
  isPrimaryTarget: boolean;
};

const MAX_MENTIONS = 500;

/**
 * Baseline resolver preserved for benchmarks.
 * This matches the pre-overhaul architecture: graph scoring + clustering +
 * target ranking + LLM edge-case adjudication.
 */
export async function resolveEntitiesLegacy(
  mentions: PersonMention[],
  query: SearchQuery,
  precomputedLlmScores?: Map<string, number>
): Promise<EntityCluster[]> {
  if (mentions.length === 0) return [];

  const seenUrls = new Map<string, PersonMention>();
  for (const m of mentions) {
    const existing = seenUrls.get(m.sourceUrl);
    if (!existing || m.confidence > existing.confidence) {
      seenUrls.set(m.sourceUrl, m);
    }
  }
  const dedupedMentions = [...seenUrls.values()];

  if (dedupedMentions.length === 1) {
    const nameMatch = bestNameMatchToQuery(dedupedMentions[0], query.name);
    const isPrimary = nameMatch >= NAME_MATCH_FOR_PRIMARY && dedupedMentions[0].confidence >= 0.4;
    return [{ mentions: dedupedMentions, isPrimaryTarget: isPrimary }];
  }

  let workingMentions = dedupedMentions;
  if (dedupedMentions.length > MAX_MENTIONS) {
    workingMentions = dedupedMentions
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_MENTIONS);
  }

  const { edges, idf } = buildSimilarityGraph(workingMentions);
  const globalEdges = edges.map((e) => ({ a: e.i, b: e.j, combined: e.combined }));
  const parent = findConnectedComponents(workingMentions.length, globalEdges, CLUSTERING_THRESHOLD);

  const initialClusters = new Map<number, number[]>();
  for (let i = 0; i < workingMentions.length; i++) {
    const root = parent[i];
    if (!initialClusters.has(root)) initialClusters.set(root, []);
    initialClusters.get(root)!.push(i);
  }

  const refinedClusters = splitWeakClusters(initialClusters, edges, COHESION_THRESHOLD);

  const allNames = new Set<string>();
  for (const m of workingMentions) {
    for (const name of m.extracted.names.slice(0, 5)) {
      if (name && typeof name === "string") allNames.add(name.trim());
    }
  }

  let llmNameScores: Map<string, number> | undefined;
  if (precomputedLlmScores && precomputedLlmScores.size > 0) {
    llmNameScores = precomputedLlmScores;
  } else {
    try {
      llmNameScores = await llmMatchNames(query.name, query.context, [...allNames]);
    } catch {
      llmNameScores = undefined;
    }
  }

  const scoredClusters = Array.from(refinedClusters.entries()).map(([id, memberIndices]) => {
    const clusterMentions = memberIndices.map((i) => workingMentions[i]);
    const targetScore = scoreClusterTargetMatch(clusterMentions, query, idf, llmNameScores);
    const bestNameMatch = Math.max(
      ...clusterMentions.map((m) => bestNameMatchToQuery(m, query.name, llmNameScores))
    );
    return { id, mentions: clusterMentions, targetScore, bestNameMatch };
  });

  scoredClusters.sort((a, b) => b.targetScore - a.targetScore);

  const targetThreshold = query.context ? 0.45 : 0.40;
  const ambiguousThreshold = query.context ? 0.30 : 0.25;

  const primaryCandidates = scoredClusters.filter(
    (c) => c.targetScore >= targetThreshold && c.bestNameMatch >= NAME_MATCH_FOR_PRIMARY
  );
  const ambiguous = scoredClusters.filter(
    (c) =>
      c.targetScore >= ambiguousThreshold &&
      c.targetScore < targetThreshold &&
      c.bestNameMatch >= NAME_MATCH_FOR_PRIMARY
  );
  const nonTarget = scoredClusters.filter(
    (c) => c.targetScore < ambiguousThreshold || c.bestNameMatch < NAME_MATCH_FOR_PRIMARY
  );

  if (ambiguous.length > 0 && primaryCandidates.length > 0) {
    type DisambigTask = { ambIdx: number; primaryIdx: number };
    const tasks: DisambigTask[] = ambiguous.flatMap((_, ambIdx) =>
      primaryCandidates.map((_, primaryIdx) => ({ ambIdx, primaryIdx }))
    );

    const disambigResults = await Promise.all(
      tasks.map(({ ambIdx, primaryIdx }) =>
        llmDisambiguate(
          mentionToDisambiguateInput(selectRichestMention(primaryCandidates[primaryIdx].mentions)),
          mentionToDisambiguateInput(selectRichestMention(ambiguous[ambIdx].mentions)),
          query
        )
      )
    );

    for (let ambIdx = 0; ambIdx < ambiguous.length; ambIdx++) {
      const amb = ambiguous[ambIdx];
      let bestMatchIdx = -1;
      let bestMatchConf = 0;

      for (let primaryIdx = 0; primaryIdx < primaryCandidates.length; primaryIdx++) {
        const result = disambigResults[ambIdx * primaryCandidates.length + primaryIdx];
        if (result.samePerson === true && result.confidence >= 0.7 && result.confidence > bestMatchConf) {
          bestMatchIdx = primaryIdx;
          bestMatchConf = result.confidence;
        }
      }

      if (bestMatchIdx >= 0) {
        primaryCandidates[bestMatchIdx] = {
          ...primaryCandidates[bestMatchIdx],
          mentions: [...primaryCandidates[bestMatchIdx].mentions, ...amb.mentions],
        };
      } else {
        nonTarget.push(amb);
      }
    }
  } else if (ambiguous.length > 0 && primaryCandidates.length === 0) {
    nonTarget.push(...ambiguous);
  }

  if (primaryCandidates.length > 0) {
    const primary = primaryCandidates[0];
    const stillNonTarget: typeof nonTarget = [];

    const nearMissNonTargets = nonTarget.filter((cluster) => {
      const anyPrimaryNames = primary.mentions.flatMap((m) => m.extracted.names);
      return cluster.mentions.some((m) =>
        m.extracted.names.some((n) =>
          anyPrimaryNames.some((pn) => bestNameSimilarity([n], [pn]) >= NAME_GATE)
        )
      );
    });

    const clearNonTargets = nonTarget.filter((c) => !nearMissNonTargets.includes(c));

    if (nearMissNonTargets.length > 0) {
      const primaryRep = selectRichestMention(primary.mentions);
      const candidates: PersonMention[] = [primaryRep];
      const nearMissReps = nearMissNonTargets.map((c) => selectRichestMention(c.mentions));
      candidates.push(...nearMissReps);

      const clusterResult = await llmClusterMentions(candidates, query);

      if (clusterResult) {
        const targetGroup = clusterResult.find((g) => g.isTarget && g.ids.includes(0));
        if (targetGroup) {
          for (let i = 0; i < nearMissNonTargets.length; i++) {
            if (targetGroup.ids.includes(i + 1)) {
              primary.mentions = [...primary.mentions, ...nearMissNonTargets[i].mentions];
            } else {
              stillNonTarget.push(nearMissNonTargets[i]);
            }
          }
        } else {
          stillNonTarget.push(...nearMissNonTargets);
        }
      } else {
        stillNonTarget.push(...nearMissNonTargets);
      }
    }

    nonTarget.length = 0;
    nonTarget.push(...clearNonTargets, ...stillNonTarget);
  }

  const results: EntityCluster[] = [];
  for (const candidate of primaryCandidates) {
    results.push({
      mentions: candidate.mentions,
      isPrimaryTarget: true,
    });
  }

  for (const cluster of nonTarget) {
    results.push({
      mentions: cluster.mentions,
      isPrimaryTarget: false,
    });
  }

  return results;
}

function mentionToDisambiguateInput(mention: PersonMention) {
  const exps = mention.extracted.experiences || [];
  const currentExp = exps.find((e) => e.isCurrent) ?? exps[0];
  const allCompanies = [...new Set(exps.map((e) => e.company).filter(Boolean))].join(", ");
  return {
    url: mention.sourceUrl,
    name: mention.extracted.names[0] || "Unknown",
    title: currentExp?.title,
    company: allCompanies || undefined,
    location: mention.extracted.location,
    details: [
      mention.extracted.bioSnippet,
      mention.extracted.education.map((e) => e.institution).join(", "),
      (mention.extracted.skills || []).slice(0, 5).map((s) => s.name).join(", "),
    ]
      .filter(Boolean)
      .join("; "),
  };
}

function selectRichestMention(mentions: PersonMention[]): PersonMention {
  return mentions.reduce((best, m) => {
    const richness = (score: PersonMention) => {
      const hasLinkedIn = /linkedin\.com\/in\//i.test(score.sourceUrl) ? 4 : 0;
      const hasSocialLink = score.extracted.socialLinks.some((l) => l.platform === "LinkedIn") ? 2 : 0;
      const hasCompany = (score.extracted.experiences || []).some((e) => e.company) ? 2 : 0;
      const hasEducation = score.extracted.education.length > 0 ? 1 : 0;
      const hasBio = score.extracted.bioSnippet ? 1 : 0;
      return hasLinkedIn + hasSocialLink + hasCompany + hasEducation + hasBio + score.confidence;
    };
    return richness(m) > richness(best) ? m : best;
  });
}
