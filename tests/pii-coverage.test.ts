/**
 * PII detector coverage tests (deep-review P2-10) — pin the documented
 * coverage AND the documented limits (docs/governance/pii-coverage.md):
 * what the detector catches, and what it honestly does not.
 */
import { describe, expect, test } from "bun:test";
import { detectPii, redactPii, pseudonymise, rehydrate } from "@hazina/kit";

/** The app-level PII threshold (src/lib/orchestrator.ts guard_in): raw
 *  matches below it are logged as low-confidence candidates, not PII. */
const APP_THRESHOLD = 0.6;
const appPii = (text: string) => detectPii(text).filter((m) => m.score >= APP_THRESHOLD);

describe("pii detection — documented coverage", () => {
  test("catches KRA PIN, phone, email", () => {
    const m = detectPii("My PIN is A123456789Z, call me on +254712345678 or amina@example.co.ke");
    const types = m.map((x) => x.type);
    expect(types).toContain("kra_pin");
    expect(types).toContain("phone");
    expect(types).toContain("email");
  });

  test("catches local 07xx/01xx phone formats", () => {
    expect(detectPii("namba yangu ni 0733445566").some((x) => x.type === "phone")).toBe(true);
    expect(detectPii("piga 0111223344").some((x) => x.type === "phone")).toBe(true);
  });

  test("national ID is context-gated: bare 8 digits stay below the app threshold", () => {
    // amounts/references produce only low-score candidates (0.45), which the
    // app's 0.6 threshold filters out — no false-positive PII badge
    expect(appPii("I paid 25000000 for the plot").some((x) => x.type === "national_id")).toBe(false);
  });

  test("national ID IS flagged with the right context (score rises to 0.95)", () => {
    expect(appPii("ID No 12345678 please").some((x) => x.type === "national_id")).toBe(true);
    expect(appPii("kitambulisho 87654321").some((x) => x.type === "national_id")).toBe(true);
  });

  test("account numbers are context-gated against the app threshold", () => {
    expect(appPii("account 9012345678901").some((x) => x.type === "account_number")).toBe(true);
    expect(appPii("9012345678901 plain digits no context").some((x) => x.type === "account_number")).toBe(false);
  });

  test("redact masks values but keeps the type", () => {
    const out = redactPii("call +254712345678");
    expect(out).toBe("call [phone]");
    expect(out).not.toContain("254712345678");
  });

  test("pseudonymise tokenises, rehydrate restores (server-side vault)", () => {
    const p = pseudonymise("Email amina@example.co.ke about A123456789Z");
    expect(p.text).not.toContain("amina@example.co.ke");
    expect(p.text).toContain("TOK_EMAIL_1");
    const back = rehydrate(p.text, new Map(p.mappings.map((m) => [m.original, m.token])));
    expect(back).toContain("amina@example.co.ke");
  });
});

describe("pii detection — documented LIMITS (pin the honesty)", () => {
  test("personal names are NOT detected (no NER ships)", () => {
    const m = detectPii("Please help Jane Muthoni Wanjiru with her loan");
    expect(m.some((x) => x.type === "name")).toBe(false);
  });

  test("addresses and employers are NOT detected", () => {
    expect(detectPii("I live in Kasarani, Nairobi and work at Savanna Logistics").length).toBe(0);
  });

  test("obfuscated identifiers escape (spaces break the patterns)", () => {
    expect(detectPii("PIN A123 456 789Z").some((x) => x.type === "kra_pin")).toBe(false);
  });

  test("international phone formats are NOT detected", () => {
    expect(detectPii("call +447700900123").some((x) => x.type === "phone")).toBe(false);
  });
});
