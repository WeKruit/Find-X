import type { ScoredURL } from "@/types";

/**
 * Priority queue for URL frontier.
 * Higher scores are dequeued first.
 */
export class URLFrontier {
  private heap: ScoredURL[] = [];
  private urlSet = new Set<string>();

  get size(): number {
    return this.heap.length;
  }

  has(url: string): boolean {
    return this.urlSet.has(this.normalize(url));
  }

  push(item: ScoredURL): void {
    const normalized = this.normalize(item.url);
    if (this.urlSet.has(normalized)) return;
    this.urlSet.add(normalized);
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  pushMany(items: ScoredURL[]): void {
    for (const item of items) {
      this.push(item);
    }
  }

  pop(): ScoredURL | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  peek(): ScoredURL | undefined {
    return this.heap[0];
  }

  toArray(): ScoredURL[] {
    return [...this.heap].sort((a, b) => b.score - a.score);
  }

  private normalize(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].score >= this.heap[i].score) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].score > this.heap[largest].score)
        largest = left;
      if (right < n && this.heap[right].score > this.heap[largest].score)
        largest = right;
      if (largest === i) break;
      [this.heap[largest], this.heap[i]] = [this.heap[i], this.heap[largest]];
      i = largest;
    }
  }
}
