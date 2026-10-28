/**
 * @hazina/kit — Signed action intents.
 *
 * The model proposes; the server signs; the executor verifies.
 * A write action (transfer) only executes if it carries a valid HMAC-SHA256
 * signature bound to the session id, with a short TTL and a single-use nonce.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface IntentBody {
  sid: string;
  intent: Record<string, unknown>;
  exp: number; // unix seconds
  nonce: string;
}

export interface SignedIntent {
  body: IntentBody;
  sig: string;
}

/** Deterministic canonical serialisation (sorted keys, compact separators). */
export function canonicalJSON(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Sign an intent for session `sid` with TTL seconds (default 120). */
export function signIntent(
  secret: string | Buffer,
  sid: string,
  intent: Record<string, unknown>,
  ttl = 120,
  now = Math.floor(Date.now() / 1000),
  nonce?: string
): SignedIntent {
  const body: IntentBody = {
    sid,
    intent,
    exp: now + ttl,
    nonce: nonce ?? randomNonce(),
  };
  const msg = canonicalJSON(body);
  const sig = createHmac("sha256", secret).update(msg).digest("hex");
  return { body, sig };
}

export interface VerifyOptions {
  now?: number;
  isNonceUsed?: (nonce: string) => boolean | Promise<boolean>;
}

/** Constant-time signature check + session binding + expiry + nonce replay. */
export async function verifyIntent(
  secret: string | Buffer,
  tok: SignedIntent,
  sid: string,
  opts: VerifyOptions = {}
): Promise<{ ok: boolean; reason?: string }> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const msg = canonicalJSON(tok.body);
  const expected = createHmac("sha256", secret).update(msg).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from((tok.sig ?? "").toLowerCase(), "hex");
  const good = a.length === b.length && timingSafeEqual(a, b);
  if (!good) return { ok: false, reason: "bad_signature" };
  if (tok.body.sid !== sid) return { ok: false, reason: "session_mismatch" };
  if (!(tok.body.exp > now)) return { ok: false, reason: "expired" };
  if (opts.isNonceUsed && (await opts.isNonceUsed(tok.body.nonce))) {
    return { ok: false, reason: "nonce_replayed" };
  }
  return { ok: true };
}

export function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
