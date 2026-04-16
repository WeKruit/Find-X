"use client";

import { useState } from "react";
import type { CriteriaCandidate } from "@/types";

interface CandidateListProps {
  candidates: CriteriaCandidate[];
  onDeepSearch: (candidate: CriteriaCandidate) => void;
  deepSearchingIds: Set<string>;
}

function MatchBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 70
      ? "bg-green-100 text-green-800 border-green-200"
      : pct >= 40
        ? "bg-yellow-100 text-yellow-800 border-yellow-200"
        : "bg-gray-100 text-gray-600 border-gray-200";

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${color}`}>
      {pct}% match
    </span>
  );
}

export default function CandidateList({
  candidates,
  onDeepSearch,
  deepSearchingIds,
}: CandidateListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeepSearchSelected = () => {
    for (const candidate of candidates) {
      if (selectedIds.has(candidate.id) && !deepSearchingIds.has(candidate.id)) {
        onDeepSearch(candidate);
      }
    }
  };

  if (candidates.length === 0) return null;

  return (
    <div className="mt-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          {candidates.length} Candidate{candidates.length !== 1 ? "s" : ""} Found
        </h2>
        {selectedIds.size > 0 && (
          <button
            onClick={handleDeepSearchSelected}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700 transition-colors"
          >
            Deep Search {selectedIds.size} Selected
          </button>
        )}
      </div>

      <div className="space-y-3">
        {candidates.map((candidate) => {
          const isExpanded = expandedId === candidate.id;
          const isSelected = selectedIds.has(candidate.id);
          const isDeepSearching = deepSearchingIds.has(candidate.id);

          return (
            <div
              key={candidate.id}
              className={`bg-white rounded-lg border shadow-sm overflow-hidden transition-colors ${
                isSelected ? "border-blue-400 ring-1 ring-blue-200" : "border-gray-200"
              }`}
            >
              {/* Main row */}
              <div className="flex items-center gap-3 p-4">
                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(candidate.id)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
                />

                {/* Info */}
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : candidate.id)}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">
                      {candidate.name}
                    </span>
                    <MatchBadge score={candidate.matchScore} />
                    {candidate.sourceUrls.length > 1 && (
                      <span className="text-xs text-gray-400">
                        {candidate.sourceUrls.length} sources
                      </span>
                    )}
                  </div>
                  {(candidate.title || candidate.company) && (
                    <p className="text-sm text-gray-600 mt-0.5 truncate">
                      {[candidate.title, candidate.company].filter(Boolean).join(" at ")}
                    </p>
                  )}
                  {candidate.evidenceSnippet && (
                    <p className="text-xs text-gray-400 mt-1 line-clamp-1">
                      {candidate.evidenceSnippet}
                    </p>
                  )}
                </div>

                {/* Deep search button */}
                <button
                  onClick={() => onDeepSearch(candidate)}
                  disabled={isDeepSearching}
                  className="px-3 py-1.5 text-sm border border-blue-200 text-blue-600 rounded-md hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {isDeepSearching ? (
                    <span className="flex items-center gap-1">
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Searching
                    </span>
                  ) : (
                    "Deep Search"
                  )}
                </button>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-0 border-t border-gray-100">
                  <div className="pt-3 space-y-2">
                    {candidate.matchReasoning && (
                      <div>
                        <span className="text-xs font-medium text-gray-500 uppercase">Why they match</span>
                        <p className="text-sm text-gray-700 mt-0.5">{candidate.matchReasoning}</p>
                      </div>
                    )}
                    {candidate.evidenceSnippet && (
                      <div>
                        <span className="text-xs font-medium text-gray-500 uppercase">Evidence</span>
                        <p className="text-sm text-gray-600 mt-0.5 italic">&ldquo;{candidate.evidenceSnippet}&rdquo;</p>
                      </div>
                    )}
                    {candidate.location && (
                      <div>
                        <span className="text-xs font-medium text-gray-500 uppercase">Location</span>
                        <p className="text-sm text-gray-700 mt-0.5">{candidate.location}</p>
                      </div>
                    )}
                    {candidate.additionalFacts.education && (
                      <div>
                        <span className="text-xs font-medium text-gray-500 uppercase">Education</span>
                        <p className="text-sm text-gray-700 mt-0.5">{candidate.additionalFacts.education}</p>
                      </div>
                    )}
                    {candidate.additionalFacts.organizations && candidate.additionalFacts.organizations.length > 0 && (
                      <div>
                        <span className="text-xs font-medium text-gray-500 uppercase">Organizations</span>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {candidate.additionalFacts.organizations.map((org, i) => (
                            <span key={i} className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full">
                              {org}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {candidate.additionalFacts.skills && candidate.additionalFacts.skills.length > 0 && (
                      <div>
                        <span className="text-xs font-medium text-gray-500 uppercase">Skills</span>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {candidate.additionalFacts.skills.map((skill, i) => (
                            <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">
                              {skill}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <span className="text-xs font-medium text-gray-500 uppercase">Sources</span>
                      <ul className="mt-0.5 space-y-0.5">
                        {candidate.sourceUrls.map((url, i) => (
                          <li key={i}>
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-500 hover:underline truncate block"
                            >
                              {url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
