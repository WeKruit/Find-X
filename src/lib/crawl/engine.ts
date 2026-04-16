import { v4 as uuidv4 } from "uuid";
import type {
  SearchQuery,
  SearchSession,
  CrawlEvent,
  PersonMention,
  ScoredURL,
  ClusterData,
} from "@/types";
import { generateSearchQueries, executeSearchQueries } from "@/lib/search";
import { extractFromSearchResults } from "@/lib/search/snippet-extractor";
import { fetchPage, routeUrl } from "./fetcher";
import {
  brightDataContextLikelyMatches,
  brightDataProfileToMention,
  collectLinkedInProfileByUrl,
  discoverLinkedInProfilesByName,
  hasBrightData,
  isLinkedInProfileUrl,
} from "./brightdata";
import { URLFrontier } from "./queue";
import { getDomain } from "./utils";
import { llmScoreLinks, llmExtractPerson, llmAdaptiveQueryRegen, llmSynthesizeFromSnippets, generateProfileSummary, createTokenTracker, runWithTracker } from "@/lib/llm/client";
import { resolveEntities, type EntityCluster } from "@/lib/entity/resolver";
import { IncrementalResolver } from "@/lib/entity/incremental-resolver";
import { buildSingleProfile } from "@/lib/profile/builder";
import { SessionLogger } from "@/lib/logger";

export interface CrawlConfig {
  pageBudget: number;
  maxDepth: number;
  maxPagesPerDomain: number;
  /** Minimum score for links discovered WITHIN crawled pages (LLM-scored). */
  minScoreThreshold: number;
  /** Minimum score for INITIAL search results added to the frontier.
   *  When context is provided this is raised to block wrong-person trails from
   *  entering the crawl in the first place. */
  initialScoreThreshold: number;
  adaptiveQueryInterval: number; // Check for query regen every N pages
}

const DEFAULT_CONFIG: CrawlConfig = {
  pageBudget: 20,
  maxDepth: 3,
  maxPagesPerDomain: 4,
  minScoreThreshold: 0.4,     // for discovered links (LLM-scored)
  initialScoreThreshold: 0.5, // for initial search results (heuristic-scored)
  adaptiveQueryInterval: 2,   // fire adaptive query regen after every 2 pages
};

type EventCallback = (event: CrawlEvent) => void;

/**
 * Core crawl engine. Orchestrates the full search pipeline:
 * 1. Generate search queries from seed info
 * 2. Execute searches across providers
 * 3. Recursively crawl, score links, extract data
 * 4. Resolve entities and build profiles
 */
export async function runSearch(
  query: SearchQuery,
  onEvent?: EventCallback,
  config: Partial<CrawlConfig> = {}
): Promise<SearchSession> {
  // When context is provided, raise the threshold for initial search results only.
  // This blocks wrong-person trails (athletes, dentists, etc.) from entering the crawl
  // while keeping the lower threshold (0.4) for links discovered within already-fetched pages.
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    initialScoreThreshold: query.context
      ? Math.max(0.6, (config.initialScoreThreshold ?? DEFAULT_CONFIG.initialScoreThreshold))
      : (config.initialScoreThreshold ?? DEFAULT_CONFIG.initialScoreThreshold),
    // minScoreThreshold (for discovered links) stays at default 0.4 regardless of context
    minScoreThreshold: config.minScoreThreshold ?? DEFAULT_CONFIG.minScoreThreshold,
  };
  const sessionId = uuidv4();
  const tokenTracker = createTokenTracker();

  // Bind the token tracker to this async context so concurrent searches
  // don't overwrite each other's tracker (replaces the unsafe global setActiveTracker).
  return runWithTracker(tokenTracker, async () => {
  const session: SearchSession = {
    id: sessionId,
    query,
    status: "searching",
    profiles: [],
    crawlState: {
      pagesVisited: 0,
      pageBudget: cfg.pageBudget,
      domainsVisited: new Set(),
      urlsVisited: new Set(),
      frontier: [],
      extractedMentions: [],
      secondaryMentions: [],
      events: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const logger = new SessionLogger(sessionId, query);

  const MAX_EVENTS = 500;
  const COMPACT_THRESHOLD = MAX_EVENTS + 50; // Only compact when 50 over limit to avoid per-emit rebuilds
  const emit = (event: CrawlEvent) => {
    session.crawlState.events.push(event);
    logger.logEvent(event);
    if (session.crawlState.events.length >= COMPACT_THRESHOLD) {
      // Keep first 50 (search phase) + most recent to stay under MAX_EVENTS
      const recent = session.crawlState.events.slice(-(MAX_EVENTS - 50));
      session.crawlState.events = [
        ...session.crawlState.events.slice(0, 50),
        ...recent,
      ];
    }
    // Wrap callback so a closed SSE stream can't crash the search pipeline
    try {
      onEvent?.(event);
    } catch {
      // Client likely disconnected — swallow the error and continue search
    }
  };

  try {
    // ── Phase 1: Search ──
    emit({
      type: "info",
      message: "Generating search queries...",
      timestamp: new Date(),
    });

    const searchQueries = generateSearchQueries(query);
    emit({
      type: "info",
      message: `Generated ${searchQueries.length} search queries`,
      timestamp: new Date(),
      data: { queries: searchQueries },
    });

    session.status = "searching";
    emit({
      type: "search",
      message: "Executing search queries across providers...",
      timestamp: new Date(),
    });

    const searchResults = await executeSearchQueries(searchQueries);

    // Enrich search recall with Bright Data LinkedIn name discovery.
    // This helps when generic search providers miss a relevant LinkedIn profile URL.
    if (hasBrightData()) {
      const discovered = await discoverLinkedInProfilesByName(query.name, 5, query.context);
      if (discovered.length > 0) {
        const seen = new Set(searchResults.map((r) => r.url.toLowerCase().replace(/\/$/, "")));
        let added = 0;
        for (const item of discovered) {
          const key = item.url.toLowerCase().replace(/\/$/, "");
          if (seen.has(key)) continue;
          seen.add(key);
          searchResults.push({
            title: item.name ? `${item.name} - LinkedIn` : "LinkedIn Profile",
            url: item.url,
            snippet: [item.subtitle, item.location, item.education].filter(Boolean).join(" · "),
            position: 999,
          });
          added++;
        }
        if (added > 0) {
          emit({
            type: "search",
            message: `Bright Data discovered ${added} additional LinkedIn profile URL(s) by name`,
            timestamp: new Date(),
            data: { source: "brightdata-linkedin-discovery", discovered: added },
          });
        }
      }
    }

    emit({
      type: "search",
      message: `Found ${searchResults.length} unique search results`,
      timestamp: new Date(),
      data: { resultCount: searchResults.length },
    });

    if (searchResults.length === 0) {
      session.status = "complete";
      emit({
        type: "info",
        message: "No search results found. Try providing more specific seed information.",
        timestamp: new Date(),
      });
      return session;
    }

    // ── Initialize Incremental Resolver ──
    const resolver = new IncrementalResolver(query);
    const enrichedLinkedInUrls = new Set<string>();

    const tryEnrichLinkedInUrl = async (
      url: string,
      source: string,
      hintText?: string
    ): Promise<boolean> => {
      if (!isLinkedInProfileUrl(url)) return false;
      const dedupKey = url.toLowerCase().replace(/\/$/, "");
      if (enrichedLinkedInUrls.has(dedupKey)) return true;
      enrichedLinkedInUrls.add(dedupKey);

      if (query.context && hintText && !brightDataContextLikelyMatches(hintText, query.context)) {
        emit({
          type: "info",
          message: `Skipping LinkedIn enrichment due to context mismatch (${source}): ${url}`,
          url,
          timestamp: new Date(),
        });
        return true;
      }

      if (!hasBrightData()) {
        emit({
          type: "info",
          message: `Skipping LinkedIn fetch (BRIGHTDATA_API_KEY not configured): ${url}`,
          url,
          timestamp: new Date(),
        });
        return true;
      }

      emit({
        type: "fetch",
        message: `Enriching LinkedIn profile via Bright Data (${source})`,
        url,
        timestamp: new Date(),
      });

      try {
        const profile = await collectLinkedInProfileByUrl(url);
        if (!profile) {
          emit({
            type: "info",
            message: `Bright Data returned no LinkedIn data for: ${url}`,
            url,
            timestamp: new Date(),
          });
          return true;
        }

        // If the source title/snippet already matched context strongly, avoid dropping
        // sparse Bright Data payloads that omit education/location fields.
        const enforceProfileContext =
          query.context && (!hintText || !brightDataContextLikelyMatches(hintText, query.context))
            ? query.context
            : undefined;
        const mention = brightDataProfileToMention(profile, url, query.name, enforceProfileContext);
        if (!mention) {
          emit({
            type: "info",
            message: `Bright Data LinkedIn result did not match target identity: ${url}`,
            url,
            timestamp: new Date(),
          });
          return true;
        }

        session.crawlState.extractedMentions.push(mention);
        resolver.addMention(mention);
        emit({
          type: "extract",
          message: `Enriched from LinkedIn via Bright Data: ${mention.extracted.names[0]}`,
          url: mention.sourceUrl,
          timestamp: new Date(),
          data: {
            title: mention.extracted.experiences[0]?.title,
            company: mention.extracted.experiences[0]?.company,
          },
        });
      } catch (error) {
        emit({
          type: "info",
          message: `Bright Data enrichment failed for LinkedIn URL: ${url}`,
          url,
          timestamp: new Date(),
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }

      return true;
    };

    // ── Phase 1.5: Extract data from search snippets (free, no fetches needed) ──
    const snippetMentions = extractFromSearchResults(searchResults, query.name);
    if (snippetMentions.length > 0) {
      // Build a URL→result map for fast score lookup
      const searchResultMap = new Map(searchResults.map((r) => [r.url, r]));

      let acceptedSnippets = 0;
      for (const mention of snippetMentions) {
        // When context is provided, gate snippet mentions on the same initial threshold
        // used for the frontier. This prevents wrong-person profiles (e.g. a fencer's
        // LinkedIn that doesn't mention USC) from contaminating entity resolution.
        if (query.context) {
          const result = searchResultMap.get(mention.sourceUrl);
          if (result) {
            const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
            if (urlScore < cfg.initialScoreThreshold) continue;
          }
        }
        session.crawlState.extractedMentions.push(mention);
        resolver.addMention(mention);
        acceptedSnippets++;
      }

      if (acceptedSnippets > 0) {
        const filtered = snippetMentions.length - acceptedSnippets;
        emit({
          type: "extract",
          message: `Extracted ${acceptedSnippets} mention(s) from search snippets${filtered > 0 ? ` (${filtered} filtered by context score)` : ""}`,
          timestamp: new Date(),
          data: { snippetMentionCount: acceptedSnippets },
        });
      }
    }

    // Declared here (before Phase 1.6) so refined queries can be tracked for dedup
    const allQueriesUsed = [...searchQueries];

    // ── Phase 1.6: LLM snippet synthesis (pre-crawl profile extraction) ──
    // Feed ALL search result titles and snippets to the LLM at once. This surfaces
    // information that regex can never catch: program names, awards, handles in URLs,
    // cross-snippet synthesis, etc. It also generates 1-2 refined follow-up queries
    // that we execute immediately to enrich the snippet pool before any page fetching.
    emit({
      type: "info",
      message: "Running LLM snippet synthesis on initial search results...",
      timestamp: new Date(),
    });

    const snippetSynthesis = await llmSynthesizeFromSnippets(
      searchResults.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      query.name,
      query.context
    );

    // Accumulate all search results (original + refined) for a final synthesis pass
    let allSearchResults = [...searchResults];

    if (snippetSynthesis) {
      // We defer adding the synthesis mention until we know whether a refined pass
      // will supersede it — this prevents two overlapping mentions with near-duplicate facts.
      let bestSynthesis = snippetSynthesis;
      let bestSynthesisUrl = "snippet-synthesis://initial";
      let bestSynthesisConfidence = 0.75;

      const factCount = snippetSynthesis.extracted.additionalFacts.length;
      emit({
        type: "extract",
        message: `LLM snippet synthesis: found ${factCount} fact(s) from initial snippets${snippetSynthesis.refinedQueries.length > 0 ? `, generated ${snippetSynthesis.refinedQueries.length} refined query(ies)` : ""}`,
        timestamp: new Date(),
        data: {
          title: (snippetSynthesis.extracted.experiences || [])[0]?.title,
          company: (snippetSynthesis.extracted.experiences || [])[0]?.company,
          education: snippetSynthesis.extracted.education.map((e) => e.institution),
          additionalFactCount: factCount,
        },
      });

      // Execute refined follow-up queries to enrich the snippet pool
      if (snippetSynthesis.refinedQueries.length > 0) {
        const refinedQueries = snippetSynthesis.refinedQueries
          .filter((q) => !allQueriesUsed.includes(q));

        if (refinedQueries.length > 0) {
          emit({
            type: "search",
            message: `Running ${refinedQueries.length} refined snippet query(ies): ${refinedQueries.join(" | ")}`,
            timestamp: new Date(),
            data: { queries: refinedQueries },
          });

          allQueriesUsed.push(...refinedQueries);
          const refinedResults = await executeSearchQueries(refinedQueries);

          if (refinedResults.length > 0) {
            emit({
              type: "search",
              message: `Refined queries returned ${refinedResults.length} additional result(s)`,
              timestamp: new Date(),
              data: { resultCount: refinedResults.length },
            });

            // Run regex extractor on the new results only
            const refinedSnippetMentions = extractFromSearchResults(refinedResults, query.name);
            const refinedResultMap = new Map(refinedResults.map((r) => [r.url, r]));
            for (const mention of refinedSnippetMentions) {
              if (query.context) {
                const result = refinedResultMap.get(mention.sourceUrl);
                if (result && scoreSearchResult(result.url, result.title, result.snippet, query) < cfg.initialScoreThreshold) continue;
              }
              session.crawlState.extractedMentions.push(mention);
              resolver.addMention(mention);
            }

            // Update combined results for frontier seeding (fix: refined URLs enter the crawl)
            allSearchResults = [...searchResults, ...refinedResults];

            // Re-synthesize ONLY the new refined snippets to avoid paying double input tokens.
            // The initial synthesis already processed the original snippets; this pass covers
            // only what's new. If both succeed, we keep only the refined result.
            const refinedOnlySynthesis = await llmSynthesizeFromSnippets(
              refinedResults.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
              query.name,
              query.context
            );

            if (refinedOnlySynthesis) {
              // Merge: take the better of the two (most additionalFacts wins as tiebreaker)
              if (refinedOnlySynthesis.extracted.additionalFacts.length >= bestSynthesis.extracted.additionalFacts.length) {
                bestSynthesis = refinedOnlySynthesis;
              }
              bestSynthesisUrl = "snippet-synthesis://refined";
              bestSynthesisConfidence = 0.80;
              emit({
                type: "extract",
                message: `Refined snippet synthesis: ${refinedOnlySynthesis.extracted.additionalFacts.length} additional fact(s)`,
                timestamp: new Date(),
              });
            }
          }
        }
      }

      // Add exactly ONE synthesis mention — the best result from initial or refined pass
      const synthMention = {
        sourceUrl: bestSynthesisUrl,
        fetchedAt: new Date(),
        confidence: bestSynthesisConfidence,
        extracted: bestSynthesis.extracted,
      };
      session.crawlState.extractedMentions.push(synthMention);
      resolver.addMention(synthMention);

      // If synthesis produced a rich profile, reduce page budget.
      const synth = bestSynthesis.extracted;
      const hasRole = (synth.experiences || []).length > 0;
      const hasEducation = synth.education.length > 0;
      const hasRichFacts = synth.additionalFacts.length >= 3;

      if ((hasRole || hasEducation) && hasRichFacts && cfg.pageBudget > 8) {
        const oldBudget = cfg.pageBudget;
        cfg.pageBudget = 8;
        session.crawlState.pageBudget = 8;
        emit({
          type: "info",
          message: `Rich snippet profile found — reducing page budget from ${oldBudget} to ${cfg.pageBudget} (crawl will fill gaps only)`,
          timestamp: new Date(),
          data: { oldBudget, newBudget: cfg.pageBudget },
        });
      }
    } else {
      emit({
        type: "info",
        message: "LLM snippet synthesis: no clear match found in initial snippets, proceeding with full crawl",
        timestamp: new Date(),
      });
    }

    // ── Phase 2: Initialize Frontier ──
    const frontier = new URLFrontier();
    const domainPageCounts = new Map<string, number>();

    // Add search results to frontier with initial scores (including refined query results)
    // Skip URLs that are snippet-only (blocked sites) — we already got their data from snippets
    for (const result of allSearchResults) {
      const strategy = routeUrl(result.url);

      if (strategy === "skip") continue;

      // For snippet-only URLs, don't add to frontier — we already extracted what we can
      if (strategy === "snippet-only") {
        const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
        if (urlScore < cfg.initialScoreThreshold) continue;
        const handled = await tryEnrichLinkedInUrl(
          result.url,
          "initial search results",
          `${result.title} ${result.snippet}`
        );
        if (handled) continue;
        emit({
          type: "info",
          message: `Skipping blocked site (snippet data already extracted): ${result.url}`,
          url: result.url,
          timestamp: new Date(),
        });
        continue;
      }

      const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
      // Apply the initial threshold (higher when context is provided) to filter wrong-person
      // pages before they enter the crawl. Discovered links use the lower minScoreThreshold.
      if (urlScore < cfg.initialScoreThreshold) continue;

      frontier.push({
        url: result.url,
        score: urlScore,
        reason: `Search result: ${result.title}`,
        depth: 0,
        sourcePage: "search",
        anchorText: result.title,
      });
    }

    // ── Phase 3: Recursive Crawl ──
    session.status = "crawling";
    const queryDescription = buildQueryDescription(query);
    let lastAdaptiveCheck = 0; // Pages visited at last adaptive query check
    // allQueriesUsed is declared above (Phase 1.6) — already seeded with searchQueries
    let emptyFrontierRescues = 0; // How many times we've rescued a drained frontier
    const MAX_EMPTY_FRONTIER_RESCUES = 2;
    let mentionCountAtLastCheck = session.crawlState.extractedMentions.length; // For no-progress detection
    let consecutiveNoProgressCycles = 0; // Adaptive cycles that found nothing new
    const MAX_NO_PROGRESS_CYCLES = 3; // Stop after this many consecutive empty cycles

    while (session.crawlState.pagesVisited < cfg.pageBudget) {
      // ── Frontier empty rescue ──
      // When the frontier drains but budget remains, run new searches to refill it.
      // Capped at MAX_EMPTY_FRONTIER_RESCUES to avoid infinite loops.
      if (frontier.size === 0) {
        if (
          emptyFrontierRescues >= MAX_EMPTY_FRONTIER_RESCUES
        ) {
          break;
        }

        emptyFrontierRescues++;

        const knownFacts = resolver.getClusters().length > 0
          ? resolver.summarizeByCluster()
          : summarizeKnownFacts(session.crawlState.extractedMentions);
        const gaps = resolver.getClusters().length > 0
          ? resolver.identifyGapsByCluster()
          : identifyGaps(session.crawlState.extractedMentions);

        emit({
          type: "info",
          message: `Frontier empty with ${cfg.pageBudget - session.crawlState.pagesVisited} pages of budget remaining — running rescue search (attempt ${emptyFrontierRescues}/${MAX_EMPTY_FRONTIER_RESCUES})...`,
          timestamp: new Date(),
        });

        // Re-use adaptive regen with rescue mode: LLM told to avoid social media, target crawlable sources
        const rescueResult = await llmAdaptiveQueryRegen(
          queryDescription,
          session.crawlState.pagesVisited,
          knownFacts,
          gaps,
          0, // frontier is empty
          0,
          allQueriesUsed,
          true // isFrontierRescue
        );

        if (!rescueResult || rescueResult.stopCrawling || rescueResult.newQueries.length === 0) {
          break;
        }

        const rescueQueries = rescueResult.newQueries
          .filter((q) => q && typeof q === "string" && q.trim().length > 0)
          .slice(0, 3);

        emit({
          type: "search",
          message: `Rescue search: ${rescueQueries.length} new queries`,
          timestamp: new Date(),
          data: { queries: rescueQueries, action: rescueResult.action },
        });

        allQueriesUsed.push(...rescueQueries);
        const rescueResults = await executeSearchQueries(rescueQueries);

        // Extract snippet mentions from rescue results
        const rescueSnippetMentions = extractFromSearchResults(rescueResults, query.name);
        const rescueResultMap = new Map(rescueResults.map((r) => [r.url, r]));
        for (const mention of rescueSnippetMentions) {
          if (query.context) {
            const result = rescueResultMap.get(mention.sourceUrl);
            if (result && scoreSearchResult(result.url, result.title, result.snippet, query) < cfg.initialScoreThreshold) continue;
          }
          session.crawlState.extractedMentions.push(mention);
          resolver.addMention(mention);
        }

        // Add crawlable URLs to frontier.
        // Use a relaxed score threshold for rescue (0.3 vs initialScoreThreshold 0.5) —
        // when the frontier is empty, borderline results are worth attempting.
        const RESCUE_SCORE_THRESHOLD = 0.3;
        let rescueAdded = 0;
        for (const result of rescueResults) {
          const strategy = routeUrl(result.url);
          if (strategy === "skip") continue;
          if (strategy === "snippet-only") {
            const hint = `${result.title} ${result.snippet}`;
            const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
            if (urlScore >= RESCUE_SCORE_THRESHOLD) {
              await tryEnrichLinkedInUrl(result.url, "rescue search", hint);
            }
            continue;
          }
          if (session.crawlState.urlsVisited.has(result.url) || frontier.has(result.url)) continue;
          const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
          if (urlScore < RESCUE_SCORE_THRESHOLD) continue;
          frontier.push({
            url: result.url,
            score: urlScore,
            reason: `Rescue search: ${result.title}`,
            depth: 0,
            sourcePage: "rescue_search",
            anchorText: result.title,
          });
          rescueAdded++;
        }

        if (rescueAdded > 0) {
          emit({
            type: "search",
            message: `Rescue search added ${rescueAdded} crawlable URL(s) to frontier`,
            timestamp: new Date(),
          });
        } else {
          emit({
            type: "info",
            message: `Rescue search found no crawlable URLs (attempt ${emptyFrontierRescues}/${MAX_EMPTY_FRONTIER_RESCUES})`,
            timestamp: new Date(),
          });
          // Don't break — loop back and try another rescue with different LLM queries,
          // unless we've exhausted MAX_EMPTY_FRONTIER_RESCUES (checked at top of loop).
        }

        lastAdaptiveCheck = session.crawlState.pagesVisited;
        continue; // Loop back to either crawl refilled frontier or attempt next rescue
      }

      const next = frontier.pop();
      if (!next) break;

      // Skip if already visited
      if (session.crawlState.urlsVisited.has(next.url)) continue;

      // Check per-domain cap
      const domain = getDomain(next.url);
      const domainCount = domainPageCounts.get(domain) || 0;
      if (domainCount >= cfg.maxPagesPerDomain) continue;

      // Check max depth
      if (next.depth > cfg.maxDepth) continue;

      // Snippet-only URLs cannot be crawled directly; enrich LinkedIn via Bright Data.
      const strategy = routeUrl(next.url);
      if (strategy === "skip") continue;
      if (strategy === "snippet-only") {
        await tryEnrichLinkedInUrl(next.url, "frontier link");
        continue;
      }

      // Fetch page
      session.crawlState.urlsVisited.add(next.url);
      session.crawlState.domainsVisited.add(domain);
      domainPageCounts.set(domain, domainCount + 1);
      session.crawlState.pagesVisited++;

      emit({
        type: "fetch",
        message: `Fetching page ${session.crawlState.pagesVisited}/${cfg.pageBudget}: ${next.url}`,
        url: next.url,
        timestamp: new Date(),
        data: { depth: next.depth, score: next.score, pageBudget: cfg.pageBudget },
      });

      const page = await fetchPage(next.url);
      if (!page) {
        emit({
          type: "error",
          message: `Failed to fetch: ${next.url}`,
          url: next.url,
          timestamp: new Date(),
        });
        continue;
      }

      // Skip LLM extraction if target profile is already rich and this page is low-priority
      if (resolver.isTargetComplete(0.85) && next.score < 0.7) {
        emit({
          type: "extract",
          message: `Skipping low-priority page (profile complete): ${next.url}`,
          url: next.url,
          timestamp: new Date(),
        });
        continue;
      }

      // Extract person data via LLM
      emit({
        type: "extract",
        message: `Extracting data from: ${page.title || next.url}`,
        url: next.url,
        timestamp: new Date(),
      });

      const extraction = await llmExtractPerson(
        query.name,
        queryDescription,
        next.url,
        page.markdown
      );

      logger.logExtraction(next.url, extraction);

      if (extraction && extraction.mentionsTarget) {
        const ex = extraction.extracted;
        const mention: PersonMention = {
          sourceUrl: next.url,
          fetchedAt: page.fetchedAt,
          confidence: extraction.confidence,
          extracted: {
            names: (ex.names || []).filter((n): n is string => typeof n === "string" && n.trim().length > 0),
            experiences: (ex.experiences || []).filter((e) => e != null && typeof e.title === "string" && typeof e.company === "string").map((e) => ({
              title: e.title,
              company: e.company,
              isCurrent: e.isCurrent,
              startDate: e.startDate ?? undefined,
              endDate: e.endDate ?? undefined,
              location: e.location ?? undefined,
              description: e.description ?? undefined,
            })),
            location: (typeof ex.location === "string") ? ex.location : undefined,
            education: (ex.education || []).filter((e): e is { institution: string; degree?: string; field?: string; year?: number } => e != null && typeof e.institution === "string"),
            skills: (ex.skills || []).filter((s) => s != null && typeof s.name === "string" && s.name.trim().length > 0).map((s) => ({
              name: s.name,
              proficiency: s.proficiency ?? undefined,
            })),
            socialLinks: (ex.socialLinks || []).filter((l): l is { platform: string; url: string } => l != null && typeof l.url === "string"),
            emails: (ex.emails || []).filter((e): e is string => typeof e === "string" && e.trim().length > 0),
            phones: (ex.phones || []).filter((p): p is string => typeof p === "string" && p.trim().length > 0),
            bioSnippet: (typeof ex.bioSnippet === "string") ? ex.bioSnippet : undefined,
            relationships: (ex.relationships || []).filter((r): r is { name: string; relationship: string } => r != null && typeof r.name === "string"),
            dates: (ex.dates || []).filter((d): d is { event: string; date: string } => d != null && typeof d.event === "string"),
            additionalFacts: (ex.additionalFacts || []).filter((f): f is string => typeof f === "string" && f.trim().length > 0),
            certifications: (ex.certifications || []).filter((c) => c != null && typeof c.name === "string").map((c) => ({
              name: c.name, issuer: c.issuer ?? undefined, year: c.year ?? undefined,
            })),
            publications: (ex.publications || []).filter((p) => p != null && typeof p.title === "string").map((p) => ({
              title: p.title, venue: p.venue ?? undefined, year: p.year ?? undefined, url: p.url ?? undefined, coAuthors: p.coAuthors,
            })),
            awards: (ex.awards || []).filter((a) => a != null && typeof a.title === "string").map((a) => ({
              title: a.title, issuer: a.issuer ?? undefined, year: a.year ?? undefined,
            })),
            languages: (ex.languages || []).filter((l): l is string => typeof l === "string" && l.trim().length > 0),
          },
        };

        // Multi-person page contamination filter: when a page is primarily about other people
        // (4+ other people extracted), strip additionalFacts that mention ONLY those other
        // people's names and NOT the target's name — those facts belong to someone else.
        if (extraction.otherPeople && extraction.otherPeople.length >= 4) {
          const otherNames = extraction.otherPeople
            .flatMap((p) => p.names || [])
            .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
            .map((n) => n.toLowerCase());
          const targetLower = query.name.toLowerCase();
          if (otherNames.length > 0) {
            mention.extracted.additionalFacts = mention.extracted.additionalFacts.filter((fact) => {
              const factLower = fact.toLowerCase();
              // Keep the fact if it mentions the target
              if (factLower.includes(targetLower)) return true;
              // Also keep if any target name word appears (handles "Alex" matching "Alexander")
              const targetWords = targetLower.split(/\s+/).filter((w) => w.length > 3);
              if (targetWords.some((w) => factLower.includes(w))) return true;
              // Drop only if the fact exclusively mentions other people's names
              const mentionsOther = otherNames.some((n) => factLower.includes(n));
              return !mentionsOther;
            });
          }
        }

        session.crawlState.extractedMentions.push(mention);
        resolver.addMention(mention);

        const firstExp = (extraction.extracted.experiences || [])[0];
        emit({
          type: "extract",
          message: `Found mention of ${query.name} (confidence: ${extraction.confidence.toFixed(2)})`,
          url: next.url,
          timestamp: new Date(),
          data: {
            confidence: extraction.confidence,
            title: firstExp?.title,
            company: firstExp?.company,
          },
        });
      }

      // Extract secondary people (other people mentioned on the page)
      if (extraction && extraction.otherPeople && extraction.otherPeople.length > 0) {
        for (const other of extraction.otherPeople) {
          const names = (other.names || []).filter((n): n is string => typeof n === "string" && n.trim().length > 0);
          if (names.length === 0) continue;

          // Build a relationship entry linking back to the target
          const relationships = other.relationshipToTarget
            ? [{ name: query.name, relationship: other.relationshipToTarget }]
            : [];

          const otherTitle = typeof other.title === "string" ? other.title : "";
          const otherCompany = typeof other.company === "string" ? other.company : "";
          const otherExperiences = (otherTitle || otherCompany)
            ? [{ title: otherTitle, company: otherCompany, isCurrent: true }]
            : [];
          const secondaryMention: PersonMention = {
            sourceUrl: next.url,
            fetchedAt: page.fetchedAt,
            confidence: 0.5, // Moderate confidence — extracted as a side-effect
            extracted: {
              names,
              experiences: otherExperiences,
              location: typeof other.location === "string" ? other.location : undefined,
              education: [],
              skills: [],
              socialLinks: [],
              emails: [],
              phones: [],
              bioSnippet: typeof other.bioSnippet === "string" ? other.bioSnippet : undefined,
              relationships,
              dates: [],
              additionalFacts: [],
              certifications: [],
              publications: [],
              awards: [],
              languages: [],
            },
          };
          session.crawlState.secondaryMentions.push(secondaryMention);
        }
      }

      // Score and enqueue outbound links
      if (
        page.links.length > 0 &&
        next.depth < cfg.maxDepth &&
        session.crawlState.pagesVisited < cfg.pageBudget
      ) {
        // Filter links we haven't seen
        const newLinks = page.links.filter(
          (l) =>
            !session.crawlState.urlsVisited.has(l.url) && !frontier.has(l.url)
        );

        if (newLinks.length > 0) {
          // Use heuristic pre-scoring to reduce LLM calls
          const preScored = newLinks
            .map((l) => ({
              ...l,
              heuristicScore: heuristicLinkScore(l.url, l.anchorText, query),
            }))
            .filter((l) => l.heuristicScore > 0.15)
            .sort((a, b) => b.heuristicScore - a.heuristicScore)
            .slice(0, 30); // Top 30 by heuristic

          if (preScored.length > 0) {
            emit({
              type: "score",
              message: `Scoring ${preScored.length} links from ${next.url}`,
              url: next.url,
              timestamp: new Date(),
            });

            // Use cluster-aware summaries when incremental resolution has run
            const knownFacts = resolver.getClusters().length > 0
              ? resolver.summarizeByCluster()
              : summarizeKnownFacts(session.crawlState.extractedMentions);
            const gaps = resolver.getClusters().length > 0
              ? resolver.identifyGapsByCluster()
              : identifyGaps(session.crawlState.extractedMentions);

            const scoredLinks = await llmScoreLinks(
              queryDescription,
              next.url,
              knownFacts,
              gaps,
              preScored.map((l) => ({ url: l.url, anchorText: l.anchorText }))
            );

            logger.logLinkScoring(next.url, scoredLinks);

            const newScoredUrls: ScoredURL[] = scoredLinks
              .filter((l) => l.score >= cfg.minScoreThreshold)
              .map((l) => ({
                url: l.url,
                score: l.score * (1 - next.depth * 0.1), // Depth penalty
                reason: l.reason,
                depth: next.depth + 1,
                sourcePage: next.url,
              }));

            frontier.pushMany(newScoredUrls);

            if (newScoredUrls.length > 0) {
              emit({
                type: "score",
                message: `Enqueued ${newScoredUrls.length} promising links (best score: ${newScoredUrls[0]?.score.toFixed(2)})`,
                timestamp: new Date(),
              });
            }
          }
        }
      }

      // ── Adaptive query regeneration ──
      if (
        session.crawlState.pagesVisited - lastAdaptiveCheck >= cfg.adaptiveQueryInterval &&
        session.crawlState.pagesVisited < cfg.pageBudget &&
        session.crawlState.extractedMentions.length > 0
      ) {
        lastAdaptiveCheck = session.crawlState.pagesVisited;

        // Run incremental resolution before summarizing (if enough mentions)
        if (resolver.mentionCount >= 3) {
          await resolver.resolve();
          const clusters = resolver.getClusters();
          const target = resolver.getTargetCluster();

          emit({
            type: "resolve",
            message: `Incremental resolution: ${clusters.length} cluster(s) from ${resolver.mentionCount} mentions`,
            timestamp: new Date(),
          });

          if (target) {
            emit({
              type: "resolve",
              message: `Target cluster: "${target.mentions[0]?.extracted.names[0] || "Unknown"}" (${target.mentions.length} mentions, completeness: ${(target.completeness.score * 100).toFixed(0)}%)`,
              timestamp: new Date(),
            });
          }

          // Only stop on completeness if profile is truly saturated (all 7 fields filled).
          // Otherwise let the no-progress counter below decide when to stop.
          if (resolver.isTargetComplete(0.97)) {
            emit({
              type: "info",
              message: `Target profile fully complete (${(target!.completeness.score * 100).toFixed(0)}% fields filled), stopping crawl`,
              timestamp: new Date(),
            });
            break;
          }
        }

        // ── No-progress detection ──
        // Count new mentions added since the last adaptive check.
        // After MAX_NO_PROGRESS_CYCLES consecutive empty cycles, stop — we've exhausted
        // what's findable without human-in-the-loop or auth'd access.
        const newMentionCount = session.crawlState.extractedMentions.length;
        const newMentionsThisCycle = newMentionCount - mentionCountAtLastCheck;
        mentionCountAtLastCheck = newMentionCount;

        if (newMentionsThisCycle === 0) {
          consecutiveNoProgressCycles++;
          emit({
            type: "info",
            message: `No new mentions found (${consecutiveNoProgressCycles}/${MAX_NO_PROGRESS_CYCLES} consecutive empty cycles)`,
            timestamp: new Date(),
          });
          if (consecutiveNoProgressCycles >= MAX_NO_PROGRESS_CYCLES) {
            emit({
              type: "info",
              message: `Stopping: ${MAX_NO_PROGRESS_CYCLES} consecutive search cycles found no new information`,
              timestamp: new Date(),
            });
            break;
          }
        } else {
          if (consecutiveNoProgressCycles > 0) {
            emit({
              type: "info",
              message: `Progress resumed: ${newMentionsThisCycle} new mention(s) found, resetting no-progress counter`,
              timestamp: new Date(),
            });
          }
          consecutiveNoProgressCycles = 0;
        }

        // Use cluster-aware summaries when available, otherwise fall back to flat summaries
        const knownFacts = resolver.getClusters().length > 0
          ? resolver.summarizeByCluster()
          : summarizeKnownFacts(session.crawlState.extractedMentions);
        const gaps = resolver.getClusters().length > 0
          ? resolver.identifyGapsByCluster()
          : identifyGaps(session.crawlState.extractedMentions);

        emit({
          type: "info",
          message: `Evaluating search strategy after ${session.crawlState.pagesVisited} pages...`,
          timestamp: new Date(),
        });

        const regenResult = await llmAdaptiveQueryRegen(
          queryDescription,
          session.crawlState.pagesVisited,
          knownFacts,
          gaps,
          frontier.size,
          frontier.size > 0 ? (frontier.peek()?.score ?? 0) : 0,
          allQueriesUsed
        );

        if (regenResult) {
          emit({
            type: "info",
            message: `Strategy: ${regenResult.action} — ${regenResult.reasoning}`,
            timestamp: new Date(),
            data: {
              action: regenResult.action,
              newQueries: regenResult.newQueries,
            },
          });

          if (regenResult.stopCrawling) {
            emit({
              type: "info",
              message: "Adaptive check: profile appears complete, stopping crawl.",
              timestamp: new Date(),
            });
            break;
          }

          // Execute new queries and add results to frontier
          if (
            (regenResult.action === "generate_queries" || regenResult.action === "both") &&
            regenResult.newQueries.length > 0
          ) {
            const newQueries = regenResult.newQueries
              .filter((q) => q && typeof q === "string" && q.trim().length > 0)
              .slice(0, 3);

            if (newQueries.length > 0) {
              emit({
                type: "search",
                message: `Generating ${newQueries.length} new search queries based on discovered facts`,
                timestamp: new Date(),
                data: { queries: newQueries },
              });

              allQueriesUsed.push(...newQueries);
              const newResults = await executeSearchQueries(newQueries);

              // Extract snippet data from adaptive search results too
              const adaptiveSnippetMentions = extractFromSearchResults(newResults, query.name);
              if (adaptiveSnippetMentions.length > 0) {
                // Apply the same context threshold to adaptive snippets to avoid wrong-person
                // mentions (e.g. Noah Liu at Santa Clara from a "Noah Liu USC CS" query).
                const adaptiveResultMap = new Map(newResults.map((r) => [r.url, r]));
                let acceptedAdaptive = 0;
                for (const mention of adaptiveSnippetMentions) {
                  if (query.context) {
                    const result = adaptiveResultMap.get(mention.sourceUrl);
                    if (result) {
                      const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
                      if (urlScore < cfg.initialScoreThreshold) continue;
                    }
                  }
                  session.crawlState.extractedMentions.push(mention);
                  resolver.addMention(mention);
                  acceptedAdaptive++;
                }
                if (acceptedAdaptive > 0) {
                  emit({
                    type: "extract",
                    message: `Extracted ${acceptedAdaptive} mention(s) from adaptive search snippets`,
                    timestamp: new Date(),
                  });
                }
              }

              let addedCount = 0;
              for (const result of newResults) {
                const strategy = routeUrl(result.url);
                if (strategy === "skip") continue;
                if (strategy === "snippet-only") {
                  const hint = `${result.title} ${result.snippet}`;
                  const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
                  if (urlScore >= cfg.initialScoreThreshold) {
                    await tryEnrichLinkedInUrl(result.url, "adaptive query results", hint);
                  }
                  continue;
                }

                if (
                  !session.crawlState.urlsVisited.has(result.url) &&
                  !frontier.has(result.url)
                ) {
                  const urlScore = scoreSearchResult(result.url, result.title, result.snippet, query);
                  if (urlScore < cfg.initialScoreThreshold) continue; // same gate as initial results
                  frontier.push({
                    url: result.url,
                    score: urlScore,
                    reason: `Adaptive search: ${result.title}`,
                    depth: 0, // New searches reset depth
                    sourcePage: "adaptive_search",
                    anchorText: result.title,
                  });
                  addedCount++;
                }
              }

              if (addedCount > 0) {
                emit({
                  type: "search",
                  message: `Added ${addedCount} new URLs from adaptive queries`,
                  timestamp: new Date(),
                });
              }
            }
          }
        }
      }

    }

    // ── Phase 4: Entity Resolution & Profile Building ──
    session.status = "resolving";
    emit({
      type: "resolve",
      message: `Resolving entities from ${session.crawlState.extractedMentions.length} mentions...`,
      timestamp: new Date(),
    });

    const entityClusters = await resolveEntities(
      session.crawlState.extractedMentions,
      query
    );

    emit({
      type: "resolve",
      message: `Identified ${entityClusters.length} distinct person(s)`,
      timestamp: new Date(),
    });

    logger.logResolution(entityClusters);

    // Resolve secondary people (other people discovered during research)
    const secondaryClusters = await resolveSecondaryPeople(session.crawlState.secondaryMentions);
    if (secondaryClusters.length > 0) {
      emit({
        type: "resolve",
        message: `Also discovered ${secondaryClusters.length} connected person(s) from ${session.crawlState.secondaryMentions.length} secondary mentions`,
        timestamp: new Date(),
      });
    }

    // Build profiles and cluster graph data
    const paired = entityClusters.map((cluster) => ({
      profile: buildSingleProfile(cluster),
      cluster,
    }));
    paired.sort((a, b) => {
      // Primary target clusters always before non-target
      if (a.cluster.isPrimaryTarget !== b.cluster.isPrimaryTarget) {
        return a.cluster.isPrimaryTarget ? -1 : 1;
      }
      // Among equally-ranked clusters, prefer those with richer biographical data.
      // A cluster with company name + bio beats one with only a job-posting title.
      const richness = (p: typeof a.profile) => {
        let r = 0;
        const curExp = p.experiences?.[0]?.value;
        if (curExp?.company && curExp.company.length > 2) r += 0.15;
        if (curExp?.title && curExp.title.length > 2) r += 0.10;
        if (p.education.length > 0) r += 0.10;
        if (p.bioSnippet && p.bioSnippet.length > 40) r += 0.15;
        return r;
      };
      return (b.profile.confidence + richness(b.profile)) - (a.profile.confidence + richness(a.profile));
    });

    // Build profiles for secondary people too
    const secondaryPaired = secondaryClusters.map((cluster) => ({
      profile: buildSingleProfile(cluster),
      cluster,
    }));

    // When user provides context, only show primary target profiles in the profile cards.
    // But always include ALL clusters in the cluster graph so the user can see all resolved entities.
    const profilePaired = query.context
      ? paired.filter((p) => p.cluster.isPrimaryTarget)
      : paired;

    session.profiles = profilePaired.map((p) => p.profile);

    // Generate LLM summaries for primary profiles in parallel
    await Promise.all(
      session.profiles.map(async (profile) => {
        profile.llmSummary = (await generateProfileSummary(profile)) ?? undefined;
      })
    );

    // Cluster data includes target clusters + secondary people clusters
    const allClusterData: ClusterData[] = [
      ...paired.map(({ profile, cluster }) => ({
        profileId: profile.id,
        profileName: profile.names[0]?.value || "Unknown",
        isPrimaryTarget: cluster.isPrimaryTarget,
        mentions: cluster.mentions.map((m) => mentionToClusterSummary(m)),
      })),
      ...secondaryPaired.map(({ profile, cluster }) => ({
        profileId: profile.id,
        profileName: profile.names[0]?.value || "Unknown",
        isPrimaryTarget: false,
        mentions: cluster.mentions.map((m) => mentionToClusterSummary(m)),
      })),
    ];
    session.clusterData = allClusterData;

    session.status = "complete";
    session.updatedAt = new Date();

    // Record token usage
    const totalTokens = tokenTracker.inputTokens + tokenTracker.outputTokens;
    session.crawlState.tokenUsage = {
      inputTokens: tokenTracker.inputTokens,
      outputTokens: tokenTracker.outputTokens,
      totalTokens,
      llmCalls: tokenTracker.llmCalls,
    };

    emit({
      type: "info",
      message: `Search complete. ${session.profiles.length} profile(s) built from ${session.crawlState.pagesVisited} pages across ${session.crawlState.domainsVisited.size} domains.`,
      timestamp: new Date(),
    });

    emit({
      type: "info",
      message: `LLM usage: ${tokenTracker.llmCalls} calls, ${tokenTracker.inputTokens.toLocaleString()} input tokens, ${tokenTracker.outputTokens.toLocaleString()} output tokens (${totalTokens.toLocaleString()} total)`,
      timestamp: new Date(),
      data: { tokenUsage: session.crawlState.tokenUsage },
    });

    console.log(`[GenSearch] Token usage for session ${sessionId}: ${tokenTracker.llmCalls} calls, ${tokenTracker.inputTokens} input + ${tokenTracker.outputTokens} output = ${totalTokens} total tokens`);

    logger.logProfiles(session.profiles);
    logger.logTokenUsage(session.crawlState.tokenUsage);
    logger.close(session.status);

    // Store frontier snapshot for debugging
    session.crawlState.frontier = frontier.toArray().slice(0, 20);

    return session;
  } catch (error) {
    session.status = "failed";
    session.error = error instanceof Error ? error.message : String(error);

    // Still record token usage on failure
    const totalTokens = tokenTracker.inputTokens + tokenTracker.outputTokens;
    session.crawlState.tokenUsage = {
      inputTokens: tokenTracker.inputTokens,
      outputTokens: tokenTracker.outputTokens,
      totalTokens,
      llmCalls: tokenTracker.llmCalls,
    };

    emit({
      type: "error",
      message: `Search failed: ${session.error}`,
      timestamp: new Date(),
    });
    console.log(`[GenSearch] Token usage for failed session ${sessionId}: ${tokenTracker.llmCalls} calls, ${totalTokens} total tokens`);
    logger.logTokenUsage(session.crawlState.tokenUsage);
    logger.close(session.status);
    return session;
  }
  }); // end runWithTracker
}

// ── Helper Functions ──

function buildQueryDescription(query: SearchQuery): string {
  if (query.context) return `${query.name}, ${query.context}`;
  return query.name;
}

const CONTEXT_STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "from", "are", "was", "not", "but"]);

/**
 * Score a search result URL for relevance to the query.
 * When context is provided, pages that don't match the context are penalised hard —
 * this is the primary gate that prevents wrong-person trails from dominating the crawl.
 */
function scoreSearchResult(
  url: string,
  title: string,
  snippet: string,
  query: SearchQuery
): number {
  let score = 0.5; // Base score for search results

  const lowerUrl = url.toLowerCase();
  const lowerTitle = (title || "").toLowerCase();
  const lowerSnippet = (snippet || "").toLowerCase();
  const lowerName = query.name.toLowerCase();

  // Name appears in title
  if (lowerTitle.includes(lowerName)) score += 0.2;

  // Name appears in snippet
  if (lowerSnippet.includes(lowerName)) score += 0.1;

  // High-value domains
  if (lowerUrl.includes("linkedin.com")) score += 0.15;
  if (lowerUrl.includes("github.com")) score += 0.1;
  if (lowerUrl.includes("scholar.google")) score += 0.1;

  // Profile-like URL patterns
  if (/\/(profile|about|team|people|author|speaker)/.test(lowerUrl)) score += 0.1;

  // Context matching — require a majority of non-trivial words to appear,
  // OR the context acronym (e.g. "USC" for "University of Southern California").
  // A weak match (e.g. "california" alone) is penalised so that wrong-person
  // sports/roster pages don't enter the crawl.
  if (query.context) {
    const contextWords = query.context.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2 && !CONTEXT_STOP_WORDS.has(w));

    // Build the acronym from capitalised words (e.g. "USC" for "University of Southern California")
    const acronym = query.context
      .split(/\s+/)
      .filter(w => /^[A-Z]/.test(w))
      .map(w => w[0])
      .join("")
      .toLowerCase();
    const acronymRe = acronym.length >= 2 ? new RegExp(`\\b${acronym}\\b`, "i") : null;
    const hasAcronym = acronymRe != null && (acronymRe.test(lowerTitle) || acronymRe.test(lowerSnippet));

    if (contextWords.length > 0) {
      // For regional LinkedIn subdomains (ca.linkedin.com, uk.linkedin.com, etc.): Google
      // highlights query terms in snippets even for wrong-country profiles. Only trust
      // title-level context (the profile's actual headline) for these URLs.
      const isRegionalLinkedIn = lowerUrl.includes("//ca.linkedin.com/") ||
        /\/\/[a-z]{2}\.linkedin\.com\//i.test(url);

      let matchCount = contextWords.filter(w => lowerTitle.includes(w) || lowerSnippet.includes(w)).length;
      const requiredMatches = Math.max(1, Math.ceil(contextWords.length * 0.5));
      let effectiveHasAcronym = hasAcronym;

      if (isRegionalLinkedIn) {
        // Title-only match for regional LinkedIn — snippet is not trustworthy
        const titleMatchCount = contextWords.filter(w => lowerTitle.includes(w)).length;
        const titleHasAcronym = acronymRe != null && acronymRe.test(lowerTitle);
        matchCount = titleMatchCount;
        effectiveHasAcronym = titleHasAcronym;
      }

      if (effectiveHasAcronym || matchCount >= requiredMatches) {
        // Acronym or majority word match: bonus (up to +0.20)
        const effectiveCount = effectiveHasAcronym ? contextWords.length : matchCount;
        score += Math.min(0.2, effectiveCount * 0.05);
      } else {
        // Context mismatch penalty.
        // Slightly stronger for regional LinkedIn (-0.40 vs -0.35) to account for the
        // full +0.15 LinkedIn domain bonus that these URLs also receive.
        score -= isRegionalLinkedIn ? 0.40 : 0.35;
      }
    }
  }

  return Math.min(Math.max(score, 0), 1.0);
}

function heuristicLinkScore(
  url: string,
  anchorText: string,
  query: SearchQuery
): number {
  let score = 0.1;
  const lowerUrl = url.toLowerCase();
  const lowerAnchor = anchorText.toLowerCase();
  const lowerName = query.name.toLowerCase();
  const nameParts = lowerName.split(" ");

  // Anchor text contains person name or parts of it
  if (lowerAnchor.includes(lowerName)) score += 0.4;
  else if (nameParts.some((p) => p.length > 2 && lowerAnchor.includes(p))) score += 0.15;

  // Context keywords in anchor or URL
  if (query.context) {
    const contextWords = query.context.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const matchCount = contextWords.filter(w => lowerAnchor.includes(w) || lowerUrl.includes(w)).length;
    if (matchCount > 0) score += Math.min(0.15, matchCount * 0.05);
  }

  // High-value URL patterns
  if (/\/(about|team|people|profile|author|speaker|bio|staff)/.test(lowerUrl))
    score += 0.2;
  if (lowerUrl.includes("linkedin.com")) score += 0.2;
  if (lowerUrl.includes("github.com")) score += 0.15;

  // Penalize obvious non-useful links
  if (/\/(login|signup|register|cart|privacy|terms|cookie)/.test(lowerUrl))
    score -= 0.3;
  if (/\.(pdf|zip|png|jpg|gif|mp4|mp3)$/i.test(lowerUrl)) score -= 0.2;

  return Math.max(0, Math.min(score, 1.0));
}

/**
 * Minimum confidence for a mention to be considered "likely the target person."
 * Set low enough to include snippet-based mentions (confidence ~0.35-0.45) so that
 * the adaptive query LLM has access to facts like company name ("WeKruit") from
 * search result snippets and can generate targeted queries.
 */
const MIN_CONFIDENCE_FOR_FACTS = 0.3;

function summarizeKnownFacts(mentions: PersonMention[]): string {
  if (mentions.length === 0) return "None yet";

  // Only include high-confidence mentions — low-confidence ones may be different people
  const trusted = mentions.filter((m) => m.confidence >= MIN_CONFIDENCE_FOR_FACTS);
  if (trusted.length === 0) return "None yet (all mentions below confidence threshold)";

  const facts: string[] = [];
  for (const m of trusted) {
    for (const exp of (m.extracted.experiences || [])) {
      if (exp.title) facts.push(`Title: ${exp.title}`);
      if (exp.company) facts.push(`Company: ${exp.company}`);
    }
    if (m.extracted.location) facts.push(`Location: ${m.extracted.location}`);
    if (m.extracted.education.length > 0)
      facts.push(`Education: ${m.extracted.education.map((e) => e.institution).join(", ")}`);
    for (const fact of m.extracted.additionalFacts.slice(0, 5)) {
      facts.push(fact);
    }
  }

  // Also note low-confidence mentions separately so the LLM knows they exist but are uncertain
  const uncertain = mentions.filter((m) => m.confidence < MIN_CONFIDENCE_FOR_FACTS && m.confidence > 0);
  if (uncertain.length > 0) {
    facts.push(`[${uncertain.length} low-confidence mention(s) excluded — may be different people with the same name]`);
  }

  const summary = [...new Set(facts)].join("; ") || "None yet";
  // Cap to prevent unbounded growth in LLM prompts
  return summary.length > 2000 ? summary.slice(0, 2000) + "..." : summary;
}

function identifyGaps(mentions: PersonMention[]): string {
  // Only consider high-confidence mentions for gap analysis
  const trusted = mentions.filter((m) => m.confidence >= MIN_CONFIDENCE_FOR_FACTS);

  const has = {
    title: false,
    company: false,
    location: false,
    education: false,
    email: false,
    social: false,
    bio: false,
  };

  for (const m of trusted) {
    if ((m.extracted.experiences || []).some((e) => e.title)) has.title = true;
    if ((m.extracted.experiences || []).some((e) => e.company)) has.company = true;
    if (m.extracted.location) has.location = true;
    if (m.extracted.education.length > 0) has.education = true;
    if ((m.extracted.emails || []).length > 0) has.email = true;
    if (m.extracted.socialLinks.length > 0) has.social = true;
    if (m.extracted.bioSnippet) has.bio = true;
  }

  const gaps: string[] = [];
  if (!has.title) gaps.push("job title");
  if (!has.company) gaps.push("current company");
  if (!has.location) gaps.push("location");
  if (!has.education) gaps.push("education history");
  if (!has.email) gaps.push("contact email");
  if (!has.social) gaps.push("social media profiles");
  if (!has.bio) gaps.push("biographical information");

  return gaps.length > 0 ? `Still need: ${gaps.join(", ")}` : "Profile is fairly complete";
}

function mentionToClusterSummary(m: PersonMention) {
  const exps = m.extracted.experiences || [];
  const primaryExp = exps.find((e) => e.isCurrent) ?? exps[0];
  return {
    sourceUrl: m.sourceUrl,
    sourceDomain: getDomain(m.sourceUrl),
    confidence: m.confidence,
    names: m.extracted.names.slice(0, 3),
    title: primaryExp?.title,
    company: primaryExp?.company,
    location: m.extracted.location,
    factCount:
      (m.extracted.experiences || []).length +
      [(m.extracted.location), (m.extracted.emails || [])[0], m.extracted.bioSnippet].filter(Boolean).length +
      m.extracted.education.length +
      (m.extracted.skills || []).length +
      m.extracted.socialLinks.length +
      m.extracted.additionalFacts.length,
  };
}

/**
 * Resolve secondary people (other people discovered during research) into clusters.
 * Groups by name similarity (Jaro-Winkler) since these are typically different people,
 * not different mentions of the same person. Simple name-based grouping is sufficient.
 */
async function resolveSecondaryPeople(
  mentions: PersonMention[]
): Promise<EntityCluster[]> {
  if (mentions.length === 0) return [];

  // Group by name: use first name as key, merge mentions with highly similar names
  const groups = new Map<string, PersonMention[]>();

  for (const m of mentions) {
    const name = m.extracted.names[0]?.toLowerCase().trim();
    if (!name) continue;

    // Check if this name matches an existing group
    let merged = false;
    for (const [groupName, groupMentions] of groups) {
      // Simple name matching — check if names are similar enough to merge
      const similarity = nameOverlap(name, groupName);
      if (similarity > 0.85) {
        groupMentions.push(m);
        merged = true;
        break;
      }
    }

    if (!merged) {
      groups.set(name, [m]);
    }
  }

  // Only return groups with at least 1 mention and some useful data
  const clusters: EntityCluster[] = [];
  for (const [, groupMentions] of groups) {
    // Skip people with no useful facts (just a name isn't enough)
    const hasData = groupMentions.some(
      (m) => (m.extracted.experiences || []).length > 0 || m.extracted.bioSnippet
    );
    if (!hasData) continue;

    clusters.push({
      mentions: groupMentions,
      isPrimaryTarget: false,
    });
  }

  return clusters;
}

/** Simple Jaro-Winkler-like name overlap for secondary person grouping */
function nameOverlap(a: string, b: string): number {
  if (a === b) return 1.0;
  // Check containment (handles "John Smith" vs "J. Smith" partially)
  if (a.includes(b) || b.includes(a)) return 0.9;
  // Word overlap
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  let matches = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) matches++;
  }
  const total = Math.max(wordsA.size, wordsB.size);
  return total > 0 ? matches / total : 0;
}
