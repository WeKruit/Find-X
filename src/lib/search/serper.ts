import type { SearchResult } from "@/types";

const SERPER_API_URL = "https://google.serper.dev/search";

export async function searchSerper(
  query: string,
  numResults: number = 10
): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn("SERPER_API_KEY not set, skipping Serper search");
    return [];
  }

  try {
    const response = await fetch(SERPER_API_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: numResults,
      }),
    });

    if (!response.ok) {
      console.error(`Serper API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    const organic = data.organic || [];

    return organic.map(
      (result: { title: string; link: string; snippet: string }, index: number) => ({
        title: result.title,
        url: result.link,
        snippet: result.snippet || "",
        position: index + 1,
      })
    );
  } catch (error) {
    console.error("Serper search failed:", error);
    return [];
  }
}
