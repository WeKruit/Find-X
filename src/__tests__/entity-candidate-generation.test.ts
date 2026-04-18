import { describe, expect, it } from "vitest";
import { generateCandidatePairs } from "@/lib/entity/candidate-generation";
import { normalizeMentions } from "@/lib/entity/normalization";
import {
  ENTITY_RESOLUTION_FIXTURES,
  makeMention,
} from "./helpers/entity-resolution-benchmark";

describe("candidate generation", () => {
  it("blocks sparse mentions together using shared exact identifiers", () => {
    const mentions = normalizeMentions([
      makeMention({
        id: "maya-github",
        clusterId: "x",
        names: ["Maya Patel"],
        socialLinks: [{ platform: "GitHub", url: "https://github.com/mayaprobotics", username: "mayaprobotics" }],
      }),
      makeMention({
        id: "maya-portfolio",
        clusterId: "x",
        names: ["M Patel"],
        socialLinks: [{ platform: "GitHub", url: "https://github.com/mayaprobotics", username: "mayaprobotics" }],
      }),
    ]);

    const pairs = generateCandidatePairs(mentions);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].blockKeys.some((key) => key.includes("social:github:mayaprobotics"))).toBe(true);
  });

  it("reduces comparisons on the scale fixture", () => {
    const fixture = ENTITY_RESOLUTION_FIXTURES.find((entry) => entry.id === "scale-blocking");
    expect(fixture).toBeDefined();

    const mentions = normalizeMentions(fixture!.mentions);
    const pairs = generateCandidatePairs(mentions);
    const allPairs = (mentions.length * (mentions.length - 1)) / 2;

    expect(pairs.length).toBeLessThan(allPairs);
  });
});
