"use client";

import { useState, useCallback } from "react";
import SearchForm from "@/components/SearchForm";
import CrawlProgress from "@/components/CrawlProgress";
import ProfileCard from "@/components/ProfileCard";
import ClusterGraph from "@/components/ClusterGraph";
import CandidateList from "@/components/CandidateList";
import type { CrawlEvent, PersonProfile, ClusterData, CriteriaCandidate, SearchMode, TokenUsageStats } from "@/types";

export default function Home() {
  const [activeMode, setActiveMode] = useState<SearchMode | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [events, setEvents] = useState<CrawlEvent[]>([]);
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [candidates, setCandidates] = useState<CriteriaCandidate[]>([]);
  const [pagesVisited, setPagesVisited] = useState(0);
  const [pageBudget, setPageBudget] = useState(20);
  const [domainsVisited, setDomainsVisited] = useState<string[]>([]);
  const [clusterData, setClusterData] = useState<ClusterData[]>([]);
  const [deepSearchingIds, setDeepSearchingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageStats | null>(null);

  /** Shared SSE reader logic */
  const readSSEStream = useCallback(async (
    response: Response,
    onComplete: (data: Record<string, unknown>) => void,
  ) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));

            if (data.type === "complete") {
              onComplete(data);
            } else if (data.type === "error" && !data.url) {
              setError(data.message);
            } else {
              setEvents((prev) => [...prev, data]);
              if (data.type === "fetch" && data.data) {
                setPagesVisited((p) => p + 1);
                if ((data.data as Record<string, unknown>).pageBudget) {
                  setPageBudget((data.data as Record<string, unknown>).pageBudget as number);
                }
              }
              if (data.url) {
                try {
                  const domain = new URL(data.url).hostname.replace(/^www\./, "");
                  setDomainsVisited((prev) =>
                    prev.includes(domain) ? prev : [...prev, domain]
                  );
                } catch { /* ignore */ }
              }
            }
          } catch { /* ignore parse errors */ }
        }
      }
    }
  }, []);

  const resetState = useCallback(() => {
    setEvents([]);
    setProfiles([]);
    setCandidates([]);
    setClusterData([]);
    setPagesVisited(0);
    setDomainsVisited([]);
    setDeepSearchingIds(new Set());
    setError(null);
    setHasSearched(true);
    setTokenUsage(null);
  }, []);

  /** Person search handler */
  const handlePersonSearch = useCallback(async (query: { name: string; context?: string }) => {
    setIsSearching(true);
    setActiveMode("person");
    resetState();

    try {
      const response = await fetch("/api/search/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });

      if (!response.ok) throw new Error(`Search failed: ${response.statusText}`);

      await readSSEStream(response, (data) => {
        const session = data.session as Record<string, unknown>;
        setProfiles(session.profiles as PersonProfile[]);
        setClusterData((session.clusterData as ClusterData[]) || []);
        const crawl = session.crawlState as Record<string, unknown>;
        setPagesVisited(crawl.pagesVisited as number);
        setPageBudget(crawl.pageBudget as number);
        setDomainsVisited(crawl.domainsVisited as string[]);
        if (crawl.tokenUsage) setTokenUsage(crawl.tokenUsage as TokenUsageStats);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setIsSearching(false);
    }
  }, [readSSEStream, resetState]);

  /** Criteria search handler */
  const handleCriteriaSearch = useCallback(async (query: { criteria: string; maxResults: number }) => {
    setIsSearching(true);
    setActiveMode("criteria");
    resetState();

    try {
      const response = await fetch("/api/search/criteria/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });

      if (!response.ok) throw new Error(`Search failed: ${response.statusText}`);

      await readSSEStream(response, (data) => {
        const session = data.session as Record<string, unknown>;
        setCandidates(session.candidates as CriteriaCandidate[]);
        const crawl = session.crawlState as Record<string, unknown>;
        setPagesVisited(crawl.pagesVisited as number);
        setPageBudget(crawl.pageBudget as number);
        setDomainsVisited(crawl.domainsVisited as string[]);
        if (crawl.tokenUsage) setTokenUsage(crawl.tokenUsage as TokenUsageStats);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setIsSearching(false);
    }
  }, [readSSEStream, resetState]);

  /** Deep search a criteria candidate (runs person search on them) */
  const handleDeepSearch = useCallback(async (candidate: CriteriaCandidate) => {
    setDeepSearchingIds((prev) => new Set([...prev, candidate.id]));

    try {
      const response = await fetch("/api/search/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: candidate.name,
          context: [candidate.title, candidate.company, candidate.location]
            .filter(Boolean)
            .join(", "),
        }),
      });

      if (!response.ok) throw new Error(`Deep search failed: ${response.statusText}`);

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "complete") {
                const session = data.session;
                if (session.profiles && session.profiles.length > 0) {
                  setProfiles((prev) => [...prev, ...session.profiles]);
                }
                if (session.clusterData && session.clusterData.length > 0) {
                  setClusterData((prev) => [...prev, ...session.clusterData]);
                }
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      console.error("Deep search failed:", err);
    } finally {
      setDeepSearchingIds((prev) => {
        const next = new Set(prev);
        next.delete(candidate.id);
        return next;
      });
    }
  }, []);

  const hasResults =
    (activeMode === "person" && profiles.length > 0) ||
    (activeMode === "criteria" && candidates.length > 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-gray-900">
            Gen<span className="text-blue-600">Search</span>
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Deep web intelligence — search like a human researcher
          </p>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Search Form */}
        <div className={`transition-all duration-500 ${hasSearched ? "" : "mt-32"}`}>
          <SearchForm
            onPersonSearch={handlePersonSearch}
            onCriteriaSearch={handleCriteriaSearch}
            isSearching={isSearching}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mt-6 max-w-2xl mx-auto p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* Crawl Progress */}
        {(isSearching || events.length > 0) && (
          <CrawlProgress
            events={events}
            pagesVisited={pagesVisited}
            pageBudget={pageBudget}
            domainsVisited={domainsVisited}
            tokenUsage={tokenUsage}
          />
        )}

        {/* Criteria Search Results */}
        {activeMode === "criteria" && candidates.length > 0 && (
          <CandidateList
            candidates={candidates}
            onDeepSearch={handleDeepSearch}
            deepSearchingIds={deepSearchingIds}
          />
        )}

        {/* Cluster Graph (person mode, or deep-searched criteria candidates) */}
        {clusterData.length > 0 && <ClusterGraph clusters={clusterData} />}

        {/* Profile Cards (person mode, or deep-searched criteria candidates) */}
        {profiles.length > 0 && (
          <div className="mt-8 space-y-6">
            <h2 className="text-lg font-semibold text-gray-900 max-w-2xl mx-auto">
              {activeMode === "criteria"
                ? `${profiles.length} Deep-Searched Profile${profiles.length !== 1 ? "s" : ""}`
                : profiles.length === 1
                  ? "Profile"
                  : `${profiles.length} Profiles Found`}
            </h2>
            {profiles.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} />
            ))}
          </div>
        )}

        {/* No results */}
        {!isSearching && hasSearched && !hasResults && !error && (
          <div className="mt-8 max-w-2xl mx-auto text-center text-gray-500">
            <p>
              {activeMode === "criteria"
                ? "No candidates found matching your criteria. Try broadening your search."
                : "No profiles found. Try adding more details like company or location."}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
