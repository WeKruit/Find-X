import type {
  EducationEntry,
  ExperienceEntry,
  PersonMention,
  Relationship,
  SearchQuery,
  SkillEntry,
  SocialLink,
} from "@/types";
import { mentionToContextText, tokenize } from "./matching";

const STOP_WORDS = new Set(["of", "the", "and", "at", "in", "for", "a", "an"]);
const COMPANY_SUFFIXES = /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|gmbh)\b/g;

const ALIAS_REGISTRY: Record<string, string[]> = {
  "amazon web services": ["aws", "amazon web services"],
  aws: ["aws", "amazon web services"],
  "university of southern california": ["usc", "university of southern california"],
  usc: ["usc", "university of southern california"],
  "university of texas at austin": ["ut austin", "university of texas at austin"],
  "ut austin": ["ut austin", "university of texas at austin"],
  "massachusetts institute of technology": ["mit", "massachusetts institute of technology"],
  mit: ["mit", "massachusetts institute of technology"],
  "georgia institute of technology": ["georgia tech", "georgia institute of technology"],
  "georgia tech": ["georgia tech", "georgia institute of technology"],
  "university of california los angeles": ["ucla", "university of california los angeles"],
  ucla: ["ucla", "university of california los angeles"],
  "university of california berkeley": ["uc berkeley", "berkeley", "university of california berkeley"],
  "uc berkeley": ["uc berkeley", "berkeley", "university of california berkeley"],
  berkeley: ["berkeley", "uc berkeley", "university of california berkeley"],
  "carnegie mellon university": ["cmu", "carnegie mellon university"],
  cmu: ["cmu", "carnegie mellon university"],
};

export interface NormalizedMention {
  mentionIndex: number;
  raw: PersonMention;
  sourceUrl: string;
  sourceDomain: string;
  names: string[];
  primaryName: string;
  primaryNameKey: string;
  nameKeys: string[];
  firstName?: string;
  lastName?: string;
  firstInitial?: string;
  employerKeys: string[];
  currentEmployerKeys: string[];
  schoolKeys: string[];
  locationKeys: string[];
  socialHandles: Record<string, string[]>;
  exactIds: string[];
  contextTokens: string[];
  completeness: number;
}

export interface NormalizedQuery {
  raw: SearchQuery;
  nameKey: string;
  contextTokens: string[];
  organizationKeys: string[];
  schoolKeys: string[];
  locationKeys: string[];
}

export function normalizeSearchQuery(query: SearchQuery): NormalizedQuery {
  const context = query.context?.trim() ?? "";
  const segments = context
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const organizationKeys = new Set<string>();
  const schoolKeys = new Set<string>();
  const locationKeys = new Set<string>();

  for (const segment of segments) {
    for (const key of buildAliasKeys(segment)) organizationKeys.add(key);
    if (looksLikeSchool(segment)) {
      for (const key of buildSchoolKeys(segment)) schoolKeys.add(key);
    }
    if (looksLikeLocation(segment)) {
      for (const key of buildLocationKeys(segment)) locationKeys.add(key);
    }
  }

  if (context && schoolKeys.size === 0 && looksLikeSchool(context)) {
    for (const key of buildSchoolKeys(context)) schoolKeys.add(key);
  }

  return {
    raw: query,
    nameKey: normalizeNameKey(query.name),
    contextTokens: tokenize(context),
    organizationKeys: [...organizationKeys],
    schoolKeys: [...schoolKeys],
    locationKeys: [...locationKeys],
  };
}

export function consolidateMentionsBySource(mentions: PersonMention[]): PersonMention[] {
  const grouped = new Map<string, PersonMention[]>();
  for (const mention of mentions) {
    const key = mention.sourceUrl.trim();
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(mention);
  }

  return [...grouped.values()].map((group) => mergeMentions(group));
}

export function normalizeMentions(mentions: PersonMention[]): NormalizedMention[] {
  return mentions.map((mention, mentionIndex) => {
    const names = mention.extracted.names.filter(Boolean);
    const primaryName = names[0] || "Unknown";
    const primaryNameKey = normalizeNameKey(primaryName);
    const nameKeys = dedupeStrings(names.flatMap((name) => buildNameKeys(name)));
    const nameParts = extractNameParts(primaryNameKey);
    const employerKeys = dedupeStrings(
      mention.extracted.experiences.flatMap((experience) => buildOrganizationKeys(experience.company))
    );
    const currentEmployerKeys = dedupeStrings(
      mention.extracted.experiences
        .filter((experience) => experience.isCurrent)
        .flatMap((experience) => buildOrganizationKeys(experience.company))
    );
    const schoolKeys = dedupeStrings(
      mention.extracted.education.flatMap((education) => buildSchoolKeys(education.institution))
    );
    const locationKeys = mention.extracted.location
      ? buildLocationKeys(mention.extracted.location)
      : [];

    const socialHandles = collectSocialHandles(mention.extracted.socialLinks);
    const exactIds = dedupeStrings([
      ...mention.extracted.emails.map((email) => `email:${email.trim().toLowerCase()}`),
      ...mention.extracted.phones.map((phone) => `phone:${phone.replace(/\D/g, "")}`),
      ...Object.entries(socialHandles).flatMap(([platform, handles]) =>
        handles.map((handle) => `social:${platform}:${handle}`)
      ),
    ]);

    const completenessFields = [
      employerKeys.length > 0,
      schoolKeys.length > 0,
      locationKeys.length > 0,
      exactIds.length > 0,
      !!mention.extracted.bioSnippet,
      mention.extracted.relationships.length > 0,
    ];

    return {
      mentionIndex,
      raw: mention,
      sourceUrl: mention.sourceUrl,
      sourceDomain: getDomain(mention.sourceUrl),
      names,
      primaryName,
      primaryNameKey,
      nameKeys,
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      firstInitial: nameParts.firstInitial,
      employerKeys,
      currentEmployerKeys,
      schoolKeys,
      locationKeys,
      socialHandles,
      exactIds,
      contextTokens: tokenize(mentionToContextText(mention)),
      completeness: completenessFields.filter(Boolean).length / completenessFields.length,
    };
  });
}

export function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildNameKeys(name: string): string[] {
  const normalized = normalizeNameKey(name);
  if (!normalized) return [];
  const words = normalized.split(" ").filter(Boolean);
  const keys = new Set<string>([normalized]);
  if (words.length >= 2) {
    keys.add(`${words[0]} ${words[words.length - 1]}`);
    keys.add(`${words[words.length - 1]} ${words[0]}`);
    keys.add(`${words[0][0]} ${words[words.length - 1]}`);
  }
  return [...keys];
}

export function buildOrganizationKeys(value?: string): string[] {
  if (!value) return [];
  return buildAliasKeys(value).map((key) => key.replace(COMPANY_SUFFIXES, "").replace(/\s+/g, " ").trim());
}

export function buildSchoolKeys(value?: string): string[] {
  if (!value) return [];
  return buildAliasKeys(value);
}

export function buildLocationKeys(value?: string): string[] {
  if (!value) return [];
  const normalized = normalizeNameKey(value);
  if (!normalized) return [];
  const parts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
  const keys = new Set<string>([normalized]);
  if (parts.length > 0) keys.add(parts[0]);
  if (parts.length > 1) keys.add(parts.slice(0, 2).join(", "));
  return [...keys];
}

function buildAliasKeys(value: string): string[] {
  const normalized = normalizeNameKey(value);
  if (!normalized) return [];

  const keys = new Set<string>([normalized]);
  const aliasEntry = ALIAS_REGISTRY[normalized];
  if (aliasEntry) {
    for (const alias of aliasEntry) keys.add(normalizeNameKey(alias));
  }

  const acronym = createAcronym(normalized);
  if (acronym.length >= 2) keys.add(acronym);

  const stripped = normalized.replace(COMPANY_SUFFIXES, "").replace(/\s+/g, " ").trim();
  if (stripped) keys.add(stripped);

  if (normalized.startsWith("university of texas at ")) {
    const city = normalized.replace("university of texas at ", "").trim();
    if (city) keys.add(`ut ${city}`);
  }

  return [...keys].filter(Boolean);
}

function createAcronym(value: string): string {
  return value
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .map((word) => word[0])
    .join("");
}

function looksLikeSchool(value: string): boolean {
  return /university|college|institute|school|academy|\but\b|\busc\b|\bmit\b/i.test(value);
}

function looksLikeLocation(value: string): boolean {
  return value.includes(",") || /\b(california|texas|new york|seattle|austin|chicago|remote)\b/i.test(value);
}

function collectSocialHandles(socialLinks: SocialLink[]): Record<string, string[]> {
  const handles = new Map<string, Set<string>>();
  for (const social of socialLinks) {
    const platform = normalizeNameKey(social.platform);
    const handle = social.username?.trim().toLowerCase() || extractHandle(platform, social.url);
    if (!platform || !handle) continue;
    if (!handles.has(platform)) handles.set(platform, new Set());
    handles.get(platform)!.add(handle);
  }
  return Object.fromEntries([...handles.entries()].map(([platform, set]) => [platform, [...set]]));
}

function extractHandle(platform: string, url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (platform.includes("linkedin")) {
      const handle = parts[1] ?? parts[0];
      return handle?.toLowerCase() ?? null;
    }
    if (platform.includes("github") || platform.includes("twitter") || platform === "x") {
      return parts[0]?.toLowerCase() ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function extractNameParts(primaryNameKey: string): {
  firstName?: string;
  lastName?: string;
  firstInitial?: string;
} {
  const words = primaryNameKey.split(" ").filter(Boolean);
  const firstName = words[0];
  const lastName = words.length > 1 ? words[words.length - 1] : undefined;
  return {
    firstName,
    lastName,
    firstInitial: firstName?.[0],
  };
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

function mergeMentions(group: PersonMention[]): PersonMention {
  if (group.length === 1) return group[0];

  const sorted = group.slice().sort((a, b) => b.confidence - a.confidence);
  const base = sorted[0];
  const allMentions = sorted.map((mention) => mention.extracted);

  const mergedExtracted = {
    names: dedupeStrings(allMentions.flatMap((extract) => extract.names)),
    experiences: mergeExperiences(allMentions.flatMap((extract) => extract.experiences)),
    location: chooseBestString(sorted.map((mention) => mention.extracted.location)),
    education: mergeEducation(allMentions.flatMap((extract) => extract.education)),
    skills: mergeSkills(allMentions.flatMap((extract) => extract.skills)),
    socialLinks: mergeSocialLinks(allMentions.flatMap((extract) => extract.socialLinks)),
    emails: dedupeStrings(allMentions.flatMap((extract) => extract.emails.map((email) => email.toLowerCase()))),
    phones: dedupeStrings(allMentions.flatMap((extract) => extract.phones)),
    bioSnippet: chooseBestString(sorted.map((mention) => mention.extracted.bioSnippet)),
    relationships: mergeRelationships(allMentions.flatMap((extract) => extract.relationships)),
    dates: dedupeObjects(allMentions.flatMap((extract) => extract.dates), (date) => `${date.event}::${date.date}`),
    additionalFacts: dedupeStrings(allMentions.flatMap((extract) => extract.additionalFacts)),
    certifications: dedupeObjects(
      allMentions.flatMap((extract) => extract.certifications),
      (cert) => `${cert.name}::${cert.issuer ?? ""}::${cert.year ?? ""}`
    ),
    publications: dedupeObjects(
      allMentions.flatMap((extract) => extract.publications),
      (publication) => `${publication.title}::${publication.venue ?? ""}::${publication.year ?? ""}`
    ),
    awards: dedupeObjects(
      allMentions.flatMap((extract) => extract.awards),
      (award) => `${award.title}::${award.issuer ?? ""}::${award.year ?? ""}`
    ),
    languages: dedupeStrings(allMentions.flatMap((extract) => extract.languages)),
  };

  return {
    sourceUrl: base.sourceUrl,
    fetchedAt: sorted.reduce((latest, mention) => (
      mention.fetchedAt > latest ? mention.fetchedAt : latest
    ), base.fetchedAt),
    confidence: Math.min(
      1,
      Math.max(...sorted.map((mention) => mention.confidence)) + Math.min(0.05, group.length * 0.01)
    ),
    extracted: mergedExtracted,
  };
}

function mergeExperiences(experiences: ExperienceEntry[]): ExperienceEntry[] {
  return dedupeObjects(experiences, (experience) => {
    const title = normalizeNameKey(experience.title);
    const company = normalizeNameKey(experience.company);
    return `${title}::${company}`;
  });
}

function mergeEducation(education: EducationEntry[]): EducationEntry[] {
  return dedupeObjects(education, (entry) => {
    return `${normalizeNameKey(entry.institution)}::${normalizeNameKey(entry.degree ?? "")}::${normalizeNameKey(entry.field ?? "")}::${entry.year ?? ""}`;
  });
}

function mergeSkills(skills: SkillEntry[]): SkillEntry[] {
  return dedupeObjects(skills, (skill) => normalizeNameKey(skill.name));
}

function mergeSocialLinks(socialLinks: SocialLink[]): SocialLink[] {
  return dedupeObjects(socialLinks, (social) => `${normalizeNameKey(social.platform)}::${social.url.toLowerCase()}`);
}

function mergeRelationships(relationships: Relationship[]): Relationship[] {
  return dedupeObjects(
    relationships,
    (relationship) => `${normalizeNameKey(relationship.name)}::${normalizeNameKey(relationship.relationship)}`
  );
}

function chooseBestString(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => !!value && value.trim().length > 0)
    .sort((a, b) => b.length - a.length)[0];
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function dedupeObjects<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
