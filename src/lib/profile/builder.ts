import { v4 as uuidv4 } from "uuid";
import type { PersonProfile, ScoredValue, PersonMention, SourceRecord, ExperienceEntry, SkillEntry, CertificationEntry, PublicationEntry, AwardEntry } from "@/types";
import type { EntityCluster } from "@/lib/entity/resolver";

// Source reliability scores by domain
const DOMAIN_RELIABILITY: Record<string, number> = {
  "linkedin.com": 0.9,
  "github.com": 0.85,
  "scholar.google.com": 0.85,
  "crunchbase.com": 0.8,
  "twitter.com": 0.7,
  "x.com": 0.7,
};

function getReliability(url: string): number {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    for (const [key, value] of Object.entries(DOMAIN_RELIABILITY)) {
      if (domain.includes(key)) return value;
    }
    if (domain.endsWith(".edu")) return 0.85;
    if (domain.endsWith(".gov")) return 0.8;
    return 0.5;
  } catch {
    return 0.5;
  }
}

function recencyDecay(date: Date): number {
  const yearsSince = Math.max(0, (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 365));
  return Math.min(1.0, Math.exp(-0.1 * yearsSince));
}

function computeConfidence(
  sourceUrls: string[],
  fetchDates: Date[]
): number {
  if (sourceUrls.length === 0 || fetchDates.length === 0) return 0;

  // Exclude synthetic internal pseudo-URLs from reliability calculation
  const realUrls = sourceUrls.filter((u) => !u.startsWith("snippet-synthesis://"));
  const urlsForReliability = realUrls.length > 0 ? realUrls : sourceUrls;
  const reliabilities = urlsForReliability.map(getReliability);
  const avgReliability = reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length;
  const corroborationBoost = Math.min(1.0, 0.5 + 0.15 * sourceUrls.length);
  const mostRecent = fetchDates.reduce((a, b) => (a > b ? a : b));
  const recency = recencyDecay(mostRecent);

  return avgReliability * corroborationBoost * recency;
}

/** Strip internal synthetic pseudo-URLs from a sources array for user-facing output. */
function realSources(sources: string[]): string[] {
  return sources.filter((u) => !u.startsWith("snippet-synthesis://"));
}

/** Helper to safely get min/max dates from a non-empty array */
function minDate(dates: Date[]): Date {
  return dates.reduce((a, b) => (a < b ? a : b));
}
function maxDate(dates: Date[]): Date {
  return dates.reduce((a, b) => (a > b ? a : b));
}

function normalizeLocation(raw: string): string {
  let s = raw.trim();
  // Remove obvious obfuscation placeholders from snippets.
  s = s.replace(/^[.\s]*\.\.\.[\s,]*/g, "");
  s = s.replace(/\s+/g, " ");
  // Remove duplicate country code suffix when full country is already present.
  // e.g. "Fairfax, Virginia, United States, US" -> "Fairfax, Virginia, United States"
  s = s.replace(/,\s*([A-Z]{2})$/g, (m, cc, offset, str) => {
    const lower = String(str).toLowerCase();
    if ((cc === "US" && lower.includes("united states")) || (cc === "UK" && lower.includes("united kingdom"))) {
      return "";
    }
    return m;
  });
  return s.trim();
}

/**
 * Build PersonProfile objects from entity clusters.
 */
export function buildProfiles(clusters: EntityCluster[]): PersonProfile[] {
  return clusters
    .map((cluster) => buildSingleProfile(cluster))
    .sort((a, b) => b.confidence - a.confidence);
}

export function buildSingleProfile(cluster: EntityCluster): PersonProfile {
  const mentions = cluster.mentions;
  const now = new Date();

  // Collect all sources — deduplicate by URL, filter synthetic pseudo-URLs
  const seenSourceUrls = new Set<string>();
  const sources: SourceRecord[] = mentions
    .filter((m) => !m.sourceUrl.startsWith("snippet-synthesis://"))
    .filter((m) => {
      if (seenSourceUrls.has(m.sourceUrl)) return false;
      seenSourceUrls.add(m.sourceUrl);
      return true;
    })
    .map((m) => ({
      url: m.sourceUrl,
      fetchedAt: m.fetchedAt,
      sourceType: "crawled_page" as const,
      reliability: getReliability(m.sourceUrl),
      relevanceScore: m.confidence,
    }));

  // ── Merge names ──
  const nameMap = new Map<string, { original: string; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const name of m.extracted.names) {
      if (!name || typeof name !== "string") continue;
      const normalized = name.trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      const existing = nameMap.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
      } else {
        nameMap.set(key, { original: normalized, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const names: ScoredValue<string>[] = Array.from(nameMap.values()).map((data) => ({
    value: data.original,
    confidence: computeConfidence(data.sources, data.dates),
    sources: realSources(data.sources),
    firstSeen: minDate(data.dates),
    lastSeen: maxDate(data.dates),
  }));

  // ── Merge experiences ──
  const GARBAGE_TITLE_RE = /contact|\.{3}|free search|email address|\bget\b.*\b(email|phone)\b|^#[a-z]|^\s*hiring\s*$/i;
  // Matches abbreviations, social handles, academic databases, and search engines
  // that get misextracted as employer names
  const GARBAGE_COMPANY_RE = /^\s*(co\.?|inc\.?|llc\.?|ltd\.?|corp\.?|hiring)\s*$|^#\w+$|^\s*(google scholar|researchgate|academia\.edu|semantic scholar|pubmed|arxiv|jstor|springer|elsevier|wiley|ieee xplore|scopus|web of science|orcid)\s*$/i;
  const isTitleLike = (t: string) => t.split(/\s+/).filter(Boolean).length <= 6;

  // Key experiences by normalized title+company to deduplicate across mentions
  const expMap = new Map<string, {
    entry: ExperienceEntry;
    sources: string[];
    dates: Date[];
    confidence: number;
  }>();

  for (const m of mentions) {
    for (const exp of (m.extracted.experiences || [])) {
      if (!exp || typeof exp.title !== "string" || typeof exp.company !== "string") continue;
      if (GARBAGE_TITLE_RE.test(exp.title)) continue;
      if (!isTitleLike(exp.title)) continue;
      if (GARBAGE_COMPANY_RE.test(exp.company)) continue;
      // Drop experiences with no title and no real company (both empty strings are useless)
      if (!exp.title.trim() && !exp.company.trim()) continue;

      const titleNorm = exp.title.toLowerCase().trim();
      const companyNorm = exp.company.toLowerCase().trim();
      const key = `${titleNorm}::${companyNorm}`;

      // When this entry has NO title, check if a titled entry for the same company already
      // exists — if so, merge this source into that entry rather than creating a duplicate.
      if (!titleNorm && companyNorm) {
        let merged = false;
        for (const [existingKey, existingData] of expMap) {
          if (existingKey.endsWith(`::${companyNorm}`)) {
            if (!existingData.sources.includes(m.sourceUrl)) existingData.sources.push(m.sourceUrl);
            existingData.dates.push(m.fetchedAt);
            if (exp.isCurrent) existingData.entry.isCurrent = true;
            if (m.confidence > existingData.confidence) existingData.confidence = m.confidence;
            merged = true;
            break;
          }
        }
        if (merged) continue;
      }

      // When this entry HAS a title, absorb any existing title-less entry for the same company.
      if (titleNorm && companyNorm) {
        const emptyKey = `::${companyNorm}`;
        const emptyEntry = expMap.get(emptyKey);
        if (emptyEntry) {
          // Upgrade: absorb the title-less entry's sources/dates into this titled entry
          const combinedSources = [...emptyEntry.sources, m.sourceUrl].filter((v, i, a) => a.indexOf(v) === i);
          const combinedDates = [...emptyEntry.dates, m.fetchedAt];
          const combinedConfidence = Math.max(emptyEntry.confidence, m.confidence);
          const newEntry: ExperienceEntry = { ...exp };
          if (emptyEntry.entry.startDate && !newEntry.startDate) newEntry.startDate = emptyEntry.entry.startDate;
          if (emptyEntry.entry.endDate && !newEntry.endDate) newEntry.endDate = emptyEntry.entry.endDate;
          if (emptyEntry.entry.location && !newEntry.location) newEntry.location = emptyEntry.entry.location;
          if (emptyEntry.entry.description && !newEntry.description) newEntry.description = emptyEntry.entry.description;
          if (emptyEntry.entry.isCurrent) newEntry.isCurrent = true;
          expMap.delete(emptyKey);
          expMap.set(key, { entry: newEntry, sources: combinedSources, dates: combinedDates, confidence: combinedConfidence });
          continue;
        }
      }

      const existing = expMap.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
        // Merge in any additional fields from this mention
        if (!existing.entry.startDate && exp.startDate) existing.entry.startDate = exp.startDate;
        if (!existing.entry.endDate && exp.endDate) existing.entry.endDate = exp.endDate;
        if (!existing.entry.location && exp.location) existing.entry.location = exp.location;
        if (!existing.entry.description && exp.description) existing.entry.description = exp.description;
        // If any source says isCurrent=true, mark as current
        if (exp.isCurrent) existing.entry.isCurrent = true;
        if (m.confidence > existing.confidence) existing.confidence = m.confidence;
      } else {
        expMap.set(key, {
          entry: { ...exp },
          sources: [m.sourceUrl],
          dates: [m.fetchedAt],
          confidence: m.confidence,
        });
      }
    }
  }

  const experiences: ScoredValue<ExperienceEntry>[] = Array.from(expMap.values())
    .map((data) => ({
      value: data.entry,
      confidence: computeConfidence(data.sources, data.dates),
      sources: realSources(data.sources),
      firstSeen: minDate(data.dates),
      lastSeen: maxDate(data.dates),
    }))
    // Sort: current roles first, then by confidence descending
    .sort((a, b) => {
      if (a.value.isCurrent !== b.value.isCurrent) return a.value.isCurrent ? -1 : 1;
      return b.confidence - a.confidence;
    });

  // ── Merge education ──
  const eduMap = new Map<string, { entry: { institution: string; degree?: string; field?: string; year?: number }; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const edu of m.extracted.education) {
      if (!edu || !edu.institution) continue;
      const key = edu.institution.toLowerCase().replace(/[^a-z0-9]/g, "");
      const existing = eduMap.get(key);
      if (existing) {
        existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
        if (edu.degree && !existing.entry.degree) existing.entry.degree = edu.degree;
        if (edu.field && !existing.entry.field) existing.entry.field = edu.field;
        if (edu.year && !existing.entry.year) existing.entry.year = edu.year;
      } else {
        eduMap.set(key, { entry: { ...edu }, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const education: ScoredValue<{ institution: string; degree?: string; field?: string; year?: number }>[] =
    Array.from(eduMap.values()).map((e) => ({
      value: e.entry,
      confidence: computeConfidence(e.sources, e.dates),
      sources: realSources(e.sources),
      firstSeen: minDate(e.dates),
      lastSeen: maxDate(e.dates),
    }));

  // ── Merge locations ──
  // Normalize key to first city token so "Fairfax" and "Fairfax, VA" merge together.
  // Keep the longer/more specific form as canonical.
  const locationMap = new Map<string, { original: string; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    if (m.extracted.location && typeof m.extracted.location === "string") {
      const loc = normalizeLocation(m.extracted.location);
      if (!loc) continue;
      if (/\*{2,}/.test(loc)) continue; // heavily redacted/obfuscated location strings
      // Key = first comma-separated part, lower-cased, alpha only (city name)
      const key = loc.split(",")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
      const existing = locationMap.get(key);
      if (existing) {
        // Prefer the more specific (longer) form
        if (loc.length > existing.original.length) existing.original = loc;
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
      } else {
        locationMap.set(key, { original: loc, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const locationsUnsorted = Array.from(locationMap.values()).map((data) => ({
    value: { city: data.original, country: undefined as string | undefined, isCurrent: false },
    confidence: computeConfidence(data.sources, data.dates),
    sources: realSources(data.sources),
    firstSeen: minDate(data.dates),
    lastSeen: maxDate(data.dates),
  }));
  // Sort by confidence descending; mark the highest-confidence location as current
  locationsUnsorted.sort((a, b) => b.confidence - a.confidence);
  if (locationsUnsorted.length > 0) {
    locationsUnsorted[0].value.isCurrent = true;
  }
  const locations: ScoredValue<{ city: string; country?: string; isCurrent: boolean }>[] = locationsUnsorted;

  // ── Merge skills ──
  const skillMap = new Map<string, { entry: SkillEntry; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const skill of (m.extracted.skills || [])) {
      if (!skill || typeof skill.name !== "string") continue;
      const trimmed = skill.name.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const existing = skillMap.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
        // Upgrade proficiency if a more specific value is found
        if (!existing.entry.proficiency && skill.proficiency) existing.entry.proficiency = skill.proficiency;
      } else {
        skillMap.set(key, { entry: { name: trimmed, proficiency: skill.proficiency ?? undefined }, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const skills: ScoredValue<SkillEntry>[] = Array.from(skillMap.values()).map(
    (data) => ({
      value: data.entry,
      confidence: computeConfidence(data.sources, data.dates),
      sources: realSources(data.sources),
      firstSeen: minDate(data.dates),
      lastSeen: maxDate(data.dates),
    })
  );

  // ── Merge social profiles ──
  // Patterns that look like LinkedIn but are NOT individual profiles (directory, search, company pages)
  const LINKEDIN_NON_PROFILE_RE = /linkedin\.com\/(pub\/dir|company|school|jobs|search|feed|pulse)\//i;
  const socialMap = new Map<string, { link: { platform: string; url: string; username?: string }; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const link of m.extracted.socialLinks) {
      if (!link || !link.url) continue;
      // Filter out LinkedIn directory/company/search pages — they're not personal profiles
      if (link.platform === "LinkedIn" && LINKEDIN_NON_PROFILE_RE.test(link.url)) continue;
      const key = link.url.toLowerCase();
      const existing = socialMap.get(key);
      if (existing) {
        existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
      } else {
        socialMap.set(key, { link, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const socialProfiles: ScoredValue<{ platform: string; url: string; username?: string }>[] =
    Array.from(socialMap.values()).map((s) => ({
      value: s.link,
      confidence: computeConfidence(s.sources, s.dates),
      sources: realSources(s.sources),
      firstSeen: minDate(s.dates),
      lastSeen: maxDate(s.dates),
    }));

  // ── Merge emails ──
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emailSet = new Map<string, { sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const rawEmail of (m.extracted.emails || [])) {
      if (!rawEmail || typeof rawEmail !== "string") continue;
      const email = rawEmail.toLowerCase().trim();
      if (!emailRegex.test(email)) continue;
      const existing = emailSet.get(email);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
      } else {
        emailSet.set(email, { sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const emails: ScoredValue<string>[] = Array.from(emailSet.entries()).map(
    ([key, data]) => ({
      value: key,
      confidence: computeConfidence(data.sources, data.dates),
      sources: realSources(data.sources),
      firstSeen: minDate(data.dates),
      lastSeen: maxDate(data.dates),
    })
  );

  // ── Merge phones ──
  const phoneSet = new Map<string, { sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const rawPhone of (m.extracted.phones || [])) {
      if (!rawPhone || typeof rawPhone !== "string") continue;
      // Normalize: keep digits, +, spaces, dashes only
      const phone = rawPhone.trim();
      const key = phone.replace(/[^\d+]/g, "");
      if (key.length < 7) continue; // too short to be real
      const existing = phoneSet.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
      } else {
        phoneSet.set(key, { sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const phones: ScoredValue<string>[] = Array.from(phoneSet.entries()).map(
    ([key, data]) => ({
      value: key,
      confidence: computeConfidence(data.sources, data.dates),
      sources: realSources(data.sources),
      firstSeen: minDate(data.dates),
      lastSeen: maxDate(data.dates),
    })
  );

  // ── Bio snippet: pick the highest-quality one (reliability × confidence), filtering aggregator garbage ──
  const GARBAGE_BIO_RE = [
    /what (industry|company|role|does|is)\b/i,  // aggregator question text
    /\?\s+\w/,                                   // any question pattern
    /\.{3}/,                                     // ellipsis-heavy scraped text
    /^\s*[@#]/,                                  // starts with @ or # (social handle fragments)
    /get .{0,30}(email|phone).{0,30}(address|number)/i, // "Get X's email address..."
    /\bfree search(es)?\b/i,                     // RocketReach "Get 5 free searches"
    /\b(rocketreach|whitebridge|zoominfo)\b/i,  // aggregator brand names in bio
    /report this post|close menu|view profile for|one comment/i, // LinkedIn post UI chrome
  ];
  const bioSnippet = mentions
    .filter((m) => typeof m.extracted.bioSnippet === "string" && (m.extracted.bioSnippet as string).length > 20)
    .map((m) => ({ bio: m.extracted.bioSnippet as string, score: getReliability(m.sourceUrl) * m.confidence }))
    .filter(({ bio }) => !GARBAGE_BIO_RE.some((re) => re.test(bio)))
    .sort((a, b) => b.score - a.score)[0]?.bio;

  // ── Merge additional facts (fuzzy dedup by word-sorted key) ──
  // Two facts are considered the same if they share the same set of significant words,
  // e.g. "Won 2nd at HackUT 2023" and "2nd place HackUT 2023 winner" → same fact.
  const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "in", "at", "of", "to", "is", "was", "for", "on", "with", "as"]);
  function factNormKey(fact: string): string {
    return fact.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      .sort()
      .join(" ");
  }
  const factMap = new Map<string, { original: string; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const fact of m.extracted.additionalFacts) {
      if (!fact || typeof fact !== "string") continue;
      const trimmed = fact.trim();
      if (!trimmed) continue;
      const key = factNormKey(trimmed);
      if (!key) continue;
      const existing = factMap.get(key);
      if (existing) {
        // Keep longer/more descriptive version as canonical
        if (trimmed.length > existing.original.length) existing.original = trimmed;
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
      } else {
        factMap.set(key, { original: trimmed, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const additionalFacts: ScoredValue<string>[] = Array.from(factMap.values()).map(
    (data) => ({
      value: data.original,
      confidence: computeConfidence(data.sources, data.dates),
      sources: realSources(data.sources),
      firstSeen: minDate(data.dates),
      lastSeen: maxDate(data.dates),
    })
  );

  // ── Merge certifications ──
  const certMap = new Map<string, { entry: CertificationEntry; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const cert of (m.extracted.certifications || [])) {
      if (!cert || typeof cert.name !== "string") continue;
      const key = cert.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const existing = certMap.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
        if (!existing.entry.issuer && cert.issuer) existing.entry.issuer = cert.issuer;
        if (!existing.entry.year && cert.year) existing.entry.year = cert.year;
      } else {
        certMap.set(key, { entry: { ...cert }, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const certifications: ScoredValue<CertificationEntry>[] = Array.from(certMap.values()).map((data) => ({
    value: data.entry,
    confidence: computeConfidence(data.sources, data.dates),
    sources: realSources(data.sources),
    firstSeen: minDate(data.dates),
    lastSeen: maxDate(data.dates),
  }));

  // ── Merge publications ──
  const pubMap = new Map<string, { entry: PublicationEntry; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const pub of (m.extracted.publications || [])) {
      if (!pub || typeof pub.title !== "string") continue;
      const key = pub.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
      const existing = pubMap.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
        if (!existing.entry.venue && pub.venue) existing.entry.venue = pub.venue;
        if (!existing.entry.year && pub.year) existing.entry.year = pub.year;
        if (!existing.entry.url && pub.url) existing.entry.url = pub.url;
      } else {
        pubMap.set(key, { entry: { ...pub }, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const publications: ScoredValue<PublicationEntry>[] = Array.from(pubMap.values()).map((data) => ({
    value: data.entry,
    confidence: computeConfidence(data.sources, data.dates),
    sources: realSources(data.sources),
    firstSeen: minDate(data.dates),
    lastSeen: maxDate(data.dates),
  }));

  // ── Merge awards ──
  const awardMap = new Map<string, { entry: AwardEntry; sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const award of (m.extracted.awards || [])) {
      if (!award || typeof award.title !== "string") continue;
      const key = award.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      const existing = awardMap.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
        if (!existing.entry.issuer && award.issuer) existing.entry.issuer = award.issuer;
        if (!existing.entry.year && award.year) existing.entry.year = award.year;
      } else {
        awardMap.set(key, { entry: { ...award }, sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const awards: ScoredValue<AwardEntry>[] = Array.from(awardMap.values()).map((data) => ({
    value: data.entry,
    confidence: computeConfidence(data.sources, data.dates),
    sources: realSources(data.sources),
    firstSeen: minDate(data.dates),
    lastSeen: maxDate(data.dates),
  }));

  // ── Merge languages ──
  const langMap = new Map<string, { sources: string[]; dates: Date[] }>();
  for (const m of mentions) {
    for (const lang of (m.extracted.languages || [])) {
      if (!lang || typeof lang !== "string") continue;
      const key = lang.toLowerCase().trim();
      if (!key) continue;
      const existing = langMap.get(key);
      if (existing) {
        if (!existing.sources.includes(m.sourceUrl)) existing.sources.push(m.sourceUrl);
        existing.dates.push(m.fetchedAt);
      } else {
        langMap.set(key, { sources: [m.sourceUrl], dates: [m.fetchedAt] });
      }
    }
  }
  const languages: ScoredValue<string>[] = Array.from(langMap.entries()).map(([key, data]) => ({
    value: key.charAt(0).toUpperCase() + key.slice(1), // Capitalize
    confidence: computeConfidence(data.sources, data.dates),
    sources: realSources(data.sources),
    firstSeen: minDate(data.dates),
    lastSeen: maxDate(data.dates),
  }));

  // ── Overall confidence ──
  const overallConfidence = computeConfidence(
    mentions.map((m) => m.sourceUrl),
    mentions.map((m) => m.fetchedAt)
  );

  return {
    id: uuidv4(),
    names,
    experiences,
    skills,
    certifications,
    publications,
    awards,
    education,
    emails,
    phones,
    socialProfiles,
    locations,
    languages,
    bioSnippet,
    additionalFacts,
    sources,
    confidence: overallConfidence,
    createdAt: now,
    updatedAt: now,
  };
}
