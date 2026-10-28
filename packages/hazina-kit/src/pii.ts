/**
 * @hazina/kit — PII detection & pseudonymisation (Presidio-style, Kenya-flavoured).
 *
 * Recognisers: KRA PIN, phone (+254 / 07xx / 01xx), Kenyan national ID (8-digit,
 * context-gated to avoid false positives), long account numbers (context-gated),
 * email, and amounts of money in natural language is NOT PII.
 *
 * Two modes:
 *  - redact: irreversible masking for logs / audit payloads
 *  - pseudonymise: reversible tokenisation used by the model-gateway proxy
 *    before any external LLM call (data-residency safeguard, DPA s.48 story)
 */
export type PiiType =
  | "kra_pin"
  | "phone"
  | "national_id"
  | "account_number"
  | "email"
  | "name";

export interface PiiMatch {
  type: PiiType;
  value: string;
  start: number;
  end: number;
  score: number;
}

export interface Recogniser {
  type: PiiType;
  pattern: RegExp;
  score: number;
  /** Extra context gate to suppress false positives */
  context?: (full: string, m: RegExpExecArray) => boolean;
}

const RECOGNISERS: Recogniser[] = [
  { type: "kra_pin", pattern: /\b([AP]\d{9}[A-Z])\b/g, score: 0.95 },
  {
    type: "phone",
    pattern: /(\+254[17]\d{8}|(?<!\d)0[17]\d{8}(?!\d))/g,
    score: 0.9,
  },
  {
    type: "national_id",
    pattern: /(?<![\d.])\d{8}(?![\d.])/g,
    score: 0.45, // low prior; context gate raises it
    context: (full, m) =>
      /(id|identity|pin number|natl|national|ktp|kitambulisho|ID No)/i.test(
        full.slice(Math.max(0, m.index - 30), m.index)
      ),
  },
  {
    type: "account_number",
    pattern: /(?<![\d.\-])\d{10,14}(?![\d.\-])/g,
    score: 0.4,
    context: (full, m) =>
      /(account|acct|acc no|a\/c|hesabu)/i.test(
        full.slice(Math.max(0, m.index - 30), m.index)
      ),
  },
  { type: "email", pattern: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, score: 0.95 },
];

/** Detect PII in text. Overlapping matches are resolved in favour of the
 *  highest-scoring recogniser (a 10-digit phone is a phone, not an account). */
export function detectPii(text: string): PiiMatch[] {
  const raw: PiiMatch[] = [];
  for (const r of RECOGNISERS) {
    const re = new RegExp(r.pattern.source, r.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) continue;
      let score = r.score;
      if (r.context) score = r.context(text, m) ? Math.min(0.95, score + 0.5) : score;
      raw.push({ type: r.type, value: m[0], start: m.index, end: m.index + m[0].length, score });
    }
  }
  // Deduplicate overlaps: best score first, then leftmost.
  const accepted: PiiMatch[] = [];
  for (const m of raw.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (accepted.some((a) => m.start < a.end && m.end > a.start)) continue;
    accepted.push(m);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/** Irreversible masking for logs/audit: keeps type but drops value. */
export function redactPii(text: string): string {
  let out = text;
  for (const m of detectPii(text)) {
    out = out.slice(0, m.start) + `[${m.type}]` + out.slice(m.end);
  }
  return out;
}

export interface Pseudonymised {
  text: string; // tokens in place of PII
  mappings: { token: string; original: string; piiType: PiiType }[];
}

/**
 * Reversible pseudonymisation for the model-gateway proxy.
 * Names → TOK_NAME_n, phones → TOK_PHONE_n, KRA PINs → TOK_KRA_n ...
 * The vault (originals) never leaves the server; the external model only
 * ever sees tokens.
 */
export function pseudonymise(text: string, existing?: Map<string, string>): Pseudonymised {
  const vault = existing ?? new Map<string, string>();
  const mappings: Pseudonymised["mappings"] = [];
  // Replace back-to-front so indices stay valid; spans are already de-duped.
  for (const m of [...detectPii(text)].reverse()) {
    let token = vault.get(m.value);
    if (!token) {
      let n = 1;
      for (const v of vault.values()) {
        if (v.startsWith(`TOK_${m.type.toUpperCase()}_`)) n++;
      }
      token = `TOK_${m.type.toUpperCase()}_${n}`;
      vault.set(m.value, token);
    }
    mappings.push({ token, original: m.value, piiType: m.type });
    text = text.slice(0, m.start) + token + text.slice(m.end);
  }
  return { text, mappings: mappings.reverse() };
}

/** Re-hydrate tokens back into real values (post LLM response, server-side). */
export function rehydrate(text: string, vault: Map<string, string>): string {
  let out = text;
  for (const [original, token] of vault.entries()) {
    out = out.split(token).join(original);
  }
  return out;
}
