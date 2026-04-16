/**
 * Criteria search evaluation harness.
 *
 * Run with:
 *   EVAL=true npx vitest run src/eval/eval-criteria.test.ts --reporter verbose
 */
import { describe, it, expect } from "vitest";
import { runCriteriaSearch } from "@/lib/crawl/criteria-engine";
import type { CriteriaCandidate } from "@/types";

const RUN_EVAL = process.env.EVAL === "true";

interface CriteriaEval {
  minCandidates: number;
  minTopScore: number;
  /** Each candidate should have at least one of these signals in evidence or reasoning */
  expectedSignals: string[];
  /** These signals should NOT appear as false positives */
  forbiddenSignals?: string[];
}

function evaluateCandidates(
  candidates: CriteriaCandidate[],
  criteria: CriteriaEval
): { passed: boolean; score: number; report: string[] } {
  const report: string[] = [];
  let checks = 0;
  let passes = 0;

  // 1. Count
  checks++;
  if (candidates.length >= criteria.minCandidates) {
    passes++;
    report.push(`✓ Found ${candidates.length} candidates (≥ ${criteria.minCandidates})`);
  } else {
    report.push(`✗ Only ${candidates.length} candidates (expected ≥ ${criteria.minCandidates})`);
  }

  // 2. Top score
  const topScore = candidates[0]?.matchScore ?? 0;
  checks++;
  if (topScore >= criteria.minTopScore) {
    passes++;
    report.push(`✓ Top score ${topScore.toFixed(3)} ≥ ${criteria.minTopScore}`);
  } else {
    report.push(`✗ Top score ${topScore.toFixed(3)} < ${criteria.minTopScore}`);
  }

  // 3. Signal coverage across top-10 candidates
  const top10 = candidates.slice(0, 10);
  for (const signal of criteria.expectedSignals) {
    checks++;
    const found = top10.some((c) => {
      const text = [
        c.matchReasoning,
        c.evidenceSnippet,
        c.additionalFacts.education ?? "",
        ...(c.additionalFacts.organizations ?? []),
        ...(c.additionalFacts.skills ?? []),
        c.location ?? "",
        c.title ?? "",
        c.company ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return text.includes(signal.toLowerCase());
    });
    if (found) {
      passes++;
      report.push(`✓ Signal "${signal}" found in top candidates`);
    } else {
      report.push(`✗ Signal "${signal}" NOT found in top candidates`);
    }
  }

  const score = Math.round((passes / checks) * 100);
  const passed = score >= 70;
  return { passed, score, report };
}

describe("Criteria Search Evaluation", () => {
  it.skipIf(!RUN_EVAL)(
    "USC sophomores in student orgs — should find relevant USC students",
    async () => {
      const criteria = "Find sophomores from USC who are active in student orgs";

      console.log("\n========================================");
      console.log("EVAL: Criteria Search — USC Sophomores in Student Orgs");
      console.log("========================================\n");

      const session = await runCriteriaSearch(criteria, (event) => {
        if (event.type === "info" || event.type === "search") {
          console.log(`[${event.type.toUpperCase()}] ${event.message}`);
        } else if (event.type === "fetch") {
          console.log(`[FETCH] ${event.message}`);
        } else if (event.type === "extract" && event.message.includes("Found")) {
          console.log(`[EXTRACT] ${event.message}`);
        }
      });

      console.log(`\nSearch complete. ${session.candidates.length} candidate(s) found.`);
      console.log(`Pages visited: ${session.crawlState.pagesVisited}/${session.crawlState.pageBudget}`);
      console.log(`Domains: ${session.crawlState.domainsVisited.size}`);

      const top10 = session.candidates.slice(0, 10);
      for (let i = 0; i < top10.length; i++) {
        const c = top10[i];
        console.log(`\n--- Candidate #${i + 1} (score: ${c.matchScore.toFixed(3)}) ---`);
        console.log(`  Name:    ${c.name}`);
        if (c.title || c.company) console.log(`  Role:    ${[c.title, c.company].filter(Boolean).join(" @ ")}`);
        if (c.additionalFacts.education) console.log(`  Edu:     ${c.additionalFacts.education}`);
        if (c.additionalFacts.organizations?.length) console.log(`  Orgs:    ${c.additionalFacts.organizations.join(", ")}`);
        console.log(`  Reason:  ${c.matchReasoning.slice(0, 120)}`);
        console.log(`  Evidence: ${c.evidenceSnippet.slice(0, 120)}`);
        console.log(`  Sources: ${c.sourceUrls.length} (${c.sourceUrls.map(u => new URL(u).hostname).join(", ")})`);
      }

      const evalResult = evaluateCandidates(session.candidates, {
        minCandidates: 5,
        minTopScore: 0.5,
        expectedSignals: ["USC", "University of Southern California", "sophomore", "student org", "club", "organization"],
      });

      console.log("\n--- Evaluation Report ---");
      for (const line of evalResult.report) console.log(` ${line}`);
      console.log(`\nScore: ${evalResult.score}% — ${evalResult.passed ? "PASSED" : "FAILED"}`);

      expect(evalResult.passed, `Criteria eval failed:\n${evalResult.report.join("\n")}`).toBe(true);
    },
    600_000 // 10 min timeout
  );
});
