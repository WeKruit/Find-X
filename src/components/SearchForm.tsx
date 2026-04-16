"use client";

import { useState } from "react";
import type { SearchMode } from "@/types";

interface SearchFormProps {
  onPersonSearch: (query: { name: string; context?: string }) => void;
  onCriteriaSearch: (query: { criteria: string; maxResults: number }) => void;
  isSearching: boolean;
}

export default function SearchForm({ onPersonSearch, onCriteriaSearch, isSearching }: SearchFormProps) {
  const [mode, setMode] = useState<SearchMode>("person");
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [criteria, setCriteria] = useState("");
  const [maxResults, setMaxResults] = useState(20);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "person") {
      if (!name.trim()) return;
      onPersonSearch({
        name: name.trim(),
        ...(context.trim() && { context: context.trim() }),
      });
    } else {
      if (!criteria.trim()) return;
      onCriteriaSearch({
        criteria: criteria.trim(),
        maxResults,
      });
    }
  };

  const isValid = mode === "person" ? name.trim().length > 0 : criteria.trim().length > 0;

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl mx-auto">
      {/* Mode Toggle */}
      <div className="flex justify-center mb-4">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          <button
            type="button"
            onClick={() => setMode("person")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              mode === "person"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:text-gray-900"
            }`}
            disabled={isSearching}
          >
            Find a Person
          </button>
          <button
            type="button"
            onClick={() => setMode("criteria")}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              mode === "criteria"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:text-gray-900"
            }`}
            disabled={isSearching}
          >
            Find People by Criteria
          </button>
        </div>
      </div>

      {mode === "person" ? (
        <>
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a person's name..."
              className="flex-1 px-4 py-3 rounded-lg border border-gray-300 bg-white text-gray-900 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={isSearching}
              autoFocus
            />
            <button
              type="submit"
              disabled={isSearching || !isValid}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSearching ? <Spinner /> : "Search"}
            </button>
          </div>
          <input
            type="text"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Add context: company, location, role, school... (optional)"
            className="mt-2 w-full px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={isSearching}
          />
        </>
      ) : (
        <>
          <div className="flex gap-2">
            <textarea
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              placeholder={"Describe who you're looking for, e.g. \"Ex-Google engineers with AI startups\""}
              className="flex-1 px-4 py-3 rounded-lg border border-gray-300 bg-white text-gray-900 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              rows={2}
              disabled={isSearching}
              autoFocus
            />
            <button
              type="submit"
              disabled={isSearching || !isValid}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors self-start"
            >
              {isSearching ? <Spinner /> : "Discover"}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <label className="text-sm text-gray-500 shrink-0">
              Max results:
            </label>
            <input
              type="range"
              min={5}
              max={50}
              step={5}
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
              className="flex-1 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
              disabled={isSearching}
            />
            <span className="text-sm font-medium text-gray-700 w-8 text-right">
              {maxResults}
            </span>
          </div>
        </>
      )}
    </form>
  );
}

function Spinner() {
  return (
    <span className="flex items-center gap-2">
      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      Searching
    </span>
  );
}
