import type { SearchResult } from "@/types";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

export async function searchBrave(
  query: string,
  numResults: number = 10
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    console.warn("BRAVE_SEARCH_API_KEY not set, skipping Brave search");
    return [];
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(numResults),
    });

    const response = await fetch(`${BRAVE_API_URL}?${params}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      console.error(`Brave API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    const results = data.web?.results || [];

    return results.map(
      (result: { title: string; url: string; description: string }, index: number) => ({
        title: result.title,
        url: result.url,
        snippet: result.description || "",
        position: index + 1,
      })
    );
  } catch (error) {
    console.error("Brave search failed:", error);
    return [];
  }
}
