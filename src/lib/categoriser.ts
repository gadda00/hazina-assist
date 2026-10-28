/**
 * Data Science model integration — transaction categoriser.
 *
 * The categoriser is a SEPARATE service (services/categoriser, own repo in
 * production) owned by the Data Science team. This app consumes it ONLY
 * through its versioned OpenAPI contract (/v1/categorise, v1). If the service
 * is unreachable (e.g. serverless demo), a contract-compatible local fallback
 * with the SAME label set keeps the journey alive. Contract tests live in
 * tests/categoriser-contract.test.ts; the model card is served by the service
 * itself at /v1/model-card.
 */
import { breakerState } from "@/lib/gateway";

const LABELS = [
  "groceries",
  "utilities",
  "transport",
  "airtime_data",
  "shopping",
  "food_dining",
  "rent_housing",
  "entertainment",
  "healthcare",
  "education",
  "savings_transfer",
  "fees_charges",
  "income",
  "other",
] as const;

export type Category = (typeof LABELS)[number];

const KEYWORD_MAP: [Category, RegExp][] = [
  ["utilities", /(kplc|kenco|nairobi water|water bill|electricity|tokens?)/i],
  ["transport", /(uber|bolt|little|matatu|fuel|shell|total| Shell|bus|sgr|parking)/i],
  ["airtime_data", /(safaricom|airtel|faiba|airtime|data bundle| bundles?)/i],
  ["groceries", /(naivas|tuskys|quickmart|carrefour|chandarana|greens?)/i],
  ["food_dining", /(java|artcaffe|kfc|mcdonald|burger|pizza|restaurant|cafe|choma|nyama)/i],
  ["shopping", /(jumia|kilimall|amka|mall|bazaar|meters|shop)/i],
  ["rent_housing", /(rent|house|landlord|apartment|housing)/i],
  ["healthcare", /(hospital|clinic|pharmacy|chemist|doctor|nhif|sha)/i],
  ["education", /(school fees|university|college|tuition|bookshop)/i],
  ["entertainment", /(netflix|showmax|cinema|spotify|game|steam)/i],
  ["savings_transfer", /(transfer|m-pesa|mpesa|pesalink|savings|deposit)/i],
  ["fees_charges", /(tariff charge|fee|withdrawal charge|charges)/i],
  ["income", /(salary|payroll|interest credit|refund|deposit from)/i],
];

const SERVICE_URL = process.env.CATEGORISER_URL;

export interface CategorisationResult {
  category: Category;
  confidence: number;
  modelVersion: string;
  backend: "ds-service" | "local-fallback";
  labelsAvailable: readonly string[];
}

/** Local fallback: keyword classifier with the same contract/labels. */
function localFallback(narrative: string): CategorisationResult {
  for (const [cat, re] of KEYWORD_MAP) {
    if (re.test(narrative)) return { category: cat, confidence: 0.7, modelVersion: "fallback-rules-0.1.0", backend: "local-fallback", labelsAvailable: LABELS };
  }
  return { category: "other", confidence: 0.3, modelVersion: "fallback-rules-0.1.0", backend: "local-fallback", labelsAvailable: LABELS };
}

/**
 * Call the DS service through its contract. Validates the response shape
 * (contract enforcement at runtime, not just in tests).
 */
export async function categorise(narrative: string): Promise<CategorisationResult> {
  if (!SERVICE_URL || breakerState().open) return localFallback(narrative);
  try {
    const res = await fetch(`${SERVICE_URL}/v1/categorise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ narrative, k: 1 }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j = (await res.json()) as { category?: string; confidence?: number; model_version?: string };
    if (!j.category || !LABELS.includes(j.category as Category)) {
      // contract violation → treat as service failure
      throw new Error(`label "${j.category}" not in contract enum`);
    }
    return {
      category: j.category as Category,
      confidence: j.confidence ?? 0.5,
      modelVersion: j.model_version ?? "unknown",
      backend: "ds-service",
      labelsAvailable: LABELS,
    };
  } catch {
    return localFallback(narrative);
  }
}

export function availableLabels(): readonly string[] {
  return LABELS;
}
