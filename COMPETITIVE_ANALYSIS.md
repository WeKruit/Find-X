# GenSearch Competitive Analysis & Quality Assessment

**Date:** March 31, 2026
**Scope:** People search / OSINT / talent intelligence landscape

---

## 1. GenSearch Architecture Assessment

### What GenSearch Does Well

**Sophisticated crawl orchestration.** The engine implements a multi-phase pipeline (search -> crawl -> extract -> resolve -> profile) that mirrors how a human researcher actually works. The adaptive query regeneration system is particularly notable -- when the frontier drains or progress stalls, the LLM generates new search queries based on what has been learned so far and what gaps remain. This is a genuine innovation absent from most competitors.

**Intelligent URL scoring and routing.** The domain-aware routing system (`routeUrl`) correctly handles the reality that LinkedIn, Facebook, Twitter, and Instagram cannot be scraped. Instead of wasting page budget on doomed fetches, these sites are marked as "snippet-only" and their search result snippets are still mined for structured data. The tiered fetch strategy (HTTP -> Playwright -> Firecrawl) is a pragmatic approach that keeps costs low while handling JS-rendered sites.

**Entity resolution with confidence scoring.** The TF-IDF cosine similarity engine combined with LLM-assisted name matching and entity clustering is genuinely sophisticated. The system correctly handles the "Noah Liu" problem -- disambiguating a common name from athletes, dentists, and other same-name individuals using contextual signals. The `IncrementalResolver` that runs entity resolution live during crawl is a smart design decision that enables early stopping and adaptive querying.

**Source reliability modeling.** The `profile/builder.ts` assigns domain-specific reliability scores (LinkedIn: 0.9, GitHub: 0.85, .edu: 0.85, etc.), applies recency decay, and computes corroboration boosts from multi-source confirmation. This produces genuinely meaningful confidence scores rather than binary present/absent flags.

**Garbage filtering.** The system filters aggregator boilerplate (RocketReach blurbs, LinkedIn UI chrome, hashtag-only roles) from bio snippets and job titles. This shows awareness of real-world data quality problems that many tools ignore.

**Evaluation harness.** The `eval-search.test.ts` with structured criteria (expected signals, forbidden contamination signals, minimum confidence thresholds) demonstrates engineering rigor unusual for an early-stage project.

### What Needs Improvement

**No persistence layer.** All data is in-memory (`store.ts` is a Map). Search results vanish on restart. No database, no caching of previously resolved profiles, no ability to build knowledge over time. Every search starts from zero.

**Limited page budget.** 15-20 pages per search is extremely constrained. For ambiguous names or sparse web footprints, this may not be sufficient to build a reliable profile. Commercial competitors access pre-indexed databases of hundreds of millions of profiles.

**No API/SDK.** GenSearch is a web UI only. No programmatic access, no batch processing, no webhook integrations. This limits its utility for workflows, CRM enrichment, or pipeline automation.

**Single-user, single-session.** No authentication, no team features, no saved searches, no search history. Each session is ephemeral.

**LinkedIn is a black box.** The most valuable people data source on the internet cannot be scraped. GenSearch extracts what it can from search snippets, but this yields thin data compared to competitors with legitimate LinkedIn partnerships or API access.

**No email verification.** Emails extracted from web pages are presented at face value. No bounce checking, deliverability scoring, or format validation beyond regex.

**No phone number enrichment.** The schema supports phones, but the extraction pipeline rarely finds them on the open web. Commercial competitors (Apollo, Lusha, ZoomInfo) maintain proprietary phone databases.

**Cost opacity.** Token usage is tracked but not presented as dollar cost. Users cannot estimate the per-search cost before running it. At Claude Haiku rates, a 20-page search likely costs $0.05-0.15, but this is not surfaced.

**No rate limiting or abuse prevention.** No authentication means no usage limits. A crawler loop could burn through API credits (Serper, Brave, Anthropic) with no guard rails.

---

## 2. Competitive Landscape Map

### Tier 1: Enterprise Sales Intelligence (Pre-indexed databases)

| Competitor | Database Size | Pricing | Key Differentiator |
|---|---|---|---|
| **ZoomInfo** | 321M professionals, 104M companies | $15,000-$60,000+/yr | Gold standard data quality, intent signals, ABM |
| **Apollo.io** | 210M contacts, 30M companies | $49-$119/user/mo | Best value in the tier, built-in engagement tools |
| **Clearbit** (HubSpot) | Undisclosed, large | ~$999+/mo custom | Real-time enrichment API, HubSpot native |
| **Lusha** | Undisclosed | $49-$79/user/mo | Direct dial phone numbers, buying intent signals |

**GenSearch vs. Tier 1:** These tools win overwhelmingly on data completeness, verified contact info, and CRM integration. They maintain continuously updated databases built from data partnerships, crowdsourced user contributions, and proprietary scraping infrastructure. GenSearch cannot compete on data volume or contact accuracy. However, GenSearch does something they cannot: it synthesizes a narrative understanding of a person from diverse web sources, rather than returning a fixed-schema contact card.

### Tier 2: Email/Contact Discovery

| Competitor | Focus | Pricing | Key Differentiator |
|---|---|---|---|
| **Hunter.io** | Email finding + verification | Freemium, paid tiers | Email pattern detection per company domain |
| **Pipl** | Identity resolution | Enterprise pricing | Deep web people search, identity graph |

**GenSearch vs. Tier 2:** Hunter.io does one thing (email finding) extremely well. GenSearch attempts email discovery as one of many fields but cannot match Hunter's pattern-based email prediction or verification infrastructure. Pipl's identity resolution engine is the closest architectural parallel to GenSearch's entity resolver, but operates on a pre-built identity graph rather than real-time crawling.

### Tier 3: AI-Powered Data Enrichment

| Competitor | Approach | Pricing | Key Differentiator |
|---|---|---|---|
| **Clay.com** | Spreadsheet + 100 data providers + AI agents | $185-$495/mo | Orchestrates data from 100+ sources, Claygent AI |
| **Exa.ai** | Neural people search API over 1B+ profiles | API pricing | Semantic search, fine-tuned embeddings, API-first |
| **Phantombuster** | Pre-built scraping automations ("Phantoms") | $69-$439/mo | 130+ platform-specific scrapers, execution-time pricing |

**GenSearch vs. Tier 3:** This is GenSearch's true competitive cohort. Clay is the most relevant comparison -- it also uses AI to orchestrate multi-source research, but does so by querying 100+ existing data APIs rather than crawling the open web. Exa.ai is the strongest technical competitor: it has pre-indexed 1 billion profiles with fine-tuned neural embeddings, making its people search both faster and more comprehensive than GenSearch's real-time crawl approach. GenSearch's advantage over Clay is cost (no $185/mo base + credit costs) and over Exa is that it reads and synthesizes full page content rather than returning pre-structured index hits.

### Tier 4: General AI Search

| Competitor | Approach | Pricing | Key Differentiator |
|---|---|---|---|
| **Perplexity AI** | RAG-based conversational search | Free / $20/mo Pro | 1.2B+ queries/mo, strong citation, general-purpose |

**GenSearch vs. Perplexity:** A user could ask Perplexity "Tell me about Noah Liu at USC" and get a reasonable synthesized answer. Perplexity is faster, has broader web coverage, and provides citations. However, Perplexity does not produce structured data (name, title, company, education as separate fields), does not perform entity resolution across multiple same-name individuals, does not score source reliability, and does not offer a criteria-based multi-person search mode. GenSearch's output is machine-readable and actionable in a way Perplexity's prose is not.

### Tier 5: Open-Source OSINT

| Tool | Focus | Key Differentiator |
|---|---|---|
| **Maltego** | Graph-based link analysis | Visual entity mapping, 100+ data source transforms |
| **SpiderFoot** | Automated OSINT reconnaissance | 200+ modules, attack surface mapping |
| **theHarvester** | Email/subdomain enumeration | Simple, fast, domain-focused |
| **Sherlock** | Username search across 400+ platforms | Cross-platform identity linkage |

**GenSearch vs. Open-Source OSINT:** Maltego is the closest architectural analogy -- it also builds entity graphs from multiple sources with visual output. However, Maltego is security-focused (IPs, domains, infrastructure), requires manual transform execution, and costs $999+/yr for the full version. SpiderFoot automates broadly but lacks LLM-powered extraction and entity resolution. GenSearch is more user-friendly and produces more structured people profiles than any of these tools, but they cover attack surface mapping and infrastructure reconnaissance that GenSearch does not attempt.

---

## 3. Competitive Positioning Matrix

```
                    Structured Data Quality
                           HIGH
                            |
          ZoomInfo          |         Clay.com
          Apollo.io         |         Exa.ai
          Lusha             |
                            |
   Pre-indexed    ----------+----------  Real-time
   Database                 |            Web Research
                            |
          Clearbit          |         GenSearch
          Hunter.io         |         Perplexity
                            |         Maltego
                            |
                           LOW
                    Structured Data Quality
```

GenSearch sits in the **lower-right quadrant**: real-time web research with moderate structured data quality. Its opportunity is to move upward (better extraction, verification, more fields) while maintaining its real-time research advantage.

---

## 4. GenSearch's True Differentiators

### What is genuinely unique

1. **Agentic research behavior.** GenSearch does not just query a database -- it reasons about what information is missing, generates new search queries to fill gaps, follows promising links, and stops when the profile is complete enough. No other tool in this analysis exhibits this full loop of adaptive research.

2. **LLM-powered entity resolution on live data.** The combination of TF-IDF cosine similarity, LLM name matching, and incremental clustering to disambiguate same-name individuals from real-time crawl data is architecturally distinctive. ZoomInfo/Apollo solve this with pre-built identity graphs; GenSearch solves it on the fly.

3. **Criteria search (reverse people search).** The ability to query "Ex-Google engineers with startup ideas" and get a ranked candidate list by decomposing criteria into search signals, crawling relevant pages, and scoring matches is a capability that most competitors either lack or charge enterprise pricing for.

4. **Transparency of process.** The SSE-streamed crawl progress, source attribution with reliability scores, and cluster visualization give users insight into how conclusions were reached. Commercial competitors are black boxes.

5. **Zero marginal cost per profile.** Unlike credit-based systems (Apollo: 1 credit/email, ZoomInfo: credits per contact view), GenSearch's per-search cost is only LLM tokens + search API calls, likely $0.05-0.15 per search. For research-heavy users, this is dramatically cheaper.

### What is NOT a differentiator

1. **Data quality.** GenSearch's extraction accuracy depends entirely on what is publicly available and what the LLM correctly parses. Commercial databases with verified, crowdsourced data will consistently produce more complete and accurate contact records.

2. **Speed.** A 20-page crawl with LLM extraction takes 30-120 seconds. Apollo or ZoomInfo returns structured data in milliseconds from a pre-built index.

3. **Contact information.** GenSearch cannot reliably find verified emails, direct dial phones, or mobile numbers. This is the core value proposition of Lusha, Hunter.io, and Apollo.

4. **Scale.** GenSearch handles one search at a time with no batch processing. Clay, Phantombuster, and Apollo handle thousands of records in automated workflows.

---

## 5. Key Gaps vs. Competitors

### Critical Gaps (blocking real-world adoption)

| Gap | Impact | Competitors That Solve It |
|---|---|---|
| No persistence / database | Cannot build knowledge over time, no saved searches | All commercial tools |
| No verified email finding | Cannot be used for outreach workflows | Hunter.io, Apollo, Lusha, ZoomInfo |
| No API access | Cannot integrate into existing workflows | Clay, Exa.ai, Apollo, Clearbit |
| No LinkedIn data access | Missing the richest people data source | Apollo, Lusha, Phantombuster (via automation) |

### Important Gaps (limiting value)

| Gap | Impact | Competitors That Solve It |
|---|---|---|
| No batch/bulk search | One person at a time only | Clay, Phantombuster, Apollo |
| No CRM integration | Manual workflow to use results | Apollo, ZoomInfo, Clearbit, Clay |
| No phone number data | Incomplete contact profiles | Lusha, ZoomInfo, Apollo |
| No company enrichment | Cannot cross-reference firmographic data | ZoomInfo, Clearbit, Apollo |
| No search history | Repeat searches waste budget | All commercial tools |

### Nice-to-Have Gaps

| Gap | Competitors |
|---|---|
| No team/collaboration features | All SaaS tools |
| No data export (CSV, JSON) | Most tools |
| No alerting / monitoring for profile changes | ZoomInfo, Lusha |
| No intent signals / buying signals | ZoomInfo, Apollo, Lusha |

---

## 6. Overall Quality Assessment

### Architecture: Strong (7/10)

The system design is well-thought-out. The separation of concerns (search -> fetch -> extract -> resolve -> build profile), the tiered fetching strategy, the incremental entity resolution, and the adaptive query regeneration all demonstrate architectural maturity beyond what you would expect from a v0.1 project. The async context-based token tracking (replacing a global mutable tracker) shows attention to correctness under concurrency.

### Code Quality: Strong (8/10)

TypeScript throughout with Zod validation on LLM outputs, proper error boundaries around SSE streams, garbage filtering on extracted data, robots.txt compliance, rate limiting per domain. The codebase is notably defensive against real-world data quality problems (aggregator boilerplate, garbled titles, fragment URLs, tracking parameters).

### Data Quality: Moderate (5/10)

The extraction quality is inherently limited by (a) what is publicly available on the open web, (b) what the LLM correctly extracts, and (c) the 15-20 page budget. For well-known individuals with rich web footprints, results are likely good. For less prominent people, results will be sparse or potentially wrong-person contaminated despite the disambiguation system.

### UX: Basic (4/10)

Functional but minimal. The search form, crawl progress stream, profile cards, and cluster graph provide the essential user experience. But there is no search history, no saved profiles, no comparison view, no export, no settings, no mobile responsiveness consideration. The UI is a proof of concept, not a product.

### Production Readiness: Low (3/10)

No persistence, no authentication, no rate limiting, no monitoring, no deployment configuration, no error reporting service, no usage metering. The in-memory store means a server restart loses all data. This is a local development tool, not a deployable service.

### Innovation: High (8/10)

The adaptive research loop, incremental entity resolution, and criteria-based reverse people search are genuinely novel approaches that combine agentic AI with traditional information retrieval in ways that commercial competitors have not yet replicated. The eval harness for search quality is also a mature engineering practice.

---

## 7. Strategic Recommendations (Summary)

GenSearch occupies a unique and defensible position: **an agentic people research tool that thinks like a human investigator**. Its closest competitors are:

- **Exa.ai** on the API/infrastructure side (pre-indexed neural people search)
- **Clay.com** on the workflow/enrichment side (AI-orchestrated multi-source research)
- **Perplexity** on the general "ask about a person" side (but without structured output)

The most promising path forward is to **lean into the agentic research narrative** rather than trying to compete with database-first tools on data completeness. The scenarios where GenSearch adds value over ZoomInfo or Apollo are:

1. **Niche / long-tail people** not well-represented in commercial databases
2. **Research depth** beyond a contact card -- understanding someone's background, achievements, and connections
3. **Criteria-based discovery** of people matching complex, qualitative criteria
4. **Cost-sensitive users** who cannot justify $15K+/year for ZoomInfo or $185/mo for Clay
5. **Transparency-demanding users** (journalists, researchers, compliance) who need to see sources and methodology

The critical next steps for making this competitive would be: adding a persistence layer, building an API, and implementing an email verification step. These three additions would transform GenSearch from a research prototype into a tool that can participate in real workflows.

---

## Sources

- [Clay Pricing 2026](https://www.warmly.ai/p/blog/clay-pricing)
- [Clay AI Review 2026](https://www.sales-echo.com/blog/clay-review)
- [Apollo.io Pricing 2026](https://www.enginy.ai/blog/apollo-io-pricing)
- [Apollo.io Pricing Plans](https://www.apollo.io/pricing)
- [Exa People Search Benchmarks](https://exa.ai/blog/people-search-benchmark)
- [Exa People Search Launch](https://exa.ai/docs/changelog/people-search-launch)
- [Exa Websets - People Search & Lead Gen](https://exa.ai/websets)
- [ZoomInfo Pricing 2026](https://www.factors.ai/blog/zoominfo-pricing)
- [ZoomInfo Pricing - Hidden Costs](https://www.cognism.com/blog/zoominfo-pricing)
- [Phantombuster Review 2026](https://lagrowthmachine.com/phantombuster-review/)
- [theHarvester GitHub](https://github.com/laramies/theHarvester)
- [Maltego OSINT Platform](https://www.maltego.com/)
- [SpiderFoot GitHub](https://github.com/smicallef/spiderfoot)
- [Sherlock - Bellingcat Toolkit](https://bellingcat.gitbook.io/toolkit/more/all-tools/sherlock)
- [Perplexity AI Overview 2026](https://www.texta.ai/blog/perplexity-ai-overview-complete-2026-guide)
- [Hunter.io vs Clearbit](https://fullenrich.com/tools/Hunterio-vs-Clearbit)
- [Lusha - Hunter Alternatives](https://www.lusha.com/blog/best-hunter-alternatives/)
