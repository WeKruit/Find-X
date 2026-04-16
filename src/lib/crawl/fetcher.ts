import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { PageContent, PageLink } from "@/types";
import { hasFirecrawl, fetchWithFirecrawl } from "./firecrawl";
import { hasPlaywright, fetchWithPlaywright } from "./playwright";
import { hasJina, fetchWithJina } from "./jina";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Domains to skip (ads, trackers, social widgets, etc.)
const SKIP_DOMAINS = new Set([
  "facebook.com/sharer",
  "twitter.com/intent",
  "t.co",
  "bit.ly",
  "ads.",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
]);

// ── Smart URL Routing ──

export type FetchStrategy = "normal" | "snippet-only" | "skip";

/**
 * Classify a URL and return the appropriate fetch strategy.
 * Domain-aware routing prevents wasting fetches on sites we can't scrape.
 */
// File extensions that are never fetchable as HTML person-profile pages.
// PDFs in particular cause Playwright to hang for 20s before timing out.
const SKIP_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|zip|gz|tar|mp4|mp3|avi|mov|png|jpe?g|gif|svg|woff2?|ttf|eot)$/i;

export function routeUrl(url: string): FetchStrategy {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // Binary/document file extensions — no person-profile data, skip immediately.
    // PDFs are the main offender: Playwright hangs 20s trying to navigate to them.
    if (SKIP_EXTENSIONS.test(path)) {
      return "skip";
    }

    // LinkedIn → always snippet-only (Voyager API doesn't work from Node.js due to TLS fingerprinting)
    if (host.includes("linkedin.com")) {
      return "snippet-only";
    }

    // Facebook → always blocked for scraping, rely on snippets
    if (host.includes("facebook.com") || host.includes("fb.com")) {
      return "snippet-only";
    }

    // Instagram → API-gated, can't scrape
    if (host.includes("instagram.com")) {
      return "snippet-only";
    }

    // Twitter/X → API-gated since 2023
    if (host.includes("twitter.com") || host.includes("x.com")) {
      return "snippet-only";
    }

    // Known ad/tracker domains
    for (const skip of SKIP_DOMAINS) {
      if (host.includes(skip)) return "skip";
    }

    // Everything else → normal tiered fetch
    return "normal";
  } catch {
    return "normal";
  }
}

// Minimum content length to consider a Tier 1 fetch successful
// Below this, the page likely needs JS rendering → fall back to Firecrawl
const MIN_CONTENT_LENGTH = 100;

// Per-domain rate limiter state
const domainLastFetch = new Map<string, number>();
const MIN_DELAY_MS = 2000; // 2 seconds between requests to same domain

// Domain fetch memory: track which tier last succeeded per domain
// If Tier 1 consistently fails for a domain, skip straight to Tier 2
const domainTierMemory = new Map<string, { tier1Fails: number; skipTier1: boolean }>();
const TIER1_FAIL_THRESHOLD = 2; // After 2 Tier 1 failures for a domain, skip to Tier 2

async function respectRateLimit(domain: string): Promise<void> {
  const last = domainLastFetch.get(domain);
  if (last) {
    const elapsed = Date.now() - last;
    if (elapsed < MIN_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS - elapsed));
    }
  }
  domainLastFetch.set(domain, Date.now());
}

function recordTier1Failure(domain: string): void {
  const mem = domainTierMemory.get(domain) || { tier1Fails: 0, skipTier1: false };
  mem.tier1Fails++;
  if (mem.tier1Fails >= TIER1_FAIL_THRESHOLD) {
    mem.skipTier1 = true;
  }
  domainTierMemory.set(domain, mem);
}

function shouldSkipTier1(domain: string): boolean {
  return domainTierMemory.get(domain)?.skipTier1 ?? false;
}

// Cache robots.txt results per domain to avoid repeated fetches
const robotsCache = new Map<string, boolean>();

/**
 * Check robots.txt for a domain. Returns true if the URL is allowed.
 */
async function checkRobotsTxt(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const cacheKey = u.host;
    if (robotsCache.has(cacheKey)) return robotsCache.get(cacheKey)!;

    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const response = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "GenSearchBot/1.0" },
    });
    if (!response.ok) {
      robotsCache.set(cacheKey, true);
      return true;
    }

    const text = await response.text();
    const lines = text.split("\n");
    let inOurSection = false;
    let inWildcardSection = false;

    for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith("user-agent:")) {
        const agent = trimmed.replace("user-agent:", "").trim();
        inOurSection = agent === "gensearchbot";
        inWildcardSection = agent === "*";
      } else if (
        (inOurSection || inWildcardSection) &&
        trimmed.startsWith("disallow:")
      ) {
        const path = trimmed.replace("disallow:", "").trim();
        if (path && u.pathname.startsWith(path)) {
          robotsCache.set(cacheKey, false);
          return false;
        }
      }
    }
    robotsCache.set(cacheKey, true);
    return true;
  } catch {
    return true;
  }
}

/**
 * Fetch a page using smart domain-aware routing + tiered strategy:
 *   Route: PDFs/binaries → skip | LinkedIn/social → snippet-only
 *   Normal:
 *     Tier 1: Direct HTTP + Readability (free, instant)
 *     Tier 2: Jina Reader (cheap ML extraction, JS rendering, no anti-bot)
 *     Tier 3: Playwright (free local Chromium, for when Jina fails)
 *     Tier 4: Firecrawl (paid, anti-bot Fire-engine, last resort)
 */
export async function fetchPage(url: string): Promise<PageContent | null> {
  try {
    const strategy = routeUrl(url);

    if (strategy === "skip") return null;

    if (strategy === "snippet-only") {
      console.log(`[Router] Snippet-only for ${url} (blocked/API-gated site)`);
      return null;
    }

    // Normal tiered fetch
    const u = new URL(url);
    const domain = u.hostname;

    // Skip known bad domains
    for (const skip of SKIP_DOMAINS) {
      if (domain.includes(skip)) return null;
    }

    // Check robots.txt
    const allowed = await checkRobotsTxt(url);
    if (!allowed) {
      console.log(`Blocked by robots.txt: ${url}`);
      return null;
    }

    // Tier 1: Direct HTTP fetch
    if (!shouldSkipTier1(domain)) {
      const tier1Result = await fetchTier1(url);
      if (tier1Result && tier1Result.markdown.length >= MIN_CONTENT_LENGTH) {
        return tier1Result;
      }
      recordTier1Failure(domain);
    } else {
      console.log(`[Router] Skipping Tier 1 for ${domain} (previous failures), trying Jina`);
    }

    // Tier 2: Jina Reader (ML-based extraction, JS rendering, cheap)
    if (hasJina()) {
      console.log(`Tier 1 insufficient for ${url}, trying Jina...`);
      const tier2Result = await fetchWithJina(url);
      if (tier2Result && tier2Result.markdown.length >= MIN_CONTENT_LENGTH) {
        return tier2Result;
      }
    }

    // Tier 3: Playwright (free local Chromium, for sites Jina can't handle)
    if (await hasPlaywright()) {
      console.log(`Tier 2 insufficient for ${url}, trying Playwright...`);
      const tier3Result = await fetchWithPlaywright(url);
      if (tier3Result && tier3Result.markdown.length >= MIN_CONTENT_LENGTH) {
        return tier3Result;
      }
    }

    // Tier 4: Firecrawl (anti-bot Fire-engine, paid — only when everything else fails)
    if (hasFirecrawl()) {
      console.log(`Tier 3 insufficient for ${url}, trying Firecrawl...`);
      const tier4Result = await fetchWithFirecrawl(url);
      if (tier4Result) {
        return tier4Result;
      }
    }

    console.log(`All fetch tiers failed for ${url}`);
    return null;
  } catch (error) {
    console.error(`Fetch failed for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Tier 1: Direct HTTP fetch + Readability extraction.
 * Free and fast. Works for ~90% of pages.
 */
async function fetchTier1(url: string): Promise<PageContent | null> {
  try {
    const u = new URL(url);
    await respectRateLimit(u.hostname);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GenSearchBot/1.0; +https://gensearch.dev/bot)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      console.log(`Tier 1: HTTP ${response.status} for ${url}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return null;
    }

    const html = await response.text();
    return parseHtmlContent(url, html, "http");
  } catch (error) {
    console.log(`Tier 1 failed for ${url}:`, error instanceof Error ? error.message : "unknown");
    return null;
  }
}

/**
 * Parse HTML into clean markdown and extract links.
 */
function parseHtmlContent(
  url: string,
  html: string,
  method: "http" | "playwright"
): PageContent {
  const { document } = parseHTML(html);

  // Extract links before Readability strips them
  const links = extractLinks(url, document);

  // Use Readability to get main content
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  let markdown: string;
  let title: string;

  if (article) {
    title = article.title || "";
    markdown = turndown.turndown(article.content || "");
  } else {
    // Fallback: get body text
    title = document.querySelector("title")?.textContent || "";
    const body = document.querySelector("body");
    markdown = body ? turndown.turndown(body.innerHTML) : "";
  }

  // Truncate very long pages
  if (markdown.length > 15000) {
    markdown = markdown.slice(0, 15000) + "\n\n[Content truncated]";
  }

  return {
    url,
    title,
    markdown,
    links,
    fetchedAt: new Date(),
    fetchMethod: method,
  };
}

/**
 * Extract all links from an HTML document.
 */
function extractLinks(
  baseUrl: string,
  document: ReturnType<typeof parseHTML>["document"]
): PageLink[] {
  const links: PageLink[] = [];
  const seenUrls = new Set<string>();

  const anchors = document.querySelectorAll("a[href]");

  for (const anchor of anchors) {
    try {
      const href = anchor.getAttribute("href");
      if (!href) continue;

      const absoluteUrl = new URL(href, baseUrl).toString();

      if (
        !absoluteUrl.startsWith("http://") &&
        !absoluteUrl.startsWith("https://")
      )
        continue;
      if (absoluteUrl.includes("#") && absoluteUrl.split("#")[0] === baseUrl.split("#")[0])
        continue;

      if (seenUrls.has(absoluteUrl)) continue;
      seenUrls.add(absoluteUrl);

      const anchorText = (anchor.textContent || "").trim().slice(0, 200);
      if (!anchorText) continue;

      links.push({
        url: absoluteUrl,
        anchorText,
      });
    } catch {
      // Skip malformed URLs
    }
  }

  return links;
}
