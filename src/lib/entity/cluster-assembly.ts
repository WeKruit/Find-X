import type { NormalizedMention } from "./normalization";
import type { PairwiseDecision } from "./pairwise-model";

export interface ClusterAssemblyStats {
  evaluatedPairs: number;
  hardPositivePairs: number;
  hardNegativePairs: number;
  autoMergedPairs: number;
}

export interface ClusterAssemblyResult {
  clusters: number[][];
  stats: ClusterAssemblyStats;
}

export function assembleClusters(
  mentions: NormalizedMention[],
  decisions: PairwiseDecision[]
): ClusterAssemblyResult {
  const decisionMap = new Map<string, PairwiseDecision>();
  for (const decision of decisions) {
    decisionMap.set(pairKey(decision.i, decision.j), decision);
  }

  const parent = Array.from({ length: mentions.length }, (_, index) => index);
  const rank = new Array(mentions.length).fill(0);

  const union = (a: number, b: number) => {
    const rootA = find(parent, a);
    const rootB = find(parent, b);
    if (rootA === rootB) return;
    if (rank[rootA] < rank[rootB]) {
      parent[rootA] = rootB;
    } else if (rank[rootA] > rank[rootB]) {
      parent[rootB] = rootA;
    } else {
      parent[rootB] = rootA;
      rank[rootA]++;
    }
  };

  let hardPositivePairs = 0;
  let hardNegativePairs = 0;
  let autoMergedPairs = 0;

  for (const decision of decisions) {
    if (decision.hardNegative) {
      hardNegativePairs++;
      continue;
    }
    if (decision.hardPositive || decision.autoMerge) {
      if (decision.hardPositive) hardPositivePairs++;
      if (decision.autoMerge) autoMergedPairs++;
      union(decision.i, decision.j);
    }
  }

  let clusters = groupClusters(parent, mentions.length);
  clusters = repairConflictedClusters(clusters, decisionMap, mentions);
  clusters = absorbSupportiveSingletons(clusters, decisionMap, mentions);

  return {
    clusters,
    stats: {
      evaluatedPairs: decisions.length,
      hardPositivePairs,
      hardNegativePairs,
      autoMergedPairs,
    },
  };
}

function repairConflictedClusters(
  clusters: number[][],
  decisionMap: Map<string, PairwiseDecision>,
  mentions: NormalizedMention[]
): number[][] {
  const repaired: number[][] = [];

  for (const cluster of clusters) {
    if (!hasClusterConflict(cluster, decisionMap, mentions)) {
      repaired.push(cluster);
      continue;
    }

    const internalEdges = cluster.flatMap((member, index) =>
      cluster.slice(index + 1).flatMap((other) => {
        const decision = decisionMap.get(pairKey(member, other));
        if (!decision || decision.hardNegative || !decision.supportMerge) return [];
        return [[member, other] as const];
      })
    );

    if (internalEdges.length === 0) {
      repaired.push(...cluster.map((member) => [member]));
      continue;
    }

    const parent = new Map<number, number>(cluster.map((member) => [member, member]));
    for (const [a, b] of internalEdges) {
      unionLocal(parent, a, b);
    }

    const components = new Map<number, number[]>();
    for (const member of cluster) {
      const root = findLocal(parent, member);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(member);
    }

    repaired.push(...components.values());
  }

  return repaired;
}

function absorbSupportiveSingletons(
  clusters: number[][],
  decisionMap: Map<string, PairwiseDecision>,
  mentions: NormalizedMention[]
): number[][] {
  const working = clusters.map((cluster) => cluster.slice());
  const singletonIndexes = working
    .map((cluster, index) => ({ cluster, index }))
    .filter(({ cluster }) => cluster.length === 1)
    .map(({ index }) => index);

  for (const singletonIndex of singletonIndexes) {
    const singletonCluster = working[singletonIndex];
    if (!singletonCluster || singletonCluster.length !== 1) continue;
    const member = singletonCluster[0];

    let bestClusterIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < working.length; index++) {
      if (index === singletonIndex || working[index].length === 0) continue;
      const compatibility = clusterCompatibility([member], working[index], decisionMap, mentions);
      if (compatibility > bestScore) {
        bestScore = compatibility;
        bestClusterIndex = index;
      }
    }

    if (bestClusterIndex >= 0 && bestScore >= 0.84) {
      working[bestClusterIndex].push(member);
      working[singletonIndex] = [];
    }
  }

  return working.filter((cluster) => cluster.length > 0);
}

function clusterCompatibility(
  clusterA: number[],
  clusterB: number[],
  decisionMap: Map<string, PairwiseDecision>,
  mentions: NormalizedMention[]
): number {
  let best = 0;
  for (const a of clusterA) {
    for (const b of clusterB) {
      const decision = decisionMap.get(pairKey(a, b));
      if (decision?.hardNegative) return 0;
      if (decision && decision.probability > best) best = decision.probability;
    }
  }

  const linkedInHandles = new Set<string>();
  for (const member of [...clusterA, ...clusterB]) {
    for (const handle of mentions[member].socialHandles.linkedin ?? []) {
      linkedInHandles.add(handle);
    }
  }
  if (linkedInHandles.size > 1) return 0;

  return best;
}

function hasClusterConflict(
  cluster: number[],
  decisionMap: Map<string, PairwiseDecision>,
  mentions: NormalizedMention[]
): boolean {
  const linkedInHandles = new Set<string>();
  for (const member of cluster) {
    for (const handle of mentions[member].socialHandles.linkedin ?? []) {
      linkedInHandles.add(handle);
    }
  }
  if (linkedInHandles.size > 1) return true;

  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const decision = decisionMap.get(pairKey(cluster[i], cluster[j]));
      if (decision?.hardNegative) return true;
    }
  }
  return false;
}

function groupClusters(parent: number[], size: number): number[][] {
  const grouped = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    const root = find(parent, i);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root)!.push(i);
  }
  return [...grouped.values()];
}

function pairKey(a: number, b: number): string {
  const left = Math.min(a, b);
  const right = Math.max(a, b);
  return `${left}:${right}`;
}

function find(parent: number[], index: number): number {
  if (parent[index] !== index) parent[index] = find(parent, parent[index]);
  return parent[index];
}

function findLocal(parent: Map<number, number>, index: number): number {
  const current = parent.get(index);
  if (current === undefined || current === index) return index;
  const root = findLocal(parent, current);
  parent.set(index, root);
  return root;
}

function unionLocal(parent: Map<number, number>, a: number, b: number) {
  const rootA = findLocal(parent, a);
  const rootB = findLocal(parent, b);
  if (rootA !== rootB) {
    parent.set(rootB, rootA);
  }
}
