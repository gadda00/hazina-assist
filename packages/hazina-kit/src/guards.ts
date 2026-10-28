/**
 * @hazina/kit — Output guards & hash-chained audit primitives.
 */
import { createHash } from "node:crypto";
import { detectPii } from "./pii";

// ---------------------------------------------------------------------------
// Output guards (guard_out node)
// ---------------------------------------------------------------------------

export interface GuardOutVerdict {
  groundednessScore: number; // 0..1 lexical overlap of answer vs cited sources
  grounded: boolean;
  piiLeaked: string[];
  adviceViolations: string[];
  languageMatch: boolean;
  pass: boolean;
}

/** Lexical groundedness: fraction of content words in the answer found in sources. */
export function groundedness(answer: string, sources: string[]): number {
  const stops = new Set([
    "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "for", "on",
    "and", "or", "with", "as", "by", "at", "from", "that", "this", "it", "be",
    "will", "can", "you", "your", "we", "our", "ni", "na", "ya", "kwa", "wa", "za",
  ]);
  const words = answer
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stops.has(w));
  if (words.length === 0) return 1;
  const sourceText = sources.join(" ").toLowerCase();
  const hits = words.filter((w) => sourceText.includes(w)).length;
  return hits / words.length;
}

const ADVICE_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "investment_advice", re: /\b(you should (buy|sell|invest in)|pengine ununue|invest in (this|that) stock|nunuzia hisa)/i },
  { label: "legal_advice", re: /\b(you should (sue|file)|take legal action against|I advise you legally)/i },
];

export function guardOut(input: {
  answer: string;
  sources: string[];
  userLang: string;
  answerLang: string;
  groundedThreshold?: number;
}): GuardOutVerdict {
  const g = groundedness(input.answer, input.sources);
  const threshold = input.groundedThreshold ?? 0.5;
  const leaked = detectPii(input.answer)
    .filter((m) => m.score >= 0.7)
    .map((m) => m.type);
  const advice = ADVICE_PATTERNS.filter((p) => p.re.test(input.answer)).map((p) => p.label);
  const langMatch = input.userLang === "mixed" || input.userLang === input.answerLang;
  return {
    groundednessScore: Math.round(g * 100) / 100,
    grounded: g >= threshold,
    piiLeaked: leaked,
    adviceViolations: advice,
    languageMatch: langMatch,
    pass: leaked.length === 0 && advice.length === 0 && (g >= threshold || input.sources.length === 0),
  };
}

// ---------------------------------------------------------------------------
// Hash-chained audit log primitives
// ---------------------------------------------------------------------------

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic payload serialisation for audit records. */
export function canonicalEvent(event: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(event).sort(([a], [b]) => (a < b ? -1 : 1)))
  );
}

export function eventHash(prevHash: string, event: Record<string, unknown>): string {
  return createHash("sha256").update(prevHash + canonicalEvent(event)).digest("hex");
}

export interface ChainEntry {
  payload: string;
  prevHash: string;
  hash: string;
}

/**
 * Verify a full chain: recompute every hash and check linkage.
 * Returns the index of the first broken entry, or null if intact.
 */
export function verifyChain(entries: ChainEntry[]): { ok: boolean; brokenAt: number | null; length: number } {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prev) return { ok: false, brokenAt: i, length: entries.length };
    const recomputed = createHash("sha256").update(prev + e.payload).digest("hex");
    if (recomputed !== e.hash) return { ok: false, brokenAt: i, length: entries.length };
    prev = e.hash;
  }
  return { ok: true, brokenAt: null, length: entries.length };
}

// ---------------------------------------------------------------------------
// Language identification (en / sw / mixed) — compares Swahili marker density
// against English function-word density, so code-mixed input lands in "mixed".
// ---------------------------------------------------------------------------

const SW_MARKERS = [
  "ni", "na", "ya", "kwa", "wa", "za", "nitume", "tuma", "pesa", "kesho", "yangu",
  "yako", "mgapi", "bile", "hii", "hiyo", "zangu", "niambie", "nione", "nionyeshe",
  "ngapi", "sasa", "siku", "mwezi", "sendi", "kutoka", "kwenda", "kwenye", "shilingi",
  "salio", "tafadhali", "langu", "huu", "mwingine", "nataka", "omba", "mkopo", "ada",
  "makato", "historia", "matukio", "fungua", "angalia", "kwamba", "zote", "hapa",
];

const EN_FUNCTION = new Set([
  "the", "is", "are", "was", "were", "my", "your", "can", "you", "what", "how",
  "when", "where", "who", "which", "do", "does", "did", "please", "and", "of", "to",
  "in", "on", "for", "with", "me", "i", "it", "that", "this", "will", "have", "has",
  "tell", "show", "send", "want", "need", "much", "much",
]);

export function detectLanguage(text: string): { lang: "en" | "sw" | "mixed"; confidence: number } {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[^a-z]/g, "")).filter(Boolean);
  if (words.length === 0) return { lang: "en", confidence: 1 };
  const swHits = words.filter((w) => SW_MARKERS.includes(w)).length;
  const enHits = words.filter((w) => EN_FUNCTION.has(w)).length;
  if (swHits >= 2 && swHits > enHits * 2) return { lang: "sw", confidence: Math.min(1, 0.6 + swHits / words.length) };
  if (enHits >= 2 && enHits > swHits * 2) return { lang: "en", confidence: Math.min(1, 0.6 + enHits / words.length) };
  if (swHits === 0 && enHits === 0) return { lang: "en", confidence: 0.6 };
  return { lang: "mixed", confidence: Math.min(1, 0.4 + (swHits + enHits) / words.length) };
}
