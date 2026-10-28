/**
 * Intelligent Document Processing — payslip → loan pre-qualification pack.
 *
 * Pipeline: (1) synthetic payslip generator (Faker/ReportLab-equivalent for
 * this TS runtime) with clean + scanned variants → (2) schema-constrained
 * extraction with per-field confidence and source evidence (page, span) →
 * (3) deterministic validation (net ≤ gross, deductions sum, KRA PIN format,
 * Employment Act one-third rule) → (4) deterministic affordability →
 * (5) a recommendation pack for a HUMAN credit officer. The system never
 * approves or declines (DPA 2019 s.35: recommend, don't decide).
 */
import { computeAffordability } from "@hazina/kit";
import { db } from "@/lib/db";
import { appendEvent } from "@/lib/audit";

// ---------------------------------------------------------------------------
// 1. Synthetic payslip generator (Kenyan-style lines: PAYE, NSSF, SHIF, AHL)
// ---------------------------------------------------------------------------

export interface SyntheticPayslipInput {
  employer: string;
  employeeName: string;
  kraPin: string;
  gross: number;
  month: string; // "October 2026"
  scanned?: boolean; // inject OCR-ish noise
}

export function generatePayslipText(i: SyntheticPayslipInput): string {
  const paye = Math.round(0.3 * i.gross * 0.9);
  const nssf = Math.min(1080, Math.round(i.gross * 0.06));
  const shif = Math.round(i.gross * 0.0275);
  const ahl = Math.round(i.gross * 0.015);
  const deductions = [
    { name: "PAYE", amount: paye },
    { name: "NSSF", amount: nssf },
    { name: "SHIF", amount: shif },
    { name: "Housing Levy (AHL)", amount: ahl },
  ];
  const totalDed = deductions.reduce((a, d) => a + d.amount, 0);
  const net = i.gross - totalDed;
  const lines = [
    `             ${i.employer.toUpperCase()}             `,
    `        PAYS LIP  —  ${i.month}        `,
    `Employee Name:  ${i.employeeName}`,
    `KRA PIN:  ${i.kraPin}`,
    `Pay Period:  ${i.month}`,
    `Gross Pay:  KES ${i.gross.toLocaleString()}.00`,
    ``,
    `DEDUCTIONS`,
    ...deductions.map((d) => `  ${d.name}:  KES ${d.amount.toLocaleString()}.00`),
    `  Total Deductions:  KES ${totalDed.toLocaleString()}.00`,
    ``,
    `NET PAY:  KES ${net.toLocaleString()}.00`,
  ];
  let text = lines.join("\n");
  if (i.scanned) {
    // simulate OCR degradation: dropped characters, stray spaces, one swapped digit
    text = text
      .replace(/KES /g, "KES  ")
      .replace(/PAYS LIP/g, "PAYSL1P")
      .replace(/Employee Name:/g, "EmpIoyee Name;")
      .replace(/Housing Levy/g, "Housin Levy");
  }
  return text;
}

export const SAMPLE_PAYSLIPS = [
  {
    key: "clean",
    label: "Sample A — clean digital payslip (text layer)",
    text: generatePayslipText({
      employer: "Savanna Logistics Ltd",
      employeeName: "Amina Wanjiru",
      kraPin: "A123456789Z",
      gross: 145_000,
      month: "October 2026",
    }),
  },
  {
    key: "scanned",
    label: "Sample B — scanned & skewed (OCR noise)",
    text: generatePayslipText({
      employer: "Tulivu Retail Group",
      employeeName: "Brian Otieno",
      kraPin: "P987654321K",
      gross: 82_500,
      month: "September 2026",
      scanned: true,
    }),
  },
];

// ---------------------------------------------------------------------------
// 2. Schema-constrained extraction with confidence + evidence
// ---------------------------------------------------------------------------

export interface Evidence {
  page: number;
  span: string; // the exact source text that justifies the value
}

export interface Field<T> {
  value: T | null;
  confidence: number;
  evidence: Evidence | null;
}

export interface Deduction {
  name: string;
  amount: Field<number>;
}

export interface ExtractedPayslip {
  employer: Field<string>;
  employeeName: Field<string>;
  kraPin: Field<string>;
  gross: Field<number>;
  net: Field<number>;
  deductions: Deduction[];
}

const KRA_RE = /\b([AP]\d{9}[A-Z0-9])\b/;

function extractField(pattern: RegExp, text: string, page = 1): Field<string> {
  const m = text.match(pattern);
  if (!m) return { value: null, confidence: 0, evidence: null };
  // OCR-noise heuristic: stray punctuation/odd characters in the matched span
  // (digits alone are NOT noise — KRA PINs contain 1s legitimately).
  const noisy = /[^a-zA-Z0-9 ,.\-:]/.test(m[0]);
  return {
    value: m[1].trim(),
    confidence: noisy ? 0.62 : 0.95,
    evidence: { page, span: m[0] },
  };
}

function extractAmount(labelRe: RegExp, text: string): Field<number> {
  const line = text.split("\n").find((l) => labelRe.test(l));
  if (!line) return { value: null, confidence: 0, evidence: null };
  const m = line.match(/KES\s+([\d,]+(?:\.\d+)?)/i);
  if (!m) return { value: null, confidence: 0.2, evidence: { page: 1, span: line.trim() } };
  const value = parseFloat(m[1].replace(/,/g, ""));
  const messy = /[;1lI]/.test(line.replace(/KES|[\d,.]/g, ""));
  return { value, confidence: messy ? 0.58 : 0.95, evidence: { page: 1, span: line.trim() } };
}

export function extractPayslip(text: string): ExtractedPayslip {
  const employer = extractField(/^\s*([A-Z][A-Z &.',\-()]+(?:LTD|LIMITED|GROUP|BANK)?)\s*$/im, text);
  // NOTE: [ \t] (not \s) in the continuation so names never capture across lines.
  const employeeName = extractField(/(?:Employee Name|EmpIoyee Name)[:;\s]+([A-Z][a-zA-Z'’\-]+(?:[ \t]+[A-Z][a-zA-Z'’\-]+){0,2})/, text);
  const kraPin = extractField(KRA_RE, text);
  const gross = extractAmount(/Gross Pay|Gross/i, text);
  const net = extractAmount(/NET PAY|Net Pay/i, text);
  const dedLines = text.split("\n").filter((l) => /^\s*(PAYE|NSSF|SHIF|Housin(?:g)? Levy)/i.test(l));
  const deductions: Deduction[] = dedLines.map((line) => {
    const name = line.trim().split(":")[0].replace(/\s+/g, " ");
    const m = line.match(/KES\s+([\d,]+(?:\.\d+)?)/i);
    const amount: Field<number> = m
      ? { value: parseFloat(m[1].replace(/,/g, "")), confidence: /[;1lI]/.test(name) ? 0.6 : 0.92, evidence: { page: 1, span: line.trim() } }
      : { value: null, confidence: 0, evidence: null };
    return { name, amount };
  });
  return { employer, employeeName, kraPin, gross, net, deductions };
}

// ---------------------------------------------------------------------------
// 3. Deterministic validation rules
// ---------------------------------------------------------------------------

export interface RuleResult {
  rule: string;
  passed: boolean;
  detail: string;
}

export function validatePayslip(p: ExtractedPayslip): { rules: RuleResult[]; ok: boolean } {
  const rules: RuleResult[] = [];
  const kraOk = p.kraPin.value ? /^[AP]\d{9}[A-Z]$/.test(p.kraPin.value) : false;
  rules.push({
    rule: "kra_pin_format",
    passed: kraOk,
    detail: p.kraPin.value
      ? kraOk
        ? "matches ^[AP]\\d{9}[A-Z]$"
        : `"${p.kraPin.value}" fails the KRA PIN pattern — possible OCR error`
      : "KRA PIN not found",
  });
  const netGrossOk = p.net.value != null && p.gross.value != null && p.net.value <= p.gross.value;
  rules.push({
    rule: "net_le_gross",
    passed: netGrossOk,
    detail: netGrossOk ? `net ${p.net.value} ≤ gross ${p.gross.value}` : "net exceeds gross — physically impossible",
  });
  const dedSum = p.deductions.reduce((a, d) => a + (d.amount.value ?? 0), 0);
  const reconOk =
    p.net.value != null && p.gross.value != null
      ? Math.abs(p.gross.value - dedSum - p.net.value) <= Math.max(50, p.gross.value * 0.005)
      : false;
  rules.push({
    rule: "deductions_reconcile",
    passed: reconOk,
    detail: `gross − Σdeductions (${dedSum.toLocaleString()}) vs net within 0.5% tolerance`,
  });
  // Employment Act s.19(3): total deductions must not exceed two-thirds of wages
  const oneThirdOk =
    p.gross.value != null ? dedSum <= p.gross.value * (2 / 3) + 1 : false;
  rules.push({
    rule: "one_third_rule",
    passed: oneThirdOk,
    detail: oneThirdOk
      ? `deductions ${(100 * dedSum / (p.gross.value ?? 1)).toFixed(1)}% of gross ≤ 66.7% cap`
      : `deductions exceed the two-thirds cap (${(100 * dedSum / (p.gross.value ?? 1)).toFixed(1)}%)`,
  });
  const lowConfidence = [p.employer, p.employeeName, p.kraPin, p.gross, p.net].some((f) => f.confidence > 0 && f.confidence < 0.7);
  rules.push({
    rule: "field_confidence",
    passed: !lowConfidence,
    detail: lowConfidence ? "one or more fields below the 0.70 confidence floor — flag for review" : "all fields ≥ 0.70",
  });
  return { rules, ok: rules.every((r) => r.passed) };
}

// ---------------------------------------------------------------------------
// 5. Pack assembly (called from the API route with a live session)
// ---------------------------------------------------------------------------

export interface PackInput {
  sessionId: string;
  fileName: string;
  docKind: "clean" | "scanned" | "user_upload";
  text: string;
  requestedAmountKes: number;
  tenorMonths: number;
}

export async function buildPayslipPack(i: PackInput) {
  const extracted = extractPayslip(i.text);
  const validation = validatePayslip(extracted);
  const gross = extracted.gross.value ?? 0;
  const dedSum = extracted.deductions.reduce((a, d) => a + (d.amount.value ?? 0), 0);
  const affordability = computeAffordability({
    netMonthlyKes: extracted.net.value ?? 0,
    existingMonthlyObligationsKes: 0,
    requestedTenorMonths: i.tenorMonths,
    requestedAmountKes: i.requestedAmountKes,
    annualInterestPct: 14.5,
  });
  const summary =
    `Extracted ${extracted.employeeName.value ?? "unknown"} (${extracted.employer.value ?? "unknown"}), ` +
    `net KES ${(extracted.net.value ?? 0).toLocaleString()}/month from ${i.fileName}. ` +
    `Validation ${validation.ok ? "passed" : "flagged: " + validation.rules.filter((r) => !r.passed).map((r) => r.rule).join(", ")}. ` +
    `Affordability: proposed instalment KES ${affordability.proposedInstalmentKes.toLocaleString()} vs max prudent KES ${affordability.maxInstalmentKes.toLocaleString()} (DTI ${(affordability.dtiAfterLoan * 100).toFixed(1)}%). ` +
    `Recommendation: ${affordability.recommendation.replace(/_/g, " ")}. A credit officer makes the final decision.`;

  const pack = await db.payslipPack.create({
    data: {
      sessionId: i.sessionId,
      fileName: i.fileName,
      docKind: i.docKind,
      fields: JSON.stringify(extracted),
      validation: JSON.stringify(validation),
      affordability: JSON.stringify(affordability),
      summary,
      status: "awaiting_review",
    },
  });
  await appendEvent({
    sessionId: i.sessionId,
    actor: "system:idp",
    eventType: "idp_pack_created",
    payload: {
      packId: pack.id,
      docKind: i.docKind,
      netKes: extracted.net.value,
      validationOk: validation.ok,
      avgConfidence:
        Math.round(
          ([extracted.employer, extracted.employeeName, extracted.kraPin, extracted.gross, extracted.net].reduce((a, f) => a + f.confidence, 0) / 5) * 100
        ) / 100,
    },
  });
  return { pack, extracted, validation, affordability, summary };
}
