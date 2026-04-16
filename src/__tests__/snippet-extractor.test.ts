import { describe, it, expect } from "vitest";
import { extractFromSearchResults } from "../lib/search/snippet-extractor";
import type { SearchResult } from "../types";

function makeResult(overrides: Partial<SearchResult>): SearchResult {
  return {
    title: "",
    url: "https://example.com/page",
    snippet: "",
    position: 1,
    ...overrides,
  };
}

describe("extractFromSearchResults", () => {
  it("returns empty array when no results match", () => {
    const results = extractFromSearchResults([], "Noah Liu");
    expect(results).toHaveLength(0);
  });

  it("skips results where query name is not in title", () => {
    const results = extractFromSearchResults(
      [makeResult({ title: "Some Other Person - Engineer at Google", snippet: "" })],
      "Noah Liu"
    );
    expect(results).toHaveLength(0);
  });

  it("extracts title and company from 'Name - Title at Company' pattern", () => {
    const results = extractFromSearchResults(
      [makeResult({
        title: "Noah Liu - Software Engineer at Google | LinkedIn",
        url: "https://linkedin.com/in/noahliu",
        snippet: "Noah Liu works as a Software Engineer at Google.",
      })],
      "Noah Liu"
    );
    expect(results).toHaveLength(1);
    const mention = results[0];
    expect(mention.extracted.names).toContain("Noah Liu");
    expect(mention.extracted.experiences[0]?.title).toBe("Software Engineer");
    expect(mention.extracted.experiences[0]?.company).toBe("Google");
  });

  it("extracts social link from LinkedIn URL", () => {
    const results = extractFromSearchResults(
      [makeResult({
        title: "Noah Liu - Co-Founder @ WeKruit | LinkedIn",
        url: "https://www.linkedin.com/in/noah-liu-123",
        snippet: "Noah Liu is co-founder of WeKruit.",
      })],
      "Noah Liu"
    );
    expect(results).toHaveLength(1);
    const social = results[0].extracted.socialLinks;
    expect(social.length).toBeGreaterThan(0);
    expect(social[0].platform).toBe("LinkedIn");
  });

  it("extracts education from title", () => {
    const results = extractFromSearchResults(
      [makeResult({
        title: "Noah Liu - University of Southern California | LinkedIn",
        url: "https://linkedin.com/in/noahliu",
        snippet: "Noah Liu graduated from University of Southern California. Located in Los Angeles, CA.",
      })],
      "Noah Liu"
    );
    expect(results).toHaveLength(1);
    const edu = results[0].extracted.education;
    expect(edu.length).toBeGreaterThan(0);
    expect(edu[0].institution).toMatch(/University of Southern California/i);
  });

  it("filters out directory listing pages", () => {
    const results = extractFromSearchResults(
      [makeResult({ title: "60+ profiles of 'Noah Liu' | LinkedIn", snippet: "" })],
      "Noah Liu"
    );
    expect(results).toHaveLength(0);
  });

  it("filters out numeric prefix directory pages (language-agnostic)", () => {
    const results = extractFromSearchResults(
      [makeResult({ title: "60+ 個符合「Noah Liu」的個人檔案", snippet: "" })],
      "Noah Liu"
    );
    expect(results).toHaveLength(0);
  });

  it("assigns lower confidence than full page extraction", () => {
    const results = extractFromSearchResults(
      [makeResult({
        title: "Noah Liu - Senior Engineer at Meta | LinkedIn",
        url: "https://linkedin.com/in/noahliu",
        snippet: "Noah Liu is a senior engineer at Meta.",
      })],
      "Noah Liu"
    );
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBeLessThan(0.85);
    expect(results[0].confidence).toBeGreaterThan(0);
  });

  it("returns no mention when only a name and no substantive data", () => {
    // Title has name but no job, company, education, social link, or bio
    const results = extractFromSearchResults(
      [makeResult({
        title: "Noah Liu",
        url: "https://example.com/noah",
        snippet: "",
      })],
      "Noah Liu"
    );
    expect(results).toHaveLength(0);
  });
});
