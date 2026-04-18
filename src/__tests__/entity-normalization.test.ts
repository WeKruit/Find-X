import { describe, expect, it } from "vitest";
import {
  buildOrganizationKeys,
  buildSchoolKeys,
  consolidateMentionsBySource,
  normalizeMentions,
} from "@/lib/entity/normalization";
import { makeMention } from "./helpers/entity-resolution-benchmark";

describe("entity normalization", () => {
  it("consolidates duplicate source mentions instead of dropping complementary facts", () => {
    const sourceUrl = "https://example.com/about";
    const merged = consolidateMentionsBySource([
      makeMention({
        id: "dup-a",
        clusterId: "x",
        sourceUrl,
        names: ["Jordan Lee"],
        experiences: [{ title: "Solutions Architect", company: "AWS", isCurrent: true }],
        bioSnippet: "Cloud architect.",
      }),
      makeMention({
        id: "dup-b",
        clusterId: "x",
        sourceUrl,
        names: ["J Lee"],
        education: ["University of Washington"],
        skills: ["Terraform"],
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].extracted.names).toEqual(expect.arrayContaining(["Jordan Lee", "J Lee"]));
    expect(merged[0].extracted.education.map((entry) => entry.institution)).toContain(
      "University of Washington"
    );
    expect(merged[0].extracted.skills.map((skill) => skill.name)).toContain("Terraform");
  });

  it("builds symmetric alias keys for organizations and schools", () => {
    expect(buildOrganizationKeys("AWS")).toEqual(
      expect.arrayContaining(["aws", "amazon web services"])
    );
    expect(buildSchoolKeys("UCLA")).toEqual(
      expect.arrayContaining(["ucla", "university of california los angeles"])
    );
  });

  it("extracts social handles into exact identifiers", () => {
    const [normalized] = normalizeMentions([
      makeMention({
        id: "social-a",
        clusterId: "x",
        names: ["Maya Patel"],
        socialLinks: [{ platform: "GitHub", url: "https://github.com/mayaprobotics" }],
        emails: ["maya@example.com"],
      }),
    ]);

    expect(normalized.socialHandles.github).toEqual(["mayaprobotics"]);
    expect(normalized.exactIds).toEqual(
      expect.arrayContaining(["social:github:mayaprobotics", "email:maya@example.com"])
    );
  });
});
