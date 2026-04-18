import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/llm/client", async () => {
  const matching = await import("@/lib/entity/matching");
  return {
    llmMatchNames: async (queryName: string, _context: string | undefined, names: string[]) =>
      new Map(names.map((name) => [name, matching.nameScore(name, queryName)])),
    llmDisambiguate: async () => ({
      samePerson: false,
      confidence: 0.1,
      reasoning: "mocked benchmark disambiguation",
    }),
    llmClusterMentions: async () => null,
  };
});

import {
  ENTITY_RESOLUTION_FIXTURES,
  legacyAllPairsCount,
  runBenchmarkSuite,
} from "./helpers/entity-resolution-benchmark";
import { resolveEntities, resolveEntitiesLegacy, resolveEntitiesWithDiagnostics } from "@/lib/entity/resolver";

describe("entity resolver v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches or beats the legacy resolver on the benchmark suite", async () => {
    const legacy = await runBenchmarkSuite(resolveEntitiesLegacy);
    const current = await runBenchmarkSuite(resolveEntities);

    expect(current.avgPairwiseF1).toBeGreaterThanOrEqual(legacy.avgPairwiseF1);
    expect(current.avgTargetJaccard).toBeGreaterThanOrEqual(legacy.avgTargetJaccard);

    const githubCaseCurrent = current.caseResults.find((result) => result.fixture.id === "github-handle-rescue");
    const githubCaseLegacy = legacy.caseResults.find((result) => result.fixture.id === "github-handle-rescue");
    expect(githubCaseCurrent?.evaluation.targetJaccard).toBeGreaterThan(
      githubCaseLegacy?.evaluation.targetJaccard ?? 0
    );

    const emailCaseCurrent = current.caseResults.find((result) => result.fixture.id === "email-rescue");
    const emailCaseLegacy = legacy.caseResults.find((result) => result.fixture.id === "email-rescue");
    expect(emailCaseCurrent?.evaluation.pairwise.f1).toBeGreaterThan(
      emailCaseLegacy?.evaluation.pairwise.f1 ?? 0
    );
  });

  it("evaluates fewer candidate pairs than the legacy all-pairs baseline on the scale case", async () => {
    const scaleFixture = ENTITY_RESOLUTION_FIXTURES.find((fixture) => fixture.id === "scale-blocking");
    expect(scaleFixture).toBeDefined();

    const result = await resolveEntitiesWithDiagnostics(
      scaleFixture!.mentions,
      scaleFixture!.query
    );

    expect(result.diagnostics.candidatePairs).toBeLessThan(legacyAllPairsCount(scaleFixture!));
  });
});
