import type { PersonMention } from "@/types";
import {
  bestNameSimilarity,
  cosineSimilarityPairwise,
  institutionSimilarity,
  jaroWinkler,
  nameScore,
  computeIDF,
  computeTF,
  mentionToContextText,
  tokenize,
} from "./matching";

export type SimilarityEdge = {
  i: number;
  j: number;
  nameSim: number;
  contextSim: number;
  combined: number;
};

export const NAME_GATE = 0.85;
export const NAME_MATCH_FOR_PRIMARY = 0.85;
export const CLUSTERING_THRESHOLD = 0.47;
export const COHESION_THRESHOLD = 0.42;

/**
 * Compute penalty for explicitly contradictory structured fields between two mentions.
 */
function computeFieldMismatch(a: PersonMention, b: PersonMention): number {
  let penalty = 0;

  const aCompanies = (a.extracted.experiences || [])
    .map((e) => e.company)
    .filter((c): c is string => !!c && c.trim().length > 0);
  const bCompanies = (b.extracted.experiences || [])
    .map((e) => e.company)
    .filter((c): c is string => !!c && c.trim().length > 0);
  if (aCompanies.length > 0 && bCompanies.length > 0) {
    const hasAnyOverlap = aCompanies.some((ac) =>
      bCompanies.some((bc) => jaroWinkler(ac.toLowerCase(), bc.toLowerCase()) >= 0.85)
    );
    if (!hasAnyOverlap) {
      penalty += 0.30;
    }
  }

  const INSTITUTION_RE = /university|college|institute|school|academy/i;
  const aSchools = a.extracted.education.map((e) => e.institution).filter(Boolean);
  const bSchools = b.extracted.education.map((e) => e.institution).filter(Boolean);
  if (aSchools.length === 0) {
    const aEduCompany = aCompanies.find((c) => INSTITUTION_RE.test(c));
    if (aEduCompany) aSchools.push(aEduCompany);
  }
  if (bSchools.length === 0) {
    const bEduCompany = bCompanies.find((c) => INSTITUTION_RE.test(c));
    if (bEduCompany) bSchools.push(bEduCompany);
  }
  if (aSchools.length > 0 && bSchools.length > 0) {
    const hasOverlap = aSchools.some((s) =>
      bSchools.some((t) => institutionSimilarity(s, t) > 0.7)
    );
    if (!hasOverlap) penalty += 0.20;
  }

  if (a.extracted.location && b.extracted.location) {
    if (jaroWinkler(a.extracted.location.toLowerCase(), b.extracted.location.toLowerCase()) < 0.5) {
      penalty += 0.15;
    }
  }

  return Math.min(penalty, 0.50);
}

/**
 * Extract the LinkedIn username from a URL.
 * Handles both profile URLs and post URLs.
 */
function getLinkedInUsernameFromUrl(url: string): string | null {
  const profileMatch = url.match(/linkedin\.com\/in\/([a-zA-Z0-9-]+)/i);
  if (profileMatch) return profileMatch[1].toLowerCase();
  const postMatch = url.match(/linkedin\.com\/posts\/([a-zA-Z0-9-]+)(?:_[a-z]|$)/i);
  if (postMatch) return postMatch[1].toLowerCase();
  return null;
}

/**
 * Build a pairwise similarity graph over mentions.
 * Each edge has name similarity and context similarity.
 */
export function buildSimilarityGraph(
  mentions: PersonMention[]
): { edges: SimilarityEdge[]; idf: Map<string, number> } {
  const tokenizedDocs = mentions.map((m) => tokenize(mentionToContextText(m)));
  const idf = computeIDF(tokenizedDocs);
  const tfVectors = tokenizedDocs.map(computeTF);

  const relationshipNames = mentions.map((m) =>
    m.extracted.relationships.map((r) => r.name.toLowerCase().trim()).filter((n) => n.length > 2)
  );

  const edges: SimilarityEdge[] = [];

  for (let i = 0; i < mentions.length; i++) {
    for (let j = i + 1; j < mentions.length; j++) {
      const nameSim = bestNameSimilarity(mentions[i].extracted.names, mentions[j].extracted.names);
      if (nameSim < NAME_GATE) continue;

      const liUsernameA = getLinkedInUsernameFromUrl(mentions[i].sourceUrl);
      const liUsernameB = getLinkedInUsernameFromUrl(mentions[j].sourceUrl);
      if (liUsernameA && liUsernameB) {
        if (liUsernameA === liUsernameB) {
          edges.push({ i, j, nameSim, contextSim: 1.0, combined: 1.0 });
          continue;
        }
        continue;
      } else if (liUsernameA || liUsernameB) {
        const singleLiUser = (liUsernameA || liUsernameB)!;
        const otherMentionIdx = liUsernameA ? j : i;
        const otherNames = mentions[otherMentionIdx].extracted.names;
        const liDisplayName = singleLiUser.replace(/-/g, " ");
        const usernameMatchesName = otherNames.some(
          (n) => typeof n === "string" && nameScore(n.trim(), liDisplayName) >= 0.95
        );
        if (usernameMatchesName) {
          edges.push({ i, j, nameSim, contextSim: 1.0, combined: 1.0 });
          continue;
        }

        const otherLiLink = mentions[otherMentionIdx].extracted.socialLinks.find(
          (l) => l.platform === "LinkedIn"
        );
        if (otherLiLink) {
          const otherLiUsername = (
            otherLiLink.username ||
            otherLiLink.url.match(/\/in\/([^/?#]+)/i)?.[1] ||
            ""
          ).toLowerCase();
          if (otherLiUsername && otherLiUsername !== singleLiUser) {
            continue;
          }
          if (otherLiUsername && otherLiUsername === singleLiUser) {
            edges.push({ i, j, nameSim, contextSim: 1.0, combined: 1.0 });
            continue;
          }
        }

        const hasLinkedInDisambigHash = /(?:^|-)[0-9a-f]{8,}$/.test(singleLiUser.toLowerCase());
        if (hasLinkedInDisambigHash) {
          continue;
        }
      }

      const liA = mentions[i].extracted.socialLinks.find((l) => l.platform === "LinkedIn");
      const liB = mentions[j].extracted.socialLinks.find((l) => l.platform === "LinkedIn");
      if (liA && liB) {
        const usernameA = (liA.username || liA.url.match(/\/in\/([^/?#]+)/i)?.[1] || "").toLowerCase();
        const usernameB = (liB.username || liB.url.match(/\/in\/([^/?#]+)/i)?.[1] || "").toLowerCase();
        if (usernameA && usernameB && usernameA !== usernameB) {
          continue;
        }
      }

      const contextSim = cosineSimilarityPairwise(tfVectors[i], tfVectors[j], idf);

      let connectionBonus = 0;
      if (relationshipNames[i].length > 0 && relationshipNames[j].length > 0) {
        for (const nameA of relationshipNames[i]) {
          for (const nameB of relationshipNames[j]) {
            if (jaroWinkler(nameA, nameB) >= 0.85) {
              connectionBonus = 0.10;
              break;
            }
          }
          if (connectionBonus > 0) break;
        }
      }

      const iComp = (mentions[i].extracted.experiences || [])[0]?.company;
      const jComp = (mentions[j].extracted.experiences || [])[0]?.company;
      const sameCompany =
        !!iComp &&
        !!jComp &&
        jaroWinkler(iComp.toLowerCase(), jComp.toLowerCase()) >= 0.85;
      if (nameSim >= 0.95 && contextSim < 0.12 && connectionBonus === 0 && !sameCompany) {
        continue;
      }

      const fieldMismatch = computeFieldMismatch(mentions[i], mentions[j]);
      const combined = nameSim * 0.50 + contextSim * 0.35 + connectionBonus - fieldMismatch;

      edges.push({ i, j, nameSim, contextSim, combined });
    }
  }

  return { edges, idf };
}
