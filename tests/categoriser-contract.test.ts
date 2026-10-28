/**
 * Contract test — the app↔categoriser boundary (the "integrate, don't build"
 * separation). If the DS service is running (CATEGORISER_URL), we exercise
 * the LIVE contract; otherwise we pin the contract shape against the local
 * fallback so the suite always runs in CI.
 */
import { describe, expect, test } from "bun:test";
import { categorise, availableLabels } from "@/lib/categoriser";

const LABELS = availableLabels();

describe("categoriser contract", () => {
  test("label enum is exactly 14 and includes the display-critical set", () => {
    expect(LABELS.length).toBe(14);
    for (const must of ["groceries", "utilities", "transport", "airtime_data", "income", "other"]) {
      expect(LABELS).toContain(must);
    }
  });

  test("live or fallback: response always validates against the enum", async () => {
    for (const narrative of [
      "KPLC electricity tokens",
      "Naivas Westlands groceries",
      "Bolt ride — town",
      "Safaricom airtime & data",
      "Salary — Savanna Logistics",
      "qqxx zzvv unknown merchant",
    ]) {
      const r = await categorise(narrative);
      // THE contract invariant: never an out-of-contract label
      expect(LABELS).toContain(r.category);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(["ds-service", "local-fallback"]).toContain(r.backend);
      expect(r.modelVersion).toBeTruthy();
    }
  });

  test("known Kenyan merchants classify to their domain", async () => {
    expect((await categorise("KPLC electricity tokens")).category).toBe("utilities");
    expect((await categorise("Naivas Westlands groceries")).category).toBe("groceries");
    expect((await categorise("Bolt ride — town")).category).toBe("transport");
    expect((await categorise("Salary — Savanna Logistics")).category).toBe("income");
  });

  test("unknown narrative defaults to other (never a confident wrong label)", async () => {
    const r = await categorise("qqxx zzvv");
    expect(r.category).toBe("other");
    expect(r.confidence).toBeLessThan(0.5);
  });
});
