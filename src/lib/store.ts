import type { SearchSession, SearchSessionDTO, CrawlStateDTO } from "@/types";

/**
 * In-memory session store for Phase 1.
 * Phase 2+ will use PostgreSQL.
 */
const sessions = new Map<string, SearchSession>();
const MAX_SESSIONS = 50;

export function storeSession(session: SearchSession): void {
  sessions.set(session.id, session);
  // Evict oldest sessions once cap is exceeded to prevent unbounded memory growth.
  if (sessions.size > MAX_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) sessions.delete(oldestKey);
  }
}

export function getSession(id: string): SearchSession | undefined {
  return sessions.get(id);
}

export function getAllSessions(): SearchSession[] {
  return Array.from(sessions.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/**
 * Convert SearchSession to a JSON-serializable DTO.
 */
export function toDTO(session: SearchSession): SearchSessionDTO {
  const crawlState: CrawlStateDTO = {
    pagesVisited: session.crawlState.pagesVisited,
    pageBudget: session.crawlState.pageBudget,
    domainsVisited: Array.from(session.crawlState.domainsVisited),
    urlsVisited: Array.from(session.crawlState.urlsVisited),
    events: session.crawlState.events,
    secondaryMentionCount: session.crawlState.secondaryMentions.length,
  };

  return {
    id: session.id,
    query: session.query,
    status: session.status,
    profiles: session.profiles,
    clusterData: session.clusterData,
    crawlState,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    error: session.error,
  };
}
