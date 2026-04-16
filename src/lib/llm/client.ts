import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { PersonMention, SearchQuery, ExtractedPersonData } from "@/types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const LLM_MODEL = process.env.LLM_MODEL || "claude-haiku-4-5-20251001";

const LLM_TIMEOUT_MS = 30_000;
const LLM_MAX_RETRIES = 2;

// ── Token Usage Tracking ──

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
}

/** Per-session token tracker. Create one per search session and pass to LLM functions. */
export function createTokenTracker(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
}

/** Per-request token tracker stored in async context — safe for concurrent requests. */
const trackerStorage = new AsyncLocalStorage<TokenUsage>();

/**
 * Run a function with a specific token tracker bound to the current async context.
 * Each concurrent request gets its own isolated tracker — no shared mutable state.
 */
export function runWithTracker<T>(tracker: TokenUsage, fn: () => Promise<T>): Promise<T> {
  return trackerStorage.run(tracker, fn);
}

export function getActiveTracker(): TokenUsage | null {
  return trackerStorage.getStore() ?? null;
}

// ── Zod Schemas for LLM Response Validation ──

const AdaptiveQueryRegenSchema = z.object({
  action: z.enum(["generate_queries", "continue_crawling", "both"]),
  reasoning: z.string(),
  newQueries: z.array(z.string()).default([]),
  stopCrawling: z.boolean().default(false),
});

const ScoredLinkSchema = z.object({
  url: z.string(),
  score: z.number().transform((n) => Math.max(0, Math.min(1, Number(n) || 0))),
  reason: z.string().default(""),
});

const OtherPersonSchema = z.object({
  names: z.array(z.string()).default([]),
  title: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  relationshipToTarget: z.string().nullable().optional(),
  bioSnippet: z.string().nullable().optional(),
});

const ExperienceEntrySchema = z.object({
  title: z.string(),
  company: z.string(),
  isCurrent: z.boolean().default(false),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const SkillEntrySchema = z.union([
  z.object({
    name: z.string(),
    proficiency: z.enum(["beginner", "intermediate", "expert"]).nullable().optional(),
  }),
  // Gracefully accept plain strings (LLM may use old format)
  z.string().transform((s) => ({ name: s, proficiency: undefined })),
]);

const PublicationEntrySchema = z.object({
  title: z.string(),
  venue: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
  url: z.string().nullable().optional(),
  coAuthors: z.array(z.string()).default([]),
});

const AwardEntrySchema = z.object({
  title: z.string(),
  issuer: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
});

const CertificationEntrySchema = z.object({
  name: z.string(),
  issuer: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
});

const ExtractPersonSchema = z.object({
  mentionsTarget: z.boolean(),
  confidence: z.number().transform((n) => Math.max(0, Math.min(1, Number(n) || 0))),
  extracted: z.object({
    names: z.array(z.string()).default([]),
    experiences: z.array(ExperienceEntrySchema).default([]),
    location: z.string().nullable().optional(),
    education: z.array(z.object({
      institution: z.string(),
      degree: z.string().nullable().optional(),
      field: z.string().nullable().optional(),
      year: z.number().nullable().optional(),
    })).default([]),
    skills: z.array(SkillEntrySchema).default([]),
    socialLinks: z.array(z.object({
      platform: z.string(),
      url: z.string(),
    })).default([]),
    emails: z.array(z.string()).default([]),
    phones: z.array(z.string()).default([]),
    bioSnippet: z.string().nullable().optional(),
    relationships: z.array(z.object({
      name: z.string(),
      relationship: z.string(),
    })).default([]),
    dates: z.array(z.object({
      event: z.string(),
      date: z.string(),
    })).default([]),
    additionalFacts: z.array(z.string()).default([]),
    certifications: z.array(CertificationEntrySchema).default([]),
    publications: z.array(PublicationEntrySchema).default([]),
    awards: z.array(AwardEntrySchema).default([]),
    languages: z.array(z.string()).default([]),
  }),
  otherPeople: z.array(OtherPersonSchema).default([]),
});

const DecomposeCriteriaSchema = z.object({
  keywords: z.array(z.string()).default([]),
  requiredTraits: z.array(z.string()).default([]),
  niceToHave: z.array(z.string()).default([]),
  searchQueries: z.array(z.string()).default([]),
  pageTypesToPrioritize: z.array(z.string()).default([]),
  exclusionSignals: z.array(z.string()).default([]),
  preferredDomains: z.array(z.string()).default([]),
  exclusionDomains: z.array(z.string()).default([]),
});

const ExtractMultiplePeopleSchema = z.object({
  peopleFound: z.array(z.object({
    name: z.string(),
    title: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    criteriaEvidence: z.string().default(""),
    matchScore: z.number().transform((n) => Math.max(0, Math.min(1, Number(n) || 0))),
    matchReasoning: z.string().default(""),
    additionalFacts: z.object({
      education: z.string().nullable().optional(),
      skills: z.array(z.string()).default([]),
      socialUrl: z.string().nullable().optional(),
      organizations: z.array(z.string()).default([]),
    }).transform(v => ({
      education: v.education ?? undefined,
      skills: v.skills,
      socialUrl: v.socialUrl ?? undefined,
      organizations: v.organizations.length > 0 ? v.organizations : undefined,
    })),
  })).default([]),
});

const DisambiguateSchema = z.object({
  samePerson: z.boolean().nullable(),
  confidence: z.number().transform((n) => Math.max(0, Math.min(1, Number(n) || 0))),
  reasoning: z.string().default(""),
});

const NameMatchEntrySchema = z.object({
  name: z.string(),
  match: z.boolean(),
  confidence: z.number().transform((n) => Math.max(0, Math.min(1, Number(n) || 0))),
});

const NameMatchResultSchema = z.object({
  results: z.array(NameMatchEntrySchema).default([]),
});

const ClusterGroupSchema = z.object({
  ids: z.array(z.number().int()),
  isTarget: z.boolean(),
  confidence: z.number().transform((n) => Math.max(0, Math.min(1, Number(n) || 0))),
  reason: z.string().default(""),
});

const ClusterResultSchema = z.object({
  groups: z.array(ClusterGroupSchema),
});

export type ClusterGroup = z.infer<typeof ClusterGroupSchema>;

const SnippetSynthesisSchema = z.object({
  matchFound: z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true"),
  confidence: z.number().transform((n) => Math.max(0, Math.min(1, Number(n) || 0))),
  extracted: z.object({
    names: z.array(z.string()).default([]),
    experiences: z.array(ExperienceEntrySchema).catch([]),
    location: z.string().nullable().optional(),
    education: z.array(z.object({
      institution: z.string(),
      degree: z.string().nullable().optional(),
      field: z.string().nullable().optional(),
      year: z.number().nullable().optional(),
    })).catch([]),
    skills: z.array(SkillEntrySchema).catch([]),
    socialLinks: z.array(z.object({
      platform: z.string(),
      url: z.string(),
      username: z.string().nullable().optional(),
    })).catch([]),
    emails: z.array(z.string()).catch([]),
    phones: z.array(z.string()).catch([]),
    bioSnippet: z.string().nullable().optional(),
    // Use .catch([]) on these so malformed LLM output (e.g. strings instead of objects) silently drops to []
    relationships: z.array(z.object({
      name: z.string(),
      relationship: z.string(),
    })).catch([]),
    dates: z.array(z.object({
      event: z.string(),
      date: z.string(),
    })).catch([]),
    additionalFacts: z.array(z.string()).catch([]),
    certifications: z.array(CertificationEntrySchema).catch([]),
    publications: z.array(PublicationEntrySchema).catch([]),
    awards: z.array(AwardEntrySchema).catch([]),
    languages: z.array(z.string()).catch([]),
  }),
  refinedQueries: z.array(z.string()).catch([]),
});

// ── LLM Call Helper with System Messages, Temperature, Timeout + Retry ──

interface LLMCallOptions {
  model: string;
  maxTokens: number;
  system?: string;
  messages: Anthropic.MessageParam[];
  temperature?: number;
}

async function llmCall(opts: LLMCallOptions): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

      try {
        const params: Anthropic.MessageCreateParams = {
          model: opts.model,
          max_tokens: opts.maxTokens,
          messages: opts.messages,
        };
        if (opts.system) {
          params.system = opts.system;
        }
        if (opts.temperature !== undefined) {
          params.temperature = opts.temperature;
        }

        const response = await anthropic.messages.create(
          params,
          { signal: controller.signal },
        );
        clearTimeout(timeout);

        // Track token usage — reads from the async-local context, safe for concurrent requests
        const tracker = trackerStorage.getStore();
        if (tracker && response.usage) {
          tracker.inputTokens += response.usage.input_tokens;
          tracker.outputTokens += response.usage.output_tokens;
          tracker.llmCalls++;
        }

        const block = response.content[0];
        return block.type === "text" ? block.text : "";
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastError = err;

      // Retry on rate limit (429) or server errors (5xx)
      const status = (err as { status?: number }).status;
      if (status === 429 || (status && status >= 500)) {
        const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      // Abort errors from timeout — retry once
      if (err instanceof Error && err.name === "AbortError" && attempt < LLM_MAX_RETRIES) {
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

/** Extract JSON object from LLM text response — handles reasoning-then-JSON patterns */
function extractJsonObject(text: string): unknown | null {
  // Try to find JSON in <json> tags first (chain-of-thought pattern)
  const tagMatch = text.match(/<json>\s*([\s\S]*?)\s*<\/json>/);
  if (tagMatch) {
    try {
      return JSON.parse(tagMatch[1]);
    } catch { /* fall through */ }
  }

  // Fall back to finding the last complete JSON object (skips reasoning text with braces)
  const matches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (matches && matches.length > 0) {
    // Try the last match first (most likely the actual output after reasoning)
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(matches[i]);
      } catch { continue; }
    }
  }

  // Last resort: greedy match
  const greedy = text.match(/\{[\s\S]*\}/);
  if (greedy) {
    try {
      return JSON.parse(greedy[0]);
    } catch { /* fall through */ }
  }

  return null;
}

/** Extract JSON array from LLM text response */
function extractJsonArray(text: string): unknown | null {
  // Try <json> tags first
  const tagMatch = text.match(/<json>\s*([\s\S]*?)\s*<\/json>/);
  if (tagMatch) {
    try {
      return JSON.parse(tagMatch[1]);
    } catch { /* fall through */ }
  }

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ── Static System Prompts (cacheable by Anthropic) ──

const SYSTEM_EXTRACT_PERSON = `You are an expert information extraction agent for a person research platform.

Your job: Given a web page, extract structured data about a target person and other notable people mentioned.

Core principles:
- ONLY extract information that is explicitly stated on the page. Never infer, guess, or fabricate.
- Be thorough — capture everything the page says about the target, especially facts that don't fit standard fields (awards, publications, projects, etc.)
- Be precise with confidence scoring — this directly affects research quality.
- Watch for same-name collisions: two different people can share a name.

Name extraction rules:
- The "names" array MUST include ALL name variants found on the page for this person.
- If someone goes by "Zelin(Noah) Liu" or "Zelin 'Noah' Liu", extract BOTH "Zelin Noah Liu" AND "Noah Liu".
- If someone uses a middle name, nickname, maiden name, or alias, include both the full name and the short form.
- Include: full legal name, preferred name, nicknames, transliterations, maiden names.
- This is critical for entity resolution — if you only extract "Zelin Noah Liu" and the user searched for "Noah Liu", we cannot match them.

Confidence calibration:
- 0.90-1.0: Page is clearly about the target (e.g., their LinkedIn profile, personal website, bio page matching the context)
- 0.70-0.89: Strong match — name matches and multiple context signals align (same company, school, location)
- 0.50-0.69: Moderate — name matches, some context aligns but some is missing or uncertain
- 0.30-0.49: Weak — name matches but context signals conflict or are absent
- 0.01-0.29: Likely a different person with the same name — context contradicts what we know
- 0.0: Page does not mention anyone with this name

Process:
1. First, scan the page for any mention of the target name or close variants.
2. If found, assess whether the context matches the identifying information provided.
3. Extract all structured fields that are explicitly present.
4. Capture any additional noteworthy facts in additionalFacts — don't lose information.
5. Note other people mentioned (colleagues, co-authors, etc.) who could help build the network.
6. Output your result as JSON inside <json> tags.`;

const SYSTEM_SCORE_LINKS = `You are a web research assistant evaluating which links on a page are worth following to find information about a specific person.

Scoring calibration:
- 0.85-1.0: Almost certainly contains direct info about the target (their profile page, personal site, dedicated bio, interview with them)
- 0.65-0.84: Likely relevant (article mentioning them, their employer's team page, conference where they spoke)
- 0.45-0.64: Possibly relevant (related organization page, topic page in their field, news from their company)
- 0.25-0.44: Tangentially related (general industry page, loosely related topic)
- 0.0-0.24: Irrelevant (ads, login pages, unrelated navigation, generic social media)

Prioritize:
- Links that could fill MISSING information gaps
- Profile/bio pages over general articles
- Pages from high-signal domains (LinkedIn, GitHub, university sites)

Output ONLY a JSON array inside <json> tags. Include only links scoring >= 0.3, maximum 20.`;

const SYSTEM_ADAPTIVE_QUERY = `You are a research strategist guiding a web crawling system that searches for information about a specific person.

You are called periodically during the crawl to decide whether to:
1. Generate new search queries based on what's been learned
2. Continue following links already queued
3. Both
4. Stop crawling (profile is complete)

Decision framework:
- If the facts reveal new leads (different name spelling, new affiliation, new company) → generate targeted queries
- If the frontier has high-scoring links and information is flowing → continue crawling
- If facts are organized by identity clusters, ONLY consider the TARGET CLUSTER's gaps. Other clusters are different people.
- If the target cluster's profile is substantially complete (6+ of 7 key fields filled) → consider stopping
- New queries MUST incorporate newly learned facts and MUST differ from previous queries
- Always include identifying context (school, company, etc.) in queries to avoid chasing the wrong person

Output JSON inside <json> tags.`;

const SYSTEM_SYNTHESIZE_SNIPPETS = `You are an expert person-research analyst. You are given a set of search result titles and snippets from a web search about a specific person.

Your task: synthesize everything the snippets collectively reveal about that person into a structured profile.

Core principles:
- Extract ONLY what is explicitly stated — never infer, guess, or fabricate.
- Search snippets are short but information-dense. A single snippet line like "TJHSST 25 | UT Austin Turing Scholar - CS and Math. Fairfax, VA." contains name, high school, university program, degree fields, location, and graduation year.
- Extract social profile usernames from URLs: a LinkedIn URL like /in/alexander-gu gives username "alexander-gu"; a GitHub URL like github.com/alexgu gives username "alexgu".
- Capture everything that doesn't fit a structured field in additionalFacts — programs, awards, competitions, papers, clubs, hobbies, etc.
- If multiple people share the queried name across these snippets, focus EXCLUSIVELY on the one that best matches any provided context. DISCARD snippets that refer to a different person with the same name — do NOT mix facts from two different individuals into one profile. For example, if searching for "Alexander Gu" with context "UT Austin" and some snippets are about a golfer named Alexander Gu from Connecticut, completely ignore the golf snippets.
- Set matchFound=false ONLY when no snippet at all mentions the queried person — if even one snippet clearly relates to the target (e.g. context "UT Austin" appears in a snippet), set matchFound=true and extract from it.
- When context is provided and at least one snippet clearly matches that context, always set matchFound=true.
- Be generous with additionalFacts for the TARGET person — capture everything about them, but nothing from different people with the same name.

After extracting the profile, generate 1-2 focused follow-up search queries that would yield the MOST NEW information. These queries should:
- Incorporate specific facts you just found (program names, company names, known usernames)
- NOT repeat the original queries
- Target high-signal pages: LinkedIn profiles, GitHub, university pages, personal websites
- Include the person's name plus 1-2 newly discovered identifiers

Output JSON inside <json> tags.`;

const SYSTEM_DISAMBIGUATE = `You are an entity resolution expert determining whether two web mentions refer to the same real-world person.

Reasoning approach:
1. Compare names — exact match, nickname, or transliteration?
2. Compare roles/titles — compatible career progression, or contradictory?
3. Compare companies — same employer, or incompatible employers for the same time period?
4. Compare locations — compatible geography?
5. Compare additional details — shared education, skills, or connections?
6. Consider the sources — are these the kind of pages that would mention the same person?

Confidence calibration:
- 0.90-1.0: Definitely same person (multiple strong signals align: same name + same company + same role)
- 0.70-0.89: Very likely same person (name matches, at least one strong contextual match, no contradictions)
- 0.50-0.69: Probably same person but uncertain (name matches, weak contextual signals, no contradictions)
- 0.30-0.49: Uncertain — could go either way (name matches, but insufficient data to confirm)
- 0.10-0.29: Probably different people (name matches but some contradictory signals)
- 0.0-0.09: Definitely different people (clear contradictions in role, company, location, or timeline)

Think step by step in <reasoning> tags, then output JSON in <json> tags.`;

const SYSTEM_DECOMPOSE_CRITERIA = `You are an expert at decomposing people-search criteria into actionable web search strategies.

Given a natural language description of the kind of person someone is looking for, break it down into:
- Required traits (must-have for a match)
- Nice-to-have traits (boost relevance)
- Diverse search queries (vary keywords, sites, and approaches)
- Page types to prioritize
- Exclusion signals (signs a person does NOT match)
- Preferred domains (e.g. "usc.edu" for University of Southern California)
- Exclusion domains (e.g. "sc.edu" when searching for USC California to avoid University of South Carolina)

DISAMBIGUATION: When a university or organization name is ambiguous (USC = University of Southern California OR University of South Carolina, BU = Boston University OR Binghamton, UT = Texas OR Tennessee, etc.), ALWAYS:
1. Identify the most likely intended institution from context (e.g., "USC Trojans", "USC Marshall", "Los Angeles" → University of Southern California)
2. Use the full institution name in at least half the search queries
3. Add the competing institution's domain to exclusionDomains
4. Add competitor keywords to exclusionSignals

Generate 8-10 diverse search queries. CRITICAL: at least 3 queries MUST target pages that list individual people BY NAME. These are more useful than generic org-list pages:
- Student spotlight/blog posts featuring named individuals (e.g. "meet our members", "student spotlight", "profile")
- Org leadership/officer rosters listing individual names
- News articles, admission blogs, or school newsletters profiling specific students
- LinkedIn profiles of individual people matching the criteria
- Student org "about us" pages listing named officers

Also include 2-3 queries targeting broader list pages (org directories, club listings) as secondary sources.

Output JSON inside <json> tags.`;

const SYSTEM_EXTRACT_MULTIPLE = `You are extracting ALL people mentioned on a web page who might match search criteria.

Be thorough — extract every person you find, even partial matches. The downstream system will handle ranking and deduplication.

Match score calibration:
- 0.80-1.0: Strong match — clear evidence the person meets required criteria
- 0.50-0.79: Partial match — some criteria met, others unclear or missing
- 0.20-0.49: Weak match — name or role is in the right ballpark but evidence is thin
- 0.0-0.19: Very weak — include for completeness but likely not a match

criteriaEvidence MUST be a direct quote or close paraphrase from the page — never fabricate evidence.

Output JSON inside <json> tags.`;

const SYSTEM_MATCH_NAMES = `You are a name-matching expert for entity resolution. Your job is to determine whether extracted names could refer to the same person as a query name.

You understand:
- Nicknames and diminutives: Alex = Alexander, Bob/Bobby = Robert, Bill/Billy = William, Mike = Michael, Dick/Rick = Richard, Jim/Jimmy = James, Liz/Beth/Betty = Elizabeth, Kate/Katie = Katherine/Catherine, Tom/Tommy = Thomas, Dan/Danny = Daniel, Joe = Joseph, Ed/Eddie = Edward, Sam = Samuel, Dave = David, Steve = Steven/Stephen, Chris = Christopher/Christine, Matt = Matthew, Pat = Patrick/Patricia, Tony = Anthony, Nick = Nicholas, Jack = John, Peggy = Margaret, Chuck = Charles, Ted = Theodore/Edward, Hank = Henry
- Middle names used as first names: "Zelin Noah Liu" going by "Noah Liu"
- Cultural naming patterns: Chinese names (pinyin vs traditional), Korean, Japanese, Indian, Hispanic (dual surnames), etc.
- Transliterations between scripts
- Name order variations (given-family vs family-given)
- Hyphenated vs unhyphenated surnames
- Maiden names and married names (if context suggests)

For each candidate name, decide if it COULD be the same person as the query name. Be generous with matches — it's better to include a potential match than to miss the right person. The downstream system will verify using context.

Output JSON inside <json> tags.`;

// ── Exported LLM Functions ──

export interface SnippetSynthesisResult {
  extracted: ExtractedPersonData;
  refinedQueries: string[];
}

/**
 * Synthesize a person profile from raw search result snippets using an LLM.
 *
 * Unlike the regex-based snippet extractor, this reads the full set of titles and
 * snippets holistically and can surface information that spans multiple results
 * (e.g. program names, awards, social handles embedded in URLs). It also returns
 * 1-2 targeted follow-up search queries derived from whatever facts were found.
 *
 * Returns null if the snippets clearly don't match the queried person, or if
 * the LLM call fails (caller should treat this as a graceful no-op).
 */
export async function llmSynthesizeFromSnippets(
  searchResults: Array<{ title: string; url: string; snippet: string }>,
  queryName: string,
  queryContext?: string
): Promise<SnippetSynthesisResult | null> {
  if (searchResults.length === 0) return null;

  // Build a compact numbered list of all results for the prompt
  const resultsText = searchResults
    .slice(0, 30) // cap at 30 to stay within token limits
    .map((r, i) => {
      const lines = [`[${i + 1}] Title: ${r.title}`, `    URL: ${r.url}`];
      if (r.snippet) lines.push(`    Snippet: ${r.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");

  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 2048,
      temperature: 0.1,
      system: SYSTEM_SYNTHESIZE_SNIPPETS,
      messages: [{
        role: "user",
        content: `<target_person>${queryName}</target_person>
${queryContext ? `<identifying_context>${queryContext}</identifying_context>\n` : ""}
<search_results>
${resultsText}
</search_results>

Synthesize everything these snippets reveal about ${queryName}${queryContext ? ` (context: ${queryContext})` : ""}. Extract every piece of information explicitly present.

Output JSON inside <json> tags:
<json>
{
  "matchFound": true,
  "confidence": 0.0-1.0,
  "extracted": {
    "names": ["Full Name as it appears in snippets"],
    "experiences": [
      {"title": "Software Engineer", "company": "Amazon", "isCurrent": true, "startDate": null, "endDate": null, "location": null, "description": null}
    ],
    "location": "City, State/Country or null",
    "education": [{"institution": "University name", "degree": "BS/MS/PhD or null", "field": "Major or null", "year": null}],
    "skills": [{"name": "Python"}, {"name": "Machine Learning", "proficiency": "expert"}],
    "socialLinks": [{"platform": "LinkedIn", "url": "https://...", "username": "handle-from-url"}],
    "emails": ["email@example.com"],
    "phones": [],
    "bioSnippet": "1-2 sentence synthesized summary of who this person is, written in third person",
    "relationships": [],
    "dates": [],
    "additionalFacts": [
      "Each fact is a self-contained sentence — programs, awards, high school, clubs, hobbies, research papers, competitions, anything notable",
      "Up to 15 facts — do NOT discard information because it seems minor"
    ],
    "certifications": [{"name": "AWS Solutions Architect", "issuer": "Amazon", "year": null}],
    "publications": [{"title": "Paper title", "venue": "NeurIPS 2023", "year": 2023, "url": null, "coAuthors": []}],
    "awards": [{"title": "1st Place Hackathon", "issuer": "HackUT", "year": 2023}],
    "languages": ["English", "Mandarin"]
  },
  "refinedQueries": [
    "1-2 follow-up search queries using newly discovered facts to find more information"
  ]
}
</json>`,
      }],
    });

    const raw = extractJsonObject(text);
    if (!raw) return null;

    // LLMs sometimes return the extracted sub-object directly (flat) rather than the
    // wrapped {matchFound, confidence, extracted} envelope. Detect and normalise.
    let normalised: Record<string, unknown> = raw as Record<string, unknown>;
    if (typeof normalised === "object" && normalised !== null &&
        !("matchFound" in normalised) && ("names" in normalised || "experiences" in normalised || "education" in normalised)) {
      // LLM returned the extracted object directly — infer confidence from field richness
      const flatObj = normalised as Record<string, unknown>;
      const expCount = Array.isArray(flatObj.experiences) ? (flatObj.experiences as unknown[]).length : 0;
      const fieldCount =
        (expCount > 0 ? 2 : 0) + (flatObj.location ? 1 : 0) +
        (Array.isArray(flatObj.education) ? Math.min((flatObj.education as unknown[]).length, 2) : 0) +
        (Array.isArray(flatObj.additionalFacts) ? Math.min((flatObj.additionalFacts as unknown[]).length, 5) * 0.3 : 0);
      const inferredConfidence = Math.min(0.7, 0.35 + fieldCount * 0.06);
      normalised = { matchFound: true, confidence: inferredConfidence, extracted: raw, refinedQueries: [] };
    }

    const result = SnippetSynthesisSchema.safeParse(normalised);
    if (!result.success) return null;

    if (!result.data.matchFound || result.data.confidence < 0.1) return null;

    const e = result.data.extracted;
    const extracted: ExtractedPersonData = {
      names: e.names.filter((n): n is string => typeof n === "string" && n.trim().length > 0),
      experiences: (e.experiences || []).filter((x) => x != null && typeof x.title === "string" && typeof x.company === "string").map((x) => ({
        title: x.title, company: x.company, isCurrent: x.isCurrent,
        startDate: x.startDate ?? undefined, endDate: x.endDate ?? undefined,
        location: x.location ?? undefined, description: x.description ?? undefined,
      })),
      location: typeof e.location === "string" ? e.location : undefined,
      education: (e.education || []).filter(
        (edu): edu is { institution: string; degree?: string; field?: string; year?: number } =>
          edu != null && typeof edu.institution === "string"
      ),
      skills: (e.skills || []).filter((s) => s != null && typeof s.name === "string" && s.name.trim().length > 0).map((s) => ({
        name: s.name, proficiency: s.proficiency ?? undefined,
      })),
      socialLinks: (e.socialLinks || []).filter(
        (l): l is { platform: string; url: string; username?: string } =>
          l != null && typeof l.url === "string"
      ),
      emails: (e.emails || []).filter((em): em is string => typeof em === "string" && em.trim().length > 0),
      phones: (e.phones || []).filter((p): p is string => typeof p === "string" && p.trim().length > 0),
      bioSnippet: typeof e.bioSnippet === "string" ? e.bioSnippet : undefined,
      relationships: (e.relationships || []).filter(
        (r): r is { name: string; relationship: string } => r != null && typeof r.name === "string"
      ),
      dates: (e.dates || []).filter(
        (d): d is { event: string; date: string } => d != null && typeof d.event === "string"
      ),
      additionalFacts: (e.additionalFacts || []).filter(
        (f): f is string => typeof f === "string" && f.trim().length > 0
      ),
      certifications: (e.certifications || []).filter((c) => c != null && typeof c.name === "string").map((c) => ({
        name: c.name, issuer: c.issuer ?? undefined, year: c.year ?? undefined,
      })),
      publications: (e.publications || []).filter((p) => p != null && typeof p.title === "string").map((p) => ({
        title: p.title, venue: p.venue ?? undefined, year: p.year ?? undefined, url: p.url ?? undefined, coAuthors: p.coAuthors,
      })),
      awards: (e.awards || []).filter((a) => a != null && typeof a.title === "string").map((a) => ({
        title: a.title, issuer: a.issuer ?? undefined, year: a.year ?? undefined,
      })),
      languages: (e.languages || []).filter((l): l is string => typeof l === "string" && l.trim().length > 0),
    };

    const refinedQueries = (result.data.refinedQueries || [])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .slice(0, 2);

    return { extracted, refinedQueries };
  } catch (err) {
    console.warn("[llmSynthesizeFromSnippets] failed:", err);
    return null;
  }
}

export async function llmAdaptiveQueryRegen(
  queryDescription: string,
  pagesVisited: number,
  knownFacts: string,
  gaps: string,
  frontierSize: number,
  bestFrontierScore: number,
  previousQueries: string[],
  isFrontierRescue = false
): Promise<z.infer<typeof AdaptiveQueryRegenSchema> | null> {
  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 1024,
      temperature: 0.4,
      system: SYSTEM_ADAPTIVE_QUERY,
      messages: [{
        role: "user",
        content: `<target>${queryDescription}</target>

<crawl_state>
Pages crawled: ${pagesVisited}
Frontier: ${frontierSize} links queued (best score: ${bestFrontierScore.toFixed(2)})
</crawl_state>

<facts_discovered>
${knownFacts || "None yet"}
</facts_discovered>

<information_gaps>
${gaps || "All information about this person"}
</information_gaps>

<previous_queries>
${previousQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}
</previous_queries>

Decide the next action. Output JSON inside <json> tags:
<json>
{
  "action": "generate_queries" | "continue_crawling" | "both",
  "reasoning": "Why this action makes sense given current state",
  "newQueries": ["query1", "query2"],
  "stopCrawling": false
}
</json>

Constraints:
- Maximum 3 new queries per call
- New queries must differ from previous queries and incorporate newly learned facts
- Each query should target a specific gap in knowledge
- If target description includes identifying context, all queries MUST include it${isFrontierRescue ? `
- RESCUE MODE: The crawl frontier is empty. LinkedIn, Instagram, Twitter, and Facebook cannot be crawled (auth-walled). Target crawlable sources: GitHub profiles, personal/portfolio websites, company websites, university pages, blogs, news articles, academic papers. Do NOT generate site:linkedin.com queries.` : ""}`,
      }],
    });

    const raw = extractJsonObject(text);
    if (!raw) return null;
    const result = AdaptiveQueryRegenSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch (err) {
    console.warn("[llmAdaptiveQueryRegen] failed:", err);
    return null;
  }
}

export async function llmScoreLinks(
  query: string,
  currentUrl: string,
  knownFacts: string,
  gaps: string,
  links: { url: string; anchorText: string }[]
): Promise<z.infer<typeof ScoredLinkSchema>[]> {
  if (links.length === 0) return [];

  // Cap at 50 links to keep prompt manageable
  const linksToScore = links.slice(0, 50);
  const linksText = linksToScore
    .map((l, i) => `${i + 1}. [${l.anchorText}](${l.url})`)
    .join("\n");

  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 2048,
      temperature: 0.1,
      system: SYSTEM_SCORE_LINKS,
      messages: [{
        role: "user",
        content: `<research_target>${query}</research_target>
<current_page>${currentUrl}</current_page>

<known_facts>
${knownFacts || "None yet"}
</known_facts>

<information_gaps>
${gaps || "All information about this person"}
</information_gaps>

<links>
${linksText}
</links>

Score these links. Output ONLY a JSON array inside <json> tags:
<json>[{"url": "...", "score": 0.0, "reason": "..."}]</json>`,
      }],
    });

    const raw = extractJsonArray(text);
    if (!raw || !Array.isArray(raw)) return [];
    const results: z.infer<typeof ScoredLinkSchema>[] = [];
    for (const item of raw) {
      const parsed = ScoredLinkSchema.safeParse(item);
      if (parsed.success) results.push(parsed.data);
    }
    return results;
  } catch (err) {
    console.warn("[llmScoreLinks] failed:", err);
    return [];
  }
}

export async function llmExtractPerson(
  targetName: string,
  targetContext: string,
  url: string,
  markdown: string
): Promise<z.infer<typeof ExtractPersonSchema> | null> {
  // Truncate markdown to ~8k chars to stay within token limits
  const truncated = markdown.slice(0, 8000);

  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 2048,
      temperature: 0.1,
      system: SYSTEM_EXTRACT_PERSON,
      messages: [{
        role: "user",
        content: `<target_person>${targetName}</target_person>
${targetContext ? `<identifying_context>${targetContext}</identifying_context>` : ""}
<page_url>${url}</page_url>

<page_content>
${truncated}
</page_content>

Extract structured data about the target person from this page. ${targetContext ? `The identifying context "${targetContext}" is a strong signal — if the page mentions someone with the same name but whose details contradict this context, set confidence LOW (below 0.3).` : "No identifying context provided — match on name only."}

Output JSON inside <json> tags:
<json>
{
  "mentionsTarget": true/false,
  "confidence": 0.0-1.0,
  "extracted": {
    "names": ["Full Name as written on page"],
    "experiences": [
      {
        "title": "Job Title (e.g. 'Co-Founder', 'Software Engineer' — 'Co' alone is NOT valid)",
        "company": "Company Name (the employer/startup name, NOT abbreviations like 'Co' or 'Inc')",
        "isCurrent": true,
        "startDate": "2022-06 or null",
        "endDate": "2024-01 or null (omit/null if isCurrent)",
        "location": "City or null",
        "description": "Brief role description or null"
      }
    ],
    "location": "City, State/Country or null",
    "education": [{"institution": "...", "degree": "...", "field": "...", "year": null}],
    "skills": [{"name": "Python"}, {"name": "Leadership", "proficiency": "expert"}],
    "socialLinks": [{"platform": "LinkedIn", "url": "https://..."}],
    "emails": ["email@example.com"],
    "phones": ["+1-555-000-0000"],
    "bioSnippet": "1-2 sentence factual professional summary drawn from page content. Third person. null if no clean description exists.",
    "relationships": [{"name": "Colleague Name", "relationship": "co-author/colleague/advisor/classmate"}],
    "dates": [{"event": "joined company", "date": "2023-01"}],
    "additionalFacts": [
      "Each fact should be a self-contained sentence",
      "Awards, projects, competitions, organizations, speaking engagements",
      "Up to 10 — do NOT lose information because there's no structured field"
    ],
    "certifications": [{"name": "AWS Solutions Architect", "issuer": "Amazon", "year": 2022}],
    "publications": [{"title": "Paper title", "venue": "NeurIPS 2023", "year": 2023, "url": null, "coAuthors": ["Jane Doe"]}],
    "awards": [{"title": "1st Place HackMIT", "issuer": "MIT", "year": 2023}],
    "languages": ["English", "Spanish"]
  },
  "otherPeople": [
    {
      "names": ["Other Person's Full Name"],
      "title": "Their title or null",
      "company": "Their company or null",
      "location": "Their location or null",
      "relationshipToTarget": "colleague/co-author/manager/classmate or null",
      "bioSnippet": "Brief description or null"
    }
  ]
}
</json>

Extract up to 5 other notable people mentioned (colleagues, co-authors, team members). Only include people with at least a name and one other fact.`,
      }],
    });

    const raw = extractJsonObject(text);
    if (!raw) return null;
    const result = ExtractPersonSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch (err) {
    console.warn("[llmExtractPerson] failed:", err);
    return null;
  }
}

export async function llmDecomposeCriteria(
  criteria: string
): Promise<z.infer<typeof DecomposeCriteriaSchema> | null> {
  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 2048,
      temperature: 0.5,
      system: SYSTEM_DECOMPOSE_CRITERIA,
      messages: [{
        role: "user",
        content: `<search_criteria>${criteria}</search_criteria>

Decompose this people-search criteria into structured search signals.

Output JSON inside <json> tags:
<json>
{
  "keywords": ["key terms for search queries"],
  "requiredTraits": ["traits a person MUST have to match — be specific and testable"],
  "niceToHave": ["traits that boost relevance but aren't required"],
  "searchQueries": [
    "5-10 diverse Google search queries to find matching people",
    "Include site-specific queries (site:linkedin.com, site:github.com)",
    "Include queries targeting list pages (team pages, speaker lists, award lists)",
    "Vary phrasing and keywords to maximize coverage"
  ],
  "pageTypesToPrioritize": ["team pages", "speaker lists", "news articles"],
  "exclusionSignals": ["signals that a page or person does NOT match"],
  "preferredDomains": ["domains most likely to have relevant pages, e.g. usc.edu"],
  "exclusionDomains": ["domains to deprioritize, e.g. sc.edu when searching for USC California"]
}
</json>`,
      }],
    });

    const raw = extractJsonObject(text);
    if (!raw) return null;
    const result = DecomposeCriteriaSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch (err) {
    console.warn("[llmDecomposeCriteria] failed:", err);
    return null;
  }
}

export async function llmExtractMultiplePeople(
  criteria: string,
  requiredTraits: string[],
  url: string,
  markdown: string
): Promise<z.infer<typeof ExtractMultiplePeopleSchema> | null> {
  const truncated = markdown.slice(0, 10000); // Larger window for multi-person pages

  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 4096,
      temperature: 0.1,
      system: SYSTEM_EXTRACT_MULTIPLE,
      messages: [{
        role: "user",
        content: `<search_criteria>${criteria}</search_criteria>
<required_traits>${requiredTraits.join("; ")}</required_traits>
<page_url>${url}</page_url>

<page_content>
${truncated}
</page_content>

Extract ALL people from this page who might match. Up to 30 on list pages.

Output JSON inside <json> tags:
<json>
{
  "peopleFound": [
    {
      "name": "Full Name",
      "title": "Job Title or null",
      "company": "Company or null",
      "location": "Location or null",
      "criteriaEvidence": "Direct quote or close paraphrase from page — never fabricate",
      "matchScore": 0.0-1.0,
      "matchReasoning": "Why this person does or doesn't match the criteria",
      "additionalFacts": {
        "education": "school/degree if mentioned or null",
        "skills": ["technical or professional skills if mentioned"],
        "socialUrl": "LinkedIn or other profile URL if found or null",
        "organizations": ["clubs, student orgs, professional orgs, societies they belong to"]
      }
    }
  ]
}
</json>

Return empty peopleFound array if no people are found.`,
      }],
    });

    const raw = extractJsonObject(text);
    if (!raw) return null;
    const result = ExtractMultiplePeopleSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch (err) {
    console.warn("[llmExtractMultiplePeople] failed:", err);
    return null;
  }
}

/**
 * Use the LLM to determine if extracted names could refer to the same person as the query name.
 * Handles nicknames (Alex=Alexander), middle names, transliterations, and cultural naming patterns.
 * Batches all names into a single LLM call for efficiency.
 *
 * Returns a Map of candidateName → score (0-1).
 * Names that couldn't be parsed get a score of 0.
 */
export async function llmMatchNames(
  queryName: string,
  queryContext: string | undefined,
  candidateNames: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (candidateNames.length === 0) return result;

  // Deduplicate and normalize
  const uniqueNames = [...new Set(candidateNames.map((n) => n.trim()).filter(Boolean))];
  if (uniqueNames.length === 0) return result;

  const nameList = uniqueNames.map((n, i) => `${i + 1}. "${n}"`).join("\n");

  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 1024,
      temperature: 0.0,
      system: SYSTEM_MATCH_NAMES,
      messages: [{
        role: "user",
        content: `Query name: "${queryName}"${queryContext ? `\nContext: ${queryContext}` : ""}

Candidate names found on various web pages:
${nameList}

For each candidate, determine if it could refer to the same person as the query name.

Output JSON inside <json> tags:
<json>
{
  "results": [
    {"name": "candidate name exactly as listed", "match": true/false, "confidence": 0.0-1.0}
  ]
}
</json>

Confidence guide:
- 1.0: Exact match or trivially equivalent (same name, different casing)
- 0.90-0.99: Very strong match — known nickname/diminutive, or query name clearly contained in candidate (e.g. "Noah Liu" → "Zelin Noah Liu")
- 0.70-0.89: Strong match — plausible nickname, transliteration, or cultural variant
- 0.50-0.69: Possible match — less common equivalence, needs context to confirm
- 0.0: Not a match — clearly a different name`,
      }],
    });

    const raw = extractJsonObject(text);
    if (!raw) return result;

    const parsed = NameMatchResultSchema.safeParse(raw);
    if (!parsed.success) return result;

    for (const entry of parsed.data.results) {
      if (entry.match) {
        result.set(entry.name, entry.confidence);
      } else {
        result.set(entry.name, 0);
      }
    }

    return result;
  } catch (err) {
    console.warn("[llmMatchNames] failed:", err);
    return result;
  }
}

export async function llmDisambiguate(
  mentionA: { url: string; name: string; title?: string; company?: string; location?: string; details: string },
  mentionB: { url: string; name: string; title?: string; company?: string; location?: string; details: string },
  query?: { name: string; context?: string }
): Promise<z.infer<typeof DisambiguateSchema>> {
  const fallback = { samePerson: null, confidence: 0, reasoning: "Failed to parse" };

  const queryNote = query?.context
    ? `\nSearch context: "${query.name}" with context "${query.context}". Use this to break ties — if one mention clearly matches the context and the other contradicts it, they are likely different people.\n`
    : "";

  try {
    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 768,
      temperature: 0.1,
      system: SYSTEM_DISAMBIGUATE,
      messages: [{
        role: "user",
        content: `Are these two web mentions the same person?${queryNote}

<mention_a>
Source: ${mentionA.url}
Name: ${mentionA.name}
Title: ${mentionA.title || "unknown"}
Company/Companies: ${mentionA.company || "unknown"}
Location: ${mentionA.location || "unknown"}
Details: ${mentionA.details}
</mention_a>

<mention_b>
Source: ${mentionB.url}
Name: ${mentionB.name}
Title: ${mentionB.title || "unknown"}
Company/Companies: ${mentionB.company || "unknown"}
Location: ${mentionB.location || "unknown"}
Details: ${mentionB.details}
</mention_b>

First reason step-by-step in <reasoning> tags, then output your verdict in <json> tags:
<reasoning>Compare names, roles, companies, locations, and any other signals...</reasoning>
<json>{"samePerson": true/false/null, "confidence": 0.0-1.0, "reasoning": "one-line summary"}</json>`,
      }],
    });

    const raw = extractJsonObject(text);
    if (!raw) return fallback;
    const result = DisambiguateSchema.safeParse(raw);
    return result.success ? result.data : fallback;
  } catch (err) {
    console.warn("[llmDisambiguate] failed:", err);
    return fallback;
  }
}

// ── Profile Summary Generation ──

/**
 * Generate a 2-3 sentence LLM summary of a person profile.
 * Called after profile building; attaches human-readable prose to the profile card.
 */
export async function generateProfileSummary(
  profile: import("@/types").PersonProfile
): Promise<string | null> {
  try {
    // Build a compact fact sheet for the LLM — only include non-empty fields
    const lines: string[] = [];

    const primaryName = profile.names[0]?.value || "Unknown";
    lines.push(`Name: ${primaryName}`);

    const altNames = profile.names.slice(1).map((n) => n.value).join(", ");
    if (altNames) lines.push(`Also known as: ${altNames}`);

    const currentExp = profile.experiences?.find((e) => e.value.isCurrent) ?? profile.experiences?.[0];
    if (currentExp) {
      const { title, company } = currentExp.value;
      if (title && company) lines.push(`Current role: ${title} at ${company}`);
      else if (title) lines.push(`Current role: ${title}`);
      else if (company) lines.push(`Associated with: ${company}`);
    }

    if (profile.education.length > 0) {
      const edus = profile.education.map((e) => {
        const parts = [e.value.institution];
        if (e.value.degree) parts.push(e.value.degree);
        if (e.value.field) parts.push(`in ${e.value.field}`);
        if (e.value.year) parts.push(`(${e.value.year})`);
        return parts.join(" ");
      });
      lines.push(`Education: ${edus.join("; ")}`);
    }

    if (profile.locations.length > 0) {
      lines.push(`Location: ${profile.locations[0].value.city}`);
    }

    if (profile.skills.length > 0) {
      lines.push(`Skills: ${profile.skills.slice(0, 8).map((s) => s.value.name).join(", ")}`);
    }

    if (profile.socialProfiles.length > 0) {
      const social = profile.socialProfiles.map((s) => `${s.value.platform}: ${s.value.url}`).join("; ");
      lines.push(`Social: ${social}`);
    }

    if (profile.bioSnippet) {
      lines.push(`Bio snippet: "${profile.bioSnippet.slice(0, 300)}"`);
    }

    if (profile.additionalFacts.length > 0) {
      lines.push(`Additional facts: ${profile.additionalFacts.slice(0, 5).map((f) => f.value).join("; ")}`);
    }

    if (lines.length <= 2) {
      // Not enough data to say anything meaningful
      return null;
    }

    const factSheet = lines.join("\n");

    const text = await llmCall({
      model: LLM_MODEL,
      maxTokens: 200,
      system:
        "You are a professional researcher writing concise person summaries. " +
        "Write in third person, present tense. Be factual — only state what the data supports. " +
        "Do not invent or speculate. If data is sparse, acknowledge the limited information briefly.",
      messages: [
        {
          role: "user",
          content: `Based only on the following verified facts, write a 2-3 sentence professional summary of this person:\n\n${factSheet}\n\nSummary:`,
        },
      ],
    });

    const summary = text.trim();
    return summary.length > 20 ? summary : null;
  } catch (err) {
    console.warn("[generateProfileSummary] failed:", err);
    return null;
  }
}

// ── LLM-Based Mention Clustering ──

/**
 * Serialize a single PersonMention into a compact card string for LLM clustering.
 * Only includes discriminating fields — skips skills, dates, and confidence scores.
 */
function serializeMentionCard(m: PersonMention, idx: number): string {
  const lines: string[] = [];

  // Header: source domain + LinkedIn username if applicable
  let domain: string;
  try {
    domain = new URL(m.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    domain = m.sourceUrl.slice(0, 50);
  }

  // Extract LinkedIn username from URL (profile or post)
  const liProfileMatch = m.sourceUrl.match(/linkedin\.com\/in\/([a-zA-Z0-9-]+)/i);
  const liPostMatch = m.sourceUrl.match(/linkedin\.com\/posts\/([a-zA-Z0-9-]+)(?:_[a-z]|$)/i);
  const liUsername = liProfileMatch?.[1] ?? liPostMatch?.[1];

  lines.push(liUsername ? `[M${idx}] ${domain} (@${liUsername})` : `[M${idx}] ${domain}`);

  // Names (all variants)
  const names = m.extracted.names.filter((n) => n && typeof n === "string").slice(0, 5);
  if (names.length > 0) lines.push(`  names: ${names.join(", ")}`);

  // Role: show current role + up to 2 past roles for fuller disambiguation context
  const exps = m.extracted.experiences || [];
  const currentExp = exps.find((e) => e.isCurrent) ?? exps[0];
  const currentRole = [currentExp?.title, currentExp?.company].filter(Boolean).join(" @ ");
  if (currentRole) lines.push(`  role: ${currentRole}`);
  const pastExps = exps.filter((e) => e !== currentExp).slice(0, 2);
  for (const pe of pastExps) {
    const pastRole = [pe.title, pe.company].filter(Boolean).join(" @ ");
    if (pastRole) lines.push(`  past: ${pastRole}`);
  }

  // Education institutions
  const edu = m.extracted.education.map((e) => e.institution).filter(Boolean);
  if (edu.length > 0) lines.push(`  education: ${edu.join(", ")}`);

  // Location
  if (m.extracted.location) lines.push(`  location: ${m.extracted.location}`);

  // Bio snippet (truncated)
  if (m.extracted.bioSnippet) {
    lines.push(`  bio: "${m.extracted.bioSnippet.slice(0, 180)}"`);
  }

  // Top additional facts
  const facts = m.extracted.additionalFacts.slice(0, 3);
  if (facts.length > 0) lines.push(`  facts: ${facts.join("; ")}`);

  // LinkedIn social link if not already captured from URL
  if (!liUsername) {
    const liSocial = m.extracted.socialLinks.find((s) => s.platform === "LinkedIn");
    if (liSocial) lines.push(`  linkedin: ${liSocial.url}`);
  }

  return lines.join("\n");
}

/**
 * Use a single LLM call to cluster all mentions by identity and identify which
 * cluster is the search target. Replaces the TF-IDF + Union-Find algorithmic
 * approach with semantic reasoning.
 *
 * Returns ClusterGroup[] if successful (all mention IDs covered exactly once),
 * or null if the call fails or produces invalid output (triggers algorithmic fallback).
 */
export async function llmClusterMentions(
  mentions: PersonMention[],
  query: SearchQuery
): Promise<ClusterGroup[] | null> {
  if (mentions.length === 0) return [];
  if (mentions.length === 1) {
    return [{ ids: [0], isTarget: true, confidence: 0.8, reason: "Single mention" }];
  }

  const cards = mentions.map((m, i) => serializeMentionCard(m, i)).join("\n\n");
  const contextNote = query.context ? ` (context: "${query.context}")` : "";
  const n = mentions.length;

  const prompt = `You are resolving identity for people named "${query.name}"${contextNote}.

Below are ${n} extracted mentions from web sources. Group them by identity — mentions about the SAME real person belong in the same group.

Key signals:
- LinkedIn @username in the source is a unique global identifier (same @ = definitely same person, different @ = definitely different people)
- Names may vary: legal name vs preferred name vs alias (e.g. "Zelin Noah Liu" = "Noah Liu" if Noah is a middle name used as preferred name)
- Same role/company across sources = strong same-person signal
- Different universities or completely different careers = likely different people
- Source domain gives platform context (e.g. scsenate.gov = politician, wayup.com = student profile)

${cards}

Respond with JSON only — no prose before or after:
{
  "groups": [
    {
      "ids": [0, 2],
      "isTarget": true,
      "confidence": 0.92,
      "reason": "one sentence explaining the decision"
    }
  ]
}

Rules:
- Every mention ID (0 to ${n - 1}) must appear in EXACTLY ONE group
- isTarget=true means this group IS the person being searched for (${query.name}${query.context ? `, ${query.context}` : ""})
- At most ONE group should have isTarget=true
- If unsure whether a mention belongs to the target, put it in its own group with isTarget=false`;

  try {
    const text = await llmCall({
      model: LLM_MODEL,
      system: "You are an expert at resolving person identity from web data. Output valid JSON only.",
      messages: [{ role: "user", content: prompt }],
      maxTokens: 800,
      temperature: 0,
    });

    const raw = extractJsonObject(text);
    if (!raw) return null;

    const parsed = ClusterResultSchema.safeParse(raw);
    if (!parsed.success) return null;

    const groups = parsed.data.groups;

    // Validate: every ID 0..n-1 appears exactly once
    const idsSeen = new Set<number>();
    for (const g of groups) {
      for (const id of g.ids) {
        if (id < 0 || id >= n || idsSeen.has(id)) return null;
        idsSeen.add(id);
      }
    }
    if (idsSeen.size !== n) return null;

    return groups;
  } catch (err) {
    console.warn("[llmClusterMentions] failed:", err);
    return null;
  }
}
