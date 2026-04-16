import type { SearchResult, PersonMention, ExtractedPersonData } from "@/types";

/**
 * Extract person data from search result titles and snippets BEFORE fetching pages.
 * Search engines have already crawled LinkedIn, Facebook, etc. — their result
 * titles/snippets contain structured data (name, title, company, school) that
 * we can harvest for free without hitting blocked sites.
 *
 * Common patterns:
 *   "Noah Liu - Co-Founder @ WeKruit | LinkedIn"
 *   "Noah Liu | Software Engineer at Google"
 *   "Noah Liu - University of Southern California - LinkedIn"
 *   "Noah Liu, MD - Cardiologist in New York, NY"
 *   "Noah Liu (@noahliu) · GitHub"
 *   "Noah Liu - Senior Engineer - Meta | LinkedIn"
 */

// Platform indicators at the end of titles
const PLATFORM_SUFFIXES = /\s*[|\-–—]\s*(LinkedIn|Facebook|Twitter|X|GitHub|Medium|Crunchbase|AngelList|Wellfound|ResearchGate|Google Scholar|ORCID|About\.me|Quora|Reddit|Stack Overflow|Kaggle|Behance|Dribbble|WayUp|RocketReach|Whitebridge(?:\.AI)?|ZoomInfo|Hunter\.io|ContactOut|Lusha|Apollo\.io|Clearbit)\s*$/i;

// Title separators (ranked by specificity)
const TITLE_SEPARATORS = /\s*[|\-–—@]\s*/;

// Role keywords that indicate a job title
const ROLE_KEYWORDS = /\b(engineer|developer|designer|manager|director|vp|vice president|president|ceo|cto|cfo|coo|founder|co-founder|cofounder|analyst|consultant|scientist|researcher|professor|lecturer|associate|lead|head|chief|principal|senior|junior|intern|architect|coordinator|specialist|strategist|advisor|partner|fellow|postdoc|phd|md|attorney|counsel|nurse|physician|surgeon)\b/i;

// Company indicators
const COMPANY_PREPOSITIONS = /\b(at|@)\s+/i;

// Education indicators
const EDUCATION_KEYWORDS = /\b(university|college|institute|school|academy|polytechnic)\b/i;

// Location patterns (City, State or City, Country)
const LOCATION_PATTERN = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*([A-Z]{2}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/;

// Social profile URL patterns
const SOCIAL_PATTERNS: { platform: string; regex: RegExp; usernameGroup?: number }[] = [
  { platform: "LinkedIn", regex: /linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i, usernameGroup: 1 },
  { platform: "GitHub", regex: /github\.com\/([a-zA-Z0-9_-]+)/i, usernameGroup: 1 },
  { platform: "Twitter", regex: /(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/i, usernameGroup: 1 },
  { platform: "Facebook", regex: /facebook\.com\/([a-zA-Z0-9._-]+)/i, usernameGroup: 1 },
  { platform: "Medium", regex: /medium\.com\/@?([a-zA-Z0-9._-]+)/i, usernameGroup: 1 },
  { platform: "Crunchbase", regex: /crunchbase\.com\/person\/([a-zA-Z0-9_-]+)/i, usernameGroup: 1 },
];

interface SnippetExtraction {
  mention: PersonMention;
  platform?: string;
}

/**
 * Extract person mentions from search results using title/snippet parsing.
 * Returns mentions with data harvested purely from the SERP — no page fetches needed.
 *
 * @param results - Search results from Serper/Brave
 * @param queryName - The person name being searched for
 * @returns Array of extracted mentions (may be empty if no useful data found)
 */
export function extractFromSearchResults(
  results: SearchResult[],
  queryName: string
): PersonMention[] {
  const mentions: PersonMention[] = [];
  const queryNameLower = queryName.toLowerCase().trim();
  const queryParts = queryNameLower.split(/\s+/);

  for (const result of results) {
    const extraction = extractFromSingleResult(result, queryNameLower, queryParts);
    if (extraction) {
      mentions.push(extraction.mention);
    }
  }

  return mentions;
}

function extractFromSingleResult(
  result: SearchResult,
  queryNameLower: string,
  queryParts: string[]
): SnippetExtraction | null {
  const { title, url, snippet } = result;
  if (!title) return null;

  // Strip platform suffix from title
  let cleanTitle = title.replace(PLATFORM_SUFFIXES, "").trim();
  const platformMatch = title.match(PLATFORM_SUFFIXES);
  const platform = platformMatch?.[1];

  // Skip directory/listing pages that aggregate many profiles
  if (/\d+\+?\s+["'].*["']\s+profiles?/i.test(title) ||
      /results?\s+for\b/i.test(title) ||
      /people\s+named\b/i.test(title) ||
      /\bprofiles?\s*[|\-–—]/i.test(title)) {
    return null;
  }

  // Language-agnostic directory filter: any title starting with "N+" that
  // contains the query name is a directory/listing page regardless of language.
  // Catches: "60+ perfiles de «Noah Liu»", "60+ 個符合「Noah Liu」的個人檔案", etc.
  if (/^\d+\+?\s+/.test(title) && title.toLowerCase().includes(queryNameLower)) {
    return null;
  }

  // Check if the query name appears in the title
  const titleLower = cleanTitle.toLowerCase();
  const nameInTitle = titleLower.includes(queryNameLower) ||
    (queryParts.length >= 2 && queryParts.every(p => p.length > 1 && titleLower.includes(p)));

  if (!nameInTitle) return null;

  // Parse the title into structured components
  const parsed = parseTitleComponents(cleanTitle, queryNameLower);
  if (!parsed) return null;

  // Extract additional data from snippet
  const snippetData = parseSnippet(snippet, queryNameLower);

  // Extract social link from URL
  const socialLink = extractSocialLink(url);

  // Build experience entry from title/company if present
  const expTitle = parsed.title || snippetData.title;
  const expCompany = parsed.company || snippetData.company;
  const experiences = (expTitle || expCompany)
    ? [{ title: expTitle || "", company: expCompany || "", isCurrent: true }]
    : [];

  // Build the extracted data
  const extracted: ExtractedPersonData = {
    names: parsed.names,
    experiences,
    location: parsed.location || snippetData.location,
    education: [
      ...(parsed.education ? [{ institution: parsed.education }] : []),
      ...(snippetData.education ? [{ institution: snippetData.education }] : []),
    ],
    skills: snippetData.skills.map((name) => ({ name })),
    socialLinks: socialLink ? [socialLink] : [],
    emails: snippetData.email ? [snippetData.email] : [],
    phones: [],
    bioSnippet: snippetData.bioSnippet,
    relationships: [],
    dates: [],
    additionalFacts: [],
    certifications: [],
    publications: [],
    awards: [],
    languages: [],
  };

  // Only return if we got substantive data beyond just a name.
  // A social link or location alone isn't enough — but location + social link together
  // (e.g., LinkedIn result with "Noah Liu - San Francisco, CA") is a useful signal.
  const hasData = experiences.length > 0 ||
    extracted.education.length > 0 ||
    extracted.emails.length > 0 || extracted.bioSnippet ||
    (extracted.location && extracted.socialLinks.length > 0);

  if (!hasData) return null;

  // Confidence is lower for snippet data — it's parsed from titles, not full page content
  const confidence = computeSnippetConfidence(extracted, platform);

  return {
    mention: {
      sourceUrl: url,
      fetchedAt: new Date(),
      confidence,
      extracted,
    },
    platform,
  };
}

/**
 * Parse a search result title into name, title, company, etc.
 *
 * Common formats:
 *   "Noah Liu - Co-Founder @ WeKruit"
 *   "Noah Liu | Senior Engineer at Google"
 *   "Noah Liu - University of Southern California"
 *   "Noah Liu, MD - Cardiologist"
 */
function parseTitleComponents(
  title: string,
  queryNameLower: string
): { names: string[]; title?: string; company?: string; location?: string; education?: string } | null {
  // Split on major separators (|, -, –, —)
  const parts = title.split(/\s*[|\-–—]\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  // Find which part contains the name.
  // Also handle "First(Alias) Last" patterns (e.g. "Zelin(Noah) Liu") by stripping
  // non-alphanumeric chars before word-level matching.
  const queryNameWords = queryNameLower.split(/\s+/).filter(w => w.length > 1);
  let namePartIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const partLower = parts[i].toLowerCase();
    if (partLower.includes(queryNameLower)) {
      namePartIdx = i;
      break;
    }
    // Word-level fallback: strip parens/brackets and check each query word is present
    const cleanPartLower = partLower.replace(/[^a-z0-9\s]/g, " ");
    if (queryNameWords.length >= 2 && queryNameWords.every(w => cleanPartLower.includes(w))) {
      namePartIdx = i;
      break;
    }
  }
  if (namePartIdx === -1) return null;

  const namePart = parts[namePartIdx];
  // Strip credential suffixes and data-site boilerplate from the name.
  // Also expand parenthetical aliases: "Zelin(Noah) Liu" → "Zelin Noah Liu"
  // so that the name can be matched by nameScore / entity resolution.
  const cleanedName = namePart
    .replace(/[(\[{]([^)\]}{]+)[)\]}]/g, " $1 ")   // "(Noah)" → " Noah "
    .replace(/,\s*(MD|PhD|JD|MBA|CPA|PE|RN|DDS|DO|DVM|Esq\.?)$/i, "")
    .replace(/\s+(Email\s*&\s*Phone\s*Number|Contact\s*Information|Salary|Net\s*Worth|Age|Bio)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const names = [cleanedName];

  let jobTitle: string | undefined;
  let company: string | undefined;
  let location: string | undefined;
  let education: string | undefined;

  // Process remaining parts
  const otherParts = parts.filter((_, i) => i !== namePartIdx);

  for (const part of otherParts) {
    // Check for "Title at Company" or "Title @ Company"
    const atMatch = part.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (atMatch) {
      if (!jobTitle && ROLE_KEYWORDS.test(atMatch[1])) {
        jobTitle = atMatch[1].trim();
      }
      if (!company) {
        company = atMatch[2].trim();
      }
      continue;
    }

    // Check for education
    if (!education && EDUCATION_KEYWORDS.test(part)) {
      education = part.trim();
      continue;
    }

    // Check for job title
    if (!jobTitle && ROLE_KEYWORDS.test(part)) {
      jobTitle = part.trim();
      continue;
    }

    // Check for location — ONLY assign if it matches the explicit City, STATE pattern
    // Don't use aggressive fallback that misclassifies headlines as locations
    const locMatch = part.match(LOCATION_PATTERN);
    if (!location && locMatch) {
      location = locMatch[0];
      continue;
    }

    // If nothing else matched and we don't have a company, it might be a company name.
    // Guard: must start with an uppercase letter or digit (rules out generic phrases like
    // "view 500+ connections"), must contain at least 3 consecutive alpha chars,
    // and must not be a pure date/number string.
    if (
      !company &&
      !ROLE_KEYWORDS.test(part) &&
      !EDUCATION_KEYWORDS.test(part) &&
      part.length < 60 &&
      /^[A-Z0-9]/.test(part) &&
      /[A-Za-z]{3}/.test(part)
    ) {
      company = part.trim();
    }
  }

  return { names, title: jobTitle, company, location, education };
}

/**
 * Extract additional data from the search result snippet.
 */
function parseSnippet(
  snippet: string,
  queryNameLower: string
): {
  title?: string;
  company?: string;
  location?: string;
  education?: string;
  skills: string[];
  email?: string;
  bioSnippet?: string;
} {
  if (!snippet) return { skills: [] };

  const snippetLower = snippet.toLowerCase();
  let jobTitle: string | undefined;
  let company: string | undefined;
  let location: string | undefined;
  let education: string | undefined;
  let email: string | undefined;
  let bioSnippet: string | undefined;
  const skills: string[] = [];

  // Try to extract email
  const emailMatch = snippet.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) {
    email = emailMatch[0];
  }

  // Parse LinkedIn-style "Field: Value · Field: Value" snippets
  // e.g. "Experience: Amazon Web Services (AWS) · Education: The University of Texas at Austin · Location: Fairfax"
  const linkedInFieldPattern = /(?:^|·)\s*([A-Za-z]+):\s*([^·]+)/g;
  let fieldMatch;
  while ((fieldMatch = linkedInFieldPattern.exec(snippet)) !== null) {
    const field = fieldMatch[1].toLowerCase();
    const value = fieldMatch[2].trim().replace(/\s+$/, "");
    if (field === "experience" || field === "work") {
      if (!company) company = value;
    } else if (field === "education") {
      if (!education) education = value;
    } else if (field === "location") {
      if (!location) location = value;
    } else if (field === "skills" || field === "skill") {
      // LinkedIn sometimes shows "Skills: Python · React · TypeScript"
      const skillItems = value.split(/[,·|]+/).map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 40);
      skills.push(...skillItems);
    }
  }

  // Try to extract "Title at Company" from snippet
  const titleAtCompany = snippet.match(/(?:works?\s+as\s+(?:an?\s+)?|is\s+(?:an?\s+)?|serves?\s+as\s+(?:an?\s+)?)([^.]+?)\s+(?:at|@)\s+([^.,]+)/i);
  if (titleAtCompany) {
    jobTitle = titleAtCompany[1].trim();
    company = company || titleAtCompany[2].trim();
  }

  // Try to extract education — pattern-based fallback if LinkedIn field pattern didn't fire
  if (!education) {
    const eduMatch = snippet.match(/(?:studied|graduated|degree|alumni|student)\s+(?:at|from)\s+([^.,]+)/i);
    if (eduMatch) {
      education = eduMatch[1].trim();
    }
  }

  // Location from snippet
  const locMatch = snippet.match(/(?:based in|located in|lives in|from)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*(?:,\s*[A-Z]{2,})?)/);
  if (locMatch) {
    location = locMatch[1].trim();
  }

  // If snippet mentions the person and has meaningful content, use as bio
  if (snippetLower.includes(queryNameLower) && snippet.length > 30) {
    bioSnippet = snippet.slice(0, 300);
  }

  return { title: jobTitle, company, location, education, skills, email, bioSnippet };
}

function extractSocialLink(url: string): { platform: string; url: string; username?: string } | null {
  for (const pattern of SOCIAL_PATTERNS) {
    const match = url.match(pattern.regex);
    if (match) {
      return {
        platform: pattern.platform,
        url,
        username: pattern.usernameGroup ? match[pattern.usernameGroup] : undefined,
      };
    }
  }
  return null;
}

function computeSnippetConfidence(
  extracted: ExtractedPersonData,
  platform?: string
): number {
  let confidence = 0.35; // Base confidence for snippet extraction (lower than page extraction)

  // LinkedIn/GitHub titles are very reliable
  if (platform === "LinkedIn" || platform === "GitHub") confidence += 0.15;

  // Having structured data increases confidence
  if (extracted.experiences.length > 0) confidence += 0.05;
  if (extracted.experiences[0]?.company) confidence += 0.05;
  if (extracted.education.length > 0) confidence += 0.05;
  // Only add socialLinks bonus when the platform isn't already counted above.
  // LinkedIn/GitHub results always have their own URL as the social link — don't double-count.
  if (extracted.socialLinks.length > 0 && platform !== "LinkedIn" && platform !== "GitHub") confidence += 0.05;

  return Math.min(confidence, 0.7); // Cap at 0.7 — snippet data is never as reliable as full extraction
}
