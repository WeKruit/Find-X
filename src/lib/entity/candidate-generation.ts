import { bestNameSimilarity } from "./matching";
import type { NormalizedMention } from "./normalization";

export interface CandidatePair {
  i: number;
  j: number;
  reasons: string[];
  blockKeys: string[];
}

const EXHAUSTIVE_THRESHOLD = 8;
const LOOSE_NAME_THRESHOLD = 24;

export function generateCandidatePairs(mentions: NormalizedMention[]): CandidatePair[] {
  if (mentions.length <= 1) return [];

  const pairMap = new Map<string, CandidatePair>();
  const blockMap = new Map<string, number[]>();

  mentions.forEach((mention, index) => {
    for (const blockKey of buildMentionBlocks(mention)) {
      if (!blockMap.has(blockKey)) blockMap.set(blockKey, []);
      blockMap.get(blockKey)!.push(index);
    }
  });

  for (const [blockKey, indices] of blockMap) {
    if (indices.length < 2) continue;
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        addPair(pairMap, indices[x], indices[y], `shared block ${blockKey}`, blockKey);
      }
    }
  }

  if (mentions.length <= EXHAUSTIVE_THRESHOLD) {
    for (let i = 0; i < mentions.length; i++) {
      for (let j = i + 1; j < mentions.length; j++) {
        addPair(pairMap, i, j, "small-corpus exhaustive comparison", "small-corpus");
      }
    }
  } else if (mentions.length <= LOOSE_NAME_THRESHOLD) {
    for (let i = 0; i < mentions.length; i++) {
      for (let j = i + 1; j < mentions.length; j++) {
        const sameLastName =
          mentions[i].lastName &&
          mentions[j].lastName &&
          mentions[i].lastName === mentions[j].lastName;
        const looseNameMatch =
          bestNameSimilarity(mentions[i].names, mentions[j].names) >= 0.85 ||
          (sameLastName &&
            mentions[i].firstInitial &&
            mentions[i].firstInitial === mentions[j].firstInitial);
        if (looseNameMatch) {
          addPair(pairMap, i, j, "loose-name safety net", "loose-name");
        }
      }
    }
  }

  return [...pairMap.values()].sort((a, b) => a.i - b.i || a.j - b.j);
}

function buildMentionBlocks(mention: NormalizedMention): string[] {
  const blocks = new Set<string>();

  for (const exactId of mention.exactIds) blocks.add(`exact:${exactId}`);
  blocks.add(`name:${mention.primaryNameKey}`);

  for (const employer of mention.employerKeys.slice(0, 4)) {
    if (mention.lastName) blocks.add(`name-org:${mention.lastName}:${employer}`);
  }

  for (const school of mention.schoolKeys.slice(0, 4)) {
    if (mention.lastName) blocks.add(`name-school:${mention.lastName}:${school}`);
  }

  for (const handle of mention.socialHandles.linkedin ?? []) {
    blocks.add(`linkedin:${handle}`);
  }

  return [...blocks];
}

function addPair(
  pairMap: Map<string, CandidatePair>,
  i: number,
  j: number,
  reason: string,
  blockKey: string
) {
  const a = Math.min(i, j);
  const b = Math.max(i, j);
  const key = `${a}:${b}`;
  const existing = pairMap.get(key);
  if (existing) {
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    if (!existing.blockKeys.includes(blockKey)) existing.blockKeys.push(blockKey);
    return;
  }
  pairMap.set(key, {
    i: a,
    j: b,
    reasons: [reason],
    blockKeys: [blockKey],
  });
}
