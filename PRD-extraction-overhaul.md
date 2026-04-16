# PRD: Extraction Pipeline Overhaul

## Problem Statement

GenSearch's current extraction pipeline fails on the majority of high-value pages. In the most recent test run (Noah Liu, USC), the system:
- Fetched 50 pages but extracted only **2 mentions** (4% success rate)
- Failed on **all 6 LinkedIn URLs** (100% failure)
- Got "No data extracted" from WayUp, Whitebridge, RocketReach — pages that clearly had the target person in their **title**
- Wasted budget on irrelevant pages (World Bank, Liberty University, wrong USC)
- Burned 174K tokens and 6 minutes to produce **zero profiles**

The extraction pipeline is the #1 bottleneck. Entity resolution, name matching, and profile building are irrelevant if we can't get data in the first place.

## Current Architecture

```
Search Results → fetchPage(url) → LLM Extract → Mentions → Resolution → Profiles
                     │
                     ├── Tier 1: Direct HTTP + Readability (free, fast)
                     ├── Tier 2: Jina Reader API (JS rendering, rate-limited)
                     └── Tier 3: Playwright (NOT IMPLEMENTED)
```

**Failure modes:**
1. **Blocked by anti-bot** — LinkedIn, Facebook, Instagram return login walls or 403s
2. **JS-rendered content** — Jina handles some, but fails on paywalled/gated sites
3. **Data in hand but unused** — Search result titles and snippets contain structured data (names, titles, companies) that is completely ignored
4. **No platform-specific strategies** — Every URL is treated identically regardless of whether it's LinkedIn, a personal blog, or a PDF

## Proposed Architecture

```
Search Results ──┬──→ Snippet Extraction (FREE, immediate)
                 │         │
                 │         ▼
                 │    Seed Mentions (from titles/snippets alone)
                 │
                 └──→ Smart Router ──→ Platform-specific fetch strategy
                           │
                           ├── Generic Web → Multi-tier fetcher
                           ├── LinkedIn    → Proxycurl API or snippet-only
                           ├── GitHub      → GitHub API (public, free)
                           ├── Academic    → Semantic Scholar / Google Scholar API
                           └── Blocked     → Google Cache → Web Archive → Skip
                                    │
                                    ▼
                              LLM Extract → Mentions → Resolution → Profiles
```

---

## Phase 1: Search Snippet Extraction (P0 — Highest Impact, Zero Cost)

### The Insight

Search engines have already crawled LinkedIn, Facebook, and every other blocked site. Their results contain structured data in titles and snippets that we currently throw away.

**Example from the Noah Liu log:**
```
Search result title: "Noah Liu - Co-Founder @ WeKruit | Whitebridge.AI"
Search result title: "Zelin(Noah) Liu - University of Southern California | WayUp"
URL pattern:         linkedin.com/in/zelin-noah-liu
```

This tells us: name variants ("Zelin Noah Liu", "Noah Liu"), role ("Co-Founder"), company ("WeKruit"), school ("University of Southern California") — all **before we fetch a single page**.

### Implementation

**1.1 Extract data from search result metadata**

Before adding URLs to the frontier, parse search result titles and snippets for person data:

```typescript
interface SearchResultMention {
  sourceUrl: string;
  names: string[];          // Extracted from title patterns
  title?: string;           // Job title if pattern-matched
  company?: string;         // Company if pattern-matched
  school?: string;          // Education if mentioned
  confidence: number;       // Low (0.3-0.5) since it's from snippets
  isSnippetOnly: boolean;   // Flag so we know to try fetching for more
}
```

Common title patterns to parse:
- `"Name - Title @ Company | Platform"` (LinkedIn, Whitebridge, etc.)
- `"Name - Company | Platform"`
- `"Name | University"` (WayUp, university directories)
- `"Name, Title at Company"` (news articles)

This is **regex + heuristic parsing**, not LLM — it's free and instant.

**1.2 Feed snippet mentions into the resolver immediately**

Even before crawling starts, create low-confidence `PersonMention` objects from snippet data. This gives the adaptive query agent context to work with from page 1.

**1.3 Use page titles from failed fetches**

When a fetch fails (HTTP 403, empty content, etc.), we still have the page title from the search result. Extract what we can instead of discarding entirely.

**Effort:** Small (~1-2 days)
**Impact:** Massive — immediately captures data from every LinkedIn, Facebook, and gated result
**Cost:** Zero

---

## Phase 2: Smart URL Router (P0)

### The Problem

Currently every URL goes through the same fetch pipeline. This wastes budget:
- LinkedIn URLs always fail → 6 wasted fetches in the Noah Liu run
- sc.edu (South Carolina) crawled instead of usc.edu (Southern California) → 5 wasted fetches
- Generic list pages with no person data → dozens of wasted fetches

### Implementation

**2.1 Domain-aware routing**

Before fetching, classify the URL and route to the optimal strategy:

```typescript
type FetchStrategy =
  | "direct"           // Standard HTTP + Readability
  | "jina"             // JS-heavy sites needing rendering
  | "firecrawl"        // Anti-bot protected sites
  | "people-data-api"  // LinkedIn/professional data via PDL/RocketReach
  | "github-api"       // GitHub profiles/repos
  | "scholar-api"      // Google Scholar / Semantic Scholar
  | "google-cache"     // Fallback for blocked sites
  | "snippet-only"     // Don't fetch — use search snippet data only
  | "skip";            // Known dead-end (ads, login walls, etc.)

function routeUrl(url: string, domain: string): FetchStrategy {
  // LinkedIn profiles → people data API enrichment or snippet-only
  if (domain.includes("linkedin.com")) {
    if (url.includes("/in/") || url.includes("/pub/")) {
      return process.env.PDL_API_KEY ? "people-data-api" : "snippet-only";
    }
    return "skip"; // LinkedIn feed, generic pages
  }

  // Facebook → snippet-only (scraping is impractical)
  if (domain.includes("facebook.com")) return "snippet-only";

  // GitHub → use API for structured data
  if (domain.includes("github.com")) return "github-api";

  // Google Scholar → use API
  if (domain.includes("scholar.google.com")) return "scholar-api";

  // Known JS-heavy sites → Firecrawl/Jina
  if (JS_HEAVY_DOMAINS.has(domain)) return "firecrawl";

  // Default → direct HTTP
  return "direct";
}
```

**2.2 URL quality pre-filter**

Before wasting a fetch, evaluate URL quality:

```typescript
function shouldFetch(url: string, query: SearchQuery): boolean {
  const domain = getDomain(url);

  // Domain confusion guard: "sc.edu" ≠ "usc.edu"
  if (query.context?.toLowerCase().includes("usc") ||
      query.context?.toLowerCase().includes("southern california")) {
    if (domain === "sc.edu") return false; // South Carolina, not USC
  }

  // Skip known low-value page types
  if (url.includes("/login") || url.includes("/signup")) return false;
  if (url.includes("/privacy-policy") || url.includes("/terms")) return false;
  if (url.includes("/debarred") || url.includes("/sanctions")) return false;

  return true;
}
```

**Effort:** Small-medium (~2-3 days)
**Impact:** Eliminates wasted fetches, enables platform-specific strategies
**Cost:** Zero (routing logic only)

---

## Phase 3: Enhanced Multi-Tier Fetcher (P1)

Upgrade the fetch pipeline with better tools for different scenarios.

### 3.1 Tier 1: Direct HTTP + Readability (current — keep)

Works for ~60-70% of pages. Free, fast. No changes needed.

### 3.2 Tier 2: Firecrawl API (replace Jina as primary fallback)

**Why Firecrawl over Jina:**
- 96% web accessibility (handles anti-bot, CAPTCHAs, proxy rotation)
- Returns clean markdown + structured JSON
- AI-powered `/extract` endpoint for targeted data extraction
- 500 free pages/month; $16/month for 3,000 pages
- Better success rate on protected sites

**Integration:**
```typescript
async function fetchTier2Firecrawl(url: string): Promise<PageContent | null> {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      waitFor: 3000,           // Wait for JS to render
      timeout: 30000,
    }),
  });
  // ... parse response
}
```

**Keep Jina as Tier 3** — free tier (200 RPM with key) is useful as a fallback when Firecrawl credits are exhausted.

### 3.3 Tier 4: Google Cache / Web Archive

When all else fails, try cached versions:

```typescript
async function fetchCached(url: string): Promise<PageContent | null> {
  // Try Google cache
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const cached = await fetchTier1(cacheUrl);
  if (cached) return { ...cached, url }; // Preserve original URL

  // Try Wayback Machine
  const waybackUrl = `https://web.archive.org/web/2024/${url}`;
  const archived = await fetchTier1(waybackUrl);
  if (archived) return { ...archived, url };

  return null;
}
```

### 3.4 Updated Tier Strategy

```
URL → Router → Strategy
  │
  ├── "direct"      → Tier 1 (HTTP) → Tier 2 (Firecrawl) → Tier 3 (Jina) → Tier 4 (Cache)
  ├── "firecrawl"   → Tier 2 (Firecrawl) → Tier 3 (Jina) → Tier 4 (Cache)
  ├── "jina"        → Tier 3 (Jina) → Tier 4 (Cache)
  ├── "people-data" → PDL/RocketReach API → snippet-only fallback
  ├── "github-api"  → GitHub REST API → Tier 1 (HTTP)
  ├── "scholar-api" → Semantic Scholar API → Tier 1 (HTTP)
  ├── "google-cache"→ Tier 4 (Cache) only
  ├── "snippet-only"→ No fetch, use search result metadata
  └── "skip"        → Don't fetch at all
```

**Effort:** Medium (~3-5 days)
**Impact:** High — converts most "No data extracted" failures into successful extractions
**Cost:** Firecrawl: $16-83/month depending on volume

---

## Phase 4: Platform-Specific APIs (P1)

### 4.1 LinkedIn Data

LinkedIn is the highest-value source for professional data but the hardest to access. Direct scraping is legally risky (LinkedIn sued Proxycurl in January 2026). Strategy: **avoid scraping entirely — use search snippets + people data APIs instead.**

**Approach A: SERP snippets (primary, safest)**

Query a SERP API for `"person name" site:linkedin.com/in/` and extract structured data from the search result snippet. Google has already crawled the profile — the snippet typically contains name, headline (title + company), location, and education summary. This is public data from a search engine, not scraping LinkedIn.

```typescript
// Example SERP snippet: "Zelin Noah Liu - Co-Founder - WeKruit | LinkedIn"
// Snippet: "University of Southern California · Los Angeles, California"
// → Extracts: name, title, company, school, location — all without touching LinkedIn
```

**Approach B: People Data APIs (enrichment)**

Use People Data Labs ($98/mo for 10K lookups, 1.5B+ person records) or RocketReach ($33-75/mo) to look up a person by name + company/school and get structured LinkedIn-equivalent data (title, company, education, skills, location) from their pre-crawled databases.

```typescript
async function enrichFromPeopleDataLabs(
  name: string,
  company?: string,
  school?: string
): Promise<PersonMention | null> {
  const params = new URLSearchParams({ name });
  if (company) params.set("company", company);
  if (school) params.set("school", school);

  const response = await fetch(
    `https://api.peopledatalabs.com/v5/person/search?${params}`,
    { headers: { "X-Api-Key": process.env.PDL_API_KEY! } }
  );

  const data = await response.json();
  if (!data.data?.[0]) return null;
  const person = data.data[0];

  return {
    sourceUrl: person.linkedin_url || `pdl:${person.id}`,
    fetchedAt: new Date(),
    confidence: 0.85,
    extracted: {
      names: [person.full_name, ...(person.first_name ? [`${person.first_name} ${person.last_name}`] : [])],
      title: person.job_title,
      company: person.job_company_name,
      location: [person.location_locality, person.location_region, person.location_country].filter(Boolean).join(", "),
      education: (person.education || []).map((e: { school: { name: string }; degrees: string[]; majors: string[] }) => ({
        institution: e.school?.name,
        degree: e.degrees?.[0],
        field: e.majors?.[0],
      })),
      skills: person.skills || [],
      socialLinks: [
        ...(person.linkedin_url ? [{ platform: "LinkedIn", url: person.linkedin_url }] : []),
        ...(person.github_url ? [{ platform: "GitHub", url: person.github_url }] : []),
        ...(person.twitter_url ? [{ platform: "Twitter", url: person.twitter_url }] : []),
      ],
      email: person.work_email || person.personal_emails?.[0],
      // ... etc
    },
  };
}
```

**Approach C: Bright Data LinkedIn Scraper (fallback, higher cost/risk)**

Bright Data offers a pre-built LinkedIn scraper using residential proxies. This is real-time scraping but through a compliant infrastructure provider. Use only when approaches A and B don't have the person.

### 4.2 GitHub via REST API

GitHub's public API is free (60 requests/hour unauthenticated, 5000/hour with token).

```typescript
async function fetchGitHubProfile(username: string): Promise<PersonMention | null> {
  const [user, repos] = await Promise.all([
    fetch(`https://api.github.com/users/${username}`).then(r => r.json()),
    fetch(`https://api.github.com/users/${username}/repos?sort=stars&per_page=5`).then(r => r.json()),
  ]);

  return {
    sourceUrl: `https://github.com/${username}`,
    confidence: 0.85,
    extracted: {
      names: [user.name, user.login].filter(Boolean),
      company: user.company,
      location: user.location,
      bioSnippet: user.bio,
      email: user.email,
      socialLinks: [
        { platform: "GitHub", url: user.html_url },
        ...(user.blog ? [{ platform: "Website", url: user.blog }] : []),
      ],
      skills: repos.map(r => r.language).filter(Boolean),
      // ... etc
    },
  };
}
```

### 4.3 Academic APIs

**Semantic Scholar** (free, 100 requests/5 min):
- Author search by name
- Returns: affiliations, h-index, publication count, homepage URL, paper titles

**Google Scholar** (via SerpAPI or scholarly):
- Author profiles with citations, co-authors, affiliations

```typescript
async function fetchScholarProfile(name: string): Promise<PersonMention | null> {
  const response = await fetch(
    `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(name)}&fields=name,affiliations,homepage,hIndex,paperCount`
  );
  const data = await response.json();
  // ... map to PersonMention
}
```

**Effort:** Medium (~3-5 days)
**Impact:** High — LinkedIn alone would have captured the target in the Noah Liu case
**Cost:** Proxycurl: $49/month; GitHub: free; Semantic Scholar: free

---

## Phase 5: Adaptive Query Improvements (P1)

### 5.1 Feed snippet data into the adaptive query agent

Currently the adaptive query agent sees "None yet" for facts until pages are successfully extracted. With snippet extraction (Phase 1), the agent immediately knows:
- Name variants discovered ("Zelin Noah Liu")
- Companies ("WeKruit")
- Schools ("University of Southern California")

This means the very first adaptive query call can generate targeted queries like `"Zelin Noah Liu" WeKruit USC` instead of generic `"Noah Liu" USC student researcher`.

### 5.2 Use failed-fetch signals

When a fetch fails, log what we know from the URL/title and use it:

```typescript
if (!page) {
  // Extract what we can from the search result metadata
  const snippetMention = extractFromSearchResult(searchResult);
  if (snippetMention) {
    resolver.addMention(snippetMention);
    // Also feed into adaptive query: "We found a WeKruit reference but couldn't fetch the page"
  }
}
```

### 5.3 Domain confusion prevention

Add context-aware domain validation to prevent crawling University of South Carolina (sc.edu) when searching for USC (usc.edu):

```typescript
const DOMAIN_ALIASES: Record<string, string[]> = {
  "university of southern california": ["usc.edu", "trojan", "viterbi"],
  "usc": ["usc.edu"],
  // ... common abbreviation mappings
};
```

**Effort:** Small (~1-2 days)
**Impact:** Medium — prevents wasted crawl budget, improves query quality
**Cost:** Zero

---

## Phase 6: Playwright with Stealth (P2 — Future)

Self-hosted headless browser for the remaining ~4% of the web that Firecrawl can't handle.

### Implementation

```typescript
import { chromium } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

async function fetchTier5Playwright(url: string): Promise<PageContent | null> {
  const browser = await addExtra(chromium)
    .use(StealthPlugin())
    .launch({ headless: true });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  const html = await page.content();
  await browser.close();

  return parseHtmlContent(url, html, "playwright");
}
```

**Considerations:**
- Requires browser binary in deployment environment
- Slower (3-10s per page vs <1s for HTTP)
- Memory-intensive
- Stealth plugins are cat-and-mouse — may break over time
- Best reserved for specific high-value domains where other methods fail

**Effort:** Medium (~3 days for basic, more for stealth tuning)
**Impact:** Low-medium (most cases already handled by Firecrawl)
**Cost:** Compute costs for running headless browsers

---

## Implementation Priority

| Phase | Priority | Effort | Impact | Cost |
|-------|----------|--------|--------|------|
| 1. Snippet Extraction | P0 | 1-2 days | Massive | Free |
| 2. Smart URL Router | P0 | 2-3 days | High | Free |
| 3. Enhanced Fetcher (Firecrawl) | P1 | 3-5 days | High | $16-83/mo |
| 4. Platform APIs | P1 | 3-5 days | High | $98/mo (PDL) or $33/mo (RocketReach) |
| 5. Adaptive Query Improvements | P1 | 1-2 days | Medium | Free |
| 6. Playwright Stealth | P2 | 3+ days | Low-Medium | Compute |

**Recommended order:** Phase 1 → Phase 2 → Phase 5 → Phase 3 → Phase 4 → Phase 6

Phases 1+2+5 are free, quick, and address the majority of the problem. Phase 3+4 require paid API keys but unlock LinkedIn and other gated platforms.

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Mention extraction rate (mentions / pages fetched) | 4% (2/50) | 40%+ |
| Wasted fetches (pages with zero useful data) | ~90% | <30% |
| LinkedIn data capture | 0% | 80%+ (via Proxycurl or snippets) |
| Time to first useful mention | ~4 min | <30 sec (from snippets) |
| Profiles built per session | 0 | 1+ (for known people) |
| LLM tokens per successful mention | ~87K | <20K |

---

## Environment Variables (New)

```env
# Phase 3: Firecrawl (open source, can also be self-hosted)
FIRECRAWL_API_KEY=fc-...

# Phase 4: Platform APIs
PDL_API_KEY=...                # People Data Labs — structured people enrichment
GITHUB_TOKEN=ghp_...           # GitHub API (optional, increases rate limit 60→5000/hr)
SEMANTIC_SCHOLAR_API_KEY=...   # Academic data (optional)
```

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| People data API changes/pricing | Snippet extraction as primary fallback; vendor-agnostic interface layer |
| Firecrawl rate limits | Keep Jina as secondary; implement credit tracking; Firecrawl is also open-source/self-hostable |
| Legal issues with LinkedIn data | No direct LinkedIn scraping; SERP snippets are public search engine data; PDL/RocketReach are compliant data brokers |
| LinkedIn suing data providers | Proxycurl was sued Jan 2026 — use PDL/RocketReach (larger companies, more defensible) + snippets |
| Over-reliance on paid APIs | Phase 1+2 are free and handle the majority case; paid APIs are optional enhancements |
| Stealth plugins breaking | P2 priority only; Firecrawl handles most cases |
| Google Custom Search API sunsetting (Jan 2027) | Use Serper/Brave as primary SERP providers (already integrated) |
| Bing Entity Search retired (Aug 2025) | Not a dependency; use SERP snippets + Knowledge Graph instead |
