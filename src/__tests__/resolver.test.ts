import { describe, it, expect } from "vitest";
import {
  jaroWinkler,
  nameScore,
} from "../lib/entity/resolver";

// ── jaroWinkler ──

describe("jaroWinkler", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaroWinkler("Noah Liu", "Noah Liu")).toBe(1.0);
  });

  it("returns 0.0 for empty strings", () => {
    expect(jaroWinkler("", "Noah Liu")).toBe(0.0);
    expect(jaroWinkler("Noah Liu", "")).toBe(0.0);
  });

  it("is case-insensitive", () => {
    expect(jaroWinkler("NOAH LIU", "noah liu")).toBe(1.0);
  });

  it("returns high similarity for minor typos", () => {
    const score = jaroWinkler("John Smith", "Jon Smith");
    expect(score).toBeGreaterThan(0.9);
  });

  it("returns low similarity for completely different names", () => {
    const score = jaroWinkler("Alice Johnson", "Bob Williams");
    expect(score).toBeLessThan(0.6);
  });

  it("gives prefix bonus (Winkler extension)", () => {
    // "MARTHA" vs "MARHTA" — transpositions, same prefix
    const jaro = jaroWinkler("MARTHA", "MARHTA");
    // Winkler bonus applies for matching prefix "MAR"
    expect(jaro).toBeGreaterThan(0.94);
  });
});

// ── nameScore ──

describe("nameScore", () => {
  it("returns 1.0 for exact match", () => {
    expect(nameScore("Noah Liu", "Noah Liu")).toBe(1.0);
  });

  it("returns 0 for empty inputs", () => {
    expect(nameScore("", "Noah Liu")).toBe(0);
    expect(nameScore("Noah Liu", "")).toBe(0);
  });

  it("handles word-containment: query name fully contained in longer name", () => {
    // "Noah Liu" is fully contained in "Zelin Noah Liu"
    const score = nameScore("Noah Liu", "Zelin Noah Liu");
    expect(score).toBeGreaterThanOrEqual(0.90);
  });

  it("handles word-containment in reverse direction", () => {
    const score = nameScore("Zelin Noah Liu", "Noah Liu");
    expect(score).toBeGreaterThanOrEqual(0.90);
  });

  it("falls back to Jaro-Winkler when no containment", () => {
    // "John Smith" vs "Jon Smith" — no containment, uses JW
    const score = nameScore("John Smith", "Jon Smith");
    expect(score).toBeGreaterThan(0.9);
  });

  it("returns low score for clearly different names", () => {
    const score = nameScore("Alice Johnson", "Bob Williams");
    expect(score).toBeLessThan(0.7);
  });

  it("single-word shorter name falls back to JW (no containment for < 2 words)", () => {
    // "Liu" is only 1 word — containment check requires >= 2 words.
    // JW match window for "liu" vs "noah liu" is too narrow to find any character
    // matches, so the result is 0. This is expected: "Liu" alone is not a reliable
    // identifier and should not trigger a match without the full name.
    const score = nameScore("Liu", "Noah Liu");
    expect(score).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(nameScore("NOAH LIU", "noah liu")).toBe(1.0);
  });
});

// ── Edge cases for names with cultural variants ──

describe("nameScore cultural variants", () => {
  it("handles middle name used as first name", () => {
    // "Mary Jane Watson" — "Jane Watson" is contained
    const score = nameScore("Jane Watson", "Mary Jane Watson");
    expect(score).toBeGreaterThanOrEqual(0.90);
  });

  it("penalizes non-overlapping two-word names appropriately", () => {
    // "Wei Chen" vs "Wei Zhang" — only one word overlaps
    const score = nameScore("Wei Chen", "Wei Zhang");
    // JW should be ~0.82, containment check fails (words don't all appear in longer)
    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThan(1.0);
  });
});
