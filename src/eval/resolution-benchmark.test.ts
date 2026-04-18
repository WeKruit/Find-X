import { describe, expect, it, vi } from "vitest";

const RUN_BENCHMARK = process.env.BENCHMARK === "true";

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
} from "@/__tests__/helpers/entity-resolution-benchmark";
import { resolveEntities, resolveEntitiesLegacy, resolveEntitiesWithDiagnostics } from "@/lib/entity/resolver";

describe.skipIf(!RUN_BENCHMARK)("Entity Resolution Benchmark", () => {
  it("compares legacy and v2 resolvers across the offline benchmark suite", async () => {
    const legacy = await runBenchmarkSuite(resolveEntitiesLegacy);
    const current = await runBenchmarkSuite(resolveEntities);

    console.log("\n========================================");
    console.log("ENTITY RESOLUTION BENCHMARK");
    console.log("========================================\n");

    console.log("Aggregate:");
    console.log(
      `  Legacy  avg pairwise F1=${legacy.avgPairwiseF1.toFixed(3)} target Jaccard=${legacy.avgTargetJaccard.toFixed(3)} total=${legacy.totalDurationMs.toFixed(1)}ms`
    );
    console.log(
      `  Current avg pairwise F1=${current.avgPairwiseF1.toFixed(3)} target Jaccard=${current.avgTargetJaccard.toFixed(3)} total=${current.totalDurationMs.toFixed(1)}ms`
    );

    for (const result of current.caseResults) {
      const legacyCase = legacy.caseResults.find((entry) => entry.fixture.id === result.fixture.id)!;
      console.log(`\nCase: ${result.fixture.id}`);
      console.log(`  ${result.fixture.description}`);
      console.log(
        `  Legacy  F1=${legacyCase.evaluation.pairwise.f1.toFixed(3)} target=${legacyCase.evaluation.targetJaccard.toFixed(3)} duration=${legacyCase.durationMs.toFixed(1)}ms`
      );
      console.log(
        `  Current F1=${result.evaluation.pairwise.f1.toFixed(3)} target=${result.evaluation.targetJaccard.toFixed(3)} duration=${result.durationMs.toFixed(1)}ms`
      );
    }

    const scaleFixture = ENTITY_RESOLUTION_FIXTURES.find((fixture) => fixture.id === "scale-blocking")!;
    const diagnostics = await resolveEntitiesWithDiagnostics(scaleFixture.mentions, scaleFixture.query);
    console.log(`\nScale-case candidate pairs: ${diagnostics.diagnostics.candidatePairs}`);
    console.log(`Scale-case legacy all-pairs baseline: ${legacyAllPairsCount(scaleFixture)}`);
    console.log(`Scale-case consolidated mentions: ${diagnostics.diagnostics.consolidatedMentions}`);

    expect(current.avgPairwiseF1).toBeGreaterThanOrEqual(legacy.avgPairwiseF1);
    expect(current.avgTargetJaccard).toBeGreaterThanOrEqual(legacy.avgTargetJaccard);
  });
});
