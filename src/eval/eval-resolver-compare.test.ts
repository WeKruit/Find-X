import { describe, expect, it } from "vitest";
import { runSearch } from "@/lib/crawl/engine";
import { buildSingleProfile } from "@/lib/profile/builder";
import { llmMatchNames } from "@/lib/llm/client";
import {
  resolveEntitiesLegacy,
  resolveEntitiesWithDiagnostics,
} from "@/lib/entity/resolver";
import type { PersonMention, PersonProfile, SearchQuery } from "@/types";

const RUN_COMPARE = process.env.COMPARE === "true";

function normalizeProfile(profile: PersonProfile) {
  return {
    names: profile.names.map((entry) => entry.value),
    confidence: Number(profile.confidence.toFixed(3)),
    experiences: profile.experiences.map((entry) => ({
      title: entry.value.title,
      company: entry.value.company,
      isCurrent: entry.value.isCurrent,
    })),
    education: profile.education.map((entry) => entry.value.institution),
    locations: profile.locations.map((entry) => entry.value.city),
    socials: profile.socialProfiles.map((entry) => ({
      platform: entry.value.platform,
      url: entry.value.url,
    })),
    emails: profile.emails.map((entry) => entry.value),
    phones: profile.phones.map((entry) => entry.value),
    facts: profile.additionalFacts.map((entry) => entry.value),
    sources: profile.sources.map((source) => source.url).sort(),
    bioSnippet: profile.bioSnippet ?? null,
  };
}

function printProfile(profile: PersonProfile, label: string): string {
  const firstExp = profile.experiences.find((entry) => entry.value.isCurrent) ?? profile.experiences[0];
  const role = [firstExp?.value.title, firstExp?.value.company].filter(Boolean).join(" at ");
  const lines = [
    `${label}`,
    `  Name: ${profile.names.map((entry) => entry.value).join(" / ")}`,
    `  Confidence: ${profile.confidence.toFixed(3)}`,
  ];
  if (role) lines.push(`  Role: ${role}`);
  if (profile.education.length > 0) {
    lines.push(`  Education: ${profile.education.map((entry) => entry.value.institution).join(", ")}`);
  }
  if (profile.locations.length > 0) {
    lines.push(`  Location: ${profile.locations.map((entry) => entry.value.city).join(", ")}`);
  }
  if (profile.socialProfiles.length > 0) {
    lines.push(
      `  Social: ${profile.socialProfiles.map((entry) => `${entry.value.platform}: ${entry.value.url}`).join(", ")}`
    );
  }
  if (profile.bioSnippet) {
    lines.push(`  Bio: ${profile.bioSnippet}`);
  }
  if (profile.additionalFacts.length > 0) {
    lines.push("  Facts:");
    for (const fact of profile.additionalFacts.slice(0, 8)) {
      lines.push(`    - ${fact.value}`);
    }
  }
  lines.push(`  Sources (${profile.sources.length}): ${profile.sources.map((source) => source.url).join(", ")}`);
  return lines.join("\n");
}

function printClusterSources(mentions: PersonMention[]): string {
  return mentions.map((mention) => mention.sourceUrl).sort().join("\n    - ");
}

async function buildNameScoreMap(query: SearchQuery, mentions: PersonMention[]) {
  const names = new Set<string>();
  for (const mention of mentions) {
    for (const name of mention.extracted.names) names.add(name);
  }
  try {
    return await llmMatchNames(query.name, query.context, [...names]);
  } catch {
    return undefined;
  }
}

describe.skipIf(!RUN_COMPARE)("Resolver Comparison Eval", { timeout: 600_000 }, () => {
  it("compares legacy and new entity resolution for Alexander Gu @ UT Austin", async () => {
    const query: SearchQuery = {
      mode: "person",
      name: "Alexander Gu",
      context: "University of Texas at Austin",
    };

    console.log("\n========================================");
    console.log("COMPARE: Legacy vs New Resolver");
    console.log("Query: Alexander Gu @ University of Texas at Austin");
    console.log("========================================");

    const session = await runSearch(query);
    const mentions = session.crawlState.extractedMentions;
    expect(mentions.length).toBeGreaterThan(0);

    const llmNameScores = await buildNameScoreMap(query, mentions);

    const legacyClusters = await resolveEntitiesLegacy(mentions, query, llmNameScores);
    const current = await resolveEntitiesWithDiagnostics(mentions, query, llmNameScores);
    const currentClusters = current.clusters;

    const legacyProfiles = legacyClusters.map((cluster) => ({
      cluster,
      profile: buildSingleProfile(cluster),
    }));
    const currentProfiles = currentClusters.map((cluster) => ({
      cluster,
      profile: buildSingleProfile(cluster),
    }));

    console.log(`\nExtracted mentions: ${mentions.length}`);
    console.log(`Mention URLs:`);
    for (const mention of mentions) {
      console.log(`  - ${mention.sourceUrl}`);
    }

    console.log(`\nLegacy resolver clusters: ${legacyClusters.length}`);
    legacyProfiles.forEach(({ cluster, profile }, index) => {
      console.log(`\n[Legacy Cluster ${index + 1}]${cluster.isPrimaryTarget ? " PRIMARY" : ""}`);
      console.log(`  Mention count: ${cluster.mentions.length}`);
      console.log(`  Mention sources:\n    - ${printClusterSources(cluster.mentions)}`);
      console.log(printProfile(profile, "  Profile"));
    });

    console.log(`\nNew resolver clusters: ${currentClusters.length}`);
    console.log(
      `New resolver diagnostics: consolidated=${current.diagnostics.consolidatedMentions}, candidatePairs=${current.diagnostics.candidatePairs}, evaluatedPairs=${current.diagnostics.evaluatedPairs}`
    );
    currentProfiles.forEach(({ cluster, profile }, index) => {
      console.log(`\n[New Cluster ${index + 1}]${cluster.isPrimaryTarget ? " PRIMARY" : ""}`);
      console.log(`  Mention count: ${cluster.mentions.length}`);
      console.log(`  Mention sources:\n    - ${printClusterSources(cluster.mentions)}`);
      console.log(printProfile(profile, "  Profile"));
    });

    const legacyNormalized = legacyProfiles.map((entry) => ({
      isPrimaryTarget: entry.cluster.isPrimaryTarget,
      profile: normalizeProfile(entry.profile),
    }));
    const currentNormalized = currentProfiles.map((entry) => ({
      isPrimaryTarget: entry.cluster.isPrimaryTarget,
      profile: normalizeProfile(entry.profile),
    }));

    const sameClusterCount = legacyNormalized.length === currentNormalized.length;
    const sameProfiles =
      JSON.stringify(legacyNormalized, null, 2) === JSON.stringify(currentNormalized, null, 2);

    console.log("\n--- Comparison Summary ---");
    console.log(`  Same cluster count: ${sameClusterCount}`);
    console.log(`  Same normalized profiles: ${sameProfiles}`);
    console.log(`  Legacy primary clusters: ${legacyClusters.filter((cluster) => cluster.isPrimaryTarget).length}`);
    console.log(`  New primary clusters: ${currentClusters.filter((cluster) => cluster.isPrimaryTarget).length}`);

    expect(legacyClusters.length).toBeGreaterThan(0);
    expect(currentClusters.length).toBeGreaterThan(0);
  });
});
