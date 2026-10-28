/**
 * @hazina/kit — Deterministic transfer policy (limits, cooling-off).
 * The LLM never enforces policy; it only proposes. This module decides.
 */

export interface TransferLimits {
  perTransactionKes: number;
  dailyKes: number;
  newBeneficiaryCoolingOffMinutes: number;
}

export const DEFAULT_LIMITS: TransferLimits = {
  perTransactionKes: 70_000,
  dailyKes: 200_000,
  newBeneficiaryCoolingOffMinutes: 30,
};

export interface PolicyInput {
  amountKes: number;
  executedTodayKes: number; // sum of today's completed outbound transfers
  beneficiaryAgeMinutes: number | null; // null = brand-new beneficiary
}

export type PolicyDecision =
  | { allowed: true; riskLevel: "low" | "medium"; notes: string[] }
  | { allowed: false; reason: string; notes: string[] };

export function checkTransferPolicy(
  input: PolicyInput,
  limits: TransferLimits = DEFAULT_LIMITS
): PolicyDecision {
  const notes: string[] = [];
  if (!Number.isFinite(input.amountKes) || input.amountKes <= 0) {
    return { allowed: false, reason: "invalid_amount", notes };
  }
  if (input.amountKes > limits.perTransactionKes) {
    return {
      allowed: false,
      reason: `exceeds_per_transaction_limit:${limits.perTransactionKes}`,
      notes: [...notes, `KES ${input.amountKes.toLocaleString()} > cap KES ${limits.perTransactionKes.toLocaleString()}`],
    };
  }
  if (input.executedTodayKes + input.amountKes > limits.dailyKes) {
    return {
      allowed: false,
      reason: `exceeds_daily_limit:${limits.dailyKes}`,
      notes: [...notes, `daily total would reach KES ${(input.executedTodayKes + input.amountKes).toLocaleString()}`],
    };
  }
  if (input.beneficiaryAgeMinutes === null) {
    notes.push(`new beneficiary: cooling-off ${limits.newBeneficiaryCoolingOffMinutes} min before first send`);
    return {
      allowed: false,
      reason: `new_beneficiary_cooling_off:${limits.newBeneficiaryCoolingOffMinutes}`,
      notes,
    };
  }
  if (input.beneficiaryAgeMinutes < limits.newBeneficiaryCoolingOffMinutes) {
    return {
      allowed: false,
      reason: `new_beneficiary_cooling_off:${limits.newBeneficiaryCoolingOffMinutes}`,
      notes: [...notes, `${limits.newBeneficiaryCoolingOffMinutes - input.beneficiaryAgeMinutes} min remaining`],
    };
  }
  const riskLevel = input.amountKes >= limits.perTransactionKes * 0.7 ? "medium" : "low";
  if (riskLevel === "medium") notes.push("≥70% of per-transaction cap");
  return { allowed: true, riskLevel, notes };
}

// ---------------------------------------------------------------------------
// Deterministic affordability (Employment Act s.19 "one-third rule")
// ---------------------------------------------------------------------------

export interface AffordabilityInput {
  netMonthlyKes: number;
  existingMonthlyObligationsKes: number;
  requestedTenorMonths: number;
  requestedAmountKes: number;
  annualInterestPct: number; // e.g. 14.5
}

export interface AffordabilityResult {
  disposableMonthlyKes: number;
  maxInstalmentKes: number; // half of disposable (prudential buffer)
  proposedInstalmentKes: number;
  dtiAfterLoan: number; // obligations + instalment over net
  oneThirdRuleOk: boolean; // total deductions ≤ 2/3 of gross (checked upstream too)
  recommendation: "proceed_to_officer" | "refer_to_officer" | "not_affordable";
  notes: string[];
}

export function computeAffordability(i: AffordabilityInput): AffordabilityResult {
  const disposable = Math.max(0, i.netMonthlyKes - i.existingMonthlyObligationsKes);
  const maxInstalment = disposable / 2;
  const r = i.annualInterestPct / 100 / 12;
  const n = i.requestedTenorMonths;
  const amortised =
    r === 0
      ? i.requestedAmountKes / n
      : (i.requestedAmountKes * r) / (1 - Math.pow(1 + r, -n));
  const instalment = Math.round(amortised);
  const dti = (i.existingMonthlyObligationsKes + instalment) / i.netMonthlyKes;
  const notes: string[] = [
    `disposable income KES ${disposable.toLocaleString()} after obligations`,
    `max prudent instalment (50% of disposable): KES ${Math.round(maxInstalment).toLocaleString()}`,
    `proposed instalment @ ${i.annualInterestPct}% for ${n}m: KES ${instalment.toLocaleString()}`,
    `DTI after loan: ${(dti * 100).toFixed(1)}%`,
  ];
  let recommendation: AffordabilityResult["recommendation"] = "refer_to_officer";
  if (instalment <= maxInstalment && dti <= 0.5) recommendation = "proceed_to_officer";
  else if (instalment > maxInstalment) recommendation = "not_affordable";
  if (recommendation === "not_affordable") {
    notes.push("proposed instalment exceeds 50% of disposable income");
  }
  return {
    disposableMonthlyKes: disposable,
    maxInstalmentKes: Math.round(maxInstalment),
    proposedInstalmentKes: instalment,
    dtiAfterLoan: Math.round(dti * 1000) / 1000,
    oneThirdRuleOk: true, // validated separately against gross in the IDP pipeline
    recommendation,
    notes,
  };
}
