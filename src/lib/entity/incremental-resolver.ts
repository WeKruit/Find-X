import type { PersonMention, SearchQuery } from "@/types";
import { resolveEntities, bestNameMatchToQuery, scoreClusterTargetMatch, type EntityCluster } from "./resolver";
import { llmMatchNames } from "@/lib/llm/client";

// ── Types ──

export interface ClusterCompleteness {
  hasTitle: boolean;
  hasCompany: boolean;
  hasLocation: boolean;
  hasEducation: boolean;
  hasEmail: boolean;
  hasSocial: boolean;
  hasBio: boolean;
  score: number; // 0-1, fraction of fields filled
}

export interface LiveCluster {
  id: string;
  mentions: PersonMention[];
  isPrimaryTarget: boolean;
  targetScore: number;
  completeness: ClusterCompleteness;
}

// ── Helpers ──

function computeCompleteness(mentions: PersonMention[]): ClusterCompleteness {
  const has = {
    hasTitle: false,
    hasCompany: false,
    hasLocation: false,
    hasEducation: false,
    hasEmail: false,
    hasSocial: false,
    hasBio: false,
  };

  for (const m of mentions) {
    if (m.extracted.experiences?.some((e) => e.title)) has.hasTitle = true;
    if (m.extracted.experiences?.some((e) => e.company)) has.hasCompany = true;
    if (m.extracted.location) has.hasLocation = true;
    if (m.extracted.education.length > 0) has.hasEducation = true;
    if (m.extracted.emails?.length > 0) has.hasEmail = true;
    if (m.extracted.socialLinks.length > 0) has.hasSocial = true;
    if (m.extracted.bioSnippet) has.hasBio = true;
  }

  const fields = [has.hasTitle, has.hasCompany, has.hasLocation, has.hasEducation, has.hasEmail, has.hasSocial, has.hasBio];
  const score = fields.filter(Boolean).length / fields.length;

  return { ...has, score };
}

/**
 * Compute how well a cluster matches the search query.
 * Delegates to the shared scoreClusterTargetMatch in resolver.ts to ensure
 * consistent scoring between incremental and final resolution paths.
 * When no IDF map is available (cold-start), scoreClusterTargetMatch builds
 * a minimal one from the cluster mentions.
 */
function computeTargetScore(
  mentions: PersonMention[],
  query: SearchQuery,
  llmScores?: Map<string, number>
): number {
  return scoreClusterTargetMatch(mentions, query, undefined, llmScores);
}

/**
 * Assign stable IDs to new clusters by matching against old clusters.
 * Uses maximum-overlap assignment: if >= 50% of the smaller cluster's mentions
 * overlap, reuse the old ID.
 */
function assignStableIds(
  oldClusters: LiveCluster[],
  newEntityClusters: EntityCluster[],
  query: SearchQuery,
  llmScores: Map<string, number> | undefined,
  generateId: () => string
): LiveCluster[] {
  if (oldClusters.length === 0) {
    // First run — assign fresh IDs
    return newEntityClusters.map((ec) => ({
      id: generateId(),
      mentions: ec.mentions,
      isPrimaryTarget: ec.isPrimaryTarget,
      targetScore: computeTargetScore(ec.mentions, query, llmScores),
      completeness: computeCompleteness(ec.mentions),
    }));
  }

  // Build a set of source URLs for each old cluster for fast lookup
  const oldUrlSets = oldClusters.map((c) => new Set(c.mentions.map((m) => m.sourceUrl)));
  const usedOldIds = new Set<string>();

  const result: LiveCluster[] = [];

  for (const ec of newEntityClusters) {
    const newUrls = new Set(ec.mentions.map((m) => m.sourceUrl));

    // Find old cluster with best overlap
    let bestOverlap = 0;
    let bestIdx = -1;

    for (let i = 0; i < oldClusters.length; i++) {
      if (usedOldIds.has(oldClusters[i].id)) continue;

      const oldUrls = oldUrlSets[i];
      let overlap = 0;
      for (const url of newUrls) {
        if (oldUrls.has(url)) overlap++;
      }

      const smallerSize = Math.min(oldUrls.size, newUrls.size);
      if (smallerSize > 0 && overlap / smallerSize >= 0.5 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }

    const id = bestIdx >= 0 ? oldClusters[bestIdx].id : generateId();
    if (bestIdx >= 0) usedOldIds.add(id);

    result.push({
      id,
      mentions: ec.mentions,
      isPrimaryTarget: ec.isPrimaryTarget,
      targetScore: computeTargetScore(ec.mentions, query, llmScores),
      completeness: computeCompleteness(ec.mentions),
    });
  }

  return result;
}

// ── IncrementalResolver Class ──

/**
 * Stateful wrapper around resolveEntities() that maintains live clusters
 * throughout a crawl session. Provides cluster-aware summaries for the
 * adaptive query agent and per-cluster early stopping.
 */
export class IncrementalResolver {
  private mentions: PersonMention[] = [];
  private clusters: LiveCluster[] = [];
  private lastResolvedCount = 0;
  private query: SearchQuery;
  /** Cached LLM name match scores — only re-fetched when new names appear */
  private llmNameScores: Map<string, number> = new Map();
  private knownNames: Set<string> = new Set();
  private nextClusterId = 0;

  constructor(query: SearchQuery) {
    this.query = query;
  }

  private generateClusterId(): string {
    return `cluster-${this.nextClusterId++}`;
  }

  /** Number of mentions added so far. */
  get mentionCount(): number {
    return this.mentions.length;
  }

  /** Add a new mention. Does NOT trigger resolution. Deduplicates by sourceUrl. */
  addMention(mention: PersonMention): void {
    const alreadyExists = this.mentions.some((m) => m.sourceUrl === mention.sourceUrl);
    if (!alreadyExists) {
      this.mentions.push(mention);
    }
  }

  /**
   * Run entity resolution on all mentions accumulated so far.
   * Only runs if new mentions have been added since last run.
   * Returns the current cluster state.
   */
  async resolve(): Promise<LiveCluster[]> {
    // Skip if no new mentions since last resolution
    if (this.mentions.length === this.lastResolvedCount) {
      return this.clusters;
    }

    // Refresh LLM name scores if new names have appeared
    await this.refreshLlmNameScores();

    // Cold-start: don't cluster with < 3 mentions.
    // Reuse existing cluster IDs for URLs we've already seen (stable across incremental calls).
    if (this.mentions.length < 3) {
      const existingIdByUrl = new Map(
        this.clusters.flatMap((c) => c.mentions.map((m) => [m.sourceUrl, c.id]))
      );
      this.clusters = this.mentions.map((m) => {
        const nameMatch = bestNameMatchToQuery(m, this.query.name, this.llmNameScores);
        return {
          id: existingIdByUrl.get(m.sourceUrl) ?? this.generateClusterId(),
          mentions: [m],
          isPrimaryTarget: nameMatch >= 0.85 && m.confidence >= 0.4,
          targetScore: computeTargetScore([m], this.query, this.llmNameScores),
          completeness: computeCompleteness([m]),
        };
      });
      this.lastResolvedCount = this.mentions.length;
      return this.clusters;
    }

    // Run the full resolution pipeline, passing our cached LLM scores to avoid redundant API calls
    const entityClusters = await resolveEntities(this.mentions, this.query, this.llmNameScores);

    // Assign stable IDs matching against previous clusters
    this.clusters = assignStableIds(
      this.clusters, entityClusters, this.query, this.llmNameScores,
      () => this.generateClusterId()
    );

    // Re-sort: target clusters first, then by target score
    this.clusters.sort((a, b) => {
      if (a.isPrimaryTarget !== b.isPrimaryTarget) return a.isPrimaryTarget ? -1 : 1;
      return b.targetScore - a.targetScore;
    });

    this.lastResolvedCount = this.mentions.length;
    return this.clusters;
  }

  /** Get the current target cluster (highest-scoring primary). */
  getTargetCluster(): LiveCluster | null {
    const target = this.clusters.find((c) => c.isPrimaryTarget);
    return target || null;
  }

  /**
   * Get cluster-aware fact summary for the adaptive query agent.
   * Target cluster facts are detailed; other clusters are briefly noted.
   */
  summarizeByCluster(): string {
    if (this.clusters.length === 0) return "None yet";

    const parts: string[] = [];
    const target = this.getTargetCluster();

    if (target) {
      parts.push(this.formatClusterSummary(target, "TARGET CLUSTER"));
    }

    // Summarize other clusters briefly
    const others = this.clusters.filter((c) => c !== target);
    for (const cluster of others.slice(0, 3)) {
      const label = cluster.isPrimaryTarget ? "OTHER TARGET" : "OTHER CLUSTER";
      parts.push(this.formatClusterBrief(cluster, label));
    }

    if (others.length > 3) {
      parts.push(`[${others.length - 3} more non-target cluster(s) omitted]`);
    }

    const summary = parts.join("\n\n");
    return summary.length > 3000 ? summary.slice(0, 3000) + "..." : summary;
  }

  /**
   * Get cluster-aware gap analysis focused on the target cluster.
   */
  identifyGapsByCluster(): string {
    const target = this.getTargetCluster();
    if (!target) {
      return "No target cluster identified yet — still gathering initial data";
    }

    const c = target.completeness;
    const gaps: string[] = [];
    if (!c.hasTitle) gaps.push("job title");
    if (!c.hasCompany) gaps.push("current company");
    if (!c.hasLocation) gaps.push("location");
    if (!c.hasEducation) gaps.push("education history");
    if (!c.hasEmail) gaps.push("contact email");
    if (!c.hasSocial) gaps.push("social media profiles");
    if (!c.hasBio) gaps.push("biographical information");

    if (gaps.length === 0) {
      return `TARGET CLUSTER profile is fairly complete (${(c.score * 100).toFixed(0)}% fields filled)`;
    }

    return `TARGET CLUSTER still needs: ${gaps.join(", ")} (${(c.score * 100).toFixed(0)}% complete)`;
  }

  /** Check if the target cluster is "complete enough" to stop. */
  isTargetComplete(threshold = 0.85): boolean {
    const target = this.getTargetCluster();
    if (!target) return false;
    return target.completeness.score >= threshold;
  }

  /** Get all mentions for the final resolution step. */
  getAllMentions(): PersonMention[] {
    return this.mentions;
  }

  /** Get current clusters (for logging/debugging). */
  getClusters(): LiveCluster[] {
    return this.clusters;
  }

  // ── Private helpers ──

  /**
   * Refresh LLM name scores if new unique names have appeared since last call.
   * Only makes an LLM call when there are genuinely new names to evaluate.
   */
  private async refreshLlmNameScores(): Promise<void> {
    const newNames: string[] = [];
    for (const m of this.mentions) {
      for (const name of m.extracted.names.slice(0, 5)) {
        if (!name || typeof name !== "string") continue;
        const trimmed = name.trim();
        if (!this.knownNames.has(trimmed)) {
          newNames.push(trimmed);
          this.knownNames.add(trimmed);
        }
      }
    }

    if (newNames.length === 0) return;

    try {
      const scores = await llmMatchNames(this.query.name, this.query.context, newNames);
      for (const [name, score] of scores) {
        this.llmNameScores.set(name, score);
      }
    } catch {
      // Silently fall back to string-based matching
    }
  }

  private formatClusterSummary(cluster: LiveCluster, label: string): string {
    const lines: string[] = [];
    lines.push(
      `${label} (${cluster.mentions.length} mention(s), completeness: ${(cluster.completeness.score * 100).toFixed(0)}%):`
    );

    // Aggregate facts from all mentions in the cluster
    const names = new Set<string>();
    const titles = new Set<string>();
    const companies = new Set<string>();
    const locations = new Set<string>();
    const education = new Set<string>();
    const skills = new Set<string>();
    const socials = new Set<string>();
    const emails = new Set<string>();
    const bios: string[] = [];

    for (const m of cluster.mentions) {
      for (const n of m.extracted.names) names.add(n);
      for (const exp of (m.extracted.experiences || [])) {
        if (exp.title) titles.add(exp.title);
        if (exp.company) companies.add(exp.company);
      }
      if (m.extracted.location) locations.add(m.extracted.location);
      for (const e of m.extracted.education) education.add(e.institution);
      for (const s of (m.extracted.skills || []).slice(0, 5)) skills.add(s.name);
      for (const sl of m.extracted.socialLinks) socials.add(`${sl.platform}: ${sl.url}`);
      for (const em of (m.extracted.emails || [])) emails.add(em);
      if (m.extracted.bioSnippet && bios.length < 2) bios.push(m.extracted.bioSnippet);
    }

    if (names.size > 0) lines.push(`  Name: ${[...names].join(", ")}`);
    if (titles.size > 0) lines.push(`  Title: ${[...titles].join(", ")}`);
    if (companies.size > 0) lines.push(`  Company: ${[...companies].join(", ")}`);
    if (locations.size > 0) lines.push(`  Location: ${[...locations].join(", ")}`);
    if (education.size > 0) lines.push(`  Education: ${[...education].join(", ")}`);
    if (skills.size > 0) lines.push(`  Skills: ${[...skills].join(", ")}`);
    if (socials.size > 0) lines.push(`  Social: ${[...socials].join(", ")}`);
    if (emails.size > 0) lines.push(`  Email: ${[...emails].join(", ")}`);
    if (bios.length > 0) lines.push(`  Bio: ${bios[0].slice(0, 200)}`);

    // Include additional freeform facts
    const allFacts = new Set<string>();
    for (const m of cluster.mentions) {
      for (const fact of m.extracted.additionalFacts.slice(0, 5)) {
        allFacts.add(fact);
      }
    }
    if (allFacts.size > 0) {
      const factList = [...allFacts].slice(0, 8);
      lines.push(`  Other facts: ${factList.join("; ")}`);
    }

    // Note what's missing
    const missing: string[] = [];
    if (!cluster.completeness.hasTitle) missing.push("job title");
    if (!cluster.completeness.hasCompany) missing.push("company");
    if (!cluster.completeness.hasLocation) missing.push("location");
    if (!cluster.completeness.hasEducation) missing.push("education");
    if (!cluster.completeness.hasEmail) missing.push("email");
    if (!cluster.completeness.hasSocial) missing.push("social profiles");
    if (!cluster.completeness.hasBio) missing.push("bio");
    if (missing.length > 0) lines.push(`  Missing: ${missing.join(", ")}`);

    return lines.join("\n");
  }

  private formatClusterBrief(cluster: LiveCluster, label: string): string {
    const primaryName = cluster.mentions[0]?.extracted.names[0] || "Unknown";
    const firstExp = cluster.mentions.flatMap((m) => m.extracted.experiences || [])[0];
    const title = firstExp?.title || "";
    const company = firstExp?.company || "";
    const details = [title, company].filter(Boolean).join(" at ");

    return `${label} "${primaryName}" (${cluster.mentions.length} mention(s)): ${details || "minimal data"}\n  [Not the target — different person with same name]`;
  }
}
