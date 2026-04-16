# GenSearch — Deep Web Intelligence Platform

## Product Requirements Document (PRD)

**Version:** 1.5
**Date:** 2026-03-10
**Status:** Draft

---

## 1. Executive Summary

GenSearch is a deep web search and intelligence platform that replicates how humans actually research — not just querying search engines at surface level, but clicking into links, traversing source chains, cross-referencing information, and building comprehensive understanding through recursive exploration.

Unlike existing tools (Automatio, Clay, Apollo) that perform shallow depth-1 lookups against pre-indexed databases or single-page API wrappers, GenSearch implements **AI-guided recursive crawling** with intelligent link prioritization, automatic entity resolution, and progressive profile building from live web sources.

The platform supports three primary modes:
1. **People Search** (primary): Turn a name into a deeply researched, source-attributed, confidence-scored profile — automatically doing the hours of work a human researcher would.
2. **Criteria Search** (primary): Discover multiple people matching criteria like "Ex-Google engineers with startup ideas" or "AI researchers at Stanford publishing on multimodal models." A two-phase workflow — discover candidates first, then deep-crawl selected ones — balances breadth with depth while keeping costs low.
3. **General Research** (secondary): Deep-crawl any topic, aggregating and synthesizing information across sources with the same recursive depth — useful for market research, competitive analysis, due diligence, and investigative research.

**Core value proposition:** Search that actually searches like a human — following leads, cross-referencing sources, and knowing when to go deeper vs. broader.

---

## 2. Problem Statement

### The Gap in Today's Tools

| Tool Category | What They Do | What They Miss |
|---|---|---|
| **Search Wrappers** (Automatio, Tavily) | Depth-1 queries — fetch search results, return snippets | Never click into links, never follow chains, never discover secondary sources |
| **Data Enrichment** (Clay, Apollo, Clearbit) | Lookup pre-indexed databases by email/name | Only know what's already in their database; can't discover new/niche information |
| **People Search** (Pipl, BeenVerified) | Match against public records databases | US-centric, often stale, no live web exploration |
| **AI Research** (Perplexity Deep Research) | Multi-hop AI-guided search with synthesis | Not programmable, no structured output, no entity resolution, no profile persistence |
| **Social Scrapers** (PhantomBuster) | Extract data from specific platforms | Single-platform, fragile, no cross-source synthesis |

**No existing tool combines:** recursive AI-guided crawling + cross-source entity resolution + structured profile building + live web exploration.

### The Criteria Search Gap

Existing tools force you to already know *who* you're looking for. But many real use cases start with *criteria*, not names:
- "Find ex-Google engineers who recently started AI companies"
- "Stanford CS professors publishing on LLMs"
- "YC founders in the climate space"

| Approach Today | Limitation |
|---|---|
| LinkedIn Recruiter boolean search | Only searches LinkedIn's database; misses people with thin LinkedIn presence; expensive ($800+/mo) |
| Clay/Apollo filters | Pre-indexed databases only; can't combine nuanced criteria; misses niche/recent people |
| Manual Google + scrolling | Extremely slow; requires researcher to manually read each page and mentally track candidates |
| ChatGPT/Perplexity "list people who..." | Returns hallucinated or outdated lists; no source attribution; can't verify results |

**GenSearch criteria search is unique because:** it discovers people from live web sources (not pre-indexed databases), verifies each candidate against the criteria using extracted evidence, and lets users drill into any candidate for a full deep search.

### Quantified Pain Points (estimates — to be validated with beta users)

- A human researcher spends **30-90 minutes** building a comprehensive profile on one person manually (based on recruiter and journalist workflow interviews)
- **Criteria-based sourcing takes 2-4 hours** to build a list of 20+ qualified candidates manually — browsing team pages, conference speaker lists, news articles, and social media
- Depth-1 tools miss substantial web information about a person — secondary mentions, conference talks, co-authored papers, nested team pages are only discoverable by following links
- Name disambiguation is a known failure mode in enrichment tools — Clay, Apollo, and similar platforms frequently conflate people with common names when only name + company is provided
- General research tasks (e.g., "what companies are building X?") require dozens of manual searches, tab management, and mental synthesis that no tool automates end-to-end

---

## 3. Goals & Metrics

### P0 — Must Have for Launch

| Goal | Metric | Target |
|---|---|---|
| Deep search accuracy | % of profile fields verified correct (human audit) | ≥ 85% |
| Entity disambiguation | % of profiles correctly separated for duplicate names | ≥ 90% |
| Depth of exploration | Average crawl depth per search session | ≥ 3 hops |
| Source diversity | Average unique domains sourced per profile | ≥ 5 |

### P1 — Important for Growth

| Goal | Metric | Target |
|---|---|---|
| Search speed | Time to deliver initial profile (before deep enrichment) | < 30 seconds |
| Full profile time | Time to complete deep search | < 5 minutes |
| Coverage | % of searches that return a usable profile | ≥ 75% |
| Cost efficiency | Average cost per person search (API + LLM) | < $0.50 |
| Criteria search precision | % of discovered candidates that actually match criteria (human audit) | ≥ 70% |
| Criteria search recall | Discovers ≥ N relevant people per criteria query | ≥ 10 (configurable) |
| Criteria search cost | Average cost per criteria search (discovery phase only) | < $2.00 |

### P2 — Nice to Have

| Goal | Metric | Target |
|---|---|---|
| Profile freshness | Data staleness (median age of data points) | < 30 days |
| User satisfaction | NPS score from beta users | ≥ 40 |
| Retention | Weekly active users returning | ≥ 60% |

---

## 4. Non-Goals (Explicit Boundaries)

- **Not a CRM.** We don't manage sales pipelines or send outreach emails. We find and organize information.
- **Not a background check service.** We don't access restricted databases (criminal records, credit reports). We aggregate publicly available web information only.
- **Not a real-time surveillance tool.** We build point-in-time snapshots, not continuous monitoring (monitoring may come later as P2).
- **Not a social media management tool.** We read social platforms for research; we don't post or interact.
- **Not a chatbot / conversational AI.** We present structured results, not prose answers. Users don't "talk" to GenSearch — they search and browse results.
- **No dark web or restricted sources.** Only publicly accessible web content.
- **No login-gated content** in Phase 1. We only access content available without authentication (except public APIs with our own credentials).
- **No automated outreach or contact.** We find information; we never send emails, messages, or connection requests on behalf of the user.

---

## 5. User Personas

### Persona 1: "The Recruiter" — Sarah, Tech Recruiting Lead

- **Context:** Evaluates 50+ candidates/week. Needs to quickly understand a candidate's full background beyond their LinkedIn.
- **Pain:** LinkedIn profiles are curated and incomplete. Wants to find GitHub contributions, conference talks, blog posts, open-source involvement, publications — scattered across dozens of sites.
- **Need:** Enter a name + company → get a comprehensive technical profile with all public web presence aggregated.
- **Success:** "I found that the candidate gave a talk at a conference about exactly the technology we need — something that wasn't on their LinkedIn at all."

### Persona 2: "The Journalist" — Marcus, Investigative Reporter

- **Context:** Researches public figures and organizations. Needs to build detailed profiles and discover connections.
- **Pain:** Manually clicks through dozens of search results, follows links in articles, cross-references names across documents. Extremely time-consuming.
- **Need:** Enter a name → discover all public mentions, affiliations, co-occurrences with other entities, corporate filings, published works.
- **Success:** "The tool followed a link from a board meeting minutes PDF to a related company's page, where it found a connection I wouldn't have discovered for hours."

### Persona 3: "The Salesperson" — Priya, Enterprise Account Executive

- **Context:** Prepares for sales meetings by researching prospects. Needs talking points and common ground.
- **Pain:** Spends 20+ minutes per prospect stitching together LinkedIn, company page, news mentions, podcast appearances.
- **Need:** Enter a name + company → get a profile with recent activity, interests, public statements, and career trajectory.
- **Success:** "I opened the prospect's GenSearch profile 5 minutes before the call and knew they were passionate about sustainability — it completely changed my pitch."

### Persona 4: "The Sourcer" — Kai, Venture Capital Associate

- **Context:** Researches potential founders and technical talent for portfolio companies. Needs to discover people who match specific criteria, not just look up known names.
- **Pain:** Spends hours crawling team pages, conference speaker lists, GitHub trending repos, and news articles to build sourcing lists. LinkedIn Recruiter is expensive and only searches its own database. No tool lets them search "ex-Stripe engineers who started fintech companies in the last 2 years."
- **Need:** Enter criteria → get a list of people matching those criteria with evidence, ranked by relevance. Click any person to deep-search.
- **Success:** "I typed 'AI researchers at top universities publishing on multimodal models' and got 25 candidates with links to their papers in under 3 minutes. I deep-searched the top 5 and had full profiles before my partner meeting."

---

## 6. Functional Requirements

### FR-001: Search Initiation (Two Modes)

**Priority:** P0

The system supports two search modes via a unified interface:

**Mode 1 — Person Search (name-based):**
- **Required:** Full name (text input)
- **Optional:** Freeform context string — any additional information the user knows (company, location, role, school, etc.) entered as plain text
- **Behavior:** Searches for a specific person. The system extracts disambiguating signals from the freeform context using keyword matching against crawled data. A name alone must still work.

**Mode 2 — Criteria Search (discovery):**
- **Required:** Freeform criteria description (e.g., "Ex-Google engineers building AI startups", "Stanford CS professors publishing on LLMs")
- **Optional:** Result count preference (default: 20, range: 5-100)
- **Behavior:** Discovers multiple people matching the criteria from live web sources. Uses a two-phase workflow:
  - **Phase 1 — Discovery:** Crawl broadly to find candidate people, build light profiles, rank by criteria match. Fast and cheap (~$1-2).
  - **Phase 2 — Deep Search:** User reviews candidates and selects which ones to deep-crawl for full profiles. Each deep search is a standard person search (~$0.25-0.50).

**Design rationale:** Criteria search is fundamentally different from person search — it optimizes for breadth (finding many people) rather than depth (fully profiling one person). The two-phase approach lets users control cost: discovery is cheap, and deep-crawl is only spent on candidates they care about.

**Acceptance criteria:**
- System accepts either a name (person mode) or criteria text (criteria mode)
- Mode is auto-detected or explicitly toggled by the user
- Person search begins within 2 seconds of submission
- Criteria search shows first candidates within 30 seconds
- Context/criteria keywords are used to improve entity disambiguation and criteria matching

---

### FR-002: AI-Guided Recursive Crawling Engine

**Priority:** P0

The core differentiator. The system must crawl beyond depth-1:

**Crawl strategy: Adaptive Research Loop**

The engine replicates how a human researcher actually works — not "gather everything then read", but a continuous loop of **search → read → learn → pivot → search again**. Every few pages, the system reflects on what it has learned and decides whether to keep following links or go back to the search engine with better queries.

1. **Seed phase:** Issue 3-5 diverse search queries from seed info. Retrieve top results.
2. **Crawl-and-learn loop:** For each page fetched:
   - Extract structured data (names, role, company, education, etc.)
   - Score outbound links using LLM (informed by what's known + what's missing)
   - Follow highest-scored links
3. **Adaptive query regeneration (every N pages):** Periodically, the system evaluates what it has learned and generates new search queries:
   - **Trigger:** Every 5 pages, or when a high-value fact is discovered (e.g., a new name variant, employer, or affiliation)
   - **LLM assessment:** Given all facts found so far + remaining gaps, the LLM decides: (a) what new search queries would help fill gaps, and (b) whether to continue link-following or pivot to new searches
   - **Examples:** Discovers the person goes by "James" not "Jim" → searches `"James Chen" engineer`. Learns they co-founded "Acme AI" → searches `"Acme AI" founder team`. Finds their PhD advisor → searches the advisor's lab page for more context.
   - **Budget:** New queries consume from the same page budget. The system balances search API calls vs. link-following based on information gain.
4. **Diminishing returns detection:** If the last N pages yielded < 2 new facts, stop crawling. This applies regardless of whether facts came from link-following or new search queries.
5. **Termination:** Page budget exhausted, max depth reached, diminishing returns, or all gaps filled.

**Why this matters:** A static query list misses information that's only discoverable after learning something from crawling. A human researcher constantly refines their search terms — GenSearch does the same.

**Link scoring signals (weighted):**
| Signal | Weight | Description |
|---|---|---|
| Anchor text relevance to target person | 0.25 | Does the link text mention the person or related entities? |
| URL pattern | 0.20 | `/about`, `/team`, `/people`, `/author` patterns score high |
| Source page quality | 0.15 | High-quality source pages link to high-quality destinations |
| Domain reputation | 0.15 | LinkedIn, GitHub, university domains score higher |
| Content type prediction | 0.15 | Prefer profiles, bios, articles over generic pages |
| Depth penalty | 0.10 | Gentle penalty for deeper links to prevent rabbit holes |

**Budget controls:**
- Per-domain cap: max 10 pages from any single domain (forces diversity)
- Total page budget: configurable, default 100 pages
- Cost cap: configurable, default $0.50 per search
- Time cap: configurable, default 5 minutes

**Acceptance criteria:**
- System traverses at least 3 hops deep on average
- System visits pages from ≥ 5 distinct domains per search
- System generates ≥ 1 new search query mid-crawl based on discovered information (on average)
- Query regeneration decisions and reasoning are logged for transparency
- System terminates gracefully when budget is exhausted
- All crawl decisions are logged for debugging/transparency

---

### FR-003: Multi-Source Content Extraction

**Priority:** P0

For each crawled page, extract structured information:

**Extraction pipeline:**
1. **Fetch (3-tier fallback):**
   - **Tier 1:** Direct HTTP request + Mozilla Readability + Turndown (free, fast, ~90% of pages)
   - **Tier 2:** Jina Reader API (`r.jina.ai`) — if Tier 1 returns minimal content (<100 chars) indicating JS rendering needed. Returns clean markdown with JS rendering handled. (~$0.001/page)
   - **Tier 3:** Playwright headless browser — for sites that block both HTTP and Jina. Most expensive, reserved for ~5% of pages.
2. **Clean:** If fetched via Tier 1, strip navigation/ads/boilerplate using Readability. Tiers 2-3 return pre-cleaned content.
3. **Extract:** Use LLM (Claude Haiku — fast/cheap model) to extract structured data:
   - Person name variants
   - Job title and company
   - Location
   - Education
   - Skills/expertise
   - Social profile links
   - Email/phone (if publicly listed)
   - Relationships to other people/organizations
   - Dates (employment dates, publication dates)
4. **Store:** Raw page snapshot (S3/R2) + extracted structured data (PostgreSQL) + source URL + fetch timestamp.

**Acceptance criteria:**
- Extraction handles both static HTML and JS-rendered pages
- Each extracted data point links back to its source URL and page location
- Extraction accuracy ≥ 90% (measured against human-labeled test set)

---

### FR-004: Entity Resolution & Disambiguation

**Priority:** P0

Given extracted data from many pages, determine which mentions refer to the same person — and which refer to different people with the same name.

**Three-layer approach:**

**Layer 1 — Similarity graph construction:**
- Build a pairwise similarity graph over all mentions (nodes = mentions, edges = similarity)
- **Name similarity**: Jaro-Winkler distance between all name variants (capped at 5 per mention), handling typos and format differences
- **Context similarity**: TF-IDF cosine similarity over mention context (title, company, location, education, skills, bio, relationships). This catches semantic matches that keyword overlap misses — e.g., "Software Engineer at Alphabet" matching a query context of "Google engineer"
- **Combined score**: `0.4 × name_similarity + 0.6 × context_similarity` — context is weighted higher because names are ambiguous but context disambiguates
- Only mentions with name similarity ≥ 0.7 generate edges (blocking threshold)
- TF vectors are precomputed once per mention for O(1) reuse in pairwise comparisons
- Safety guard: if mention count exceeds 500, truncate to top-confidence mentions to cap O(N²)

**Layer 2 — Graph clustering (Union-Find + Leiden-inspired splitting):**
- Find connected components using Union-Find with rank-based union (threshold: combined score ≥ 0.35)
- **Leiden-inspired cohesion check**: for each cluster, compute average internal edge weight. If below 0.45, re-cluster with the higher threshold. This prevents the over-linking problem where one weak false-positive link merges two real people into one cluster
- Edge index pre-built for O(E)-total internal edge lookup across all clusters

**Layer 3 — Target scoring + LLM disambiguation:**
- Score each cluster against the search query using TF-IDF cosine similarity between the query context and the cluster's best mention
- When user provides context, threshold for "primary target" is raised (0.45 vs 0.35 without context). Mentions matching the name but NOT the context are penalized (-0.15)
- **Ambiguous clusters** (between thresholds) are sent to the LLM for pairwise disambiguation against the best primary cluster
- When context is provided, only primary-target clusters are returned to the user — non-matching same-name clusters are filtered out as noise

**Output:** Each search produces 1 or more `PersonProfile` objects. When context is provided, typically returns only the matching person. Without context, returns all disambiguated profiles.

**Acceptance criteria:**
- Correctly separates ≥ 90% of same-name-different-person cases (tested on a curated dataset of common names)
- Correctly merges ≥ 95% of same-person-different-source mentions
- Context-aware: when user provides context like "John Smith, Google engineer", does NOT return profiles of other John Smiths who don't match
- Disambiguation reasoning is transparent and explainable to the user

---

### FR-005: Profile Building & Confidence Scoring

**Priority:** P0

Merge all extracted and resolved data into a unified person profile.

**Profile schema core fields:**
- Names (with variants)
- Current role (title + company)
- Past roles (with dates)
- Education (institution, degree, field, year)
- Locations (current + past)
- Skills/expertise
- Social profiles (LinkedIn, GitHub, Twitter/X, etc.)
- Contact info (publicly available email/phone)
- Publications / talks / media mentions
- Key associations (companies, organizations, co-authors)

**Confidence scoring per field:**
```
confidence = source_reliability × corroboration_boost × recency_decay × consistency_factor
```

Where:
- `source_reliability`: LinkedIn profile = 0.9, company page = 0.85, news article = 0.7, blog mention = 0.4
- `corroboration_boost`: min(1.0, 0.5 + 0.15 × num_independent_sources)
- `recency_decay`: exp(-0.1 × years_since_observation)
- `consistency_factor`: 1.0 if consistent with other data, 0.7 if minor conflict, 0.3 if major conflict

**Conflict resolution:**
- For single-valued fields (current title): highest confidence wins, conflicts flagged
- For multi-valued fields (skills, past roles): union with deduplication
- All conflicts are stored and visible to the user

**Acceptance criteria:**
- Every data point has a confidence score (0-1)
- Every data point links to ≥ 1 source URL
- User can click any field to see all sources and confidence breakdown
- Profile renders within 1 second of search completion

---

### FR-006: Search Interface & Real-Time Progress

**Priority:** P0

**Search input (unified):**
- Mode toggle: "Find a person" (default) vs "Find people matching criteria"
- **Person mode:** Name field + optional freeform context
- **Criteria mode:** Single large text input for criteria description + result count slider (5-100)
- Auto-detection: if input doesn't look like a name (e.g., "engineers at Google who..."), suggest switching to criteria mode

**Real-time progress display (via SSE):**
- Pages crawled / budget remaining
- Domains visited (shown as icons/badges)
- Entities/candidates discovered (running count)
- Current crawl activity (which URL is being fetched)
- Estimated time remaining

**Results display — Person mode:**
- Profile card with photo (if found), name, current role, location
- Confidence indicator per field (green/yellow/red)
- Source attribution (click any data point → see source URLs)
- Timeline view of career history
- Cluster graph visualization showing how mentions were grouped into profiles
- "Sources" panel showing all crawled pages with relevance scores
- If multiple people found: card selector to switch between profiles

**Results display — Criteria mode:**
- **Candidate list view:** Table/cards of discovered people ranked by criteria match score
- Each candidate shows: name, current role, match score, key evidence snippet, source count
- Checkbox selection for deep-search
- "Deep search selected" button to trigger Phase 2 on chosen candidates
- Deep-searched candidates expand into full profile cards inline
- Export candidate list as CSV

**Acceptance criteria:**
- Real-time updates appear within 500ms of server events
- Profile card loads progressively (initial results in < 30s, enrichment continues)
- Mobile-responsive layout
- Accessible (WCAG 2.1 AA)

---

### FR-007: Social Platform Support

**Priority:** P1

Specific integrations for structured data extraction from major platforms:

| Platform | Method | Data Extracted |
|---|---|---|
| LinkedIn | Proxycurl API ($0.01/profile) | Full professional profile, experience, education, skills |
| GitHub | REST API (free, 5K req/hr) | Repos, contributions, languages, README bio, organizations |
| Twitter/X | API v2 (Basic tier) | Bio, recent tweets, follower count, interests |
| Google Scholar | Web scraping | Publications, citations, h-index, co-authors |
| Crunchbase | API | Founder/exec roles, company funding data |

**Acceptance criteria:**
- When a social profile URL is discovered during crawling, the system fetches structured data via the appropriate API
- Social data is merged into the unified profile with proper confidence scoring
- Rate limits are respected; fallback to web scraping if API is unavailable

---

### FR-008: Search History & Profile Persistence

**Priority:** P1

- All searches and resulting profiles are saved
- Users can re-search a profile to trigger incremental enrichment (only fetch new/changed sources)
- Search history is searchable and sortable
- Profiles can be exported as JSON, CSV, or PDF

---

### FR-009: General Research Mode

**Priority:** P1

Beyond people search, GenSearch supports open-ended topic research using the same recursive crawling engine.

**Input:** Natural language query (e.g., "What startups are building AI-powered legal tools?" or "Compare serverless database options in 2026")

**Behavior:**
1. Issue diverse search queries derived from the input
2. Crawl results recursively, following links to primary sources, comparisons, case studies
3. Extract structured findings: entities mentioned, claims with sources, comparisons, timelines
4. Synthesize into a structured research report with source attribution

**Output format:**
- Executive summary (3-5 key findings)
- Detailed findings organized by theme/subtopic
- Entity list (companies, people, products discovered)
- Source list with relevance scores
- Knowledge gaps identified (what couldn't be found)

**How it differs from Perplexity Deep Research:**
- Structured, exportable output (not just prose)
- Transparent crawl trail (user sees every page visited and why)
- Deeper crawling with configurable budget (Perplexity caps at ~30 searches)
- Persistent results that can be incrementally updated

**Acceptance criteria:**
- Accepts free-form text queries
- Produces a structured report with ≥ 10 sourced findings from ≥ 5 domains
- All claims link to source URLs
- Report renders progressively as crawling proceeds

---

### FR-010: Batch / Bulk Search

**Priority:** P1

For power users (recruiters, sales teams), support searching multiple people in a single session.

**Input:** CSV upload or manual list of names + optional seed fields

**Behavior:**
- Queue all searches and run concurrently (respecting global rate limits)
- Shared crawl cache: if Person A's search discovers a team page listing Person B, reuse that data
- Progress dashboard showing status of each search in the batch
- Cost estimate before execution ("This batch will cost approximately $X")

**Output:** Downloadable CSV/JSON with all profiles, or browse individually in the UI

**Acceptance criteria:**
- Accepts CSV with columns: name (required), context (optional freeform)
- Handles batches of up to 100 people
- Displays per-person status (queued / crawling / complete / failed)
- Exports combined results as CSV or JSON

---

### FR-011: API / SDK Access

**Priority:** P2

Programmatic access for developers and integration into existing workflows.

**Endpoints:**
- `POST /api/v1/search/person` — initiate a people search
- `POST /api/v1/search/criteria` — initiate a criteria-based people discovery
- `POST /api/v1/search/criteria/:id/deep-search` — trigger deep search on selected candidates
- `POST /api/v1/search/topic` — initiate a general research search
- `GET /api/v1/search/:id` — poll search status and get results
- `GET /api/v1/search/:id/stream` — SSE stream of real-time progress
- `POST /api/v1/batch` — submit a batch search
- `GET /api/v1/profiles/:id` — retrieve a stored profile

**Authentication:** API key (issued per user account)

**Rate limits:** Configurable per plan (e.g., 100 searches/day on free tier, 1000/day on pro)

**Acceptance criteria:**
- REST API with OpenAPI 3.1 spec
- API key authentication with per-key rate limiting
- Webhook support for batch completion notifications
- SDK packages for TypeScript and Python

---

### FR-012: Privacy Controls & Data Governance

**Priority:** P0

Since GenSearch aggregates personal information, privacy must be a first-class concern.

**User-facing controls:**
- Opt-out mechanism: any person can request their profile be deleted and their name blocklisted from future searches
- Data retention policy: raw page snapshots auto-expire after 90 days; profiles persist until user deletes
- No profile is publicly accessible — all results are private to the searching user's account

**System-level controls:**
- PII detection: flag and separately secure detected emails, phone numbers, addresses
- Audit log: every search, every page crawled, every profile viewed — logged with user ID and timestamp
- robots.txt compliance: always respect robots.txt directives
- Data minimization: extract only fields defined in the profile schema; do not store full page text beyond the 90-day snapshot window

**Legal considerations (to validate with counsel before launch):**
- GDPR Article 14: when processing EU residents' data, may need to notify data subjects. Research exemptions for publicly available data.
- CCPA: California residents can request deletion. Opt-out mechanism covers this.
- Terms of service: clearly disclaim that GenSearch aggregates publicly available information only.

**Acceptance criteria:**
- Opt-out endpoint: `POST /api/v1/optout` accepts name + email, immediately blocklists
- Audit log is immutable and queryable by admin
- Raw snapshots are auto-deleted after 90 days (verified by automated test)
- robots.txt is checked before every crawl request

---

### FR-013: Criteria-Based People Discovery

**Priority:** P1

Discover multiple people matching user-defined criteria from live web sources.

**Input:**
- Natural language criteria: "Ex-Google engineers who started AI companies", "Female VCs investing in climate tech", "Researchers at MIT working on robotics"
- Result count preference: 5-100 (default: 20)
- Optional filters: geography, recency ("in the last 2 years"), seniority level

**Two-Phase Architecture:**

**Phase 1 — Discovery (automated, ~$1-2):**

1. **Criteria decomposition:** LLM parses the freeform criteria into structured signals:
   ```json
   {
     "keywords": ["Google", "engineer", "AI", "startup"],
     "required_traits": ["previously worked at Google", "currently at a startup or founded one"],
     "nice_to_have": ["AI/ML focus", "technical background"],
     "search_strategies": [
       "\"ex-Google\" founder AI startup",
       "site:linkedin.com \"Google\" \"founder\" artificial intelligence",
       "YC companies founded by Google alumni",
       "\"former Google engineer\" startup"
     ]
   }
   ```

2. **Broad crawl:** Issue 5-10 diverse search queries. Crawl results with higher page budget and lower depth than person search. Prioritize pages that list multiple people:
   - Team/about pages
   - Conference speaker lists
   - Award/fellowship recipient lists
   - News articles mentioning multiple people
   - LinkedIn search result pages (via Serper)
   - GitHub org member pages

3. **Multi-person extraction:** Instead of extracting data about one target, extract ALL people mentioned on each page along with any matching criteria signals:
   ```json
   {
     "people_found": [
       {
         "name": "Jane Chen",
         "title": "CEO & Co-founder",
         "company": "NovAI",
         "criteria_match": {
           "previously_at_google": true,
           "evidence": "Former Senior Engineer at Google Brain (2018-2022)",
           "match_score": 0.92
         },
         "source_url": "https://example.com/team"
       }
     ]
   }
   ```

4. **Candidate ranking:** Score each discovered person by:
   - `criteria_match_score`: How well they match stated criteria (0-1)
   - `evidence_strength`: How many sources corroborate the match (0-1)
   - `profile_completeness`: How much data was found (0-1)
   - Combined: `rank = criteria_match * 0.5 + evidence_strength * 0.3 + completeness * 0.2`

5. **Deduplication:** Merge mentions of the same person across pages (reuses entity resolution from FR-004).

**Phase 1 Output — Candidate List:**
- Ranked list of discovered people with light profiles
- Each candidate shows: name, current role, criteria match score, key evidence snippet, source URLs
- User can select individual candidates for Phase 2 deep search

**Phase 2 — Deep Search (user-triggered, ~$0.25-0.50 per person):**
- User selects one or more candidates from the discovery list
- System runs a standard person search (FR-001 Mode 1) on each selected candidate
- Results displayed as full profile cards with cluster graph
- Can run multiple deep searches concurrently

**Budget controls for criteria search:**
- Discovery page budget: configurable, default 50 pages (higher than person search since breadth matters more)
- Discovery cost cap: $2.00 default
- Max candidates to return: user-configurable (5-100, default 20)
- Deep search budget: same as standard person search ($0.50 per person)

**Key difference from batch search (FR-010):**
Batch search takes a known list of names and searches each one. Criteria search *discovers* the names from scratch — the user doesn't know who they're looking for yet.

**Acceptance criteria:**
- Accepts freeform criteria text and returns a ranked list of matching people
- Discovery phase completes within 3 minutes for default settings
- Each candidate includes at least one evidence snippet explaining why they match
- Discovered candidates can be deep-searched with one click
- Cost of discovery phase stays under $2 for default settings
- Deduplication correctly merges the same person found across multiple sources

---

## 7. Error Handling & Edge Cases

### Crawl Failures
| Scenario | Handling |
|---|---|
| Page returns 403/429 | Log, skip, do not retry immediately. Mark domain as rate-limited. Try alternative URLs for same content. |
| Page hangs / timeout (>15s) | Kill fetch, skip URL, continue crawl. Log for analysis. |
| Playwright crashes | Restart browser context. Retry page once. If fails again, fall back to Jina Reader API. |
| Search API returns 0 results | Try alternative search API. If all fail, broaden query (remove constraints). Inform user if no results found. |
| All sources blocked | Return partial profile with explanation: "Limited results — many sources blocked automated access." |
| LLM API timeout (>30s) | Abort, retry with exponential backoff (up to 2 retries). If all fail, skip that extraction step and continue crawl. |
| LLM rate limit (429) or server error (5xx) | Exponential backoff retry (2 attempts max). Circuit breaker if error rate exceeds threshold. |
| LLM returns malformed JSON | Zod schema validation rejects the response; return null/empty and continue. Never trust raw `JSON.parse` output. |
| LLM returns out-of-range scores | All numeric fields (confidence, matchScore, score) clamped to [0, 1] via Zod transform. NaN defaults to 0. |
| Crawl event log grows too large | Ring buffer caps at 500 events (first 50 + most recent 449). Prevents memory bloat during long crawls. |
| Known facts summary exceeds LLM context | Capped at 2000 characters to prevent prompt overflow and cost explosion. |

### Entity Resolution Edge Cases
| Scenario | Handling |
|---|---|
| Very common name, no disambiguating seeds | Present top 3-5 candidate profiles with clear labels ("John Smith — Engineer at Google, SF" vs "John Smith — Attorney, Chicago"). Let user select. |
| Person has changed name (marriage, legal change) | Cross-link name variants when discovered. Surface both names in profile. |
| Person has very little web presence | Return what's found with honest confidence scores. Flag "Low coverage — limited public information found." |
| Extracted data contradicts itself | Store both values, flag conflict, show both to user with sources. Never silently pick one. |

### Criteria Search Edge Cases
| Scenario | Handling |
|---|---|
| Criteria too vague ("find people") | Ask user to be more specific. Suggest example queries. Do not proceed with overly broad criteria. |
| Criteria too narrow (0 candidates found) | Broaden search queries progressively. Remove least important constraints. Report "No candidates found matching all criteria — try broadening." |
| Same person found on many pages | Entity resolution deduplicates. Show highest-ranked mention with "found on N sources" badge. |
| Criteria match is ambiguous (e.g., "worked at Google" but unclear if full-time, intern, or contractor) | Include the candidate with a lower match score and flag the ambiguity in the evidence snippet. Let the user decide. |
| Very large result set (>100 candidates before filtering) | Apply criteria match threshold (default ≥ 0.5), return top N by score. Show "X additional candidates below threshold" notice. |

### Budget & Cost Edge Cases
| Scenario | Handling |
|---|---|
| Search hits cost cap before completing | Stop gracefully. Return partial results. Show "Search stopped — budget limit reached. Increase budget to continue." |
| Single page yields enormous outbound links (>500) | Cap link scoring to top 50 by URL pattern heuristics before sending to LLM. |
| Crawl enters an infinite redirect loop | Track redirect chains. Cap at 5 redirects per URL. Blocklist looping domains. |
| Duplicate content across URLs (mirrors, syndication) | Content-hash deduplication. If two pages have >90% similar text, treat as same source. |

---

## 8. Prompt Engineering Specifications

### Link Scoring Prompt (Claude Haiku / GPT-4o-mini)

```
You are a web research assistant evaluating which links on a page are worth following.

RESEARCH TARGET: {query_description}
CURRENT PAGE URL: {current_url}
INFORMATION FOUND SO FAR: {summary_of_known_facts}
INFORMATION STILL NEEDED: {gaps_list}

Below are links found on this page. For each, provide a relevance score (0.0-1.0)
and one-line reason.

LINKS:
{links_with_anchor_text_and_url}

Return JSON array:
[{"url": "...", "score": 0.0-1.0, "reason": "..."}]

Scoring guidance:
- 0.8-1.0: Likely contains direct information about the target (profile pages, bios, about pages)
- 0.5-0.7: May contain relevant information (articles mentioning target, related org pages)
- 0.2-0.4: Tangentially related (industry pages, general topic pages)
- 0.0-0.1: Irrelevant (ads, unrelated navigation, generic links)

Only return links scoring ≥ 0.3. Maximum 20 links.
```

### Adaptive Query Regeneration Prompt (Claude Haiku)

```
You are a research strategist deciding how to continue a web investigation.

TARGET: {query_description}
PAGES CRAWLED SO FAR: {pages_visited}
FACTS DISCOVERED:
{known_facts_summary}

INFORMATION STILL MISSING:
{gaps_list}

FRONTIER: {frontier_size} links queued (best score: {best_frontier_score})

Should we generate new search queries based on what we've learned? Or keep following links?

Return ONLY JSON:
{
  "action": "generate_queries" | "continue_crawling" | "both",
  "reasoning": "Why this action makes sense given what we know and don't know",
  "new_queries": ["query1", "query2"],
  "stop_crawling": false
}

Rules:
- Generate new queries if you learned something that changes how you'd search
  (new name variant, new company, new affiliation, new keyword)
- "continue_crawling" if the frontier has promising links and gaps are being filled
- "both" if you want to search AND keep following links
- Set "stop_crawling" to true ONLY if the profile seems complete
- New queries should be DIFFERENT from what we already searched — use newly learned facts
- Maximum 3 new queries per call
- Each query should target a specific gap in knowledge
```

### Entity Extraction Prompt (Claude Haiku)

```
Extract structured person data from the following page content.
Only extract information that is explicitly stated — do not infer or guess.

TARGET PERSON: {name} {optional_context}
PAGE URL: {url}
PAGE CONTENT:
{cleaned_markdown_content}

Return JSON:
{
  "mentions_target": true/false,
  "confidence_this_is_target": 0.0-1.0,
  "extracted": {
    "names": ["Full Name as written"],
    "title": "Job Title",
    "company": "Company Name",
    "location": "City, State/Country",
    "education": [{"institution": "...", "degree": "...", "year": null}],
    "skills": ["skill1", "skill2"],
    "social_links": [{"platform": "...", "url": "..."}],
    "email": null,
    "phone": null,
    "bio_snippet": "Brief relevant quote from page",
    "relationships": [{"name": "...", "relationship": "co-author/colleague/etc"}],
    "dates": [{"event": "joined company", "date": "2023-01"}]
  }
}

Rules:
- Set "mentions_target" to false if this page doesn't mention the target person
- Leave fields as null if not found — never fabricate data
- "confidence_this_is_target" reflects how certain you are this mention is the
  specific person we're searching for (vs. a different person with the same name)
```

### Entity Disambiguation Prompt (Claude Sonnet — used for ambiguous cases)

```
You are resolving whether two web mentions refer to the same person.

MENTION A:
- Source: {url_a}
- Name: {name_a}
- Title: {title_a}
- Company: {company_a}
- Location: {location_a}
- Other details: {other_a}

MENTION B:
- Source: {url_b}
- Name: {name_b}
- Title: {title_b}
- Company: {company_b}
- Location: {location_b}
- Other details: {other_b}

Are these the same person? Respond with JSON:
{
  "same_person": true/false/null,
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of why you believe they are/aren't the same person"
}

Use null for "same_person" if genuinely impossible to determine.
```

### Criteria Decomposition Prompt (Claude Haiku)

```
You are parsing a people search criteria into structured signals for web search.

USER CRITERIA: {criteria_text}

Decompose into JSON:
{
  "keywords": ["key terms for search queries"],
  "required_traits": ["traits a person MUST have to match"],
  "nice_to_have": ["traits that boost relevance but aren't required"],
  "search_queries": [
    "5-10 diverse Google search queries to find people matching these criteria",
    "Include site-specific queries (site:linkedin.com, site:github.com, etc.)",
    "Include queries targeting list pages (team pages, speaker lists, award pages)",
    "Vary phrasing to maximize coverage"
  ],
  "page_types_to_prioritize": ["team pages", "speaker lists", "news articles", etc.],
  "exclusion_signals": ["signals that indicate a page/person does NOT match"]
}

Rules:
- Generate diverse search queries — vary keywords, site operators, and phrasing
- Include at least 2 queries targeting pages that list multiple people
- Be specific in required_traits — break vague criteria into testable conditions
- exclusion_signals help avoid false positives (e.g., if criteria is "founders", exclude "employee at" without leadership signals)
```

### Multi-Person Extraction Prompt (Claude Haiku)

```
Extract ALL people mentioned on this page who might match the search criteria.
Do not limit to one person — extract every person you find.

SEARCH CRITERIA: {criteria_text}
REQUIRED TRAITS: {required_traits}
PAGE URL: {url}
PAGE CONTENT:
{cleaned_markdown_content}

Return JSON:
{
  "people_found": [
    {
      "name": "Full Name",
      "title": "Job Title or null",
      "company": "Company or null",
      "location": "Location or null",
      "criteria_evidence": "Specific text from the page proving/suggesting they match the criteria",
      "match_score": 0.0-1.0,
      "match_reasoning": "Why this person does or doesn't match",
      "additional_facts": {
        "education": "if mentioned",
        "skills": ["if mentioned"],
        "social_url": "if found"
      }
    }
  ],
  "page_mentions_count": 0
}

Rules:
- Extract EVERY person mentioned, even if they only partially match
- Set match_score based on how well the criteria_evidence supports the required_traits
- match_score >= 0.7: strong match with clear evidence
- match_score 0.4-0.7: partial match or ambiguous evidence
- match_score < 0.4: weak match, include anyway for completeness
- criteria_evidence must be a direct quote or close paraphrase from the page — never fabricate
- If the page lists many people (e.g., a team page), extract up to 30 most relevant
```

### Candidate Ranking Prompt (Claude Haiku)

```
You are ranking discovered candidates by how well they match search criteria.

SEARCH CRITERIA: {criteria_text}
REQUIRED TRAITS: {required_traits}

CANDIDATES (with evidence from multiple sources):
{candidates_with_merged_evidence}

For each candidate, provide a final relevance score and one-line summary:
[
  {
    "name": "...",
    "final_score": 0.0-1.0,
    "summary": "One-line description of who they are and why they match",
    "evidence_quality": "strong" | "moderate" | "weak",
    "missing_info": ["what we'd need to verify to be more confident"]
  }
]

Rules:
- Rank by how well ALL required_traits are satisfied
- Penalize candidates where evidence is from a single source
- Boost candidates corroborated by multiple independent sources
- Flag candidates where match depends on an assumption
```

### General Research Synthesis Prompt (Claude Sonnet)

```
You are synthesizing research findings from multiple web sources into a structured report.

RESEARCH QUERY: {query}
SOURCES AND EXTRACTED CONTENT:
{numbered_list_of_sources_with_content}

Produce a structured report:
{
  "executive_summary": "3-5 sentence overview of key findings",
  "themes": [
    {
      "theme": "Theme Name",
      "findings": [
        {"claim": "...", "source_ids": [1, 3], "confidence": 0.0-1.0}
      ]
    }
  ],
  "entities_discovered": [
    {"name": "...", "type": "company/person/product", "relevance": "..."}
  ],
  "knowledge_gaps": ["What couldn't be determined from available sources"],
  "contradictions": [
    {"claim_a": "...", "source_a": 1, "claim_b": "...", "source_b": 4}
  ]
}

Rules:
- Every claim must cite at least one source by ID
- Flag contradictions explicitly — do not silently resolve them
- Confidence reflects how well-supported a claim is across sources
- Knowledge gaps should suggest what additional searches might fill them
```

---

## 9. Implementation Phases

### Phase 1: Core Search Engine (Weeks 1-4)

**Goal:** End-to-end pipeline from name input → deep crawl → basic profile

**Deliverables:**
- Search API integration (Serper primary + Brave secondary)
- Recursive crawl engine with priority queue and LLM-guided link scoring
- 3-tier content fetching (HTTP + Readability → Jina Reader API → Playwright) with LLM extraction
- Entity resolution with TF-IDF cosine similarity + Jaro-Winkler name matching + graph-based clustering
- PostgreSQL schema for profiles and sources
- Privacy foundation: robots.txt compliance, audit logging, opt-out endpoint (FR-012)
- Minimal web UI: search input + profile card + source list

**Dependencies:** None (greenfield)

**Exit criteria:** Given "Jane Doe, engineer at Stripe", produces a profile with ≥ 5 verified data points from ≥ 3 sources, with correct entity disambiguation.

---

### Phase 2: Smart Crawling, Criteria Search & Disambiguation (Weeks 5-8)

**Goal:** Production-quality crawling intelligence, entity resolution, and criteria-based people discovery

**Deliverables:**
- Playwright fallback for JS-rendered pages
- Per-domain rate limiting and politeness controls
- Production-hardened entity resolution: Union-Find clustering with Leiden-inspired cohesion splitting, context-aware scoring, LLM adjudication for ambiguous cases
- Confidence scoring system
- Crawl budget management (page cap, cost cap, time cap, diminishing returns detection)
- Real-time progress streaming (SSE)
- Profile diff/merge for incremental re-searches
- Error handling for all crawl failure modes (Section 7)
- **Criteria search — discovery phase (FR-013):** criteria decomposition, multi-person extraction, candidate ranking, deduplication
- **Criteria search — UI:** mode toggle, candidate list view, deep-search trigger
- General research mode — topic-based search (FR-009)

**Dependencies:** Phase 1 complete

**Exit criteria:** System correctly disambiguates "John Smith" (common name) with only name + city as input ≥ 85% of the time. Crawl stays within budget and terminates gracefully. Criteria search for "ex-Google AI engineers" returns ≥ 10 verified candidates with ≥ 70% precision. General research mode produces structured report for topic queries.

---

### Phase 3: Social Integrations & Polish (Weeks 9-12)

**Goal:** Structured social platform data + production-ready UI

**Deliverables:**
- Proxycurl integration (LinkedIn profiles)
- GitHub API integration
- Twitter/X API integration
- Google Scholar scraper
- Polished frontend: profile timeline, confidence breakdown, source panel, graph visualization
- Search history and profile persistence (FR-008)
- Batch/bulk search (FR-010)
- Export (JSON, CSV, PDF)
- User authentication and rate limiting

**Dependencies:** Phase 2 complete

**Exit criteria:** Full profile accuracy ≥ 85% on a 100-person test set. UI is usable by non-technical users. Batch search handles 50+ people in a single run.

---

### Phase 4: Scale, API & Optimize (Weeks 13-16)

**Goal:** Cost optimization, API access, performance, and reliability

**Deliverables:**
- BullMQ job queue for async crawling at scale
- Caching layer (Redis) for LLM responses, page content, search results
- REST API with OpenAPI spec + TypeScript/Python SDKs (FR-011)
- Cost tracking dashboard (per-search cost breakdown)
- Monitoring and alerting (crawl failures, API errors, budget overruns)
- Rate limiting and abuse prevention for the platform
- Fine-tuned small model for link scoring (replace LLM calls for cost reduction)
- PII detection and data retention automation (FR-012 completion)

**Dependencies:** Phase 3 complete

**Exit criteria:** Average search cost < $0.50. System handles 100 concurrent searches. 99.5% uptime. API serves external developers.

---

## 10. Technical Architecture

### Search & Fetching API Strategy

GenSearch uses a **layered approach** — different APIs for different jobs, chosen after evaluating Serper, Brave, SerpAPI, Tavily, Exa, and Jina AI:

#### Search API Comparison (evaluated)

| API | Cost/Search | Free Tier | Index Source | Verdict |
|---|---|---|---|---|
| **Serper** | ~$0.001 ($50/50K) | 2,500 one-time | Real Google results | **Primary search — best value, highest quality** |
| **Brave Search** | ~$0.003 ($5/20K) | 2,000/month | Independent index (own crawler) | **Secondary search — catches what Google misses** |
| **SerpAPI** | ~$0.01 ($50/5K) | 100/month | Google + Bing + Yahoo | Skipped — 10x more expensive than Serper for similar results |
| **Tavily** | ~$0.001 ($40+/mo) | 1,000/month | Unknown backend | Skipped — returns pre-digested content; we want raw results + our own extraction |
| **Exa** | ~$0.001-0.003 | Limited credits | Own neural index | Phase 2+ — `find_similar` useful for discovering related profiles |
| **Jina Reader** | Token-based | 20 RPM free | N/A (URL → markdown) | **Content extraction — handles JS, returns clean markdown** |
| **Jina Search** | Token-based | 20 RPM free | Unknown backend | Skipped — unclear index, less reliable than Serper/Brave for discovery |

#### Chosen Layered Architecture

**Layer 1: Search (discovery)**
- **Serper** (primary): Real Google results, Knowledge Panels, "People Also Ask" — goldmines for people data. $0.001/search.
- **Brave** (secondary): Independent index provides source diversity. Discussions endpoint surfaces Reddit/forum mentions valuable for less prominent people. Falls back when Serper results are thin.

**Layer 2: Content Fetching (3-tier fallback)**
```
Tier 1: Direct HTTP fetch + Readability  (free, fast)       — ~90% of pages
Tier 2: Jina Reader API (r.jina.ai)      (cheap, handles JS) — JS-heavy pages, blocked pages
Tier 3: Playwright headless browser       (expensive, local)  — sites that block both
```

**Why Jina Reader as Tier 2 (not Tier 1):**
- Direct HTTP + Readability is free and handles most pages
- Jina Reader handles JS rendering and returns clean markdown, avoiding Playwright overhead
- Much cheaper than running Playwright for every page
- Free tier (20 RPM) sufficient for Phase 1; paid tier scales cheaply
- Playwright reserved for the ~5% of sites that block Jina's crawler

**Layer 3: Enrichment (Phase 2+)**
- **Exa `find_similar`**: Given a person's profile page, find other pages about similar people or by the same person
- **Jina Grounding API**: Fact-check extracted claims against web sources (confidence boosting)

### System Architecture

```
┌─────────────────────────────────────────────────┐
│  Frontend: Next.js 15 + Tailwind + shadcn/ui    │
│  (SSE for real-time crawl progress)             │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  API Layer: Next.js API Routes / tRPC           │
│  (Auth, rate limiting, query parsing, SSE)      │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  Orchestrator: BullMQ + Redis                   │
│  (Priority queue, per-domain rate limits)       │
├─────────────────────────────────────────────────┤
│  Workers:                                       │
│  ├─ Search Worker    (Serper + Brave APIs)       │
│  ├─ Crawl Worker     (HTTP → Jina → Playwright)  │
│  ├─ Extract Worker   (Readability + LLM)         │
│  ├─ Score Worker     (LLM link scoring, Haiku)   │
│  ├─ Entity Worker    (resolution + disambiguation)│
│  └─ Synthesis Worker (profile merge + summary)   │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  Data Layer:                                    │
│  ├─ PostgreSQL (profiles, sources, crawl state) │
│  │   ├─ pgvector (similarity search)            │
│  │   └─ pg_trgm (fuzzy name matching)           │
│  ├─ Redis (queues, cache, dedup, rate limits)   │
│  └─ S3/R2 (raw page snapshots)                  │
└─────────────────────────────────────────────────┘
```

### Key Technology Choices

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node.js) | First-class Playwright support, same lang for frontend/backend, excellent async I/O |
| Framework | Next.js 15 (App Router) | SSR + API routes + server actions in one framework |
| Database | PostgreSQL + pgvector | Flexible JSONB for evolving schemas, vector search for similarity, pg_trgm for fuzzy matching |
| Queue | BullMQ (Redis) | Priority queues, rate limiting, job dependencies — built for this use case |
| Search (primary) | Serper | Best cost/volume ($0.001/search), real Google results, Knowledge Panels + PAA |
| Search (secondary) | Brave Search | Independent index for diversity, discussions endpoint for forum mentions |
| Content fetch (Tier 1) | Direct HTTP + Readability + Turndown | Free, fast, handles ~90% of pages. Clean HTML→markdown without LLM cost |
| Content fetch (Tier 2) | Jina Reader API (r.jina.ai) | Handles JS rendering, returns clean markdown, cheaper than Playwright |
| Content fetch (Tier 3) | Playwright | Last resort for sites blocking HTTP and Jina. Multi-browser, stealth plugin |
| LLM (scoring) | Claude Haiku (configurable via `LLM_MODEL` env var) | Fast, cheap, sufficient for link scoring and entity extraction. All responses validated with Zod schemas. 30s timeout + retry with exponential backoff. |
| LLM (synthesis) | Claude Sonnet | Higher quality for final profile synthesis and ambiguous entity resolution |
| UI Components | shadcn/ui + Tailwind | Professional UI quickly, accessible by default |

---

## 11. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| **Anti-bot detection blocks crawling** | Reduced coverage | High | 3-tier fetch strategy (HTTP → Jina Reader → Playwright). Each tier handles failures the previous can't. Proxy rotation for critical domains. Respect rate limits. |
| **LLM costs exceed budget** | Unsustainable unit economics | Medium | Use cheapest sufficient model (Haiku). Cache LLM responses aggressively. Batch link scoring. Fine-tune small model for scoring in Phase 4. |
| **Entity resolution errors** | Wrong person's data in profile | High | Conservative merge thresholds (prefer false negatives over false positives). LLM adjudication for ambiguous cases. User can manually split/merge profiles. |
| **LinkedIn blocks Proxycurl** | Lose richest data source | Medium | Proxycurl handles this risk. Fallback to web scraping of public LinkedIn pages. Supplement with People Data Labs API. |
| **Legal/privacy concerns** | Regulatory risk | Medium | Only index publicly available information. Provide opt-out mechanism. Consult legal counsel on GDPR/CCPA compliance before launch. No scraping of login-gated content. |
| **Search API rate limits** | Slow searches during peak | Low | Multiple search providers (failover). Request queuing with backpressure. Caching of recent searches. |
| **Criteria search low precision** | Users see irrelevant candidates | Medium | Conservative match thresholds. Require evidence snippets for every candidate. Let users give feedback to improve future queries. |
| **Criteria search cost overrun** | Discovery phase too expensive | Medium | Hard page budget cap on discovery. Prioritize pages listing multiple people (team pages, conference lists). Cache pages across concurrent criteria searches. |
| **Scope creep** | Delayed launch | High | Strict phase gates. Phase 1 = core pipeline only. No social integrations until Phase 3. Criteria search in Phase 2. |

---

## 12. Competitive Differentiation Summary

| Capability | GenSearch | Automatio | Clay | Perplexity | Apollo |
|---|---|---|---|---|---|
| Recursive deep crawling | **Yes (AI-guided, depth 5+)** | No (depth 1) | No (API lookups) | Yes (but unstructured) | No |
| Entity resolution | **Yes (TF-IDF + graph clustering + LLM)** | No | Basic (email match) | Implicit (LLM) | Basic |
| Criteria-based discovery | **Yes (live web, two-phase)** | No | Filters only (pre-indexed DB) | Sort of (unstructured lists) | Filters only |
| Structured profile output | **Yes (scored, attributed)** | No | Yes | No (prose only) | Yes |
| General topic research | **Yes (structured reports)** | No | No | Yes (prose only) | No |
| Live web exploration | **Yes** | Limited | No (pre-indexed) | Yes | No |
| Source attribution | **Yes (every field → URL)** | No | Partial | Yes (citations) | No |
| Batch search | **Yes (CSV upload)** | Manual only | Yes | No | Yes |
| Programmable/API | **Yes (REST + SDKs)** | Yes | Yes | Limited | Yes |
| Privacy controls | **Yes (opt-out, audit log)** | No | Partial | N/A | Partial |
| Cost per person search | **~$0.25-0.50** | ~$0.01 | ~$0.50-2.00 | ~$0.10 | ~$0.05 |
| Cost per criteria search | **~$1-2 discovery + $0.25-0.50/deep** | N/A | ~$0.50-2.00/person | N/A | ~$0.05/person |

---

## Self-Score (100-Point Framework) — v1.3

### AI-Specific Optimization: 25/25
- Clear LLM model assignments per task (Haiku for scoring/extraction, Sonnet for synthesis): +8
- Explicit cost budgets and caching strategy for both search modes: +8
- Full prompt templates for all LLM interactions including criteria search (Section 8): +9

### Traditional PRD Core: 25/25
- Problem statement quantified with criteria search gap analysis: +9
- 4 personas covering all primary use cases (including sourcing): +8
- Goals/metrics are SMART with P0/P1/P2 tiers including criteria metrics: +8

### Implementation Clarity: 29/30
- Phase-gated with explicit exit criteria: +10
- 13 functional requirements with acceptance criteria: +10
- Error handling matrix covers crawl, entity, criteria, budget edge cases: +9

### Completeness: 19/20
- Risks mitigated with specific strategies (including criteria search risks): +7
- Privacy/data governance as P0 requirement: +7
- Three search modes + batch + API cover the full product surface: +5

**Total: 98/100**

### Changes from v1.3:
- Rewrote: FR-002 crawl strategy from "Adaptive Priority-Based Search" to "Adaptive Research Loop"
- Added: Adaptive query regeneration — system generates new search queries mid-crawl based on discovered facts
- Added: Acceptance criteria for adaptive query behavior
- Added: Adaptive Query Regeneration Prompt in Section 8
- Rationale: Humans don't batch-search then batch-read — they search, read, learn, pivot, and search again. The engine must do the same.

### Changes from v1.2:
- Added: **Criteria-Based People Discovery** (FR-013) — two-phase discover-then-deep-search workflow
- Added: Persona 4 ("The Sourcer" — VC associate for criteria search)
- Added: Criteria search gap analysis in Problem Statement
- Added: 3 new prompt templates (criteria decomposition, multi-person extraction, candidate ranking)
- Added: Criteria search edge cases in Section 7
- Updated: FR-001 now supports two modes (person search + criteria search)
- Updated: FR-006 UI supports criteria mode with candidate list view
- Updated: FR-011 API adds criteria search endpoints
- Updated: Phase 2 includes criteria search implementation
- Updated: Competitive table adds criteria-based discovery row
- Updated: Risks table adds criteria search precision and cost risks

### Changes from v1.1:
- Simplified: FR-001 input model — removed structured fields (company, location, title, etc.) in favor of name + freeform context text
- Updated: FR-006 search input description to match simplified model
- Updated: FR-010 batch CSV format to name + context columns
- Rationale: Freeform context is more flexible, reduces UI complexity, and lets the system extract any signal without requiring users to categorize their knowledge

### Changes from v1.0 (90/100):
- Added: General Research Mode (FR-009), Batch Search (FR-010), API/SDK (FR-011), Privacy Controls (FR-012)
- Added: Error handling & edge cases matrix (Section 7)
- Added: Full prompt engineering specifications for all LLM interactions (Section 8)
- Improved: Honest caveats on quantified pain points (estimates vs. validated data)
- Improved: Non-goals expanded (no chatbot, no automated outreach)
- Improved: Competitive table expanded with new capabilities
- Remaining gap: User flow diagrams / wireframes (better suited to a separate design doc)

---

*Generated for the GenSearch project. This PRD is designed to be directly actionable for AI-assisted implementation — each functional requirement includes acceptance criteria, priority levels, and specific technical approaches.*
