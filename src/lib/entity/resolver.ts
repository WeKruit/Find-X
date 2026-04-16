import type { PersonMention, SearchQuery } from "@/types";
import { llmDisambiguate, llmMatchNames, llmClusterMentions } from "@/lib/llm/client";

export type EntityCluster = {
  mentions: PersonMention[];
  isPrimaryTarget: boolean;
};

// ── TF-IDF Cosine Similarity Engine ──

/** Tokenize text into lowercased terms, filtering noise */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Build a text representation of a mention's context (everything except the name) */
function mentionToContextText(m: PersonMention): string {
  const parts: string[] = [];
  for (const exp of (m.extracted.experiences || [])) {
    if (exp.title) parts.push(exp.title);
    if (exp.company) parts.push(exp.company);
  }
  if (m.extracted.location) parts.push(m.extracted.location);
  if (m.extracted.bioSnippet) parts.push(m.extracted.bioSnippet);
  for (const edu of m.extracted.education) {
    parts.push(
      [edu.institution, edu.degree, edu.field].filter(Boolean).join(" ")
    );
  }
  for (const skill of (m.extracted.skills || [])) parts.push(skill.name);
  for (const rel of m.extracted.relationships)
    parts.push(`${rel.name} ${rel.relationship}`);
  for (const fact of m.extracted.additionalFacts.slice(0, 20)) parts.push(fact);
  return parts.join(" ");
}

/** Compute TF (term frequency) for a document */
function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  // Normalize by document length
  const len = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / len);
  }
  return tf;
}

/** Compute IDF (inverse document frequency) across all documents */
function computeIDF(docs: string[][]): Map<string, number> {
  const n = docs.length;
  const df = new Map<string, number>();
  for (const doc of docs) {
    const unique = new Set(doc);
    for (const term of unique) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((n + 1) / (count + 1)) + 1); // Smoothed IDF
  }
  return idf;
}

/** Compute cosine similarity from precomputed TF vectors and shared IDF */
function cosineSimilarityFromVectors(
  tfA: Map<string, number>,
  tfB: Map<string, number>,
  idf: Map<string, number>
): number {
  // Build term union without array spread to avoid two intermediate arrays.
  const allTerms = new Set<string>(tfA.keys());
  for (const k of tfB.keys()) allTerms.add(k);

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const term of allTerms) {
    const idfVal = idf.get(term) || 1;
    const a = (tfA.get(term) || 0) * idfVal;
    const b = (tfB.get(term) || 0) * idfVal;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Cosine similarity optimized for pairwise mention comparisons where all terms
 * in both TF vectors are guaranteed to be in the IDF map (same corpus).
 * Iterates the IDF map directly, eliminating per-pair Set allocation.
 * Only use this when both vectors come from the same tokenized document set.
 */
function cosineSimilarityPairwise(
  tfA: Map<string, number>,
  tfB: Map<string, number>,
  idf: Map<string, number>
): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, idfVal] of idf) {
    const a = (tfA.get(term) ?? 0) * idfVal;
    const b = (tfB.get(term) ?? 0) * idfVal;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compute TF-IDF cosine similarity between a query context string and a mention.
 */
function contextSimilarityToQuery(
  queryContext: string,
  mention: PersonMention,
  idf: Map<string, number>
): number {
  const queryTokens = tokenize(queryContext);
  const mentionTokens = tokenize(mentionToContextText(mention));
  if (queryTokens.length === 0 || mentionTokens.length === 0) return 0;
  return cosineSimilarityFromVectors(computeTF(queryTokens), computeTF(mentionTokens), idf);
}

// ── Jaro-Winkler String Similarity ──

export function jaroWinkler(s1: string, s2: string): number {
  const a = s1.toLowerCase();
  const b = s2.toLowerCase();

  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);

    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler's prefix bonus
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Compare two name strings with both Jaro-Winkler AND word-containment.
 * Handles cases like "Zelin Noah Liu" vs "Noah Liu" where JW alone fails
 * due to prefix mismatch, but the query name is clearly contained.
 */
export function nameScore(a: string, b: string): number {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return 0;

  // Exact match
  if (al === bl) return 1.0;

  const wordsA = al.split(/\s+/);
  const wordsB = bl.split(/\s+/);

  // Word-set match: same words in different order (e.g. "Zelin Noah Liu" vs "Noah Zelin Liu").
  // Only for 3+ word names — distinctive enough that false positives are negligible.
  // Returns 0.93 (not 0.95) so it stays below the zero-context guard threshold (0.95)
  // but still merges with the lowered CLUSTERING_THRESHOLD (0.47).
  if (wordsA.length >= 3 && wordsA.length === wordsB.length) {
    const setBa = new Set(wordsB);
    if (wordsA.every(w => setBa.has(w))) return 0.93;
  }

  // 2-word set match: handles reversed 2-word names ("John Smith" vs "Smith John").
  // Lower score (0.90) because 2-word set overlap is less distinctive than 3+ words.
  if (wordsA.length === 2 && wordsB.length === 2) {
    const setA = new Set(wordsA);
    if (wordsB.every(w => setA.has(w))) return 0.90;
  }

  // Word-containment check: if all words of the shorter name appear
  // in order within the longer name, it's a strong match.
  // "Noah Liu" contained in "Zelin Noah Liu" → 0.90+
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;

  if (shorter.length >= 2) {
    // Check if all words of the shorter name appear in the longer name (in order)
    let idx = 0;
    let allFound = true;
    for (const word of shorter) {
      const found = longer.indexOf(word, idx);
      if (found === -1) {
        allFound = false;
        break;
      }
      idx = found + 1;
    }
    if (allFound) {
      // All words of shorter name found in order in longer name
      // Score based on how much of the longer name is covered
      const coverage = shorter.length / longer.length;
      return Math.max(0.90, coverage); // At least 0.90 for containment
    }
  }

  // Fall back to Jaro-Winkler
  return jaroWinkler(a, b);
}

/** Best name score between any pair of names from two mentions (capped at 5 each) */
function bestNameSimilarity(namesA: string[], namesB: string[]): number {
  let best = 0;
  const capA = namesA.slice(0, 5);
  const capB = namesB.slice(0, 5);
  for (const a of capA) {
    if (!a || typeof a !== "string") continue;
    for (const b of capB) {
      if (!b || typeof b !== "string") continue;
      const score = nameScore(a.trim(), b.trim());
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Check if any name in a mention closely matches the query name.
 * If llmScores are provided (from llmMatchNames), uses those for semantic matching
 * (handles nicknames, transliterations, cultural naming patterns).
 * Falls back to string-based nameScore if no LLM scores available.
 */
export function bestNameMatchToQuery(
  mention: PersonMention,
  queryName: string,
  llmScores?: Map<string, number>
): number {
  let best = 0;
  for (const name of mention.extracted.names.slice(0, 5)) {
    if (!name || typeof name !== "string") continue;
    const trimmed = name.trim();

    // Use LLM score if available, fall back to string-based score
    let score: number;
    if (llmScores && llmScores.has(trimmed)) {
      score = llmScores.get(trimmed)!;
    } else {
      score = nameScore(trimmed, queryName.trim());
    }

    if (score > best) best = score;
  }
  return best;
}

// ── Abbreviation / Acronym Matching ──

/** Prepositions/articles to skip when matching acronyms against full names */
const SKIP_WORDS = new Set(["of", "the", "and", "at", "in", "for", "a", "an"]);

/**
 * Check if a short string is an acronym/abbreviation of a longer string.
 * e.g., "USC" matches "University of Southern California"
 *       "MIT" matches "Massachusetts Institute of Technology"
 * Returns true if the acronym letters match the initials of significant words.
 */
function isAcronymOf(short: string, long: string): boolean {
  if (short.length < 2 || short.length > 6) return false;
  const letters = short.toLowerCase().split("");
  const words = long.toLowerCase().split(/\s+/).filter((w) => !SKIP_WORDS.has(w));
  if (letters.length > words.length) return false;
  // Check if acronym letters match initial letters of consecutive words
  let wi = 0;
  for (const letter of letters) {
    while (wi < words.length && words[wi][0] !== letter) wi++;
    if (wi >= words.length) return false;
    wi++;
  }
  return true;
}

/**
 * Compare two institution names with acronym awareness.
 * Falls back to Jaro-Winkler if no acronym match is detected.
 */
function institutionSimilarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1.0;

  // Check if one is an acronym of the other
  const aWords = al.split(/\s+/);
  const bWords = bl.split(/\s+/);
  if (aWords.length === 1 && bWords.length > 1 && isAcronymOf(al, bl)) return 0.95;
  if (bWords.length === 1 && aWords.length > 1 && isAcronymOf(bl, al)) return 0.95;

  return jaroWinkler(a, b);
}

// ── Field Mismatch Detection ──

/**
 * Compute penalty for explicitly contradictory structured fields between two mentions.
 * When both mentions have a field filled but the values are completely different,
 * it's a strong signal they're different people (e.g., different companies, schools, locations).
 *
 * Penalty weights (empirically tuned):
 * - Company mismatch (0.25): strongest signal — people rarely share name + different company
 * - Education mismatch (0.20): strong signal — different schools almost always means different person
 * - Location mismatch (0.15): weaker — people move, but different state/country is informative
 * Total capped at 0.50 to prevent triple-mismatch from being insurmountable.
 */
function computeFieldMismatch(a: PersonMention, b: PersonMention): number {
  let penalty = 0;

  // Company mismatch: compare ALL companies from both mentions.
  // Only penalize when BOTH have at least one company AND there is NO overlap at all.
  // This avoids false mismatches when a person has worked at multiple companies
  // (e.g., A has [AWS(current), Google(past)] and B has [Google(current)] → shared Google → no penalty).
  const aCompanies = (a.extracted.experiences || []).map(e => e.company).filter((c): c is string => !!c && c.trim().length > 0);
  const bCompanies = (b.extracted.experiences || []).map(e => e.company).filter((c): c is string => !!c && c.trim().length > 0);
  if (aCompanies.length > 0 && bCompanies.length > 0) {
    const hasAnyOverlap = aCompanies.some(ac =>
      bCompanies.some(bc => jaroWinkler(ac.toLowerCase(), bc.toLowerCase()) >= 0.85)
    );
    if (!hasAnyOverlap) {
      penalty += 0.30; // No common employer → strong mismatch signal
    }
  }

  // Education mismatch: different schools = strong signal of different people.
  const INSTITUTION_RE = /university|college|institute|school|academy/i;
  const aSchools = a.extracted.education.map(e => e.institution).filter(Boolean);
  const bSchools = b.extracted.education.map(e => e.institution).filter(Boolean);
  // Only add institution-like employers if there are no real education entries
  // (avoids false positives from company names that contain "university" etc.)
  if (aSchools.length === 0) {
    const aEduCompany = aCompanies.find(c => INSTITUTION_RE.test(c));
    if (aEduCompany) aSchools.push(aEduCompany);
  }
  if (bSchools.length === 0) {
    const bEduCompany = bCompanies.find(c => INSTITUTION_RE.test(c));
    if (bEduCompany) bSchools.push(bEduCompany);
  }
  if (aSchools.length > 0 && bSchools.length > 0) {
    const hasOverlap = aSchools.some(s => bSchools.some(t => institutionSimilarity(s, t) > 0.7));
    if (!hasOverlap) penalty += 0.20;
  }

  // Location mismatch: both have locations, and they're in different states/regions
  if (a.extracted.location && b.extracted.location) {
    if (jaroWinkler(a.extracted.location.toLowerCase(), b.extracted.location.toLowerCase()) < 0.5) {
      penalty += 0.15;
    }
  }

  // Cap total penalty to prevent triple-mismatch from being insurmountable.
  // Even with all three fields contradicting, a strong context overlap or
  // shared connections should still have a chance to merge.
  return Math.min(penalty, 0.50);
}

// ── Graph-Based Clustering ──

type SimilarityEdge = {
  i: number;
  j: number;
  nameSim: number;
  contextSim: number;
  combined: number;
};

// ── Clustering & Target Thresholds ──
// Name similarity gate: minimum JW score to even consider two mentions as potentially the same person
const NAME_GATE = 0.85;
// Minimum name match to query for a cluster to qualify as primary target
const NAME_MATCH_FOR_PRIMARY = 0.85;
// Union-Find clustering threshold
const CLUSTERING_THRESHOLD = 0.47;
// Leiden split cohesion threshold — kept low to avoid over-splitting same-person mentions
// that have different "aspects" (one page mentions school, another mentions company)
const COHESION_THRESHOLD = 0.42;

/**
 * Extract the LinkedIn username from a URL.
 * Handles both profile URLs (/in/username) and post URLs (/posts/username_activityverb-...).
 */
function getLinkedInUsernameFromUrl(url: string): string | null {
  // Profile URL: linkedin.com/in/username
  const profileMatch = url.match(/linkedin\.com\/in\/([a-zA-Z0-9-]+)/i);
  if (profileMatch) return profileMatch[1].toLowerCase();
  // Post URL: linkedin.com/posts/username_activityword-... (username ends before _lowercase)
  const postMatch = url.match(/linkedin\.com\/posts\/([a-zA-Z0-9-]+)(?:_[a-z]|$)/i);
  if (postMatch) return postMatch[1].toLowerCase();
  return null;
}

/**
 * Build a pairwise similarity graph over mentions.
 * Each edge has name similarity (Jaro-Winkler) and context similarity (TF-IDF cosine).
 * TF vectors are precomputed once, not per-pair.
 */
function buildSimilarityGraph(
  mentions: PersonMention[]
): { edges: SimilarityEdge[]; idf: Map<string, number> } {
  // Precompute tokenized context, TF vectors, and IDF for all mentions
  const tokenizedDocs = mentions.map((m) => tokenize(mentionToContextText(m)));
  const idf = computeIDF(tokenizedDocs);
  const tfVectors = tokenizedDocs.map(computeTF);

  // Precompute relationship names per mention for shared-connection matching
  const relationshipNames = mentions.map((m) =>
    m.extracted.relationships.map((r) => r.name.toLowerCase().trim()).filter((n) => n.length > 2)
  );

  const edges: SimilarityEdge[] = [];

  for (let i = 0; i < mentions.length; i++) {
    for (let j = i + 1; j < mentions.length; j++) {
      const nameSim = bestNameSimilarity(
        mentions[i].extracted.names,
        mentions[j].extracted.names
      );

      // Only compute context similarity if names are sufficiently similar
      if (nameSim < NAME_GATE) continue;

      // LinkedIn username check — from source URL (handles both /in/ profiles and /posts/ post URLs)
      const liUsernameA = getLinkedInUsernameFromUrl(mentions[i].sourceUrl);
      const liUsernameB = getLinkedInUsernameFromUrl(mentions[j].sourceUrl);
      if (liUsernameA && liUsernameB) {
        if (liUsernameA === liUsernameB) {
          // Same LinkedIn user → force-merge: posts and profile from the same person
          edges.push({ i, j, nameSim, contextSim: 1.0, combined: 1.0 });
          continue;
        } else {
          // Different LinkedIn users → definitively different people
          continue;
        }
      } else if (liUsernameA || liUsernameB) {
        // One mention is from a LinkedIn URL — cross-check the username against the
        // other mention's extracted names. LinkedIn usernames are constructed from real
        // names (e.g. "zelin-noah-liu"), so a high nameScore here is a strong signal.
        const singleLiUser = (liUsernameA || liUsernameB)!;
        const otherMentionIdx = liUsernameA ? j : i;
        const otherNames = mentions[otherMentionIdx].extracted.names;
        const liDisplayName = singleLiUser.replace(/-/g, " "); // "zelin-noah-liu" → "zelin noah liu"
        const usernameMatchesName = otherNames.some(
          (n) => typeof n === "string" && nameScore(n.trim(), liDisplayName) >= 0.95
        );
        if (usernameMatchesName) {
          // LinkedIn username matches the other mention's full name → strong same-person signal
          edges.push({ i, j, nameSim, contextSim: 1.0, combined: 1.0 });
          continue;
        }

        // Cross-check: does the other mention have an extracted LinkedIn link that
        // conflicts with this source URL's LinkedIn username?
        const otherLiLink = mentions[otherMentionIdx].extracted.socialLinks.find(l => l.platform === "LinkedIn");
        if (otherLiLink) {
          const otherLiUsername = (otherLiLink.username || otherLiLink.url.match(/\/in\/([^/?#]+)/i)?.[1] || "").toLowerCase();
          if (otherLiUsername && otherLiUsername !== singleLiUser) {
            continue; // Definitively different people: different LinkedIn profiles
          }
          if (otherLiUsername && otherLiUsername === singleLiUser) {
            // Confirmed same LinkedIn profile → force merge
            edges.push({ i, j, nameSim, contextSim: 1.0, combined: 1.0 });
            continue;
          }
        }

        // LinkedIn disambiguation hash detection:
        // When LinkedIn can't assign the clean "firstname-lastname" URL (already taken),
        // it appends a long numeric ID (e.g. "alexander-gu-964140144") or an 8-char
        // hex hash (e.g. "alexander-gu-a5762b44"). These always mean a DIFFERENT person
        // with the same common name. If the hash-bearing username didn't match by name
        // or social link, skip — don't let context similarity cause a false merge.
        const hasLinkedInDisambigHash = /(?:^|-)[0-9a-f]{8,}$/.test(singleLiUser.toLowerCase());
        if (hasLinkedInDisambigHash) {
          continue; // Auto-disambiguated LinkedIn profile → definitively different person
        }
      }

      // Also check extracted social links for LinkedIn URL conflicts
      const liA = mentions[i].extracted.socialLinks.find(l => l.platform === "LinkedIn");
      const liB = mentions[j].extracted.socialLinks.find(l => l.platform === "LinkedIn");
      if (liA && liB) {
        const usernameA = (liA.username || liA.url.match(/\/in\/([^/?#]+)/i)?.[1] || "").toLowerCase();
        const usernameB = (liB.username || liB.url.match(/\/in\/([^/?#]+)/i)?.[1] || "").toLowerCase();
        if (usernameA && usernameB && usernameA !== usernameB) {
          continue; // Definitively different people
        }
      }

      const contextSim = cosineSimilarityPairwise(tfVectors[i], tfVectors[j], idf);

      // Shared connection bonus: if two mentions share a relationship with
      // the same named person, it's a strong signal they're the same person.
      // Computed once and reused for both the zero-context guard and the scoring formula.
      let connectionBonus = 0;
      if (relationshipNames[i].length > 0 && relationshipNames[j].length > 0) {
        for (const nameA of relationshipNames[i]) {
          for (const nameB of relationshipNames[j]) {
            if (jaroWinkler(nameA, nameB) >= 0.85) {
              connectionBonus = 0.10;
              break;
            }
          }
          if (connectionBonus > 0) break;
        }
      }

      // CRITICAL: Common names (exact match or near-exact) with very low context
      // overlap are likely DIFFERENT people. "Noah Liu" the powerlifter and
      // "Noah Liu" the Kaggle user share a name but nothing else.
      // Without shared connections, don't merge low-context same-name mentions.
      // Threshold raised from 0.05 to 0.12: even small shared vocabulary (CS terms)
      // is not enough to confirm two common-name people are the same individual.
      // Exception: if both have the same company name, it's a strong positive signal.
      const iComp = (mentions[i].extracted.experiences || [])[0]?.company;
      const jComp = (mentions[j].extracted.experiences || [])[0]?.company;
      const sameCompany =
        !!iComp && !!jComp &&
        jaroWinkler(iComp.toLowerCase(), jComp.toLowerCase()) >= 0.85;
      if (nameSim >= 0.95 && contextSim < 0.12 && connectionBonus === 0 && !sameCompany) {
        continue;
      }

      // Field-level mismatch penalty: when structured fields explicitly contradict,
      // apply hard penalties to prevent merging different people with the same name
      const fieldMismatch = computeFieldMismatch(mentions[i], mentions[j]);

      // Combined score: name-dominant weighting
      // Name similarity is the primary signal; context and connections are secondary
      const combined = nameSim * 0.50 + contextSim * 0.35 + connectionBonus - fieldMismatch;

      edges.push({ i, j, nameSim, contextSim, combined });
    }
  }

  return { edges, idf };
}

/**
 * Find connected components using Union-Find on a local index space [0..n).
 */
function findConnectedComponents(
  n: number,
  edges: { a: number; b: number; combined: number }[],
  threshold: number
): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);

  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  function union(x: number, y: number) {
    const px = find(x);
    const py = find(y);
    if (px === py) return;
    if (rank[px] < rank[py]) {
      parent[px] = py;
    } else if (rank[px] > rank[py]) {
      parent[py] = px;
    } else {
      parent[py] = px;
      rank[px]++;
    }
  }

  for (const edge of edges) {
    if (edge.combined >= threshold) {
      union(edge.a, edge.b);
    }
  }

  // Normalize parents
  for (let i = 0; i < n; i++) find(i);
  return parent;
}

/**
 * Split clusters that have low internal cohesion.
 * Inspired by Leiden: if a cluster's average internal similarity is below
 * a threshold, split it by removing the weakest links.
 *
 * Uses local index remapping to avoid allocating global-sized arrays.
 */
function splitWeakClusters(
  clusters: Map<number, number[]>,
  edges: SimilarityEdge[],
  minCohesion: number
): Map<number, number[]> {
  // Pre-index edges by node for efficient internal edge lookup
  const edgeIndex = new Map<number, SimilarityEdge[]>();
  for (const e of edges) {
    if (!edgeIndex.has(e.i)) edgeIndex.set(e.i, []);
    if (!edgeIndex.has(e.j)) edgeIndex.set(e.j, []);
    edgeIndex.get(e.i)!.push(e);
    edgeIndex.get(e.j)!.push(e);
  }

  const result = new Map<number, number[]>();
  let nextId = 0;

  for (const [, members] of clusters) {
    if (members.length <= 1) {
      result.set(nextId++, members);
      continue;
    }

    // Find internal edges efficiently via index
    const memberSet = new Set(members);
    const internalEdges: SimilarityEdge[] = [];
    const seenEdges = new Set<string>();
    for (const m of members) {
      for (const e of edgeIndex.get(m) || []) {
        if (memberSet.has(e.i) && memberSet.has(e.j)) {
          const key = `${Math.min(e.i, e.j)}-${Math.max(e.i, e.j)}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            internalEdges.push(e);
          }
        }
      }
    }

    if (internalEdges.length === 0) {
      // No edges between members — split into singletons
      for (const m of members) {
        result.set(nextId++, [m]);
      }
      continue;
    }

    const avgSimilarity =
      internalEdges.reduce((sum, e) => sum + e.combined, 0) /
      internalEdges.length;

    if (avgSimilarity >= minCohesion) {
      result.set(nextId++, members);
    } else {
      // Re-cluster with local index remapping
      const globalToLocal = new Map<number, number>();
      const localToGlobal: number[] = [];
      for (const m of members) {
        globalToLocal.set(m, localToGlobal.length);
        localToGlobal.push(m);
      }

      const localEdges = internalEdges.map((e) => ({
        a: globalToLocal.get(e.i)!,
        b: globalToLocal.get(e.j)!,
        combined: e.combined,
      }));

      const subParent = findConnectedComponents(
        members.length,
        localEdges,
        CLUSTERING_THRESHOLD
      );

      const subClusters = new Map<number, number[]>();
      for (let local = 0; local < members.length; local++) {
        const root = subParent[local];
        if (!subClusters.has(root)) subClusters.set(root, []);
        subClusters.get(root)!.push(localToGlobal[local]);
      }

      for (const [, subMembers] of subClusters) {
        result.set(nextId++, subMembers);
      }
    }
  }

  return result;
}

// ── Main Resolution Pipeline ──

const MAX_MENTIONS = 500;

/**
 * Resolve extracted mentions into identity clusters.
 *
 * Pipeline:
 * 1. Build pairwise similarity graph (Jaro-Winkler names + TF-IDF cosine context)
 * 2. Find connected components via Union-Find
 * 3. Split weak clusters (Leiden-inspired cohesion check)
 * 4. Score each cluster against the query to identify primary target
 * 5. Hard name-match gate: cluster must contain a near-exact name match to be primary
 * 6. LLM disambiguation for ambiguous cases
 * 7. LLM near-miss check: absorb singletons/small clusters that are name-similar
 *    to the primary but had too-low context overlap to merge algorithmically.
 *    Uses llmClusterMentions (query-context-aware) instead of llmDisambiguate
 *    to correctly handle cases where the primary has USC context but the near-miss
 *    has WeKruit/startup context — single LLM call for all near-miss candidates.
 */
export async function resolveEntities(
  mentions: PersonMention[],
  query: SearchQuery,
  precomputedLlmScores?: Map<string, number>
): Promise<EntityCluster[]> {
  if (mentions.length === 0) return [];

  // Dedup by sourceUrl — keep the highest-confidence mention for each URL.
  // Duplicate URLs arise when the same page appears in multiple search queries
  // (e.g., LinkedIn profile fetched for both name + context queries).
  const seenUrls = new Map<string, PersonMention>();
  for (const m of mentions) {
    const existing = seenUrls.get(m.sourceUrl);
    if (!existing || m.confidence > existing.confidence) {
      seenUrls.set(m.sourceUrl, m);
    }
  }
  const dedupedMentions = [...seenUrls.values()];

  if (dedupedMentions.length === 1) {
    const nameMatch = bestNameMatchToQuery(dedupedMentions[0], query.name);
    const isPrimary = nameMatch >= NAME_MATCH_FOR_PRIMARY && dedupedMentions[0].confidence >= 0.4;
    return [{ mentions: dedupedMentions, isPrimaryTarget: isPrimary }];
  }

  // Guard against excessive mention count (O(N^2) pairwise comparison)
  let workingMentions = dedupedMentions;
  if (dedupedMentions.length > MAX_MENTIONS) {
    workingMentions = dedupedMentions
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_MENTIONS);
  }

  // Step 1: Build similarity graph (TF vectors precomputed, not per-pair)
  const { edges, idf } = buildSimilarityGraph(workingMentions);

  // Step 2: Find connected components (initial clustering)
  const globalEdges = edges.map((e) => ({ a: e.i, b: e.j, combined: e.combined }));
  const parent = findConnectedComponents(workingMentions.length, globalEdges, CLUSTERING_THRESHOLD);

  // Group into clusters
  const initialClusters = new Map<number, number[]>();
  for (let i = 0; i < workingMentions.length; i++) {
    const root = parent[i];
    if (!initialClusters.has(root)) initialClusters.set(root, []);
    initialClusters.get(root)!.push(i);
  }

  // Step 3: Split weak clusters (Leiden-inspired)
  const refinedClusters = splitWeakClusters(
    initialClusters,
    edges,
    COHESION_THRESHOLD
  );

  // Step 3.5: LLM-based name matching for target identification
  // Collect all unique names from all mentions and ask the LLM once
  // whether each could refer to the query name (handles nicknames, etc.)
  const allNames = new Set<string>();
  for (const m of workingMentions) {
    for (const name of m.extracted.names.slice(0, 5)) {
      if (name && typeof name === "string") allNames.add(name.trim());
    }
  }

  // Use pre-computed scores if provided (from IncrementalResolver's cache),
  // otherwise make a fresh LLM call. This avoids redundant API calls when
  // the caller already has cached scores.
  let llmNameScores: Map<string, number> | undefined;
  if (precomputedLlmScores && precomputedLlmScores.size > 0) {
    llmNameScores = precomputedLlmScores;
  } else {
    try {
      llmNameScores = await llmMatchNames(query.name, query.context, [...allNames]);
    } catch {
      // If LLM call fails, fall back to string-based matching
      llmNameScores = undefined;
    }
  }

  // Step 4: Score each cluster against the query
  const scoredClusters = Array.from(refinedClusters.entries()).map(
    ([id, memberIndices]) => {
      const clusterMentions = memberIndices.map((i) => workingMentions[i]);
      const targetScore = scoreClusterTargetMatch(clusterMentions, query, idf, llmNameScores);
      // Hard gate: check if ANY mention in the cluster has a name match to the query
      const bestNameMatch = Math.max(
        ...clusterMentions.map((m) => bestNameMatchToQuery(m, query.name, llmNameScores))
      );
      return { id, mentions: clusterMentions, targetScore, bestNameMatch };
    }
  );

  scoredClusters.sort((a, b) => b.targetScore - a.targetScore);

  // Step 5: Determine primary target + handle ambiguous clusters
  // Hard gate: cluster MUST have at least one mention with a strong name match
  const targetThreshold = query.context ? 0.45 : 0.40;
  const ambiguousThreshold = query.context ? 0.30 : 0.25;

  const primaryCandidates = scoredClusters.filter(
    (c) => c.targetScore >= targetThreshold && c.bestNameMatch >= NAME_MATCH_FOR_PRIMARY
  );
  const ambiguous = scoredClusters.filter(
    (c) =>
      c.targetScore >= ambiguousThreshold &&
      c.targetScore < targetThreshold &&
      c.bestNameMatch >= NAME_MATCH_FOR_PRIMARY
  );
  const nonTarget = scoredClusters.filter(
    (c) => c.targetScore < ambiguousThreshold || c.bestNameMatch < NAME_MATCH_FOR_PRIMARY
  );

  // LLM disambiguation for ambiguous clusters against each primary candidate.
  // All (amb × primary) pairs are run in parallel, then the best match per ambiguous
  // cluster is selected. This replaces the prior nested sequential await loop.
  if (ambiguous.length > 0 && primaryCandidates.length > 0) {
    type DisambigTask = { ambIdx: number; primaryIdx: number };
    const tasks: DisambigTask[] = ambiguous.flatMap((_, ambIdx) =>
      primaryCandidates.map((_, primaryIdx) => ({ ambIdx, primaryIdx }))
    );

    const disambigResults = await Promise.all(
      tasks.map(({ ambIdx, primaryIdx }) =>
        llmDisambiguate(
          mentionToDisambiguateInput(selectRichestMention(primaryCandidates[primaryIdx].mentions)),
          mentionToDisambiguateInput(selectRichestMention(ambiguous[ambIdx].mentions)),
          query
        )
      )
    );

    for (let ambIdx = 0; ambIdx < ambiguous.length; ambIdx++) {
      const amb = ambiguous[ambIdx];
      let bestMatchIdx = -1;
      let bestMatchConf = 0;

      for (let primaryIdx = 0; primaryIdx < primaryCandidates.length; primaryIdx++) {
        const result = disambigResults[ambIdx * primaryCandidates.length + primaryIdx];
        if (result.samePerson === true && result.confidence >= 0.7 && result.confidence > bestMatchConf) {
          bestMatchIdx = primaryIdx;
          bestMatchConf = result.confidence;
        }
      }

      if (bestMatchIdx >= 0) {
        primaryCandidates[bestMatchIdx] = {
          ...primaryCandidates[bestMatchIdx],
          mentions: [...primaryCandidates[bestMatchIdx].mentions, ...amb.mentions],
        };
      } else {
        nonTarget.push(amb);
      }
    }
  } else if (ambiguous.length > 0 && primaryCandidates.length === 0) {
    // No clear primary — don't auto-promote. Put ambiguous into non-target.
    // The user searched for a specific person; if we can't confidently identify them,
    // it's better to show no primary than to guess wrong.
    nonTarget.push(...ambiguous);
  }

  // Step 6: LLM near-miss absorption
  // Clusters that didn't reach the ambiguous threshold but are name-similar to the
  // primary (nameSim >= NAME_GATE) may still be the same person — the algorithmic
  // approach failed due to zero context overlap (e.g. WeKruit mentions have no USC
  // keywords). Use llmClusterMentions (query-context-aware, includes LinkedIn
  // username cross-checking) to adjudicate all near-miss candidates in one call.
  if (primaryCandidates.length > 0) {
    const primary = primaryCandidates[0];
    const stillNonTarget: typeof nonTarget = [];

    const nearMissNonTargets = nonTarget.filter((cluster) => {
      // Only consider if any mention has a name similar enough to any primary mention
      const anyPrimaryNames = primary.mentions.flatMap((m) => m.extracted.names);
      return cluster.mentions.some((m) =>
        m.extracted.names.some((n) =>
          anyPrimaryNames.some((pn) => bestNameSimilarity([n], [pn]) >= NAME_GATE)
        )
      );
    });

    const clearNonTargets = nonTarget.filter((c) => !nearMissNonTargets.includes(c));

    if (nearMissNonTargets.length > 0) {
      // Pick the "richest" primary mention as representative — the one with the most
      // identifying information (LinkedIn URL > social link > company + education > confidence).
      // This gives the LLM the best discriminating context, not just the most confident mention.
      const primaryRep = selectRichestMention(primary.mentions);

      // Build candidate list: [primaryRep (idx 0), one rep per near-miss cluster (idx 1..N)]
      const candidates: PersonMention[] = [primaryRep];
      const nearMissReps = nearMissNonTargets.map((c) => selectRichestMention(c.mentions));
      candidates.push(...nearMissReps);

      // Single LLM call with query context — the prompt exposes LinkedIn @username
      // and the query name+context, giving the LLM enough signal to identify
      // "zelin-noah-liu" (@linkedin) == "Noah Liu" (whitebridge.ai, Co-Founder @ WeKruit).
      const clusterResult = await llmClusterMentions(candidates, query);

      if (clusterResult) {
        // Find the group that contains the primary representative (idx 0) and is the target
        const targetGroup = clusterResult.find((g) => g.isTarget && g.ids.includes(0));
        if (targetGroup) {
          for (let i = 0; i < nearMissNonTargets.length; i++) {
            // candidate index i+1 corresponds to nearMissNonTargets[i]
            if (targetGroup.ids.includes(i + 1)) {
              primary.mentions = [...primary.mentions, ...nearMissNonTargets[i].mentions];
            } else {
              stillNonTarget.push(nearMissNonTargets[i]);
            }
          }
        } else {
          // Primary rep not classified as target — unexpected; keep near-misses separate
          stillNonTarget.push(...nearMissNonTargets);
        }
      } else {
        // LLM call failed — keep near-misses as non-target (don't merge on uncertainty)
        stillNonTarget.push(...nearMissNonTargets);
      }
    }

    nonTarget.length = 0;
    nonTarget.push(...clearNonTargets, ...stillNonTarget);
  }

  // Step 8: Build final clusters
  const results: EntityCluster[] = [];

  for (const candidate of primaryCandidates) {
    results.push({
      mentions: candidate.mentions,
      isPrimaryTarget: true,
    });
  }

  for (const cluster of nonTarget) {
    results.push({
      mentions: cluster.mentions,
      isPrimaryTarget: false,
    });
  }

  return results;
}

/**
 * Score how well a cluster of mentions matches the target query.
 * Name similarity is the dominant signal; context is secondary.
 * If llmScores are provided, uses LLM-based name matching (handles nicknames, etc.)
 *
 * Scoring weights:
 * - Name match: up to 0.50 (dominant signal, gated by NAME_MATCH_FOR_PRIMARY)
 * - Context match: up to 0.35 (TF-IDF cosine similarity with query context)
 * - No-context penalty: -0.10 (when name matches but context doesn't overlap)
 * - Confidence factor: scales score by 0.5 + 0.5 * mention.confidence
 * - Corroboration bonus: up to 0.05 for multiple mentions
 */
export function scoreClusterTargetMatch(
  clusterMentions: PersonMention[],
  query: SearchQuery,
  idf?: Map<string, number>,
  llmScores?: Map<string, number>
): number {
  // If no IDF map provided (e.g., cold-start), build a minimal one from the cluster
  const effectiveIdf = idf ?? computeIDF(
    clusterMentions.map((m) => tokenize(mentionToContextText(m)))
  );

  // Precompute context acronym once (e.g. "usc" for "University of Southern California")
  let contextAcronymRe: RegExp | null = null;
  if (query.context) {
    const acronym = query.context
      .split(/\s+/)
      .filter(w => /^[A-Z]/.test(w))
      .map(w => w[0])
      .join("")
      .toLowerCase();
    if (acronym.length >= 2) {
      contextAcronymRe = new RegExp(`\\b${acronym}\\b`, "i");
    }
  }

  let bestScore = 0;

  for (const m of clusterMentions) {
    let score = 0;

    // Name match — uses LLM scores when available, falls back to string-based
    const nameMatchScore = bestNameMatchToQuery(m, query.name, llmScores);

    // Name must be strongly similar — this is the primary filter
    if (nameMatchScore < NAME_MATCH_FOR_PRIMARY) continue;

    // Name contribution is the dominant signal (up to 0.5)
    score += nameMatchScore * 0.5;

    // Context matching via TF-IDF cosine similarity + acronym fallback
    if (query.context) {
      const contextSim = contextSimilarityToQuery(query.context, m, effectiveIdf);

      // Also check if the mention's context text contains the acronym of the query context
      // (e.g. "USC" matching "University of Southern California"). TF-IDF misses this
      // because "usc" ≠ "university"/"southern"/"california" at the token level.
      const mentionText = mentionToContextText(m);
      const hasAcronym = contextAcronymRe != null && contextAcronymRe.test(mentionText);

      if (contextSim > 0.1 || hasAcronym) {
        // Boost for semantic context match — up to 0.35
        // Acronym match alone gets a moderate boost (0.15), full token overlap gets up to 0.35
        score += hasAcronym && contextSim <= 0.1
          ? 0.15
          : Math.min(0.35, contextSim * 0.5);
      } else {
        // Zero context overlap — penalize regardless of name match strength.
        // An exact name match ("Noah Liu") with no USC content is still the
        // wrong person. Without this, athletes/professionals with the same name
        // pass the PRIMARY threshold purely on name score.
        score -= 0.20;
      }

      // Education context mismatch: if the query mentions a specific school
      // and the mention has education at a DIFFERENT school, penalize.
      // Prevents "Cal Poly" or "UChicago" clusters from being marked PRIMARY
      // when searching for someone at "University of Southern California".
      if (m.extracted.education.length > 0 && /university|college|institute|school/i.test(query.context)) {
        const hasMatchingEdu = m.extracted.education.some(e =>
          institutionSimilarity(e.institution, query.context!) > 0.7
        );
        if (!hasMatchingEdu) {
          score -= 0.15;
        }
      }
    }

    // Extraction confidence factor
    score *= 0.5 + 0.5 * m.confidence;

    if (score > bestScore) bestScore = score;
  }

  // Corroboration bonus: more mentions = more confident (but smaller)
  const corroborationBoost = Math.min(0.05, clusterMentions.length * 0.01);

  return Math.max(0, Math.min(bestScore + corroborationBoost, 1.0));
}

function mentionToDisambiguateInput(mention: PersonMention) {
  const exps = mention.extracted.experiences || [];
  const currentExp = exps.find(e => e.isCurrent) ?? exps[0];
  // Aggregate all companies across experiences for richer context
  const allCompanies = [...new Set(exps.map(e => e.company).filter(Boolean))].join(", ");
  return {
    url: mention.sourceUrl,
    name: mention.extracted.names[0] || "Unknown",
    title: currentExp?.title,
    company: allCompanies || undefined,
    location: mention.extracted.location,
    details: [
      mention.extracted.bioSnippet,
      mention.extracted.education.map((e) => e.institution).join(", "),
      (mention.extracted.skills || []).slice(0, 5).map((s) => s.name).join(", "),
    ]
      .filter(Boolean)
      .join("; "),
  };
}

/**
 * Select the "richest" mention from a list — the one with the most identifying
 * information for LLM disambiguation. Prefers:
 *  1. Mentions with a LinkedIn profile URL (globally unique identifier)
 *  2. Mentions with more structured fields (company + education)
 *  3. Highest extraction confidence as tiebreaker
 */
function selectRichestMention(mentions: PersonMention[]): PersonMention {
  return mentions.reduce((best, m) => {
    const richness = (score: PersonMention) => {
      const hasLinkedIn = /linkedin\.com\/in\//i.test(score.sourceUrl) ? 4 : 0;
      const hasSocialLink = score.extracted.socialLinks.some(l => l.platform === "LinkedIn") ? 2 : 0;
      const hasCompany = (score.extracted.experiences || []).some(e => e.company) ? 2 : 0;
      const hasEducation = score.extracted.education.length > 0 ? 1 : 0;
      const hasBio = score.extracted.bioSnippet ? 1 : 0;
      return hasLinkedIn + hasSocialLink + hasCompany + hasEducation + hasBio + score.confidence;
    };
    return richness(m) > richness(best) ? m : best;
  });
}
