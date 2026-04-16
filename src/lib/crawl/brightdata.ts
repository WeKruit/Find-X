import type { ExtractedPersonData, PersonMention } from "@/types";

const BRIGHTDATA_BASE_URL = "https://api.brightdata.com/datasets/v3";
const LINKEDIN_PROFILES_DATASET_ID = "gd_l1viktl72bvl7bjuj0";
const LINKEDIN_DISCOVER_DATASET_ID = "gd_m8d03he47z8nwb5xc";

// Support both the canonical key and common casing typos.
function getBrightDataApiKey(): string | undefined {
  return process.env.BRIGHTDATA_API_KEY || process.env.BRIGHTdATA_API_KEY;
}

export function hasBrightData(): boolean {
  return Boolean(getBrightDataApiKey());
}

interface BrightDataCurrentCompany {
  name?: string | null;
}

interface BrightDataExperience {
  title?: string | null;
  subtitle?: string | null;
  company?: string | null;
}

interface BrightDataEducation {
  school_name?: string | null;
  school?: string | null;
  degree?: string | null;
  field_of_study?: string | null;
  start_year?: number | null;
  end_year?: number | null;
}

interface BrightDataProfile {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  city?: string | null;
  location?: string | null;
  country_code?: string | null;
  position?: string | null;
  about?: string | null;
  url?: string | null;
  linkedin_id?: string | null;
  followers?: number | null;
  connections?: number | null;
  current_company?: BrightDataCurrentCompany | null;
  current_company_name?: string | null;
  experience?: BrightDataExperience[] | null;
  education?: string | null;
  educations_details?: BrightDataEducation[] | null;
  skills?: string[] | null;
  languages?: string[] | null;
}

interface BrightDataSnapshotProgress {
  status?: string;
}

interface BrightDataSnapshotResponse {
  snapshot_id?: string;
}

async function pollSnapshot(snapshotId: string, apiKey: string): Promise<unknown[] | null> {
  const start = Date.now();
  const timeoutMs = 90_000;
  const pollIntervalMs = 2_500;

  while (Date.now() - start < timeoutMs) {
    const progressRes = await fetch(`${BRIGHTDATA_BASE_URL}/progress/${snapshotId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!progressRes.ok) return null;

    const progress = (await progressRes.json()) as BrightDataSnapshotProgress;
    if (progress.status === "failed") return null;

    if (progress.status === "ready") {
      const snapRes = await fetch(`${BRIGHTDATA_BASE_URL}/snapshot/${snapshotId}?format=json`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!snapRes.ok) return null;
      const data = (await snapRes.json()) as unknown;
      if (!Array.isArray(data)) return null;
      return data;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return null;
}

async function runDataset(datasetId: string, input: unknown[]): Promise<unknown[] | null> {
  const apiKey = getBrightDataApiKey();
  if (!apiKey) return null;

  const requestUrl = `${BRIGHTDATA_BASE_URL}/scrape?dataset_id=${datasetId}&format=json`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as unknown;
  if (Array.isArray(data)) return data;

  const snapshot = data as BrightDataSnapshotResponse;
  if (!snapshot.snapshot_id) return null;
  return pollSnapshot(snapshot.snapshot_id, apiKey);
}

export async function collectLinkedInProfileByUrl(url: string): Promise<BrightDataProfile | null> {
  const rows = await runDataset(LINKEDIN_PROFILES_DATASET_ID, [{ url }]);
  if (!rows || rows.length === 0) return null;
  return rows[0] as BrightDataProfile;
}

export interface BrightDataDiscoveredLinkedInProfile {
  url: string;
  name?: string;
  location?: string;
  subtitle?: string;
  education?: string;
}

function splitName(fullName: string): { firstName: string; lastName: string } | null {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return {
    firstName: parts[0],
    lastName: parts[parts.length - 1],
  };
}

function toCanonicalLinkedInUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().includes("linkedin.com")
      ? "www.linkedin.com"
      : parsed.hostname;
    return `${parsed.protocol}//${host}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function isLinkedInProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("linkedin.com")) return false;
    const path = parsed.pathname.toLowerCase();
    if (path.startsWith("/in/")) return true;
    // Exclude directory pages like /pub/dir/... — those are high-noise, not single profiles.
    if (path.startsWith("/pub/dir/")) return false;
    return path.startsWith("/pub/");
  } catch {
    return false;
  }
}

export async function discoverLinkedInProfilesByName(
  fullName: string,
  maxResults = 5,
  queryContext?: string
): Promise<BrightDataDiscoveredLinkedInProfile[]> {
  const split = splitName(fullName);
  if (!split) return [];

  const rows = await runDataset(LINKEDIN_DISCOVER_DATASET_ID, [
    {
      url: "https://www.linkedin.com",
      first_name: split.firstName,
      last_name: split.lastName,
    },
  ]);
  if (!rows || rows.length === 0) return [];

  const out: BrightDataDiscoveredLinkedInProfile[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    if (!isLinkedInProfileUrl(url)) continue;
    const name = typeof r.name === "string" ? r.name : undefined;
    const location = typeof r.location === "string" ? r.location : undefined;
    const subtitle = typeof r.subtitle === "string" ? r.subtitle : undefined;
    const education = typeof r.education === "string" ? r.education : undefined;
    if (queryContext) {
      const hint = [name, subtitle, education, location].filter(Boolean).join(" | ");
      if (!brightDataContextLikelyMatches(hint, queryContext)) continue;
    }
    out.push({
      url: toCanonicalLinkedInUrl(url),
      name,
      location,
      subtitle,
      education,
    });
    if (out.length >= maxResults) break;
  }

  return out;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function nameMatchesQuery(profileName: string | null | undefined, queryName: string): boolean {
  if (!profileName) return false;
  const p = normalizeName(profileName);
  const q = normalizeName(queryName);
  if (!p || !q) return false;
  if (p === q || p.includes(q) || q.includes(p)) return true;
  const pParts = new Set(p.split(" ").filter((w) => w.length > 1));
  const qParts = q.split(" ").filter((w) => w.length > 1);
  const overlap = qParts.filter((w) => pParts.has(w)).length;
  return overlap >= Math.max(1, Math.ceil(qParts.length * 0.6));
}

export function brightDataNameMatches(profileName: string | null | undefined, queryName: string): boolean {
  return nameMatchesQuery(profileName, queryName);
}

const CONTEXT_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "not",
  "but",
  "at",
  "in",
  "of",
  "to",
  "by",
]);

function contextWords(context: string): string[] {
  return context
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 2 && !CONTEXT_STOP_WORDS.has(w));
}

function contextAcronym(context: string): string | null {
  const tokens = context.split(/\s+/).filter(Boolean);
  const explicit = tokens.find((t) => /^[A-Z]{2,6}$/.test(t));
  if (explicit) return explicit.toLowerCase();

  const letters = tokens
    .map((w) => w.replace(/[^A-Za-z]/g, ""))
    .filter((w) => w.length > 2 && !CONTEXT_STOP_WORDS.has(w.toLowerCase()))
    .filter((w) => /^[A-Z]/.test(w))
    .map((w) => w[0])
    .join("")
    .toLowerCase();
  return letters.length >= 2 ? letters : null;
}

/**
 * Returns true when candidate text likely matches the query context.
 * This is intentionally conservative to avoid costly false-positive LinkedIn enrichments.
 */
export function brightDataContextLikelyMatches(
  candidateText: string | undefined,
  queryContext: string | undefined
): boolean {
  if (!queryContext) return true;
  const text = (candidateText || "").toLowerCase();
  if (!text) return false;

  const words = contextWords(queryContext);
  const acronym = contextAcronym(queryContext);

  if (acronym && new RegExp(`\\b${acronym}\\b`, "i").test(text)) return true;
  if (words.length === 0) return false;

  const matchCount = words.filter((w) => text.includes(w)).length;
  const required = Math.max(1, Math.ceil(words.length * 0.5));
  return matchCount >= required;
}

function buildProfileContextText(profile: BrightDataProfile): string {
  const fields: string[] = [];
  if (profile.position) fields.push(profile.position);
  if (profile.about) fields.push(profile.about);
  if (profile.current_company?.name) fields.push(profile.current_company.name);
  if (profile.current_company_name) fields.push(profile.current_company_name);
  if (profile.education && typeof profile.education === "string") fields.push(profile.education);
  if (profile.city) fields.push(profile.city);
  if (profile.location) fields.push(profile.location);
  if (Array.isArray(profile.experience)) {
    for (const exp of profile.experience.slice(0, 5)) {
      if (typeof exp.title === "string") fields.push(exp.title);
      if (typeof exp.company === "string") fields.push(exp.company);
      if (typeof exp.subtitle === "string") fields.push(exp.subtitle);
    }
  }
  if (Array.isArray(profile.educations_details)) {
    for (const ed of profile.educations_details.slice(0, 5)) {
      if (typeof ed.school_name === "string") fields.push(ed.school_name);
      if (typeof ed.school === "string") fields.push(ed.school);
      if (typeof ed.degree === "string") fields.push(ed.degree);
      if (typeof ed.field_of_study === "string") fields.push(ed.field_of_study);
    }
  }
  return fields.join(" | ");
}

function parsePosition(position: string | null | undefined): { title?: string; company?: string } {
  if (!position) return {};
  const trimmed = position.trim();
  if (!trimmed) return {};

  const atMatch = trimmed.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (atMatch) {
    return {
      title: atMatch[1].trim() || undefined,
      company: atMatch[2].trim() || undefined,
    };
  }

  return { title: trimmed };
}

function extractEducation(profile: BrightDataProfile): ExtractedPersonData["education"] {
  const out: ExtractedPersonData["education"] = [];

  if (Array.isArray(profile.educations_details)) {
    for (const ed of profile.educations_details) {
      const institution = ed.school_name || ed.school;
      if (!institution || typeof institution !== "string") continue;
      out.push({
        institution,
        degree: typeof ed.degree === "string" ? ed.degree : undefined,
        field: typeof ed.field_of_study === "string" ? ed.field_of_study : undefined,
        year: ed.end_year || ed.start_year || undefined,
      });
    }
  }

  if (out.length === 0 && profile.education && typeof profile.education === "string") {
    out.push({ institution: profile.education });
  }

  return out;
}

export function brightDataProfileToMention(
  profile: BrightDataProfile,
  fallbackUrl: string,
  queryName: string,
  queryContext?: string
): PersonMention | null {
  const fullName = profile.name || [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  if (!fullName || !nameMatchesQuery(fullName, queryName)) return null;
  if (queryContext) {
    const profileContextText = buildProfileContextText(profile);
    if (!brightDataContextLikelyMatches(profileContextText, queryContext)) return null;
  }

  const position = parsePosition(profile.position);
  const currentCompany = profile.current_company?.name || profile.current_company_name || position.company;
  const experiences: ExtractedPersonData["experiences"] = [];

  if (position.title || currentCompany) {
    experiences.push({
      title: position.title || "",
      company: currentCompany || "",
      isCurrent: true,
    });
  }

  if (Array.isArray(profile.experience)) {
    for (const exp of profile.experience.slice(0, 4)) {
      const title = exp.title || undefined;
      const company = exp.company || exp.subtitle || undefined;
      if (!title && !company) continue;
      const duplicateCurrent = experiences.some(
        (e) =>
          e.isCurrent &&
          e.title.toLowerCase() === (title || "").toLowerCase() &&
          e.company.toLowerCase() === (company || "").toLowerCase()
      );
      if (!duplicateCurrent) {
        experiences.push({
          title: title || "",
          company: company || "",
          isCurrent: false,
        });
      }
    }
  }

  const locationParts = [profile.city || profile.location || undefined, profile.country_code || undefined].filter(Boolean);
  const location = locationParts.join(", ") || undefined;
  const socialUrl = toCanonicalLinkedInUrl(profile.url || fallbackUrl);

  const additionalFacts: string[] = [];
  if (typeof profile.followers === "number") additionalFacts.push(`LinkedIn followers: ${profile.followers}`);
  if (typeof profile.connections === "number") additionalFacts.push(`LinkedIn connections: ${profile.connections}`);
  if (profile.linkedin_id) additionalFacts.push(`LinkedIn ID: ${profile.linkedin_id}`);

  const extracted: ExtractedPersonData = {
    names: [fullName],
    experiences,
    location,
    education: extractEducation(profile),
    skills: (profile.skills || []).filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((name) => ({ name })),
    socialLinks: [{ platform: "LinkedIn", url: socialUrl }],
    emails: [],
    phones: [],
    bioSnippet: profile.about || undefined,
    relationships: [],
    dates: [],
    additionalFacts,
    certifications: [],
    publications: [],
    awards: [],
    languages: (profile.languages || []).filter((l): l is string => typeof l === "string" && l.trim().length > 0),
  };

  return {
    sourceUrl: socialUrl,
    fetchedAt: new Date(),
    confidence: 0.88,
    extracted,
  };
}
