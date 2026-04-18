import { CLUSTERING_THRESHOLD, type SimilarityEdge } from "./pairwise-scoring";

/** Find connected components using Union-Find on a local index space [0..n). */
export function findConnectedComponents(
  n: number,
  edges: { a: number; b: number; combined: number }[],
  threshold: number
): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);

  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  function union(x: number, y: number) {
    const px = find(x);
    const py = find(y);
    if (px === py) return;
    if (rank[px] < rank[py]) {
      parent[px] = py;
    } else if (rank[px] > rank[py]) {
      parent[py] = px;
    } else {
      parent[py] = px;
      rank[px]++;
    }
  }

  for (const edge of edges) {
    if (edge.combined >= threshold) {
      union(edge.a, edge.b);
    }
  }

  for (let i = 0; i < n; i++) find(i);
  return parent;
}

/**
 * Split clusters that have low internal cohesion.
 * Inspired by Leiden: if a cluster's average internal similarity is below
 * a threshold, split it by removing the weakest links.
 */
export function splitWeakClusters(
  clusters: Map<number, number[]>,
  edges: SimilarityEdge[],
  minCohesion: number
): Map<number, number[]> {
  const edgeIndex = new Map<number, SimilarityEdge[]>();
  for (const e of edges) {
    if (!edgeIndex.has(e.i)) edgeIndex.set(e.i, []);
    if (!edgeIndex.has(e.j)) edgeIndex.set(e.j, []);
    edgeIndex.get(e.i)!.push(e);
    edgeIndex.get(e.j)!.push(e);
  }

  const result = new Map<number, number[]>();
  let nextId = 0;

  for (const [, members] of clusters) {
    if (members.length <= 1) {
      result.set(nextId++, members);
      continue;
    }

    const memberSet = new Set(members);
    const internalEdges: SimilarityEdge[] = [];
    const seenEdges = new Set<string>();
    for (const m of members) {
      for (const e of edgeIndex.get(m) || []) {
        if (memberSet.has(e.i) && memberSet.has(e.j)) {
          const key = `${Math.min(e.i, e.j)}-${Math.max(e.i, e.j)}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            internalEdges.push(e);
          }
        }
      }
    }

    if (internalEdges.length === 0) {
      for (const m of members) {
        result.set(nextId++, [m]);
      }
      continue;
    }

    const avgSimilarity =
      internalEdges.reduce((sum, e) => sum + e.combined, 0) / internalEdges.length;

    if (avgSimilarity >= minCohesion) {
      result.set(nextId++, members);
    } else {
      const globalToLocal = new Map<number, number>();
      const localToGlobal: number[] = [];
      for (const m of members) {
        globalToLocal.set(m, localToGlobal.length);
        localToGlobal.push(m);
      }

      const localEdges = internalEdges.map((e) => ({
        a: globalToLocal.get(e.i)!,
        b: globalToLocal.get(e.j)!,
        combined: e.combined,
      }));

      const subParent = findConnectedComponents(
        members.length,
        localEdges,
        CLUSTERING_THRESHOLD
      );

      const subClusters = new Map<number, number[]>();
      for (let local = 0; local < members.length; local++) {
        const root = subParent[local];
        if (!subClusters.has(root)) subClusters.set(root, []);
        subClusters.get(root)!.push(localToGlobal[local]);
      }

      for (const [, subMembers] of subClusters) {
        result.set(nextId++, subMembers);
      }
    }
  }

  return result;
}
