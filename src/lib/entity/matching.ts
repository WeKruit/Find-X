import type { PersonMention } from "@/types";

// ── TF-IDF Cosine Similarity Engine ──

/** Tokenize text into lowercased terms, filtering noise */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Build a text representation of a mention's context (everything except the name) */
export function mentionToContextText(m: PersonMention): string {
  const parts: string[] = [];
  for (const exp of (m.extracted.experiences || [])) {
    if (exp.title) parts.push(exp.title);
    if (exp.company) parts.push(exp.company);
  }
  if (m.extracted.location) parts.push(m.extracted.location);
  if (m.extracted.bioSnippet) parts.push(m.extracted.bioSnippet);
  for (const edu of m.extracted.education) {
    parts.push([edu.institution, edu.degree, edu.field].filter(Boolean).join(" "));
  }
  for (const skill of (m.extracted.skills || [])) parts.push(skill.name);
  for (const rel of m.extracted.relationships) {
    parts.push(`${rel.name} ${rel.relationship}`);
  }
  for (const fact of m.extracted.additionalFacts.slice(0, 20)) parts.push(fact);
  return parts.join(" ");
}

/** Compute TF (term frequency) for a document */
export function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  const len = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / len);
  }
  return tf;
}

/** Compute IDF (inverse document frequency) across all documents */
export function computeIDF(docs: string[][]): Map<string, number> {
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
    idf.set(term, Math.log((n + 1) / (count + 1)) + 1);
  }
  return idf;
}

/** Compute cosine similarity from precomputed TF vectors and shared IDF */
export function cosineSimilarityFromVectors(
  tfA: Map<string, number>,
  tfB: Map<string, number>,
  idf: Map<string, number>
): number {
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
 */
export function cosineSimilarityPairwise(
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

/** Compute TF-IDF cosine similarity between a query context string and a mention. */
export function contextSimilarityToQuery(
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

  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Compare two name strings with both Jaro-Winkler AND word-containment.
 * Handles cases like "Zelin Noah Liu" vs "Noah Liu" where JW alone fails.
 */
export function nameScore(a: string, b: string): number {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return 0;

  if (al === bl) return 1.0;

  const wordsA = al.split(/\s+/);
  const wordsB = bl.split(/\s+/);

  if (wordsA.length >= 3 && wordsA.length === wordsB.length) {
    const setBa = new Set(wordsB);
    if (wordsA.every((w) => setBa.has(w))) return 0.93;
  }

  if (wordsA.length === 2 && wordsB.length === 2) {
    const setA = new Set(wordsA);
    if (wordsB.every((w) => setA.has(w))) return 0.90;
  }

  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer = wordsA.length <= wordsB.length ? wordsB : wordsA;

  if (shorter.length >= 2) {
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
      const coverage = shorter.length / longer.length;
      return Math.max(0.90, coverage);
    }
  }

  return jaroWinkler(a, b);
}

/** Best name score between any pair of names from two mentions (capped at 5 each) */
export function bestNameSimilarity(namesA: string[], namesB: string[]): number {
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
 * If llmScores are provided, use them for semantic matching.
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
    const score = llmScores?.has(trimmed)
      ? llmScores.get(trimmed)!
      : nameScore(trimmed, queryName.trim());
    if (score > best) best = score;
  }
  return best;
}

const SKIP_WORDS = new Set(["of", "the", "and", "at", "in", "for", "a", "an"]);

function isAcronymOf(short: string, long: string): boolean {
  if (short.length < 2 || short.length > 6) return false;
  const letters = short.toLowerCase().split("");
  const words = long.toLowerCase().split(/\s+/).filter((w) => !SKIP_WORDS.has(w));
  if (letters.length > words.length) return false;
  let wi = 0;
  for (const letter of letters) {
    while (wi < words.length && words[wi][0] !== letter) wi++;
    if (wi >= words.length) return false;
    wi++;
  }
  return true;
}

/** Compare two institution names with acronym awareness. */
export function institutionSimilarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1.0;

  const aWords = al.split(/\s+/);
  const bWords = bl.split(/\s+/);
  if (aWords.length === 1 && bWords.length > 1 && isAcronymOf(al, bl)) return 0.95;
  if (bWords.length === 1 && aWords.length > 1 && isAcronymOf(bl, al)) return 0.95;

  return jaroWinkler(a, b);
}
