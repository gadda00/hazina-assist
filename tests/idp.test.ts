/**
 * App-level unit tests: payslip extraction, validation, policy gate helpers.
 * (DB-backed flows are covered by the eval harness end-to-end.)
 */
import { describe, expect, test } from "bun:test";
import {
  generatePayslipText, extractPayslip, validatePayslip,
} from "@/lib/idp";

const CLEAN_INPUT = {
  employer: "Savanna Logistics Ltd",
  employeeName: "Amina Wanjiru",
  kraPin: "A123456789Z",
  gross: 145_000,
  month: "October 2026",
};

describe("payslip generation + extraction roundtrip", () => {
  test("clean payslip extracts with high confidence", () => {
    const text = generatePayslipText(CLEAN_INPUT);
    const p = extractPayslip(text);
    expect(p.employeeName.value).toBe("Amina Wanjiru");
    expect(p.kraPin.value).toBe("A123456789Z");
    expect(p.gross.value).toBe(145_000);
    expect(p.net.value).toBeLessThan(145_000);
    expect(p.gross.confidence).toBeGreaterThan(0.7);
    expect(p.deductions.length).toBe(4); // PAYE, NSSF, SHIF, AHL
    expect(p.deductions.every((d) => d.amount.evidence)).toBe(true);
  });
  test("scanned payslip: OCR-tolerant extraction despite noise", () => {
    const text = generatePayslipText({ ...CLEAN_INPUT, scanned: true });
    const p = extractPayslip(text);
    // cosmetic OCR noise (EmpIoyee Name;, PAYSL1P header, Housin Levy) is tolerated
    expect(p.employeeName.value).toBe("Amina Wanjiru");
    expect(p.gross.value).toBe(145_000);
    expect(p.deductions.length).toBe(4);
    expect(p.deductions.every((d) => d.amount.evidence)).toBe(true);
  });
});

describe("deterministic validation rules", () => {
  test("clean payslip passes all rules", () => {
    const p = extractPayslip(generatePayslipText(CLEAN_INPUT));
    const v = validatePayslip(p);
    expect(v.rules.find((r) => r.rule === "kra_pin_format")?.passed).toBe(true);
    expect(v.rules.find((r) => r.rule === "net_le_gross")?.passed).toBe(true);
    expect(v.rules.find((r) => r.rule === "deductions_reconcile")?.passed).toBe(true);
    expect(v.rules.find((r) => r.rule === "one_third_rule")?.passed).toBe(true);
    expect(v.ok).toBe(true);
  });
  test("bad KRA PIN fails format rule", () => {
    const text = generatePayslipText(CLEAN_INPUT).replace("A123456789Z", "A12345Z89X");
    const v = validatePayslip(extractPayslip(text));
    expect(v.rules.find((r) => r.rule === "kra_pin_format")?.passed).toBe(false);
    expect(v.ok).toBe(false);
  });
  test("impossible net > gross fails", () => {
    const p = extractPayslip(generatePayslipText(CLEAN_INPUT));
    p.net.value = 999_999;
    const v = validatePayslip(p);
    expect(v.rules.find((r) => r.rule === "net_le_gross")?.passed).toBe(false);
  });
});

describe("routing amount parsing (fees)", () => {
  // Mirrors the regression that produced the 2,000,000 KES bug.
  test("'k' suffix requires word boundary", () => {
    const AMOUNT = /(?:kes|ksh|shilingi)?\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k)\b)?/i;
    const m1 = "Ada ya kutuma pesa 2000 kwa mpesa".match(AMOUNT);
    expect(parseFloat(m1![1].replace(/,/g, ""))).toBe(2000);
    expect(m1![2]).toBeUndefined();
    const m2 = "nikituma 15k kwa mpesa".match(AMOUNT);
    expect(m2![2]?.toLowerCase()).toBe("k");
  });
});
