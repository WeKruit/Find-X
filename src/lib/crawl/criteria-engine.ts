import { v4 as uuidv4 } from "uuid";
import type {
  CriteriaSearchSession,
  CriteriaCandidate,
  CrawlEvent,
  CriteriaDecomposition,
} from "@/types";
import { executeSearchQueries } from "@/lib/search";
import { fetchPage } from "./fetcher";
import { URLFrontier } from "./queue";
import { getDomain } from "./utils";
import {
  brightDataNameMatches,
  brightDataProfileToMention,
  collectLinkedInProfileByUrl,
  discoverLinkedInProfilesByName,
  hasBrightData,
  isLinkedInProfileUrl,
} from "./brightdata";
import { llmDecomposeCriteria, llmExtractMultiplePeople, llmScoreLinks, createTokenTracker, runWithTracker } from "@/lib/llm/client";
import { SessionLogger } from "@/lib/logger";

export interface CriteriaConfig {
  pageBudget: number;
  maxDepth: number;
  maxPagesPerDomain: number;
  maxCandidates: number;
  minMatchScore: number;
}

const DEFAULT_CONFIG: CriteriaConfig = {
  pageBudget: 40,      // Higher than person search — breadth matters more
  maxDepth: 2,         // Shallower — we want list pages, not deep profiles
  maxPagesPerDomain: 8,
  maxCandidates: 20,
  minMatchScore: 0.25,
};

type EventCallback = (event: CrawlEvent) => void;

/**
 * Criteria search engine: discover multiple people matching freeform criteria.
 * Phase 1 only — builds light profiles for candidates. Deep search is separate.
 */
export async function runCriteriaSearch(
  criteria: string,
  onEvent?: EventCallback,
  config: Partial<CriteriaConfig> = {}
): Promise<CriteriaSearchSession> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sessionId = uuidv4();
  const tokenTracker = createTokenTracker();

  return runWithTracker(tokenTracker, async () => {
  const session: CriteriaSearchSession = {
    id: sessionId,
    criteria,
    status: "searching",
    candidates: [],
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

  const logger = new SessionLogger(sessionId, { mode: "criteria", name: "", criteria });

  const MAX_EVENTS = 500;
  const COMPACT_THRESHOLD = MAX_EVENTS + 50;
  const emit = (event: CrawlEvent) => {
    session.crawlState.events.push(event);
    logger.logEvent(event);
    if (session.crawlState.events.length >= COMPACT_THRESHOLD) {
      const recent = session.crawlState.events.slice(-(MAX_EVENTS - 50));
      session.crawlState.events = [
        ...session.crawlState.events.slice(0, 50),
        ...recent,
      ];
    }
    try {
      onEvent?.(event);
    } catch {
      // Client likely disconnected — swallow and continue
    }
  };

  try {
    // ── Step 1: Decompose criteria into search signals ──
    emit({
      type: "info",
      message: "Analyzing search criteria...",
      timestamp: new Date(),
    });

    const decomposition = await llmDecomposeCriteria(criteria);
    if (!decomposition || decomposition.searchQueries.length === 0) {
      session.status = "failed";
      session.error = "Could not parse search criteria. Try being more specific.";
      emit({
        type: "error",
        message: session.error,
        timestamp: new Date(),
      });
      return session;
    }

    emit({
      type: "info",
      message: `Decomposed criteria into ${decomposition.requiredTraits.length} required traits and ${decomposition.searchQueries.length} search queries`,
      timestamp: new Date(),
      data: {
        requiredTraits: decomposition.requiredTraits,
        queries: decomposition.searchQueries,
      },
    });

    // ── Step 2: Execute search queries ──
    session.status = "searching";
    emit({
      type: "search",
      message: "Searching across providers...",
      timestamp: new Date(),
    });

    // Use more queries than person search for broader coverage
    const searchQueries = decomposition.searchQueries.slice(0, 10);
    const searchResults = await executeSearchQueries(searchQueries);

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
        message: "No search results found. Try broadening the criteria.",
        timestamp: new Date(),
      });
      return session;
    }

    // ── Step 3: Crawl and extract people ──
    session.status = "crawling";
    const frontier = new URLFrontier();
    const domainPageCounts = new Map<string, number>();

    // Seed frontier — prioritize pages likely to list multiple people
    for (const result of searchResults) {
      const score = scoreCriteriaResult(result.url, result.title, result.snippet, decomposition);
      frontier.push({
        url: result.url,
        score,
        reason: `Search result: ${result.title}`,
        depth: 0,
        sourcePage: "search",
        anchorText: result.title,
      });
    }

    // Raw candidates before deduplication
    const rawCandidates: Array<{
      name: string;
      title?: string;
      company?: string;
      location?: string;
      matchScore: number;
      matchReasoning: string;
      evidenceSnippet: string;
      sourceUrl: string;
      additionalFacts: { education?: string; skills?: string[]; socialUrl?: string; organizations?: string[] };
    }> = [];

    // Track URL attempts separately so snippet-only/failed fetches don't eat the budget.
    // pagesVisited counts only successful content fetches; maxAttempts prevents infinite loops.
    const maxAttempts = cfg.pageBudget * 3;
    let pagesAttempted = 0;

    while (
      frontier.size > 0 &&
      session.crawlState.pagesVisited < cfg.pageBudget &&
      pagesAttempted < maxAttempts
    ) {
      const next = frontier.pop();
      if (!next) break;
      if (session.crawlState.urlsVisited.has(next.url)) continue;

      const domain = getDomain(next.url);
      const domainCount = domainPageCounts.get(domain) || 0;
      if (domainCount >= cfg.maxPagesPerDomain) continue;
      if (next.depth > cfg.maxDepth) continue;

      pagesAttempted++;
      session.crawlState.urlsVisited.add(next.url);
      session.crawlState.domainsVisited.add(domain);
      domainPageCounts.set(domain, domainCount + 1);

      const page = await fetchPage(next.url);
      if (!page) {
        // Snippet-only or failed fetch — don't count against content budget, no "fetch" event
        continue;
      }

      session.crawlState.pagesVisited++;

      emit({
        type: "fetch",
        message: `Fetching page ${session.crawlState.pagesVisited}/${cfg.pageBudget}: ${next.url}`,
        url: next.url,
        timestamp: new Date(),
        data: { depth: next.depth, score: next.score, pageBudget: cfg.pageBudget },
      });

      // Extract ALL people from this page
      emit({
        type: "extract",
        message: `Extracting people from: ${page.title || next.url}`,
        url: next.url,
        timestamp: new Date(),
      });

      const extraction = await llmExtractMultiplePeople(
        criteria,
        decomposition.requiredTraits,
        next.url,
        page.markdown
      );

      if (extraction && extraction.peopleFound.length > 0) {
        const validPeople = extraction.peopleFound.filter(
          (p) => p.name && typeof p.name === "string" && p.name.trim().length > 0
        );

        for (const person of validPeople) {
          rawCandidates.push({
            name: person.name.trim(),
            title: typeof person.title === "string" ? person.title : undefined,
            company: typeof person.company === "string" ? person.company : undefined,
            location: typeof person.location === "string" ? person.location : undefined,
            matchScore: typeof person.matchScore === "number" ? person.matchScore : 0.5,
            matchReasoning: person.matchReasoning || "",
            evidenceSnippet: person.criteriaEvidence || "",
            sourceUrl: next.url,
            additionalFacts: person.additionalFacts || {},
          });
        }

        emit({
          type: "extract",
          message: `Found ${validPeople.length} people on this page (${rawCandidates.length} total candidates)`,
          url: next.url,
          timestamp: new Date(),
          data: {
            peopleCount: validPeople.length,
            topMatch: validPeople[0]?.name,
          },
        });
      }

      // Score outbound links for more candidate pages
      if (
        page.links.length > 0 &&
        next.depth < cfg.maxDepth
      ) {
        const newLinks = page.links.filter(
          (l) => !session.crawlState.urlsVisited.has(l.url) && !frontier.has(l.url)
        );

        // Heuristic pre-filter for criteria search: prefer list/team pages
        const preScored = newLinks
          .map((l) => ({
            ...l,
            heuristicScore: heuristicCriteriaLinkScore(l.url, l.anchorText, decomposition),
          }))
          .filter((l) => l.heuristicScore > 0.2)
          .sort((a, b) => b.heuristicScore - a.heuristicScore)
          .slice(0, 20);

        if (preScored.length > 0) {
          const scoredLinks = await llmScoreLinks(
            `Find people matching: ${criteria}`,
            next.url,
            `Found ${rawCandidates.length} candidates so far`,
            `Need more people matching: ${decomposition.requiredTraits.join(", ")}`,
            preScored.map((l) => ({ url: l.url, anchorText: l.anchorText }))
          );

          const newScoredUrls = scoredLinks
            .filter((l) => l.score >= 0.4)
            .map((l) => ({
              url: l.url,
              score: l.score * (1 - next.depth * 0.15),
              reason: l.reason,
              depth: next.depth + 1,
              sourcePage: next.url,
            }));

          frontier.pushMany(newScoredUrls);
        }
      }
    }

    // ── Step 4: Deduplicate and rank candidates ──
    session.status = "ranking";
    emit({
      type: "resolve",
      message: `Deduplicating and ranking ${rawCandidates.length} raw candidates...`,
      timestamp: new Date(),
    });

    const deduped = deduplicateCandidates(rawCandidates);

    // Filter by minimum match score and sort
    const ranked = deduped
      .filter((c) => c.matchScore >= cfg.minMatchScore)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, cfg.maxCandidates);

    if (ranked.length > 0 && hasBrightData()) {
      emit({
        type: "info",
        message: `Running LinkedIn enrichment for ${ranked.length} ranked candidate(s) via Bright Data...`,
        timestamp: new Date(),
      });
      const enrichedCount = await enrichCandidatesWithLinkedIn(ranked, emit);
      if (enrichedCount > 0) {
        emit({
          type: "info",
          message: `LinkedIn enrichment updated ${enrichedCount} candidate(s)`,
          timestamp: new Date(),
        });
      }
    }

    session.candidates = ranked;
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
      message: `Criteria search complete. ${ranked.length} candidates found from ${session.crawlState.pagesVisited} pages across ${session.crawlState.domainsVisited.size} domains.`,
      timestamp: new Date(),
    });

    emit({
      type: "info",
      message: `LLM usage: ${tokenTracker.llmCalls} calls, ${tokenTracker.inputTokens.toLocaleString()} input tokens, ${tokenTracker.outputTokens.toLocaleString()} output tokens (${totalTokens.toLocaleString()} total)`,
      timestamp: new Date(),
      data: { tokenUsage: session.crawlState.tokenUsage },
    });

    console.log(`[GenSearch] Token usage for criteria session ${sessionId}: ${tokenTracker.llmCalls} calls, ${tokenTracker.inputTokens} input + ${tokenTracker.outputTokens} output = ${totalTokens} total tokens`);

    logger.logTokenUsage(session.crawlState.tokenUsage);
    logger.close(session.status);

    return session;
  } catch (error) {
    session.status = "failed";
    session.error = error instanceof Error ? error.message : String(error);

    const totalTokens = tokenTracker.inputTokens + tokenTracker.outputTokens;
    session.crawlState.tokenUsage = {
      inputTokens: tokenTracker.inputTokens,
      outputTokens: tokenTracker.outputTokens,
      totalTokens,
      llmCalls: tokenTracker.llmCalls,
    };

    emit({
      type: "error",
      message: `Criteria search failed: ${session.error}`,
      timestamp: new Date(),
    });
    console.log(`[GenSearch] Token usage for failed criteria session ${sessionId}: ${tokenTracker.llmCalls} calls, ${totalTokens} total tokens`);
    logger.logTokenUsage(session.crawlState.tokenUsage);
    logger.close(session.status);
    return session;
  }
  }); // end runWithTracker
}

// ── Helper Functions ──

/**
 * Score a search result for criteria search — prefer pages listing multiple people.
 */
function scoreCriteriaResult(
  url: string,
  title: string,
  snippet: string,
  decomposition: CriteriaDecomposition
): number {
  let score = 0.5;
  const lowerUrl = url.toLowerCase();
  const lowerTitle = (title || "").toLowerCase();
  const lowerSnippet = (snippet || "").toLowerCase();

  // Keywords from decomposition appear in title/snippet
  const keywordMatches = decomposition.keywords.filter(
    (k) => lowerTitle.includes(k.toLowerCase()) || lowerSnippet.includes(k.toLowerCase())
  ).length;
  score += Math.min(0.2, keywordMatches * 0.05);

  // URL patterns that suggest list pages (high value for criteria search)
  if (/\/(team|people|about|speakers|alumni|fellows|portfolio|members|staff|directory|organizations|clubs|roster|student-orgs)/.test(lowerUrl))
    score += 0.2;
  if (/\/(awards|winners|recipients|scholars|cohort|batch|class-of)/.test(lowerUrl))
    score += 0.15;

  // High-value domains
  if (lowerUrl.includes("linkedin.com")) score += 0.1;
  if (lowerUrl.includes("crunchbase.com")) score += 0.1;
  if (lowerUrl.includes("github.com")) score += 0.05;

  // News/blog/spotlight pages that name individual people — high value
  if (/\/(news|blog|article|post|press|spotlight|profile|student-spotlight|meet)/.test(lowerUrl)) score += 0.1;
  if (/spotlight|profile|meet-our|featured|student-of/i.test(lowerTitle)) score += 0.1;

  // Boost preferred domains, penalize exclusion domains
  if (decomposition.preferredDomains.some((d) => lowerUrl.includes(d.toLowerCase()))) score += 0.25;
  if (decomposition.exclusionDomains.some((d) => lowerUrl.includes(d.toLowerCase()))) score -= 0.5;

  // Penalize results matching exclusion signals
  const exclusionHits = decomposition.exclusionSignals.filter(
    (s) => lowerTitle.includes(s.toLowerCase()) || lowerSnippet.includes(s.toLowerCase())
  ).length;
  score -= exclusionHits * 0.1;

  return Math.min(Math.max(score, 0), 1.0);
}

/**
 * Heuristic link scoring for criteria search — favor team/list pages.
 */
function heuristicCriteriaLinkScore(
  url: string,
  anchorText: string,
  decomposition: CriteriaDecomposition
): number {
  let score = 0.1;
  const lowerUrl = url.toLowerCase();
  const lowerAnchor = anchorText.toLowerCase();

  // Keywords in anchor or URL
  const keywordMatches = decomposition.keywords.filter(
    (k) => lowerAnchor.includes(k.toLowerCase()) || lowerUrl.includes(k.toLowerCase())
  ).length;
  score += Math.min(0.2, keywordMatches * 0.05);

  // Team/list page patterns
  if (/\/(team|people|about|speakers|alumni|fellows|portfolio|members|staff|directory|organizations|clubs|roster|student-orgs)/.test(lowerUrl))
    score += 0.3;
  if (/team|people|about|speakers|alumni|founders|members|organizations|clubs|roster/i.test(lowerAnchor))
    score += 0.2;

  // Student spotlight/blog pages — naming individuals
  if (/\/(spotlight|blog|profile|news|article|post|student-life|meet)/.test(lowerUrl)) score += 0.15;
  if (/spotlight|profile|meet|featured|our story|student life/i.test(lowerAnchor)) score += 0.15;

  // LinkedIn/social profiles
  if (lowerUrl.includes("linkedin.com")) score += 0.15;

  // Boost preferred domains, penalize exclusion domains
  if (decomposition.preferredDomains.some((d) => lowerUrl.includes(d.toLowerCase()))) score += 0.2;
  if (decomposition.exclusionDomains.some((d) => lowerUrl.includes(d.toLowerCase()))) score -= 0.5;

  // Exclusion patterns
  if (/\/(login|signup|register|cart|privacy|terms|cookie)/.test(lowerUrl))
    score -= 0.3;
  if (/\.(pdf|zip|png|jpg|gif|mp4|mp3)$/i.test(lowerUrl))
    score -= 0.2;

  return Math.max(0, Math.min(score, 1.0));
}

/**
 * Deduplicate candidates by name similarity + merge evidence from multiple sources.
 */
function deduplicateCandidates(
  raw: Array<{
    name: string;
    title?: string;
    company?: string;
    location?: string;
    matchScore: number;
    matchReasoning: string;
    evidenceSnippet: string;
    sourceUrl: string;
    additionalFacts: { education?: string; skills?: string[]; socialUrl?: string; organizations?: string[] };
  }>
): CriteriaCandidate[] {
  const merged = new Map<string, CriteriaCandidate>();

  for (const raw_candidate of raw) {
    // Normalize name for dedup key
    const key = raw_candidate.name.toLowerCase().replace(/[^a-z ]/g, "").trim();
    if (!key) continue;

    const existing = merged.get(key);
    if (existing) {
      // Merge: keep highest score, add source, merge evidence
      if (raw_candidate.matchScore > existing.matchScore) {
        existing.matchScore = raw_candidate.matchScore;
        existing.matchReasoning = raw_candidate.matchReasoning;
        existing.evidenceSnippet = raw_candidate.evidenceSnippet;
      }
      if (!existing.title && raw_candidate.title) existing.title = raw_candidate.title;
      if (!existing.company && raw_candidate.company) existing.company = raw_candidate.company;
      if (!existing.location && raw_candidate.location) existing.location = raw_candidate.location;
      if (!existing.sourceUrls.includes(raw_candidate.sourceUrl)) {
        existing.sourceUrls.push(raw_candidate.sourceUrl);
      }
      // Merge organizations lists
      if (raw_candidate.additionalFacts.organizations?.length) {
        const existingOrgs = existing.additionalFacts.organizations ?? [];
        const newOrgs = raw_candidate.additionalFacts.organizations.filter(o => !existingOrgs.includes(o));
        if (newOrgs.length) existing.additionalFacts.organizations = [...existingOrgs, ...newOrgs];
      }
      // Boost score for multi-source corroboration
      existing.matchScore = Math.min(1.0, existing.matchScore + 0.05 * (existing.sourceUrls.length - 1));
    } else {
      merged.set(key, {
        id: uuidv4(),
        name: raw_candidate.name,
        title: raw_candidate.title,
        company: raw_candidate.company,
        location: raw_candidate.location,
        matchScore: raw_candidate.matchScore,
        matchReasoning: raw_candidate.matchReasoning,
        evidenceSnippet: raw_candidate.evidenceSnippet,
        sourceUrls: [raw_candidate.sourceUrl],
        additionalFacts: raw_candidate.additionalFacts,
      });
    }
  }

  return Array.from(merged.values());
}

async function enrichCandidatesWithLinkedIn(
  candidates: CriteriaCandidate[],
  emit: EventCallback
): Promise<number> {
  let enrichedCount = 0;
  for (const candidate of candidates) {
    const linkedinUrl = await findCandidateLinkedInUrl(candidate);
    if (!linkedinUrl) continue;

    emit({
      type: "fetch",
      message: `Enriching candidate from LinkedIn via Bright Data: ${candidate.name}`,
      url: linkedinUrl,
      timestamp: new Date(),
    });

    const profile = await collectLinkedInProfileByUrl(linkedinUrl);
    if (!profile) continue;

    const mention = brightDataProfileToMention(profile, linkedinUrl, candidate.name);
    if (!mention) continue;

    // Merge richer LinkedIn fields into the candidate card
    const exp = mention.extracted.experiences[0];
    if (!candidate.title && exp?.title) candidate.title = exp.title;
    if (!candidate.company && exp?.company) candidate.company = exp.company;
    if (!candidate.location && mention.extracted.location) candidate.location = mention.extracted.location;
    if (!candidate.additionalFacts.socialUrl) candidate.additionalFacts.socialUrl = mention.sourceUrl;

    candidate.matchScore = Math.min(1, candidate.matchScore + 0.05);
    candidate.matchReasoning = candidate.matchReasoning
      ? `${candidate.matchReasoning}; LinkedIn verified via Bright Data`
      : "LinkedIn verified via Bright Data";
    if (!candidate.evidenceSnippet && mention.extracted.bioSnippet) {
      candidate.evidenceSnippet = mention.extracted.bioSnippet;
    }

    enrichedCount++;
  }
  return enrichedCount;
}

async function findCandidateLinkedInUrl(candidate: CriteriaCandidate): Promise<string | null> {
  const hintUrl = candidate.additionalFacts.socialUrl;
  if (hintUrl && isLinkedInProfileUrl(hintUrl)) return hintUrl;

  const discovered = await discoverLinkedInProfilesByName(candidate.name, 3);
  for (const item of discovered) {
    if (!item.url) continue;
    if (item.name && !brightDataNameMatches(item.name, candidate.name)) continue;
    return item.url;
  }
  return null;
}
