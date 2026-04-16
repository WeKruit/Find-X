import type { SearchQuery, SearchResult } from "@/types";
import { searchSerper } from "./serper";
import { searchBrave } from "./brave";
export { extractFromSearchResults } from "./snippet-extractor";

/**
 * Generate diverse search queries from seed information.
 * Uses name + freeform context to build targeted queries.
 */
export function generateSearchQueries(query: SearchQuery): string[] {
  const queries: string[] = [];
  const { name, context } = query;

  // Core name query — no strict quotes on context so partial matches still surface
  queries.push(`"${name}"`);

  // Name + context (if provided) — context is NOT quoted so "UT Austin" matches
  // "University of Texas at Austin" and other partial forms
  if (context) {
    queries.push(`"${name}" ${context}`);
  }

  // LinkedIn-specific search — context unquoted for same reason
  if (context) {
    queries.push(`"${name}" ${context} site:linkedin.com`);
  } else {
    queries.push(`"${name}" site:linkedin.com`);
  }

  // GitHub / personal site — separate query so OR doesn't silently drop to one site
  if (context) {
    queries.push(`"${name}" ${context} site:github.com`);
  }

  return queries;
}

/**
 * Execute search queries across all configured providers.
 * Deduplicates results by URL.
 */
export async function executeSearchQueries(
  queries: string[]
): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];
  const seenUrls = new Set<string>();

  // Run queries across configured providers (only calls APIs with keys set)
  const searchPromises = queries.flatMap((query) => {
    const promises: Promise<SearchResult[]>[] = [];
    if (process.env.SERPER_API_KEY) promises.push(searchSerper(query, 5));
    if (process.env.BRAVE_SEARCH_API_KEY) promises.push(searchBrave(query, 5));
    return promises;
  });

  const resultSets = await Promise.allSettled(searchPromises);

  for (const result of resultSets) {
    if (result.status === "fulfilled") {
      for (const sr of result.value) {
        const normalizedUrl = normalizeUrl(sr.url);
        if (!seenUrls.has(normalizedUrl)) {
          seenUrls.add(normalizedUrl);
          allResults.push(sr);
        }
      }
    }
  }

  return allResults;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove trailing slash, www prefix, fragments, tracking params
    const cleanParams = new URLSearchParams();
    // Strip tracking/redirect params that don't affect page content
    const STRIP_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source", "srsltid", "gbraid", "wbraid", "gclid", "fbclid"]);
    for (const [key, value] of u.searchParams) {
      if (!key.startsWith("utm_") && !STRIP_PARAMS.has(key)) {
        cleanParams.set(key, value);
      }
    }
    const search = cleanParams.toString();
    let normalized = `${u.protocol}//${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
    if (search) normalized += `?${search}`;
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
