/**
 * Search evaluation harness.
 *
 * Run with:
 *   EVAL=true npx vitest run src/eval/eval-search.test.ts --reporter verbose
 *
 * Does NOT run in the normal test suite (vitest only includes src/**\/*.test.ts
 * but this file is inside src/eval/, and the default include pattern excludes it).
 * Actually vitest.config.ts includes src/**\/*.test.ts so this WILL be included.
 * Use EVAL env var to gate it:
 *   Normal tests: EVAL is unset → all describe blocks skip
 *   Eval run:     EVAL=true → runs the evaluation
 */
import { describe, it, expect } from "vitest";
import { runSearch } from "@/lib/crawl/engine";
import type { PersonProfile } from "@/types";

const RUN_EVAL = process.env.EVAL === "true";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface EvalCriteria {
  /** Minimum confidence the best-ranked profile must have */
  minConfidence: number;
  /** Strings that should appear in the top profile's name (case-insensitive) */
  expectedNameTokens: string[];
  /** At least one of these must appear somewhere in the top profile */
  expectedSignals: {
    company?: string[];
    education?: string[];
    social?: string[];
    location?: string[];
    bio?: string[];
    title?: string[];
  };
  /** None of these should be in the top profile (wrong-person signals) */
  forbiddenSignals: {
    skills?: string[];
    bio?: string[];
    company?: string[];
  };
  /** The top profile must rank above any wrong-person profile */
  topProfileShouldWin: boolean;
}

function evaluateProfile(profile: PersonProfile, criteria: EvalCriteria): {
  passed: boolean;
  score: number;
  report: string[];
} {
  const report: string[] = [];
  let points = 0;
  const total = 10;

  // 1. Confidence
  if (profile.confidence >= criteria.minConfidence) {
    points += 2;
    report.push(`✓ Confidence ${profile.confidence.toFixed(3)} >= ${criteria.minConfidence}`);
  } else {
    report.push(`✗ Confidence ${profile.confidence.toFixed(3)} < ${criteria.minConfidence}`);
  }

  // 2. Name tokens
  const nameStr = profile.names.map(n => n.value).join(" ").toLowerCase();
  const nameHits = criteria.expectedNameTokens.filter(t => nameStr.includes(t.toLowerCase()));
  if (nameHits.length === criteria.expectedNameTokens.length) {
    points += 2;
    report.push(`✓ Name contains all expected tokens: ${nameHits.join(", ")}`);
  } else {
    report.push(`✗ Name missing tokens: ${criteria.expectedNameTokens.filter(t => !nameStr.includes(t.toLowerCase())).join(", ")}`);
  }

  // 3. Expected signals
  const { expectedSignals } = criteria;

  const checkSignal = (
    label: string,
    expected: string[] | undefined,
    actual: string,
    weight: number
  ) => {
    if (!expected || expected.length === 0) return;
    const hit = expected.some(s => actual.toLowerCase().includes(s.toLowerCase()));
    if (hit) {
      points += weight;
      report.push(`✓ ${label} contains expected signal`);
    } else {
      report.push(`✗ ${label} missing — expected one of: ${expected.join(", ")}`);
    }
  };

  const curExp = profile.experiences?.find((e) => e.value.isCurrent) ?? profile.experiences?.[0];
  const allCompanies = profile.experiences?.map((e) => `${e.value.title} ${e.value.company}`).join(" ") ?? "";
  const allEducation = profile.education.map(e => e.value.institution).join(" ");
  const allSocials = profile.socialProfiles.map(s => s.value.url + " " + s.value.platform).join(" ");
  const allLocations = profile.locations.map(l => l.value.city).join(" ");
  const allBio = profile.bioSnippet ?? "";
  const allTitles = curExp?.value.title ?? "";

  checkSignal("Company/role", expectedSignals.company, allCompanies, 1.5);
  checkSignal("Education", expectedSignals.education, allEducation, 1.5);
  checkSignal("Social", expectedSignals.social, allSocials, 1);
  checkSignal("Location", expectedSignals.location, allLocations, 0.5);
  checkSignal("Bio", expectedSignals.bio, allBio, 0.5);
  checkSignal("Title", expectedSignals.title, allTitles, 1);

  // 4. Forbidden signals (wrong-person contamination)
  const { forbiddenSignals } = criteria;
  const allSkills = profile.skills.map(s => s.value.name).join(" ");
  const allFacts = profile.additionalFacts.map(f => f.value).join(" ");

  let contaminated = false;
  if (forbiddenSignals.skills) {
    const hit = forbiddenSignals.skills.find(s => allSkills.toLowerCase().includes(s.toLowerCase()));
    if (hit) {
      contaminated = true;
      report.push(`✗ Forbidden skill detected: "${hit}" — profile likely contaminated with wrong person`);
    }
  }
  if (forbiddenSignals.bio) {
    const hit = forbiddenSignals.bio.find(s => allBio.toLowerCase().includes(s.toLowerCase()));
    if (hit) {
      contaminated = true;
      report.push(`✗ Forbidden bio signal: "${hit}"`);
    }
  }
  if (forbiddenSignals.company) {
    const hit = forbiddenSignals.company.find(s => allCompanies.toLowerCase().includes(s.toLowerCase()));
    if (hit) {
      contaminated = true;
      report.push(`✗ Forbidden company: "${hit}"`);
    }
  }
  if (!contaminated) {
    points += 1;
    report.push("✓ No wrong-person contamination detected");
  }

  const score = points / total;
  const passed = !contaminated && score >= 0.6;
  return { passed, score, report };
}

function printProfile(p: PersonProfile, rank: number): string {
  const lines: string[] = [];
  lines.push(`\n--- Profile #${rank} (confidence: ${p.confidence.toFixed(3)}) ---`);
  lines.push(`  Name:      ${p.names.map(n => n.value).join(" / ")}`);

  const firstExp = p.experiences?.find((e) => e.value.isCurrent) ?? p.experiences?.[0];
  const roleStr = [firstExp?.value.title, firstExp?.value.company].filter(Boolean).join(" at ");
  if (roleStr) lines.push(`  Role:      ${roleStr}`);

  if (p.education.length) lines.push(`  Education: ${p.education.map(e => e.value.institution).join(", ")}`);
  if (p.locations.length) lines.push(`  Location:  ${p.locations.map(l => l.value.city).join(", ")}`);
  if (p.skills.length) lines.push(`  Skills:    ${p.skills.slice(0, 5).map(s => s.value.name).join(", ")}`);
  if (p.socialProfiles.length) lines.push(`  Social:    ${p.socialProfiles.map(s => `${s.value.platform}: ${s.value.url}`).join(", ")}`);
  if (p.bioSnippet) lines.push(`  Bio:       ${p.bioSnippet.slice(0, 200)}`);
  if (p.additionalFacts.length) {
    lines.push(`  Facts:`);
    for (const f of p.additionalFacts.slice(0, 5)) {
      lines.push(`    - ${f.value}`);
    }
  }
  lines.push(`  Sources:   ${p.sources.length} (domains: ${[...new Set(p.sources.map(s => { try { return new URL(s.url).hostname.replace(/^www\./, ""); } catch { return s.url; } }))].join(", ")})`);
  return lines.join("\n");
}

// ── Test Cases ────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_EVAL)("Search Quality Evaluation", { timeout: 600_000 }, () => {
  it("Noah Liu @ USC — top profile should be USC/WeKruit person", async () => {
    console.log("\n========================================");
    console.log("EVAL: Noah Liu @ University of Southern California");
    console.log("========================================");

    const session = await runSearch({
      mode: "person",
      name: "Noah Liu",
      context: "University of Southern California",
    });

    console.log(`\nSearch complete. ${session.profiles.length} profile(s) found.`);

    for (let i = 0; i < session.profiles.length; i++) {
      console.log(printProfile(session.profiles[i], i + 1));
    }

    // ── Grade the top profile ──
    const top = session.profiles[0];
    expect(top).toBeDefined();

    const criteria: EvalCriteria = {
      minConfidence: 0.6,
      expectedNameTokens: ["noah", "liu"],
      expectedSignals: {
        company: ["wekruit", "WeKruit"],
        education: ["southern california", "USC"],
        social: ["linkedin.com/in/zelin-noah-liu", "linkedin"],
        bio: ["founder", "USC", "CSSA", "WeKruit"],
        title: ["founder", "president", "engineer"],
      },
      forbiddenSignals: {
        skills: ["épée", "fencing", "swimming", "golf"],
        bio: ["fencer", "swimmer", "athlete"],
        company: ["Gonzaga", "Simulator Product"],
      },
      topProfileShouldWin: true,
    };

    const { passed, score, report } = evaluateProfile(top, criteria);

    console.log("\n--- Evaluation Report ---");
    for (const line of report) {
      console.log("  " + line);
    }
    console.log(`\nScore: ${(score * 100).toFixed(0)}% — ${passed ? "PASSED" : "FAILED"}`);

    // Soft assertions that produce readable output on failure
    expect(passed, `Profile evaluation failed (score: ${(score * 100).toFixed(0)}%):\n${report.filter(r => r.startsWith("✗")).join("\n")}`).toBe(true);
  });

  it("Alexander Gu @ UT Austin — top profile should be the CS/AWS student", async () => {
    console.log("\n========================================");
    console.log("EVAL: Alexander Gu @ University of Texas at Austin");
    console.log("========================================");

    const session = await runSearch({
      mode: "person",
      name: "Alexander Gu",
      context: "University of Texas at Austin",
    });

    console.log(`\nSearch complete. ${session.profiles.length} profile(s) found.`);

    for (let i = 0; i < session.profiles.length; i++) {
      console.log(printProfile(session.profiles[i], i + 1));
    }

    // ── Grade the top profile ──
    const top = session.profiles[0];
    expect(top).toBeDefined();

    const criteria: EvalCriteria = {
      minConfidence: 0.55,
      expectedNameTokens: ["alexander", "gu"],
      expectedSignals: {
        company: ["amazon", "aws", "Amazon Web Services"],
        education: ["texas", "UT Austin", "austin"],
        social: ["linkedin.com/in/alexander-gu", "linkedin"],
        bio: ["amazon", "aws", "texas", "computer science"],
        title: ["engineer", "software", "cloud"],
      },
      forbiddenSignals: {
        bio: ["golf", "golfer", "dartmouth", "fencing"],
        company: ["DraftKings"],
        skills: ["golf", "fencing"],
      },
      topProfileShouldWin: true,
    };

    const { passed, score, report } = evaluateProfile(top, criteria);

    console.log("\n--- Evaluation Report ---");
    for (const line of report) {
      console.log("  " + line);
    }
    console.log(`\nScore: ${(score * 100).toFixed(0)}% — ${passed ? "PASSED" : "FAILED"}`);

    expect(passed, `Profile evaluation failed (score: ${(score * 100).toFixed(0)}%):\n${report.filter(r => r.startsWith("✗")).join("\n")}`).toBe(true);
  });
});
