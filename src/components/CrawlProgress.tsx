"use client";

import type { CrawlEvent, TokenUsageStats } from "@/types";

interface CrawlProgressProps {
  events: CrawlEvent[];
  pagesVisited: number;
  pageBudget: number;
  domainsVisited: string[];
  tokenUsage?: TokenUsageStats | null;
}

const EVENT_COLORS: Record<string, string> = {
  search: "text-blue-600",
  fetch: "text-green-600",
  extract: "text-purple-600",
  score: "text-orange-600",
  resolve: "text-indigo-600",
  error: "text-red-600",
  info: "text-gray-600",
};

export default function CrawlProgress({
  events,
  pagesVisited,
  pageBudget,
  domainsVisited,
  tokenUsage,
}: CrawlProgressProps) {
  const progress = pageBudget > 0 ? (pagesVisited / pageBudget) * 100 : 0;

  return (
    <div className="w-full max-w-2xl mx-auto mt-6">
      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex justify-between text-sm text-gray-600 mb-1">
          <span>{pagesVisited} / {pageBudget} pages crawled</span>
          <span>{domainsVisited.length} domains</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      </div>

      {/* Token usage summary */}
      {tokenUsage && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-blue-900">LLM Token Usage</span>
            <span className="text-blue-700 font-mono text-xs">
              {tokenUsage.llmCalls} calls
            </span>
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-3 text-xs">
            <div>
              <span className="text-blue-600">Input</span>
              <div className="font-mono font-medium text-blue-900">{tokenUsage.inputTokens.toLocaleString()}</div>
            </div>
            <div>
              <span className="text-blue-600">Output</span>
              <div className="font-mono font-medium text-blue-900">{tokenUsage.outputTokens.toLocaleString()}</div>
            </div>
            <div>
              <span className="text-blue-600">Total</span>
              <div className="font-mono font-medium text-blue-900">{tokenUsage.totalTokens.toLocaleString()}</div>
            </div>
          </div>
        </div>
      )}

      {/* Domain badges */}
      {domainsVisited.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {domainsVisited.slice(0, 15).map((domain) => (
            <span
              key={domain}
              className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full"
            >
              {domain}
            </span>
          ))}
          {domainsVisited.length > 15 && (
            <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">
              +{domainsVisited.length - 15} more
            </span>
          )}
        </div>
      )}

      {/* Event log */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 max-h-64 overflow-y-auto">
        <div className="p-3 space-y-1">
          {events.slice(-20).reverse().map((event, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className={`font-mono text-xs uppercase font-semibold w-16 shrink-0 ${EVENT_COLORS[event.type] || "text-gray-600"}`}>
                {event.type}
              </span>
              <span className="text-gray-700 break-all">
                {event.url && event.message.includes(event.url)
                  ? event.message.replace(event.url, "")
                  : event.message}
                {event.url && (
                  <a href={event.url} target="_blank" rel="noopener noreferrer" className="ml-1 text-blue-500 hover:underline text-xs truncate max-w-xs inline-block align-bottom">{event.url}</a>
                )}
              </span>
            </div>
          ))}
          {events.length === 0 && (
            <div className="text-gray-400 text-sm">Waiting for events...</div>
          )}
        </div>
      </div>
    </div>
  );
}
