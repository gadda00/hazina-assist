/**
 * @hazina/kit — Hybrid lexical retrieval (BM25) with reciprocal rank fusion.
 * A framework-free stand-in for the production stack (Postgres tsvector +
 * pgvector fused with RRF then a cross-encoder reranker). Same ranking
 * contract, lighter runtime — see docs/adr/ADR-003-retrieval-strategy.md.
 */

export interface SearchDoc {
  id: string;
  text: string;
  keywords?: string;
}

const TOKENISE = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);

const SW_STOP = new Set([
  "the", "and", "for", "are", "you", "your", "with", "this", "that", "from",
  "what", "how", "much", "does", "ni", "na", "ya", "kwa", "wa", "za", "mgapi",
  "kwa", "hii", "yangu", "yako", "can", "may", "was", "were", "has", "have",
]);

export function bm25Scores(query: string, docs: SearchDoc[], k1 = 1.4, b = 0.72): Map<string, number> {
  const qTerms = TOKENISE(query).filter((t) => !SW_STOP.has(t));
  const docTerms = docs.map((d) => TOKENISE(`${d.text} ${d.keywords ?? ""}`));
  const N = docs.length;
  const avgdl = docTerms.reduce((a, t) => a + t.length, 0) / (N || 1);
  const df = new Map<string, number>();
  for (const terms of docTerms) {
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const scores = new Map<string, number>();
  docs.forEach((d, i) => {
    const terms = docTerms[i];
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const q of qTerms) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * terms.length) / (avgdl || 1))));
    }
    scores.set(d.id, s);
  });
  return scores;
}

/** Dense-ish semantic channel: term-overlap embedding proxy with sub-linear TF. */
export function denseScores(query: string, docs: SearchDoc[]): Map<string, number> {
  const qSet = new Set(TOKENISE(query).filter((t) => !SW_STOP.has(t)));
  const scores = new Map<string, number>();
  for (const d of docs) {
    const tSet = new Set(TOKENISE(`${d.text} ${d.keywords ?? ""}`));
    let overlap = 0;
    for (const q of qSet) if (tSet.has(q)) overlap++;
    scores.set(d.id, qSet.size ? overlap / Math.sqrt(qSet.size) : 0);
  }
  return scores;
}

export interface FusedResult {
  id: string;
  score: number;
  bm25Rank?: number;
  denseRank?: number;
}

/** Reciprocal rank fusion of the two channels. */
export function rrfFuse(
  bm25: Map<string, number>,
  dense: Map<string, number>,
  k = 60
): FusedResult[] {
  const rank = (m: Map<string, number>) =>
    [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const bRanks = rank(bm25);
  const dRanks = rank(dense);
  const fused = new Map<string, { s: number; b?: number; d?: number }>();
  bRanks.forEach((id, i) => {
    fused.set(id, { s: 1 / (k + i + 1), b: i + 1 });
  });
  dRanks.forEach((id, i) => {
    const cur = fused.get(id) ?? { s: 0 };
    cur.s += 1 / (k + i + 1);
    cur.d = i + 1;
    fused.set(id, cur);
  });
  return [...fused.entries()]
    .map(([id, v]) => ({ id, score: v.s, bm25Rank: v.b, denseRank: v.d }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Cross-encoder-style reranker proxy: boosts docs whose title/breadcrumb
 * contain query terms and penalises very short chunks. Produces a 0..1 score
 * used by the answerability gate. Stopwords are stripped BEFORE matching so
 * generic fillers ("the", "is", "of") can never manufacture relevance.
 */
export function rerank(query: string, docs: { id: string; text: string; title?: string; breadcrumb?: string }[]): Map<string, number> {
  const qTerms = TOKENISE(query).filter((t) => !SW_STOP.has(t));
  const out = new Map<string, number>();
  for (const d of docs) {
    const titleTerms = TOKENISE(`${d.title ?? ""} ${d.breadcrumb ?? ""}`);
    let titleHits = 0;
    for (const q of qTerms) if (titleTerms.includes(q)) titleHits++;
    const bodyTerms = TOKENISE(d.text);
    let bodyHits = 0;
    for (const q of qTerms) if (bodyTerms.includes(q)) bodyHits++;
    const lengthPenalty = d.text.length < 60 ? 0.5 : 1;
    const raw = 0.45 * Math.min(1, titleHits / 2) + 0.4 * Math.min(1, bodyHits / 4) + 0.15;
    out.set(d.id, Math.min(1, raw * lengthPenalty));
  }
  return out;
}
