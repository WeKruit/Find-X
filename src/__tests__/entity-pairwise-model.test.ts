import { describe, expect, it } from "vitest";
import { evaluateCandidatePair } from "@/lib/entity/pairwise-model";
import { normalizeMentions } from "@/lib/entity/normalization";
import type { CandidatePair } from "@/lib/entity/candidate-generation";
import { makeMention } from "./helpers/entity-resolution-benchmark";

function pair(i = 0, j = 1): CandidatePair {
  return { i, j, reasons: ["test"], blockKeys: ["test"] };
}

describe("pairwise model", () => {
  it("treats shared exact identifiers as a hard positive", () => {
    const mentions = normalizeMentions([
      makeMention({
        id: "andrew-a",
        clusterId: "x",
        names: ["Andrew James Brown"],
        emails: ["ajbrown@ledgerflow.com"],
      }),
      makeMention({
        id: "andrew-b",
        clusterId: "x",
        names: ["AJ Brown"],
        emails: ["ajbrown@ledgerflow.com"],
      }),
    ]);

    const decision = evaluateCandidatePair(pair(), mentions[0], mentions[1]);
    expect(decision.hardPositive).toBe(true);
    expect(decision.autoMerge).toBe(true);
    expect(decision.probability).toBeGreaterThan(0.99);
  });

  it("treats conflicting linkedin handles as a hard negative", () => {
    const mentions = normalizeMentions([
      makeMention({
        id: "alex-a",
        clusterId: "x",
        sourceUrl: "https://www.linkedin.com/in/alex-chen-stripe",
        names: ["Alex Chen"],
        socialLinks: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/alex-chen-stripe" }],
      }),
      makeMention({
        id: "alex-b",
        clusterId: "y",
        sourceUrl: "https://www.linkedin.com/in/alex-chen-figma",
        names: ["Alex Chen"],
        socialLinks: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/alex-chen-figma" }],
      }),
    ]);

    const decision = evaluateCandidatePair(pair(), mentions[0], mentions[1]);
    expect(decision.hardNegative).toBe(true);
    expect(decision.autoReject).toBe(true);
    expect(decision.probability).toBeLessThan(0.01);
  });

  it("penalizes same-name mentions with incompatible current employers", () => {
    const mentions = normalizeMentions([
      makeMention({
        id: "alex-notion",
        clusterId: "x",
        names: ["Alex Morgan"],
        experiences: [{ title: "Product Lead", company: "Notion", isCurrent: true }],
        skills: ["Product", "Analytics"],
      }),
      makeMention({
        id: "alex-canva",
        clusterId: "y",
        names: ["Alex Morgan"],
        experiences: [{ title: "Product Lead", company: "Canva", isCurrent: true }],
        skills: ["Product", "Analytics"],
      }),
    ]);

    const decision = evaluateCandidatePair(pair(), mentions[0], mentions[1]);
    expect(decision.probability).toBeLessThan(0.5);
  });
});
