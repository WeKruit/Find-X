import type { PageContent, PageLink } from "@/types";

/**
 * Jina Reader API client — Tier 2 fetcher.
 *
 * Jina Reader converts any URL to clean markdown using a headless browser +
 * ML-based content extraction (ReaderLM-v2). Cheaper than Firecrawl for
 * standard public pages; no proprietary anti-bot bypass.
 *
 * API: GET https://r.jina.ai/{url}
 * Docs: https://jina.ai/reader/
 *
 * Env vars:
 *   JINA_API_KEY — optional; without it uses the free tier (20 RPM).
 *                  With a paid key, rate limit is 500–5000 RPM depending on plan.
 */

const JINA_BASE_URL = "https://r.jina.ai";

// Conservative rate limit for free tier (20 RPM = 1 req/3s).
// Overridden implicitly by paid key (500 RPM = ~1 req/120ms; we still throttle to 200ms).
let jinaLastFetch = 0;

function jinaMinDelay(): number {
  return process.env.JINA_API_KEY ? 200 : 3100;
}

async function respectJinaRateLimit(): Promise<void> {
  const elapsed = Date.now() - jinaLastFetch;
  const delay = jinaMinDelay();
  if (elapsed < delay) {
    await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
  }
  jinaLastFetch = Date.now();
}

/**
 * Jina Reader is always available (works without an API key on the free tier).
 */
export function hasJina(): boolean {
  return true;
}

/**
 * Fetch a page using Jina Reader.
 * Returns clean markdown + structured link map, or null on failure.
 */
export async function fetchWithJina(url: string): Promise<PageContent | null> {
  try {
    await respectJinaRateLimit();

    const apiKey = process.env.JINA_API_KEY;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Return-Format": "markdown",
      // Disable Jina's 5-minute response cache so we always get fresh content
      "X-No-Cache": "true",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${JINA_BASE_URL}/${encodeURIComponent(url)}`, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.log(`[Jina] HTTP ${response.status} for ${url}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const content: string = data.data?.content || "";
    const title: string = data.data?.title || "";
    // Jina returns links as { [anchorText]: url } map
    const jinaLinks: Record<string, string> = data.data?.links ?? {};

    if (content.length < 50) {
      console.log(`[Jina] Too little content for ${url} (${content.length} chars)`);
      return null;
    }

    // Convert Jina's link map to PageLink[]
    const links: PageLink[] = [];
    const seenUrls = new Set<string>();
    for (const [anchorText, linkUrl] of Object.entries(jinaLinks)) {
      if (typeof linkUrl !== "string" || !linkUrl.startsWith("http")) continue;
      if (seenUrls.has(linkUrl)) continue;
      seenUrls.add(linkUrl);
      links.push({ url: linkUrl, anchorText: anchorText.slice(0, 200) });
    }

    const truncated =
      content.length > 15000 ? content.slice(0, 15000) + "\n\n[Content truncated]" : content;

    return {
      url,
      title,
      markdown: truncated,
      links,
      fetchedAt: new Date(),
      fetchMethod: "jina",
    };
  } catch (error) {
    console.log(`[Jina] Failed for ${url}:`, error instanceof Error ? error.message : "unknown");
    return null;
  }
}
