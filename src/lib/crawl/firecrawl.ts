import type { PageContent, PageLink } from "@/types";

/**
 * Firecrawl API client — Tier 2 fetcher.
 *
 * Firecrawl handles JS rendering, anti-bot bypass (proxy rotation, CAPTCHA solving),
 * and returns clean markdown. Replaces Jina Reader as the fallback when direct HTTP fails.
 *
 * Supports both hosted (firecrawl.dev) and self-hosted instances.
 *
 * Env vars:
 *   FIRECRAWL_API_KEY  — API key for hosted Firecrawl (required for hosted)
 *   FIRECRAWL_BASE_URL — Base URL for self-hosted instance (default: https://api.firecrawl.dev)
 */

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";

// Rate limiter — respect Firecrawl's concurrency limits
let firecrawlLastFetch = 0;
const FIRECRAWL_MIN_DELAY_MS = 1500; // Conservative: ~40 RPM

async function respectFirecrawlRateLimit(): Promise<void> {
  const elapsed = Date.now() - firecrawlLastFetch;
  if (elapsed < FIRECRAWL_MIN_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, FIRECRAWL_MIN_DELAY_MS - elapsed));
  }
  firecrawlLastFetch = Date.now();
}

/**
 * Check if Firecrawl is configured (API key or self-hosted URL).
 */
export function hasFirecrawl(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_BASE_URL);
}

/**
 * Fetch a page using Firecrawl's /v1/scrape endpoint.
 * Returns clean markdown with metadata, or null on failure.
 */
export async function fetchWithFirecrawl(url: string): Promise<PageContent | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  const baseUrl = (process.env.FIRECRAWL_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

  if (!apiKey && baseUrl === DEFAULT_BASE_URL) {
    console.log("[Firecrawl] No API key set and no self-hosted URL configured, skipping");
    return null;
  }

  try {
    await respectFirecrawlRateLimit();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/v1/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        waitFor: 3000, // Wait up to 3s for JS to render
        timeout: 30000,
        onlyMainContent: true,
      }),
      signal: AbortSignal.timeout(45000), // Generous timeout — Firecrawl does its own rendering
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.log(`[Firecrawl] HTTP ${response.status} for ${url}: ${errorText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();

    if (!data.success) {
      console.log(`[Firecrawl] API returned success=false for ${url}: ${data.error || "unknown"}`);
      return null;
    }

    const markdown = data.data?.markdown || "";
    const title = data.data?.metadata?.title || "";

    if (markdown.length < 50) {
      console.log(`[Firecrawl] Too little content for ${url} (${markdown.length} chars)`);
      return null;
    }

    // Extract links from markdown content
    const links = extractLinksFromMarkdown(url, markdown);

    // Truncate very long pages
    const truncatedMarkdown = markdown.length > 15000
      ? markdown.slice(0, 15000) + "\n\n[Content truncated]"
      : markdown;

    return {
      url,
      title,
      markdown: truncatedMarkdown,
      links,
      fetchedAt: new Date(),
      fetchMethod: "firecrawl",
    };
  } catch (error) {
    console.log(`[Firecrawl] Failed for ${url}:`, error instanceof Error ? error.message : "unknown");
    return null;
  }
}

/**
 * Extract markdown-style links [text](url) from content.
 */
function extractLinksFromMarkdown(baseUrl: string, markdown: string): PageLink[] {
  const links: PageLink[] = [];
  const seenUrls = new Set<string>();

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;

  while ((match = linkRegex.exec(markdown)) !== null) {
    const anchorText = match[1].trim();
    const linkUrl = match[2];

    if (seenUrls.has(linkUrl)) continue;
    seenUrls.add(linkUrl);

    if (anchorText && linkUrl !== baseUrl) {
      links.push({
        url: linkUrl,
        anchorText: anchorText.slice(0, 200),
      });
    }
  }

  return links;
}
