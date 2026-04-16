# GenSearch — Incremental Entity Resolution

## Product Requirements Document (PRD)

**Version:** 1.0
**Date:** 2026-03-10
**Status:** Proposed
**Parent PRD:** GenSearch PRD v1.5
**Scope:** Refactor entity resolution from end-of-crawl batch processing to incremental mid-crawl resolution. Affects FR-002 (Crawl Engine), FR-004 (Entity Resolution), and the adaptive query system.

---

## 1. Executive Summary

### What

Move entity resolution from a single post-crawl batch step into an incremental process that runs periodically during crawling. The crawl engine will maintain live entity clusters throughout the search, using them to make smarter decisions about what to search for next.

### Why

The current architecture collects all mentions into a flat bag during crawling, then resolves entities only at the end. This means the system's mid-crawl intelligence (adaptive query generation, link scoring, diminishing returns detection) operates blind to identity — it doesn't know which facts belong to which person. This causes:

1. **Cross-contamination:** Facts from wrong-person mentions (a different "Alexander Gu") leak into the adaptive query agent's knowledge, causing it to chase the wrong person's details.
2. **Wasted budget:** The system can't tell that its target cluster is already well-profiled while spending pages on dead-end clusters.
3. **Flat confidence gating:** The blunt `MIN_CONFIDENCE_FOR_FACTS = 0.5` threshold is the only defense against wrong-person contamination, but it's too coarse — a 0.45-confidence mention of the right person gets filtered out alongside a 0.45-confidence mention of the wrong person.

Incremental resolution fixes all three by giving the crawl engine per-cluster awareness mid-crawl — exactly how a human researcher builds a mental model of "this is my target" vs "this is someone else" as they browse.

### Impact

- **Search quality:** The adaptive query agent sees per-cluster fact summaries, not a mixed bag. It generates queries targeting gaps in the correct cluster.
- **Budget efficiency:** Early stopping can trigger per-cluster ("target profile is complete") rather than globally ("no new facts across all mentions").
- **Accuracy:** The entity resolution result at the end will be identical or better to the current end-of-crawl approach (we still do a final resolution pass), but the crawl path that produced the mentions will be smarter.

### Cost

Minimal. Entity resolution (TF-IDF + Union-Find + Leiden splitting) is pure CPU — milliseconds even on 50 mentions. The only LLM cost is disambiguation calls for ambiguous clusters, which already exist and would be spread across the crawl instead of batched at the end. Expected additional LLM calls: 0-3 per search session.

---

## 2. Problem Statement

### Current Architecture (End-of-Crawl)

```
Phase 1: Search → Generate queries, fetch search results
Phase 2: Crawl  → For each page: extract mention → push to flat array
                   Every N pages: summarize flat array → feed to adaptive query agent
Phase 3: Resolve → Run entity resolution on full mention array (once)
Phase 4: Build   → Build profiles from resolved clusters
```

**Problem:** During Phase 2, the adaptive query agent receives `summarizeKnownFacts()` — a flat text list of all high-confidence facts across ALL mentions, regardless of which person they belong to. If two people named "Alexander Gu" are found (one at TJ High School, one at Park Tudor), the agent sees: "Education: Thomas Jefferson HS; Education: Park Tudor HS" with no way to know these are different people. It may then generate queries combining facts from both, chasing a phantom person who attended both schools.

### Proposed Architecture (Incremental)

```
Phase 1: Search → Generate queries, fetch search results
Phase 2: Crawl  → For each page: extract mention → push to array
                   Every N pages:
                     1. Run lightweight entity resolution on all mentions so far
                     2. Identify target cluster + other clusters
                     3. Summarize per-cluster facts → feed to adaptive query agent
                     4. Check per-cluster completeness for early stopping
Phase 3: Resolve → Run final entity resolution pass (same as today, for accuracy)
Phase 4: Build   → Build profiles from resolved clusters
```

### Quantified Impact (Estimates)

| Metric | Current | Expected After |
|--------|---------|---------------|
| Cross-contamination rate | ~15-20% of adaptive queries reference wrong-person facts | < 3% |
| Wasted pages on wrong-person exploration | ~20-30% of page budget when common names involved | < 10% |
| Entity resolution accuracy | ~90% (end-of-crawl) | ~93-95% (smarter crawl path produces better data) |
| Additional compute cost per search | N/A | < 50ms CPU (resolution runs) + 0-3 LLM calls (~$0.01) |
| Code complexity increase | N/A | +150-250 lines, moderate refactor of engine.ts |

---

## 3. Goals & Success Criteria

### P0 — Must Have

| Goal | Metric | Target |
|------|--------|--------|
| Cluster-aware adaptive queries | % of adaptive queries that reference only correct-cluster facts | >= 95% |
| No regression in resolution accuracy | Entity disambiguation accuracy vs current implementation | >= current (90%) |
| Budget efficiency | % of page budget spent on target-relevant pages (common name searches) | >= 70% (up from ~50%) |
| Performance | Additional latency per search session from incremental resolution | < 500ms total |

### P1 — Important

| Goal | Metric | Target |
|------|--------|--------|
| Cluster-aware early stopping | % of searches that stop early due to target cluster completeness | >= 30% of searches |
| Reduced total LLM token usage | Tokens per search (fewer wasted extractions on wrong-person pages) | 10-20% reduction |
| Better profile quality | Average confidence score of returned profiles | >= 0.1 improvement |

### P2 — Nice to Have

| Goal | Metric | Target |
|------|--------|--------|
| Real-time cluster visualization | Show live cluster graph during crawl (not just at end) | Functional prototype |
| Per-cluster gap analysis | Show "Cluster A: missing education; Cluster B: complete" in progress UI | Implemented |

---

## 4. Non-Goals

- **Not replacing the final resolution pass.** The end-of-crawl resolution still runs as the authoritative result. Incremental resolution is advisory — it guides the crawl but doesn't define the final output.
- **Not adding new clustering algorithms.** We reuse the existing TF-IDF + Union-Find + Leiden pipeline. The change is when/how often it runs, not what it computes.
- **Not changing the extraction pipeline.** `llmExtractPerson` is unchanged. We're changing what happens with the extracted mentions, not how they're extracted.
- **Not implementing real-time cluster streaming to the UI** (P2 goal, not in this scope).

---

## 5. Detailed Design

### 5.1 IncrementalResolver — New Module

**File:** `src/lib/entity/incremental-resolver.ts`

A stateful wrapper around the existing `resolveEntities()` pipeline that:
- Maintains a cache of the last resolution result
- Tracks which mentions have been added since the last resolution
- Provides cluster-aware summaries for the adaptive query agent

```typescript
interface LiveCluster {
  id: string;                    // Stable identifier across resolution runs
  mentions: PersonMention[];
  isPrimaryTarget: boolean;
  targetScore: number;           // How well this cluster matches the query
  completeness: ClusterCompleteness;
}

interface ClusterCompleteness {
  hasTitle: boolean;
  hasCompany: boolean;
  hasLocation: boolean;
  hasEducation: boolean;
  hasEmail: boolean;
  hasSocial: boolean;
  hasBio: boolean;
  score: number;                 // 0-1, fraction of fields filled
}

class IncrementalResolver {
  private mentions: PersonMention[] = [];
  private clusters: LiveCluster[] = [];
  private lastResolvedCount: number = 0;
  private query: SearchQuery;

  constructor(query: SearchQuery);

  /** Add a new mention. Does NOT trigger resolution. */
  addMention(mention: PersonMention): void;

  /** Run entity resolution on all mentions accumulated so far.
   *  Only runs full resolution if new mentions have been added since last run.
   *  Returns the current cluster state. */
  resolve(): Promise<LiveCluster[]>;

  /** Get the current target cluster (highest-scoring primary). */
  getTargetCluster(): LiveCluster | null;

  /** Get cluster-aware fact summary for the adaptive query agent. */
  summarizeByCluster(): string;

  /** Get cluster-aware gap analysis. */
  identifyGapsByCluster(): string;

  /** Check if the target cluster is "complete enough" to stop. */
  isTargetComplete(threshold?: number): boolean;

  /** Get all clusters for the final resolution step. */
  getAllMentions(): PersonMention[];
}
```

### 5.2 Stable Cluster IDs

**Problem:** When resolution re-runs with more mentions, clusters can split or merge. The adaptive query agent shouldn't be confused by cluster IDs changing between runs.

**Solution:** After each resolution run, match new clusters to old clusters using maximum-overlap assignment:
1. For each new cluster, find the old cluster whose mention set has the largest intersection.
2. If overlap >= 50% of the smaller cluster's size, reuse the old cluster's ID.
3. Otherwise, assign a new ID.

This ensures that the "target" cluster maintains a stable identity even as its membership evolves.

### 5.3 Resolution Timing

**When to run incremental resolution:**

| Trigger | Condition | Rationale |
|---------|-----------|-----------|
| Periodic | Every `adaptiveQueryInterval` pages (default: 4) | Aligns with adaptive query checks — resolution feeds into query decisions |
| Minimum mentions | Only if `mentions.length >= 3` | With < 3 mentions, clustering is meaningless. Use raw confidence filtering instead. |
| Before adaptive query | Always run just before `llmAdaptiveQueryRegen` | Ensures the agent has the latest cluster state |
| Skip if no new mentions | Don't re-resolve if no new mentions since last run | Avoid wasted CPU |

**Cost per run:** The resolution pipeline is O(N^2) for pairwise similarity, but N is small during crawling (typically 3-15 mentions at the point of each incremental run). Even 15 mentions = 105 pairs = < 1ms.

### 5.4 Cluster-Aware Fact Summaries

Replace the current flat `summarizeKnownFacts()` with cluster-aware summaries:

**Current (flat):**
```
Title: Software Engineer; Title: Teacher; Company: Google; Company: Park Tudor HS;
Education: Thomas Jefferson HS; Education: Park Tudor HS
[2 low-confidence mentions excluded]
```

**Proposed (cluster-aware):**
```
TARGET CLUSTER (3 mentions, confidence: 0.87):
  Name: Alexander Gu
  Education: Thomas Jefferson HS
  Skills: USACO, competitive programming
  Social: github.com/alexandergu
  Missing: job title, company, location, email

OTHER CLUSTER "Alexander Gu" (1 mention, confidence: 0.45):
  Title: Teacher
  Company: Park Tudor HS
  [Not the target — different person with same name]

UNASSIGNED (1 mention, confidence: 0.30):
  [Too low confidence to cluster reliably]
```

**Key rules for the cluster-aware summary:**
1. **Target cluster facts only** feed into adaptive query generation — other clusters are mentioned only as context ("these exist, but they're not our target").
2. **Gap analysis is per-cluster:** "TARGET CLUSTER missing: job title, email" — not "overall we're missing job title" which might be satisfied by a wrong-person mention.
3. **The LLM prompt explicitly says:** "Generate queries to fill gaps in the TARGET CLUSTER only. Do NOT generate queries based on facts from other clusters."

### 5.5 Cluster-Aware Early Stopping

Replace the current flat diminishing returns check with per-cluster completeness:

**Current logic:**
```
if (recentNewFacts < 2 in last 10 pages) → stop
```

**Proposed logic:**
```
// Primary check: target cluster completeness
if (targetCluster.completeness.score >= 0.85) → stop ("target profile is sufficiently complete")

// Secondary check: diminishing returns for target
if (recentNewFactsForTargetCluster < 1 in last 10 pages) → stop ("no new target-relevant information")

// Fallback: global diminishing returns (same as today)
if (recentNewFacts < 2 in last 10 pages) → stop
```

The completeness score is computed as:
```
score = (fieldsPresent / totalTrackableFields)
```
Where tracked fields are: title, company, location, education, email, social, bio (7 fields). A score of 0.85 = 6/7 fields filled.

### 5.6 Engine Integration Points

Changes to `engine.ts` crawl loop:

```typescript
// At session start:
const resolver = new IncrementalResolver(query);

// After each extraction (existing code):
if (extraction && extraction.mentionsTarget) {
  const mention = { ... };  // existing mention construction
  session.crawlState.extractedMentions.push(mention);
  resolver.addMention(mention);  // NEW
}

// Before adaptive query check (existing location):
if (pagesVisited - lastAdaptiveCheck >= adaptiveQueryInterval) {
  // NEW: Run incremental resolution before summarizing
  if (resolver.mentionCount >= 3) {
    await resolver.resolve();
  }

  // CHANGED: Use cluster-aware summaries
  const knownFacts = resolver.summarizeByCluster();
  const gaps = resolver.identifyGapsByCluster();

  // NEW: Check cluster-aware early stopping
  if (resolver.isTargetComplete(0.85)) {
    emit({ type: "info", message: "Target profile is sufficiently complete." });
    break;
  }

  // Existing adaptive query regen (now receives better facts/gaps)
  const regenResult = await llmAdaptiveQueryRegen(..., knownFacts, gaps, ...);
}

// Before link scoring (existing location):
// CHANGED: Use cluster-aware summaries for link scoring too
const knownFacts = resolver.summarizeByCluster();
const gaps = resolver.identifyGapsByCluster();
const scoredLinks = await llmScoreLinks(..., knownFacts, gaps, ...);

// Phase 4 (existing): Final resolution pass still runs on all mentions
// This ensures the final output is as accurate as possible
const entityClusters = await resolveEntities(
  session.crawlState.extractedMentions, query
);
```

### 5.7 Handling the Cold Start Problem

**Problem:** With < 3 mentions, TF-IDF vectors are sparse and clustering is unreliable. Early wrong merges could cascade.

**Solution — Phased activation:**

| Mention Count | Behavior |
|---------------|----------|
| 0-2 mentions | No clustering. Use raw confidence filtering (current `MIN_CONFIDENCE_FOR_FACTS` approach). |
| 3-4 mentions | Run clustering with higher thresholds (initial: 0.45, cohesion: 0.55) to avoid false merges. Skip LLM disambiguation — too few data points. |
| 5+ mentions | Run full clustering pipeline with normal thresholds. Enable LLM disambiguation for ambiguous clusters. |

### 5.8 Handling Cluster Instability

**Problem:** A cluster may split between resolution runs (e.g., a 3-mention cluster splits into a 2-mention and 1-mention cluster when a new mention adds contradictory evidence). If the adaptive query agent was targeting that cluster, its ID is now gone.

**Mitigation:**
1. **Stable ID assignment** (section 5.2) handles most cases — the larger fragment inherits the old ID.
2. **Target cluster is re-identified each run** by `targetScore` against the query, not by ID. Even if the cluster ID changes, the system re-evaluates which cluster is the target.
3. **Agent prompts reference the target by description** ("the cluster matching your search context"), not by ID. So cluster ID changes are invisible to the LLM.

---

## 6. Implementation Plan

### Phase 1: IncrementalResolver Module (Low Risk)

**Files:** New `src/lib/entity/incremental-resolver.ts`

1. Create `IncrementalResolver` class wrapping existing `resolveEntities()`
2. Implement `addMention()`, `resolve()`, `getTargetCluster()`
3. Implement stable cluster ID assignment
4. Implement `summarizeByCluster()` and `identifyGapsByCluster()`
5. Implement `isTargetComplete()`
6. Unit tests for cluster stability, summary formatting, completeness scoring

**Estimated scope:** ~200 lines of new code + tests

### Phase 2: Engine Integration (Moderate Risk)

**Files:** Modified `src/lib/crawl/engine.ts`

1. Initialize `IncrementalResolver` at session start
2. Call `addMention()` after each extraction
3. Call `resolve()` before adaptive query checks
4. Replace `summarizeKnownFacts()` / `identifyGaps()` with cluster-aware versions
5. Add cluster-aware early stopping
6. Keep final resolution pass unchanged

**Estimated scope:** ~50 lines changed in engine.ts

### Phase 3: Prompt Updates (Low Risk)

**Files:** Modified `src/lib/llm/client.ts`

1. Update `llmAdaptiveQueryRegen` prompt to reference cluster-aware summaries
2. Add explicit instruction: "Only generate queries for the TARGET CLUSTER"
3. Update `llmScoreLinks` prompt to score links based on target cluster gaps

**Estimated scope:** ~20 lines of prompt changes

### Phase 4: Validation & Tuning

1. Run the existing test searches and compare:
   - Same person found? (must not regress)
   - Fewer wrong-person adaptive queries generated? (should improve)
   - Lower token usage? (should decrease due to less wasted exploration)
2. Tune thresholds:
   - Cold-start activation threshold (3 mentions? 5?)
   - Completeness threshold for early stopping (0.85? 0.80?)
   - Resolution frequency (every 4 pages? every 3?)
3. A/B comparison: run same queries with old (flat) and new (incremental) summaries, compare profile quality and token usage

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Early wrong merge cascades | Medium | High — sends crawl in wrong direction | Phased activation: high thresholds with few mentions, relaxing as data grows. Final resolution pass catches errors. |
| Cluster instability confuses agent | Low | Medium — agent generates incoherent queries | Stable ID assignment + target identified by score, not ID. Agent prompt references cluster by description. |
| Performance regression | Low | Low — resolution is < 50ms | Only resolve when new mentions exist. Skip if < 3 mentions. |
| Increased code complexity | Certain | Medium — harder to debug crawl decisions | Clear separation: `IncrementalResolver` is a self-contained class. Crawl loop changes are minimal. Extensive logging. |
| LLM disambiguation during crawl delays pipeline | Low | Low — 1-2 calls at 500ms each | Only disambiguate with 5+ mentions. Skip disambiguation during cold start. |

---

## 8. Changes to Existing PRD Sections

### FR-002 (Crawl Engine) — Update

Add to the "Crawl-and-learn loop" description:

> **Incremental entity resolution (every N pages):** Before each adaptive query check, the engine runs a lightweight entity resolution pass on all mentions collected so far. This produces live clusters with per-cluster fact summaries and gap analysis. The adaptive query agent receives cluster-aware context — facts organized by identity cluster — instead of a flat bag of all facts. This prevents cross-contamination from wrong-person mentions and enables cluster-specific gap targeting.

### FR-004 (Entity Resolution) — Update

Add a new subsection:

> **Incremental Resolution (Mid-Crawl):**
> Entity resolution runs incrementally during crawling, not just at the end. Every N pages (aligned with adaptive query interval), the system runs the full TF-IDF + Union-Find + Leiden pipeline on all mentions accumulated so far. Clusters are assigned stable IDs across runs. The adaptive query agent and link scorer receive per-cluster summaries instead of flat fact lists. A final resolution pass still runs at crawl completion for maximum accuracy.
>
> **Cold-start protection:** With fewer than 3 mentions, clustering is skipped (too sparse for reliable similarity computation). With 3-4 mentions, higher clustering thresholds are used to avoid false merges.

### Error Handling — Add

| Scenario | Handling |
|----------|----------|
| Incremental resolution produces different clusters than final pass | Expected and acceptable. The final pass is authoritative. Incremental results are advisory only — they guide the crawl but don't define the output. |
| All mentions cluster into one group during incremental resolution | Fall back to raw confidence filtering (same as current behavior). This is the expected outcome when only one person is found. |
| Cluster split causes target cluster ID to change | Target is re-identified by query score each run. The stable ID heuristic handles most cases; edge cases fall through to score-based re-identification. |

---

## 9. Metrics & Observability

### New Events Emitted

| Event Type | Message Pattern | When |
|-----------|-----------------|------|
| `resolve` | `Incremental resolution: {N} clusters from {M} mentions` | After each incremental resolution run |
| `resolve` | `Target cluster: "{name}" ({K} mentions, completeness: {score})` | After identifying target cluster |
| `info` | `Target profile sufficiently complete (score: {score}), stopping crawl` | When cluster-aware early stopping triggers |

### New Metrics to Track

| Metric | How Measured | Goal |
|--------|-------------|------|
| Incremental resolution runs per session | Counter in session data | 3-12 (depends on page budget) |
| Target cluster stability | % of runs where target cluster ID is unchanged | >= 80% |
| Cluster-aware early stopping rate | % of sessions that stop due to target completeness | 20-40% |
| Token savings vs baseline | A/B comparison of total tokens per search | 10-20% reduction |
| Cross-contamination incidents | Manual audit: adaptive queries referencing wrong-cluster facts | < 3% (down from ~15-20%) |

---

## 10. Testing Strategy

### Unit Tests

1. **IncrementalResolver basics:**
   - Add 5 mentions from 2 different people → resolve → expect 2 clusters
   - Add mentions incrementally → resolve after each batch → clusters should stabilize
   - Cluster IDs remain stable when adding more mentions to existing clusters

2. **Cold-start behavior:**
   - With 1-2 mentions: `resolve()` returns raw mentions, no clustering
   - With 3-4 mentions: higher thresholds applied, no LLM disambiguation

3. **Cluster-aware summaries:**
   - `summarizeByCluster()` groups facts by cluster
   - Target cluster is labeled "TARGET CLUSTER"
   - Other clusters are labeled with "[Not the target]"
   - Only target cluster facts would be actionable for queries

4. **Completeness scoring:**
   - Mention with title + company + location + education = 4/7 = 0.57
   - Cluster with multiple mentions merging all fields → higher score

5. **Stable ID assignment:**
   - Cluster splits: larger fragment keeps old ID
   - Cluster merges: surviving cluster keeps the primary's ID
   - Completely new cluster gets new ID

### Integration Tests

1. **End-to-end with mock LLM:** Run a full search with canned page responses. Verify:
   - Incremental resolution runs at expected intervals
   - Adaptive query agent receives cluster-aware summaries
   - Final profiles match or exceed quality of end-of-crawl-only approach

2. **Common name scenario:** Feed mentions of 2 different "John Smiths". Verify:
   - Mid-crawl: clusters separate after sufficient data (3+ mentions each)
   - Adaptive queries only target the correct cluster's gaps
   - Final output: 2 distinct profiles

### Manual Validation

Run the existing test queries ("Alexander Gu, Thomas Jefferson HS") and compare:
- Crawl log: are adaptive queries more focused?
- Token usage: lower total?
- Profile quality: same or better?
- Entity resolution: correct clusters?
