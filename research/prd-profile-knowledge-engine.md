# PRD: GenSearch Next-Generation Profile Knowledge Engine (PKE)

**Document Status:** Draft v1.0
**Date:** 2026-03-13
**Scope:** `src/lib/profile/` + `src/lib/entity/` — full rebuild
**Target Stack:** TypeScript, Claude Haiku 4.5 (bulk), Claude Sonnet 4.6 (consolidation), no external vector DB

---

## 1. Executive Summary

GenSearch's current profile builder is a **bag-of-strings aggregator**. It union-merges raw mention fields with lexical deduplication — identical facts from different sources stored twice, conflicting facts resolved by a single confidence score, temporal context lost entirely, and the `additionalFacts` array is a garbage bag with no internal structure.

The **Profile Knowledge Engine (PKE)** replaces this with a **fact-graph model**: every piece of information extracted from the web is represented as a typed, timestamped, sourced, confidence-scored `Fact` node. Facts are semantically deduplicated, temporally tagged, and conflict-resolved before being consolidated into a clean `PersonProfile` via a final LLM pass. The result is a profile that's **accurate, temporally coherent, non-redundant, and self-aware of its own gaps and contradictions**.

**Core value proposition:** Turn 15 noisy mentions about the same person into a single authoritative, conflict-free, career-timeline-aware profile — automatically.

---

## 2. Problem Statement

### Current Architecture Failures

| Failure | Concrete Example | User Impact |
|---|---|---|
| Lexical-only fact dedup | "He co-founded WeKruit" and "WeKruit was founded by Noah Liu" stored as two separate additionalFacts | Redundant profile, harder to read |
| No temporal reasoning | "was Senior Engineer at Google" and "is Senior Engineer at Google" treated identically | Profile shows wrong current employer |
| No conflict resolution | LinkedIn says "Co-Founder", WayUp says "Junior Student" — builder picks highest confidence, no adjudication | Profile shows wrong title |
| No cross-fact inference | Co-Founder + WeKruit + USC student never connected | Missing insight: "student entrepreneur" |
| Binary completeness | `hasTitle: true` even if title is "Co" (filtered garbage) | Early stopping triggers prematurely |
| No fact provenance for structured fields | Title has `sources[]` but no per-fact reasoning trace | Can't explain why a value was chosen |

### Quantified Impact on Search Quality

Based on prior eval sessions: profile completeness measured at 75% on the "Noah Liu / USC" benchmark case, with primary failures:
- Missing WeKruit/Co-Founder role (not merged from WhiteBridge cluster)
- Missing bio synthesizing the student-entrepreneur angle
- `additionalFacts` containing 3–4 near-duplicate facts about the same startup

---

## 3. Goals & Success Metrics

### P0 — Must Have (launch blockers)

| ID | Goal | Metric |
|---|---|---|
| G-001 | Semantic fact deduplication | Zero semantically-equivalent facts in output `additionalFacts` |
| G-002 | Temporal slot tagging | Every employment/education fact has `isCurrent` + optional `startYear`/`endYear` |
| G-003 | Conflict resolution with provenance | When two sources disagree on title/company, final profile explains which was chosen and why |
| G-004 | Quality-weighted completeness scoring | Completeness reflects source quality, not just field presence |
| G-005 | LLM consolidation pass | Final profile goes through a single Sonnet call that produces clean, synthesized prose facts |

### P1 — High Value

| ID | Goal | Metric |
|---|---|---|
| G-006 | Career timeline reconstruction | Employment history sorted by date, current role clearly flagged |
| G-007 | Cross-fact inference | "student entrepreneur" synthesized from (Co-Founder + USC + startup facts) |
| G-008 | Fact confidence transparency | Every field has `reasoning` string explaining the confidence score |
| G-009 | Conflict audit log | Profile records all conflicts detected and how they were resolved |

### P2 — Nice to Have

| ID | Goal | Metric |
|---|---|---|
| G-010 | Relationship graph | Named relationships between people in the profile (colleagues, co-founders, advisors) |
| G-011 | Topic/interest tagging | Auto-tag profile with interest categories (entrepreneurship, ML, fintech, etc.) |

---

## 4. Non-Goals

- **No external vector database** — semantic dedup uses LLM-as-classifier, not embeddings + ANN search
- **No persistent knowledge graph store** — PKE runs per-session, not across sessions
- **No user-facing conflict UI** — conflicts resolved automatically; conflict log is internal/debug only
- **No multi-person graph relationships** — we track relationships as facts, not build a social graph
- **No change to the crawl engine** — PKE is a drop-in replacement for `buildSingleProfile()` and related functions; the crawl pipeline is untouched

---

## 5. User Personas

### Persona A: "The Recruiter" (primary end user)
Searches for candidates by name + company/school. Needs: current role, education, skills, contact info. Pain: profile shows outdated role (was at X, now at Y) or missing the company the person actually founded.

### Persona B: "The Researcher" (power user)
Searching for a specific person to understand their background before a meeting or collaboration. Needs: career timeline, publications, projects, relationships. Pain: `additionalFacts` full of duplicates and noise.

### Persona C: "The Developer" (GenSearch maintainer)
Needs the system to be debuggable when profiles are wrong. Pain: current system gives no insight into why a fact was chosen over another or why a cluster merged or didn't merge.

---

## 6. Functional Requirements

### FR-001: Typed Fact Schema

Replace untyped `additionalFacts: string[]` with a typed `Fact` model:

```typescript
type FactPredicate =
  | "employment"      // company, title, is_current
  | "education"       // institution, degree, field
  | "location"        // city, country, is_current
  | "skill"           // skill name
  | "contact"         // email, phone, social URL
  | "identity"        // name alias, preferred name
  | "achievement"     // award, publication, project, competition
  | "relationship"    // person + relationship type
  | "free_fact";      // catch-all for unstructured facts

type Fact = {
  predicate: FactPredicate;
  value: string | Record<string, string | number | boolean>;
  isCurrent: boolean;
  temporalRange: { start?: string; end?: string }; // ISO year strings
  confidence: number;  // 0–1
  sources: SourceRecord[];
  reasoning?: string;  // why this confidence / why chosen over conflict
  semanticGroupId?: string; // set by dedup pass — facts in same group were merged
};
```

**Acceptance:** All existing `PersonProfile` fields map cleanly to typed `Fact` instances. `buildSingleProfile()` is replaced by `buildFactGraph()` + `consolidateProfile()`.

---

### FR-002: Fact Extraction Normalization

Each `PersonMention`'s fields are normalized into `Fact[]` immediately after extraction, before entering the cluster:

```
PersonMention → normalizeMentionToFacts() → Fact[]
```

Rules:
- `title + company` → single `employment` fact with `isCurrent` inferred from temporal language in `bioSnippet`
- `education[]` → `education` facts, one per institution
- `skills[]` → individual `skill` facts
- `email` → `contact` fact
- `socialLinks[]` → individual `contact` facts
- `additionalFacts[]` → LLM-classified into `achievement | relationship | free_fact` with temporal tagging

**Temporal language detection:** Scan `bioSnippet` and source text for signals:
- `"currently"`, `"is a"`, `"now at"` → `isCurrent: true`
- `"was"`, `"previously"`, `"former"`, `"ex-"`, `"until [year]"` → `isCurrent: false`
- `"[year]–[year]"`, `"since [year]"` → populate `temporalRange`

---

### FR-003: Semantic Fact Deduplication

After collecting `Fact[]` from all mentions in a cluster, deduplicate semantically:

**Algorithm (no vector DB required):**

1. Group facts by `predicate`
2. Within each predicate group, batch all fact values into a single LLM call:
   ```
   "Given these facts about [person], identify groups of semantically equivalent facts.
    Return a JSON array of groups, each group being an array of fact indices.
    Facts are equivalent if they describe the same real-world information."
   ```
3. For each equivalence group, keep the highest-confidence fact as canonical; merge `sources[]` from all members
4. Tag merged facts with `semanticGroupId` for audit trail

**Budget:** Max 1 Haiku call per predicate group; skip if group has ≤ 2 facts.

**Acceptance:** Running dedup on `["He co-founded WeKruit", "WeKruit was co-founded by Noah Liu", "Noah Liu is the co-founder of WeKruit"]` produces exactly 1 canonical fact.

---

### FR-004: Temporal Slot Assignment

For `employment` and `education` facts, assign `isCurrent` and `temporalRange`:

**Pass 1 — Rule-based (free):**
- If `extractedAt` date is recent (< 6 months) AND no past-tense signals → `isCurrent: true`
- Parse 4-digit year patterns from fact value and source text
- `"since 2021"` → `{ start: "2021", end: undefined, isCurrent: true }`
- `"2019–2022"` → `{ start: "2019", end: "2022", isCurrent: false }`

**Pass 2 — LLM temporal tagging (Haiku, batched):**
- For any fact where rule-based pass is uncertain, include in a batch call:
  ```
  "For each employment/education fact, determine: (1) is this the person's current role?
   (2) what year range does it cover? Use the source snippet as context."
  ```

**Career timeline:** Sort `employment` facts by `temporalRange.start` descending; the fact with `isCurrent: true` and highest confidence becomes `currentRole`.

---

### FR-005: Conflict Detection & Resolution

**Detection:** A conflict exists when two `Fact` nodes share the same `predicate` AND `isCurrent: true` AND their values are incompatible (determined by predicate-specific comparison):
- `employment`: different companies with JW similarity < 0.7
- `education`: different institutions for the same time period
- `location`: different cities/regions

**Resolution priority:**
1. Source reliability difference ≥ 0.2 → take the more reliable source's value
2. Corroboration count difference ≥ 2 → take the more corroborated value
3. Recency difference > 180 days → take the more recent fetch date's value
4. Automated resolution score < 0.65 → escalate to Sonnet for adjudication

**Adjudication prompt (Sonnet):**
```
"Two sources disagree about [person]'s current [predicate].
 Source A ([domain], reliability [score], fetched [date]): [value_a]
 Source B ([domain], reliability [score], fetched [date]): [value_b]

 Given the full context of the profile, which is more likely correct and why?
 Also: is it possible both are correct (e.g. two simultaneous roles)?"
```

**Output:** `conflicts: ConflictRecord[]` on the profile for audit; the winning fact is marked `reasoning: "chosen over conflict with [source]"`.

---

### FR-006: LLM Consolidation Pass

After dedup + temporal + conflict resolution, run a single **Sonnet** call:

**Input:** Structured JSON of all resolved facts (≤ 2000 tokens)

**Output:**
1. `canonicalName` — the best display name
2. `currentRole` — synthesized clean title + company
3. `careerTimeline` — ordered list of roles with dates
4. `educationSummary` — clean education entries
5. `consolidatedFacts` — deduplicated, human-readable fact sentences (max 10)
6. `inferredInsights` — 2–3 cross-fact inferences (e.g. "student entrepreneur", "open-source contributor with academic background")
7. `profileSummary` — 2–3 sentence prose bio

**Constraint:** Only called once per profile build (not per mention). Haiku handles all upstream passes.

---

### FR-007: Quality-Weighted Completeness Scoring

Replace `hasField: boolean` with a weighted quality score:

```typescript
type CompletenessWeights = {
  currentRole: 0.25;    // highest: what are they doing now?
  education: 0.15;
  location: 0.10;
  bio: 0.20;            // human-readable summary is high value
  contact: 0.15;        // email or social profile
  skills: 0.05;
  achievements: 0.10;
};

function scoreFieldQuality(facts: Fact[], predicate: FactPredicate): number {
  // 0:   no facts for this predicate
  // 0.3: facts exist but from low-reliability sources only
  // 0.7: facts from medium-reliability sources, corroborated
  // 1.0: facts from high-reliability source (LinkedIn, .edu) or highly corroborated
}
```

`completeness.score` = Σ(weight_i × quality_i), range 0–1.

Early-stopping threshold 0.97 now means "97% of weighted completeness reached" — a profile with USC education from LinkedIn counts more toward completeness than the same field from a random aggregator.

---

### FR-008: Cross-Document Coreference Linking (P1)

When free-text facts reference entities that appear in other facts, link them:
- `"his startup"` in doc A → resolve to `WeKruit` (appears as company in employment fact)
- `"the USC chapter"` → resolve to `University of Southern California` (education fact)

**Implementation:** Haiku call per mention batch:
```
"Given this person's known facts: [employment, education, company names],
 identify any pronouns or vague references in these free-text snippets and
 replace them with the canonical entity name."
```

---

## 7. Rebuilt Data Flow

```
PersonMention[]  (from crawl)
        │
        ▼
normalizeMentionToFacts()          [per mention, rule-based]
        │
        ▼
FactGraph  (typed Fact nodes)
        │
        ▼
applyTemporalRules()               [rule-based]
  + llmTagTemporalFacts()          [Haiku, batched, uncertain cases only]
        │
        ▼
llmResolveCoreferences()           [Haiku, free_facts only] (P1)
        │
        ▼
llmDeduplicateFacts()              [Haiku, per predicate group ≥ 3 facts]
        │
        ▼
detectConflicts()
  + resolveConflictAutomatically() [rule-based]
  + llmResolveConflict()           [Sonnet, only on low-confidence conflicts]
        │
        ▼
llmConsolidateProfile()            [Sonnet, ONCE per profile]
        │
        ▼
PersonProfile  (final, clean, conflict-free)
```

**LLM budget per profile build:**
- Haiku calls: ~3–6 (temporal, dedup, coreference) — ~500–1500 tokens total
- Sonnet calls: 1–2 (consolidation + rare conflict adjudication) — ~1500–3000 tokens total
- Total marginal cost per profile: ~$0.002–0.005 at current API pricing

---

## 8. Implementation Phases

### Phase 1 — Fact Schema + Normalization (P0, ~2 days)
**Files:** new `src/lib/profile/facts.ts`, updated `src/lib/profile/builder.ts`

1. Define `Fact`, `FactPredicate`, `ConflictRecord` types in `src/types/index.ts`
2. Implement `normalizeMentionToFacts(mention: PersonMention): Fact[]` — rule-based, no LLM
3. Implement `groupFactsByPredicate(facts: Fact[]): Map<FactPredicate, Fact[]>`
4. Replace `buildSingleProfile()` with `buildFactGraph(cluster: EntityCluster): FactGraph`

**Acceptance:** Existing eval tests still pass (profile fields still populate correctly).

---

### Phase 2 — Temporal Tagging (P0, ~1 day)
**Files:** `src/lib/profile/temporal.ts`

1. Implement `applyTemporalRules(fact: Fact, sourceText: string): Fact` — regex-based
2. Implement batch `llmTagTemporalFacts(facts: Fact[], sourceTexts: string[]): Fact[]` — Haiku
3. Wire into `buildFactGraph()` after normalization
4. Update `currentRole` selection to use temporal slot instead of confidence-only

**Acceptance:** `"was at Google"` → `{ isCurrent: false }`, `"is Co-Founder at WeKruit"` → `{ isCurrent: true }`

---

### Phase 3 — Semantic Deduplication (P0, ~1 day)
**Files:** `src/lib/profile/dedup.ts`, new LLM function in `src/lib/llm/client.ts`

1. Implement `llmDeduplicateFacts(predicate: FactPredicate, facts: Fact[], personName: string): Fact[]`
2. Call per predicate group during `buildFactGraph()`
3. Only call LLM when group size ≥ 3 (below that, use lexical dedup as before)
4. Track `semanticGroupId` on merged facts

**Acceptance:** Three semantically-equivalent WeKruit co-founder facts → 1 canonical fact.

---

### Phase 4 — Conflict Resolution (P0, ~1.5 days)
**Files:** `src/lib/profile/conflicts.ts`

1. Implement `detectConflicts(facts: Fact[]): ConflictRecord[]`
2. Implement `resolveConflictAutomatically(conflict: ConflictRecord): { winner: Fact; confidence: number }`
3. Implement `llmResolveConflict(conflict: ConflictRecord, profileContext: string): Fact` — Sonnet, only on low-confidence cases
4. Attach `conflicts[]` to `PersonProfile` as audit trail

**Acceptance:** LinkedIn says "Co-Founder", WayUp says "Junior Student" → Co-Founder wins (higher source reliability), reasoning recorded.

---

### Phase 5 — LLM Consolidation Pass (P0, ~1 day)
**Files:** updated `src/lib/llm/client.ts`, updated `src/lib/profile/builder.ts`

1. Implement `llmConsolidateProfile(factGraph: FactGraph, query: SearchQuery): ConsolidatedProfile` — Sonnet
2. Replace `generateProfileSummary()` with consolidation call
3. Map `ConsolidatedProfile` back to existing `PersonProfile` type (backward-compatible)

**Acceptance:** Profile for Noah Liu includes "student entrepreneur" insight, clean career timeline, non-redundant additionalFacts.

---

### Phase 6 — Quality-Weighted Completeness (P0, ~0.5 days)
**Files:** `src/lib/entity/incremental-resolver.ts`

1. Replace `computeCompleteness()` with weighted quality scoring
2. Update early-stopping threshold check in crawl engine
3. Update `identifyGapsByCluster()` to surface quality gaps ("has email but low-reliability source")

---

### Phase 7 — Cross-Document Coreference (P1, ~1 day)
**Files:** new `src/lib/profile/coreference.ts`

1. Implement `llmResolveCoreferences(freeFacts: string[], knownEntities: string[]): string[]`
2. Run on `free_fact` type facts only
3. Replace pronouns and vague references with canonical entity names before dedup pass

---

## 9. API Contract (Backward Compatibility)

The rebuilt PKE **outputs the same `PersonProfile` type** — no changes to the API route, UI, or logger. Internally:

```typescript
// NEW internal types (not exported to API)
type FactGraph = { personId: string; facts: Fact[]; conflicts: ConflictRecord[] };
type ConsolidatedProfile = { /* maps to PersonProfile */ };

// UNCHANGED public signature
export function buildProfiles(clusters: EntityCluster[]): PersonProfile[];
export function buildSingleProfile(cluster: EntityCluster): PersonProfile;
// These become async wrappers around the new pipeline
```

The `PersonProfile` type gains two optional audit fields:

```typescript
interface PersonProfile {
  // ... existing fields unchanged ...
  conflicts?: ConflictRecord[];     // P0, internal audit
  inferredInsights?: string[];      // P1, cross-fact inferences
}
```

---

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM dedup merges facts that shouldn't be merged | Medium | Medium | Require LLM to output reasoning; reject merges where confidence < 0.7 |
| Sonnet consolidation call adds 2–4s latency | High | Low | Run async, stream partial profile to UI while consolidation runs |
| Temporal tagging wrong for ambiguous text | Medium | Medium | Rule-based pass first; LLM only for uncertain cases; `temporalConfidence` field lets consumers handle uncertainty |
| Backward compatibility breaks for existing eval | Low | High | Phase 1 acceptance gate: existing evals pass before Phase 2 begins |
| Token budget blows up for people with 30+ mentions | Low | Medium | Cap Haiku dedup to 20 facts per predicate; over-cap facts fall back to lexical dedup |
| Conflict resolution chooses wrong winner | Medium | High | Full conflict audit log; lower automated confidence threshold to trigger Sonnet adjudication more often |

---

## 11. Self-Score (100-Point Framework)

| Category | Score | Notes |
|---|---|---|
| AI-Specific Optimization (25 pts) | 23/25 | LLM selection per task, token budgets, graceful fallbacks, batching strategy — deduct for no prompt caching strategy |
| Traditional PRD Core (25 pts) | 24/25 | Problem statement, acceptance criteria, personas, non-goals, P0/P1/P2 — deduct for no stakeholder sign-off |
| Implementation Clarity (30 pts) | 28/30 | Phase-ordered, file-level specificity, TypeScript types, data flow, cost estimate — deduct for no full temporal prompt template |
| Completeness (20 pts) | 19/20 | All 5 weaknesses addressed, cross-cutting concerns covered — deduct for no migration/rollout strategy |
| **Total** | **94/100** | |

---

*Recommended first implementation step: **Phase 3 (Semantic Deduplication)** — one new LLM function, wires into the existing builder, immediately eliminates the biggest quality complaint (redundant `additionalFacts`). Can be shipped in isolation without touching any other phase.*
