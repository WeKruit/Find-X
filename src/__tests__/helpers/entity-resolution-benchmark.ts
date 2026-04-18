import type {
  EducationEntry,
  ExperienceEntry,
  PersonMention,
  SearchQuery,
  SkillEntry,
  SocialLink,
} from "@/types";
import type { EntityCluster } from "@/lib/entity/resolver";
import { nameScore } from "@/lib/entity/matching";

interface MentionInput {
  id: string;
  clusterId: string;
  sourceUrl?: string;
  confidence?: number;
  names: string[];
  experiences?: Array<Partial<ExperienceEntry>>;
  location?: string;
  education?: Array<string | Partial<EducationEntry>>;
  skills?: Array<string | SkillEntry>;
  socialLinks?: SocialLink[];
  emails?: string[];
  phones?: string[];
  bioSnippet?: string;
  additionalFacts?: string[];
}

export interface ResolutionFixture {
  id: string;
  description: string;
  query: SearchQuery;
  primaryClusterId: string;
  mentions: PersonMention[];
  expectedClusterByUrl: Record<string, string>;
}

export interface PairwiseMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface FixtureEvaluation {
  pairwise: PairwiseMetrics;
  targetJaccard: number;
  predictedClusterCount: number;
}

export interface BenchmarkSummary {
  avgPairwiseF1: number;
  avgTargetJaccard: number;
  totalDurationMs: number;
  caseResults: Array<{
    fixture: ResolutionFixture;
    evaluation: FixtureEvaluation;
    durationMs: number;
  }>;
}

const BENCHMARK_DATE = new Date("2026-01-01T00:00:00.000Z");

export const ENTITY_RESOLUTION_FIXTURES: ResolutionFixture[] = [
  createFixture({
    id: "linkedin-identity",
    description: "LinkedIn handle should dominate cross-page identity matching",
    query: {
      mode: "person",
      name: "Alex Chen",
      context: "Stripe payments",
    },
    primaryClusterId: "alex-stripe",
    mentions: [
      mention({
        id: "alex-stripe-linkedin",
        clusterId: "alex-stripe",
        sourceUrl: "https://www.linkedin.com/in/alex-chen-stripe",
        names: ["Alex Chen"],
        experiences: [{ title: "Staff Engineer", company: "Stripe", isCurrent: true }],
        education: ["Carnegie Mellon University"],
        location: "New York, New York",
        socialLinks: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/alex-chen-stripe" }],
        bioSnippet: "Engineer at Stripe focused on payments infrastructure.",
      }),
      mention({
        id: "alex-stripe-post",
        clusterId: "alex-stripe",
        sourceUrl: "https://www.linkedin.com/posts/alex-chen-stripe_platform-launch",
        names: ["Alex Chen"],
        experiences: [{ title: "Engineering Manager", company: "Stripe", isCurrent: true }],
        socialLinks: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/alex-chen-stripe" }],
        bioSnippet: "Launching a new Stripe Radar workflow.",
      }),
      mention({
        id: "alex-stripe-team",
        clusterId: "alex-stripe",
        sourceUrl: "https://stripe.com/team/alex-chen",
        names: ["Alexander Chen"],
        experiences: [{ title: "Engineering Manager", company: "Stripe", isCurrent: true }],
        education: ["Carnegie Mellon University"],
        socialLinks: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/alex-chen-stripe" }],
        location: "New York, New York",
      }),
      mention({
        id: "alex-figma-linkedin",
        clusterId: "alex-figma",
        sourceUrl: "https://www.linkedin.com/in/alex-chen-figma",
        names: ["Alex Chen"],
        experiences: [{ title: "Product Designer", company: "Figma", isCurrent: true }],
        education: ["Rhode Island School of Design"],
        socialLinks: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/alex-chen-figma" }],
        location: "San Francisco, California",
      }),
    ],
  }),
  createFixture({
    id: "github-handle-rescue",
    description: "GitHub handle should rescue sparse name variants",
    query: {
      mode: "person",
      name: "Maya Patel",
      context: "MIT robotics",
    },
    primaryClusterId: "maya-robotics",
    mentions: [
      mention({
        id: "maya-github",
        clusterId: "maya-robotics",
        sourceUrl: "https://github.com/mayaprobotics",
        names: ["Maya Patel"],
        education: ["Massachusetts Institute of Technology"],
        skills: ["ROS", "Python", "Robotics"],
        socialLinks: [{ platform: "GitHub", url: "https://github.com/mayaprobotics", username: "mayaprobotics" }],
        bioSnippet: "MIT robotics engineer building autonomous systems.",
      }),
      mention({
        id: "maya-portfolio",
        clusterId: "maya-robotics",
        sourceUrl: "https://www.mayapatel.dev",
        names: ["M Patel"],
        socialLinks: [{ platform: "GitHub", url: "https://github.com/mayaprobotics", username: "mayaprobotics" }],
        location: "Cambridge, Massachusetts",
        additionalFacts: ["Lead builder for the MIT Robotics Team"],
      }),
      mention({
        id: "maya-hackathon",
        clusterId: "maya-robotics",
        sourceUrl: "https://hack.mit.edu/team/maya-a-patel",
        names: ["Maya A Patel"],
        education: ["MIT"],
        socialLinks: [{ platform: "GitHub", url: "https://github.com/mayaprobotics", username: "mayaprobotics" }],
        bioSnippet: "Captain of the MIT Robotics Team.",
      }),
      mention({
        id: "maya-deloitte",
        clusterId: "maya-consulting",
        sourceUrl: "https://www.linkedin.com/in/maya-patel-consulting",
        names: ["Maya Patel"],
        experiences: [{ title: "Senior Consultant", company: "Deloitte", isCurrent: true }],
        education: ["Duke University"],
        location: "Chicago, Illinois",
      }),
    ],
  }),
  createFixture({
    id: "email-rescue",
    description: "Shared email should merge initials that name-only logic misses",
    query: {
      mode: "person",
      name: "Andrew James Brown",
      context: "LedgerFlow fintech",
    },
    primaryClusterId: "andrew-ledgerflow",
    mentions: [
      mention({
        id: "andrew-site",
        clusterId: "andrew-ledgerflow",
        sourceUrl: "https://andrewbrown.dev",
        names: ["Andrew James Brown"],
        experiences: [{ title: "Founding Engineer", company: "LedgerFlow", isCurrent: true }],
        emails: ["ajbrown@ledgerflow.com"],
        location: "New York, New York",
        bioSnippet: "Fintech infrastructure engineer building payment rails.",
      }),
      mention({
        id: "andrew-demo",
        clusterId: "andrew-ledgerflow",
        sourceUrl: "https://demo.day/teams/aj-brown",
        names: ["AJ Brown"],
        experiences: [{ title: "Founder", company: "LedgerFlow", isCurrent: true }],
        emails: ["ajbrown@ledgerflow.com"],
        bioSnippet: "Builder of LedgerFlow settlement products.",
      }),
      mention({
        id: "andrew-github",
        clusterId: "andrew-ledgerflow",
        sourceUrl: "https://github.com/ajbrown-fintech",
        names: ["Andrew Brown"],
        experiences: [{ title: "Engineer", company: "LedgerFlow", isCurrent: true }],
        emails: ["ajbrown@ledgerflow.com"],
        socialLinks: [{ platform: "GitHub", url: "https://github.com/ajbrown-fintech", username: "ajbrown-fintech" }],
      }),
      mention({
        id: "andrew-visa",
        clusterId: "andrew-visa",
        sourceUrl: "https://www.linkedin.com/in/andrew-brown-risk",
        names: ["Andrew Brown"],
        experiences: [{ title: "Risk Analyst", company: "Visa", isCurrent: true }],
        education: ["UNC Charlotte"],
        location: "Charlotte, North Carolina",
      }),
    ],
  }),
  createFixture({
    id: "aws-alias-bridge",
    description: "Organization and school aliases should bridge otherwise sparse mentions",
    query: {
      mode: "person",
      name: "Priya Nair",
      context: "Amazon Web Services",
    },
    primaryClusterId: "priya-aws",
    mentions: [
      mention({
        id: "priya-speakerdeck",
        clusterId: "priya-aws",
        sourceUrl: "https://speakerdeck.com/priyanair/cloud",
        names: ["Priya Nair"],
        experiences: [{ title: "Principal Engineer", company: "AWS", isCurrent: true }],
        education: ["Georgia Tech"],
        location: "Seattle, Washington",
        bioSnippet: "Building cloud security systems at AWS.",
      }),
      mention({
        id: "priya-securityconf",
        clusterId: "priya-aws",
        sourceUrl: "https://events.securityconf.com/priya-s-nair",
        names: ["Priya S Nair"],
        experiences: [{ title: "Principal Engineer", company: "Amazon Web Services", isCurrent: true }],
        education: ["Georgia Institute of Technology"],
        location: "Seattle, Washington",
      }),
      mention({
        id: "priya-blog",
        clusterId: "priya-aws",
        sourceUrl: "https://blog.priyanair.dev",
        names: ["P Nair"],
        experiences: [{ title: "Security Lead", company: "AWS", isCurrent: true }],
        education: ["Georgia Tech"],
      }),
      mention({
        id: "priya-microsoft",
        clusterId: "priya-microsoft",
        sourceUrl: "https://www.microsoft.com/team/priya-nair",
        names: ["Priya Nair"],
        experiences: [{ title: "Senior Engineer", company: "Microsoft Azure", isCurrent: true }],
        education: ["Purdue University"],
        location: "Redmond, Washington",
      }),
    ],
  }),
  createFixture({
    id: "noah-liu-split",
    description: "Common-name target should split cleanly across startup and athlete identities",
    query: {
      mode: "person",
      name: "Noah Liu",
      context: "University of Southern California",
    },
    primaryClusterId: "noah-usc",
    mentions: [
      mention({
        id: "noah-linkedin",
        clusterId: "noah-usc",
        sourceUrl: "https://www.linkedin.com/in/zelin-noah-liu",
        names: ["Noah Liu", "Zelin Noah Liu"],
        experiences: [{ title: "Co-Founder", company: "WeKruit", isCurrent: true }],
        education: ["University of Southern California"],
        socialLinks: [{ platform: "LinkedIn", url: "https://www.linkedin.com/in/zelin-noah-liu" }],
        bioSnippet: "Co-Founder at WeKruit and USC student leader.",
      }),
      mention({
        id: "noah-wekruit",
        clusterId: "noah-usc",
        sourceUrl: "https://wekruit.com/about/noah-liu",
        names: ["Noah Liu"],
        experiences: [{ title: "Co-Founder", company: "WeKruit", isCurrent: true }],
        education: ["USC"],
        bioSnippet: "USC founder building WeKruit.",
      }),
      mention({
        id: "noah-cssa",
        clusterId: "noah-usc",
        sourceUrl: "https://usc.org/clubs/cssa/noah-liu",
        names: ["Noah Liu"],
        experiences: [{ title: "President", company: "USC CSSA", isCurrent: true }],
        education: ["University of Southern California"],
        location: "Los Angeles, California",
      }),
      mention({
        id: "noah-fencing",
        clusterId: "noah-athlete",
        sourceUrl: "https://fencing.example.com/noah-liu",
        names: ["Noah Liu"],
        experiences: [{ title: "Team Captain", company: "Princeton Fencing", isCurrent: true }],
        education: ["Princeton University"],
        skills: ["Fencing"],
        location: "Princeton, New Jersey",
      }),
      mention({
        id: "noah-swim",
        clusterId: "noah-athlete",
        sourceUrl: "https://swim.example.com/noah-liu",
        names: ["Noah Liu"],
        experiences: [{ title: "Athlete", company: "Princeton Swim", isCurrent: true }],
        education: ["Princeton University"],
        skills: ["Swimming"],
        location: "Princeton, New Jersey",
      }),
      mention({
        id: "noah-kaggle",
        clusterId: "noah-kaggle",
        sourceUrl: "https://www.kaggle.com/noahliu",
        names: ["Noah Liu"],
        skills: ["Machine Learning"],
        location: "Toronto, Ontario",
      }),
    ],
  }),
  createScaleFixture(),
];

export function buildNameScoreMap(fixture: ResolutionFixture): Map<string, number> {
  const names = new Set<string>();
  for (const mention of fixture.mentions) {
    for (const name of mention.extracted.names) {
      names.add(name);
    }
  }
  return new Map([...names].map((name) => [name, nameScore(name, fixture.query.name)]));
}

export async function runBenchmarkSuite(
  resolver: (mentions: PersonMention[], query: SearchQuery, llmScores?: Map<string, number>) => Promise<EntityCluster[]>,
  fixtures = ENTITY_RESOLUTION_FIXTURES
): Promise<BenchmarkSummary> {
  const caseResults: BenchmarkSummary["caseResults"] = [];

  for (const fixture of fixtures) {
    const started = performance.now();
    const clusters = await resolver(fixture.mentions, fixture.query, buildNameScoreMap(fixture));
    const durationMs = performance.now() - started;
    caseResults.push({
      fixture,
      evaluation: evaluateFixture(fixture, clusters),
      durationMs,
    });
  }

  return {
    avgPairwiseF1:
      caseResults.reduce((sum, result) => sum + result.evaluation.pairwise.f1, 0) / caseResults.length,
    avgTargetJaccard:
      caseResults.reduce((sum, result) => sum + result.evaluation.targetJaccard, 0) / caseResults.length,
    totalDurationMs: caseResults.reduce((sum, result) => sum + result.durationMs, 0),
    caseResults,
  };
}

export function evaluateFixture(
  fixture: ResolutionFixture,
  clusters: EntityCluster[]
): FixtureEvaluation {
  const assignment = clusterAssignmentByUrl(clusters);
  const urls = Object.keys(fixture.expectedClusterByUrl);

  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let i = 0; i < urls.length; i++) {
    for (let j = i + 1; j < urls.length; j++) {
      const expectedSame =
        fixture.expectedClusterByUrl[urls[i]] === fixture.expectedClusterByUrl[urls[j]];
      const predictedSame = assignment[urls[i]] === assignment[urls[j]];

      if (predictedSame && expectedSame) tp++;
      else if (predictedSame && !expectedSame) fp++;
      else if (!predictedSame && expectedSame) fn++;
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const expectedPrimary = urls.filter((url) => fixture.expectedClusterByUrl[url] === fixture.primaryClusterId);
  const predictedPrimary = new Set(
    clusters
      .filter((cluster) => cluster.isPrimaryTarget)
      .flatMap((cluster) => cluster.mentions.map((mention) => mention.sourceUrl))
  );
  const targetIntersection = expectedPrimary.filter((url) => predictedPrimary.has(url)).length;
  const targetUnion = new Set([...expectedPrimary, ...predictedPrimary]).size || 1;

  return {
    pairwise: { tp, fp, fn, precision, recall, f1 },
    targetJaccard: targetIntersection / targetUnion,
    predictedClusterCount: clusters.length,
  };
}

export function legacyAllPairsCount(fixture: ResolutionFixture): number {
  const count = fixture.mentions.length;
  return (count * (count - 1)) / 2;
}

function createFixture(input: {
  id: string;
  description: string;
  query: SearchQuery;
  primaryClusterId: string;
  mentions: Array<{ id: string; clusterId: string; mention: PersonMention }>;
}): ResolutionFixture {
  return {
    id: input.id,
    description: input.description,
    query: input.query,
    primaryClusterId: input.primaryClusterId,
    mentions: input.mentions.map((entry) => entry.mention),
    expectedClusterByUrl: Object.fromEntries(
      input.mentions.map((entry) => [entry.mention.sourceUrl, entry.clusterId])
    ),
  };
}

function mention(input: MentionInput): { id: string; clusterId: string; mention: PersonMention } {
  return {
    id: input.id,
    clusterId: input.clusterId,
    mention: makeMention(input),
  };
}

export function makeMention(input: MentionInput): PersonMention {
  return {
    sourceUrl: input.sourceUrl ?? `https://example.com/${input.id}`,
    fetchedAt: BENCHMARK_DATE,
    confidence: input.confidence ?? 0.82,
    extracted: {
      names: input.names,
      experiences: (input.experiences ?? []).map((experience) => ({
        title: experience.title ?? "",
        company: experience.company ?? "",
        isCurrent: experience.isCurrent ?? true,
        startDate: experience.startDate,
        endDate: experience.endDate,
        location: experience.location,
        description: experience.description,
      })),
      location: input.location,
      education: (input.education ?? []).map((entry) =>
        typeof entry === "string"
          ? { institution: entry }
          : {
              institution: entry.institution ?? "",
              degree: entry.degree,
              field: entry.field,
              year: entry.year,
            }
      ),
      skills: (input.skills ?? []).map((skill) =>
        typeof skill === "string" ? { name: skill } : skill
      ),
      socialLinks: input.socialLinks ?? [],
      emails: input.emails ?? [],
      phones: input.phones ?? [],
      bioSnippet: input.bioSnippet,
      relationships: [],
      dates: [],
      additionalFacts: input.additionalFacts ?? [],
      certifications: [],
      publications: [],
      awards: [],
      languages: [],
    },
  };
}

function createScaleFixture(): ResolutionFixture {
  const clusterTemplates = [
    {
      clusterId: "chris-amplitude",
      orgs: ["Amplitude", "Amplitude Analytics"],
      schools: ["UCLA", "University of California Los Angeles"],
      location: "Los Angeles, California",
      handle: "cpark-amp",
    },
    {
      clusterId: "chris-notion",
      orgs: ["Notion"],
      schools: ["UC Berkeley", "University of California Berkeley"],
      location: "San Francisco, California",
      handle: "cpark-notion",
    },
    {
      clusterId: "chris-stripe",
      orgs: ["Stripe"],
      schools: ["USC", "University of Southern California"],
      location: "New York, New York",
      handle: "cpark-stripe",
    },
    {
      clusterId: "chris-canva",
      orgs: ["Canva"],
      schools: ["CMU", "Carnegie Mellon University"],
      location: "San Francisco, California",
      handle: "cpark-canva",
    },
    {
      clusterId: "chris-ramp",
      orgs: ["Ramp"],
      schools: ["MIT", "Massachusetts Institute of Technology"],
      location: "New York, New York",
      handle: "cpark-ramp",
    },
  ];

  const nameVariants = ["Chris Park", "Christopher Park", "Chris H Park", "C Park", "Chris Park"];
  const generatedMentions = clusterTemplates.flatMap((template, templateIndex) =>
    nameVariants.map((name, variantIndex) =>
      mention({
        id: `${template.clusterId}-${variantIndex}`,
        clusterId: template.clusterId,
        sourceUrl:
          variantIndex === 0
            ? `https://github.com/${template.handle}`
            : `https://people.example.com/${template.clusterId}/${variantIndex}`,
        names: [name],
        experiences: [
          {
            title: templateIndex % 2 === 0 ? "Product Analytics Lead" : "Senior Product Manager",
            company: template.orgs[variantIndex % template.orgs.length],
            isCurrent: true,
          },
        ],
        education: [template.schools[variantIndex % template.schools.length]],
        location: template.location,
        socialLinks:
          variantIndex === 0
            ? [{ platform: "GitHub", url: `https://github.com/${template.handle}`, username: template.handle }]
            : [],
        skills: ["Analytics", "SQL", "Experimentation"],
        bioSnippet: `${name} works on product analytics at ${template.orgs[0]}.`,
      })
    )
  );

  const distractors = [
    mention({
      id: "chris-salesforce",
      clusterId: "chris-salesforce",
      sourceUrl: "https://linkedin.com/in/chris-park-salesforce",
      names: ["Chris Park"],
      experiences: [{ title: "Revenue Operations Manager", company: "Salesforce", isCurrent: true }],
      education: ["Duke University"],
      location: "Chicago, Illinois",
    }),
    mention({
      id: "chris-zillow",
      clusterId: "chris-zillow",
      sourceUrl: "https://example.com/chris-park-zillow",
      names: ["Chris Park"],
      experiences: [{ title: "Growth Lead", company: "Zillow", isCurrent: true }],
      education: ["University of Washington"],
      location: "Seattle, Washington",
    }),
    mention({
      id: "christine-park",
      clusterId: "christine-park",
      sourceUrl: "https://example.com/christine-park",
      names: ["Christine Park"],
      experiences: [{ title: "Designer", company: "Figma", isCurrent: true }],
      education: ["RISD"],
      location: "San Francisco, California",
    }),
  ];

  return createFixture({
    id: "scale-blocking",
    description: "Large same-name corpus should benchmark blocking efficiency",
    query: {
      mode: "person",
      name: "Chris Park",
      context: "Amplitude UCLA",
    },
    primaryClusterId: "chris-amplitude",
    mentions: [...generatedMentions, ...distractors],
  });
}

function clusterAssignmentByUrl(clusters: EntityCluster[]): Record<string, string> {
  const result: Record<string, string> = {};
  clusters.forEach((cluster, clusterIndex) => {
    cluster.mentions.forEach((mention) => {
      result[mention.sourceUrl] = `cluster-${clusterIndex}`;
    });
  });
  return result;
}
