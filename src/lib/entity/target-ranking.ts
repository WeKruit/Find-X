import type { PersonMention, SearchQuery } from "@/types";
import {
  bestNameMatchToQuery,
  computeIDF,
  contextSimilarityToQuery,
  institutionSimilarity,
  mentionToContextText,
  tokenize,
} from "./matching";
import { NAME_MATCH_FOR_PRIMARY } from "./pairwise-scoring";

/**
 * Score how well a cluster of mentions matches the target query.
 * Name similarity is the dominant signal; context is secondary.
 */
export function scoreClusterTargetMatch(
  clusterMentions: PersonMention[],
  query: SearchQuery,
  idf?: Map<string, number>,
  llmScores?: Map<string, number>
): number {
  const effectiveIdf = idf ?? computeIDF(
    clusterMentions.map((m) => tokenize(mentionToContextText(m)))
  );

  let contextAcronymRe: RegExp | null = null;
  if (query.context) {
    const acronym = query.context
      .split(/\s+/)
      .filter((w) => /^[A-Z]/.test(w))
      .map((w) => w[0])
      .join("")
      .toLowerCase();
    if (acronym.length >= 2) {
      contextAcronymRe = new RegExp(`\\b${acronym}\\b`, "i");
    }
  }

  let bestScore = 0;

  for (const m of clusterMentions) {
    let score = 0;
    const nameMatchScore = bestNameMatchToQuery(m, query.name, llmScores);
    if (nameMatchScore < NAME_MATCH_FOR_PRIMARY) continue;

    score += nameMatchScore * 0.5;

    if (query.context) {
      const contextSim = contextSimilarityToQuery(query.context, m, effectiveIdf);
      const mentionText = mentionToContextText(m);
      const hasAcronym = contextAcronymRe != null && contextAcronymRe.test(mentionText);

      if (contextSim > 0.1 || hasAcronym) {
        score += hasAcronym && contextSim <= 0.1
          ? 0.15
          : Math.min(0.35, contextSim * 0.5);
      } else {
        score -= 0.20;
      }

      if (
        m.extracted.education.length > 0 &&
        /university|college|institute|school/i.test(query.context)
      ) {
        const hasMatchingEdu = m.extracted.education.some(
          (e) => institutionSimilarity(e.institution, query.context!) > 0.7
        );
        if (!hasMatchingEdu) {
          score -= 0.15;
        }
      }
    }

    score *= 0.5 + 0.5 * m.confidence;

    if (score > bestScore) bestScore = score;
  }

  const corroborationBoost = Math.min(0.05, clusterMentions.length * 0.01);
  return Math.max(0, Math.min(bestScore + corroborationBoost, 1.0));
}
