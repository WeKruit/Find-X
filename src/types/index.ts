export type SearchMode = "person" | "criteria";

export interface SearchQuery {
  mode: SearchMode;
  name: string;       // Required for person mode; empty string for criteria mode
  context?: string;   // Freeform additional context for person mode
  criteria?: string;   // Freeform criteria for criteria mode: "Ex-Google engineers with startup ideas"
  maxResults?: number; // For criteria mode: how many candidates to return (default: 20)
}

export interface SearchSession {
  id: string;
  query: SearchQuery;
  status: "queued" | "searching" | "crawling" | "resolving" | "complete" | "failed";
  profiles: PersonProfile[];
  clusterData?: ClusterData[];
  crawlState: CrawlState;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}

export interface TokenUsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  llmCalls: number;
}

export interface CrawlState {
  pagesVisited: number;
  pageBudget: number;
  domainsVisited: Set<string>;
  urlsVisited: Set<string>;
  frontier: ScoredURL[];
  extractedMentions: PersonMention[];
  secondaryMentions: PersonMention[]; // Other people discovered during research
  events: CrawlEvent[];
  tokenUsage?: TokenUsageStats;
}

export interface ScoredURL {
  url: string;
  score: number;
  reason: string;
  depth: number;
  sourcePage: string;
  anchorText?: string;
}

export interface CrawlEvent {
  type: "search" | "fetch" | "extract" | "score" | "resolve" | "error" | "info";
  message: string;
  url?: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

export interface PersonMention {
  sourceUrl: string;
  fetchedAt: Date;
  confidence: number;
  extracted: ExtractedPersonData;
}

// ── Structured sub-types ──

export interface ExperienceEntry {
  title: string;
  company: string;
  isCurrent: boolean;
  startDate?: string;    // Store as-found: "2022-06", "2022", "June 2022", etc.
  endDate?: string;      // Omit or null when isCurrent is true
  location?: string;
  description?: string;  // Short role summary when page provides it
}

export interface SkillEntry {
  name: string;
  proficiency?: "beginner" | "intermediate" | "expert"; // Only set if explicitly stated
}

export interface PublicationEntry {
  title: string;
  venue?: string;        // "NeurIPS 2023", "arXiv", journal name
  year?: number;
  url?: string;
  coAuthors?: string[];
}

export interface AwardEntry {
  title: string;
  issuer?: string;
  year?: number;
}

export interface CertificationEntry {
  name: string;
  issuer?: string;       // "AWS", "Google", "Coursera"
  year?: number;
}

export interface ExtractedPersonData {
  names: string[];
  experiences: ExperienceEntry[];  // All work experiences; isCurrent=true marks the active role
  location?: string;
  education: EducationEntry[];
  skills: SkillEntry[];
  socialLinks: SocialLink[];
  emails: string[];
  phones: string[];
  bioSnippet?: string;
  relationships: Relationship[];
  dates: DateEvent[];
  /** Freeform facts that don't fit structured fields — projects, achievements, memberships, etc. */
  additionalFacts: string[];
  certifications: CertificationEntry[];
  publications: PublicationEntry[];
  awards: AwardEntry[];
  languages: string[];
}

export interface EducationEntry {
  institution: string;
  degree?: string;
  field?: string;
  year?: number;
}

export interface SocialLink {
  platform: string;
  url: string;
  username?: string;
}

export interface Relationship {
  name: string;
  relationship: string;
}

export interface DateEvent {
  event: string;
  date: string;
}

export interface PersonProfile {
  id: string;
  names: ScoredValue<string>[];

  // Professional
  experiences: ScoredValue<ExperienceEntry>[];
  skills: ScoredValue<SkillEntry>[];
  certifications: ScoredValue<CertificationEntry>[];
  publications: ScoredValue<PublicationEntry>[];
  awards: ScoredValue<AwardEntry>[];

  // Education
  education: ScoredValue<EducationEntry>[];

  // Contact
  emails: ScoredValue<string>[];
  phones: ScoredValue<string>[];
  socialProfiles: ScoredValue<SocialLink>[];

  // Personal
  locations: ScoredValue<{ city: string; country?: string; isCurrent: boolean }>[];
  languages: ScoredValue<string>[];

  // Narrative
  bioSnippet?: string;
  llmSummary?: string;
  additionalFacts: ScoredValue<string>[];

  photoUrl?: string;
  sources: SourceRecord[];
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScoredValue<T> {
  value: T;
  confidence: number;
  sources: string[];
  firstSeen: Date;
  lastSeen: Date;
}

export interface SourceRecord {
  url: string;
  fetchedAt: Date;
  sourceType: "search_result" | "social_profile" | "crawled_page";
  reliability: number;
  title?: string;
  relevanceScore?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
}

export interface PageContent {
  url: string;
  title: string;
  markdown: string;
  links: PageLink[];
  fetchedAt: Date;
  fetchMethod: "http" | "playwright" | "jina" | "firecrawl" | "snippet-only";
}

export interface PageLink {
  url: string;
  anchorText: string;
  context?: string;
}

// ── Criteria Search Types ──

export interface CriteriaDecomposition {
  keywords: string[];
  requiredTraits: string[];
  niceToHave: string[];
  searchQueries: string[];
  pageTypesToPrioritize: string[];
  exclusionSignals: string[];
  preferredDomains: string[];
  exclusionDomains: string[];
}

export interface CriteriaCandidate {
  id: string;
  name: string;
  title?: string;
  company?: string;
  location?: string;
  matchScore: number;
  matchReasoning: string;
  evidenceSnippet: string;
  sourceUrls: string[];
  additionalFacts: {
    education?: string;
    skills?: string[];
    socialUrl?: string;
    organizations?: string[];
  };
}

export interface CriteriaSearchSession {
  id: string;
  criteria: string;
  status: "searching" | "crawling" | "ranking" | "complete" | "failed";
  candidates: CriteriaCandidate[];
  crawlState: CrawlState;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}

// Cluster visualization data
export interface ClusterData {
  profileId: string;
  profileName: string;
  isPrimaryTarget: boolean;
  mentions: MentionSummary[];
}

export interface MentionSummary {
  sourceUrl: string;
  sourceDomain: string;
  confidence: number;
  names: string[];
  title?: string;
  company?: string;
  location?: string;
  factCount: number;
}

// Serializable version of CrawlState for API responses
export interface CrawlStateDTO {
  pagesVisited: number;
  pageBudget: number;
  domainsVisited: string[];
  urlsVisited: string[];
  events: CrawlEvent[];
  secondaryMentionCount: number;
  tokenUsage?: TokenUsageStats;
}

export interface SearchSessionDTO {
  id: string;
  query: SearchQuery;
  status: SearchSession["status"];
  profiles: PersonProfile[];
  clusterData?: ClusterData[];
  crawlState: CrawlStateDTO;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
