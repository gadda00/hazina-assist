/**
 * Route node — constrained intent classification.
 * Deterministic keyword/regex scoring first (cheap, auditable, bilingual);
 * the LLM is only used as a tie-breaker for ambiguous input, constrained to
 * a fixed label set. The LLM can NEVER invent a route.
 */
import { detectLanguage } from "@hazina/kit";
import { gatewayChat } from "@/lib/gateway";

export type Route = "rag" | "account" | "transfer" | "idp" | "handoff";

export interface RouteDecision {
  route: Route;
  confidence: number;
  signals: string[];
  lang: "en" | "sw" | "mixed";
  method: "rules" | "rules+llm_tiebreak";
}

interface RouteRule {
  route: Route;
  weight: number;
  patterns: RegExp[];
}

const RULES: RouteRule[] = [
  // ---- transfer (verbs of sending money; Swahili stems take subject prefixes) ----
  {
    route: "transfer",
    weight: 1.0,
    patterns: [
      /\b(?:send|sent|transfer)\b/i,
      /\b(?:ni|ku|tu|wa|a|me|li|ta)?tuma\b/i, // tuma / nituma / kutuma / metuma…
      /\b(\d[\d,]*(?:\.\d+)?)\b[^\n]{0,40}\b(?:send|sent|transfer|tuma)\b/i,
      /\bpay\s+(bill|kplc|naivas|jumia)\b/i,
    ],
  },
  // ---- account (balance / statement) ----
  {
    route: "account",
    weight: 0.9,
    patterns: [
      /\b(balance|bal|salio|remaining)\b/i,
      /\b(statement|mini|transactions?|historia|matukio)\b/i,
      /\b(angalia|nionyeshe|niambie)\b.*\b(salio|account)\b/i,
      /\bhow much.*(have|left|kesho)\b/i,
      /\bngapi.*\bnina\b/i,
    ],
  },
  // ---- IDP / loan pre-qualification (intent to APPLY, not to ask about rules) ----
  {
    route: "idp",
    weight: 1.0,
    patterns: [
      /\b(?:i want|apply for|applying|nataka|omba|naomba|borrow|kopa|qualify|pre-?qualif)\b[^\n]{0,40}\b(loan|mkopo|credit)\b/i,
      /\b(loan|mkopo|credit)\b[^\n]{0,40}\b(?:apply|application|nataka|omba|qualif|pre-?qualif)\b/i,
      /\bpayslip\b/i,
      /\bpay ?slip\b/i,
    ],
  },
  // ---- RAG (policy, tariffs, products, fees) ----
  {
    route: "rag",
    weight: 0.7,
    patterns: [
      /\b(fee|fees|charge|charges|tariff|cost|makato|ada)\b/i,
      /\b(how much.*(cost|charge)|ngapi.*(ada|makato))\b/i,
      /\b(policy|faq|require|requirements|documents|haja|nyaraka)\b/i,
      /\b(account type|types of accounts|opening|fungua|dormant?)\b/i,
      /\b(interest|riba|rate)\b/i,
      /\b(eazzy|mobile|app|ussd)\b/i,
      /\b(cheque|clearing|card replacement)\b/i,
    ],
  },
  // ---- generic question words: WEAK signal only (never beats a domain hit) ----
  {
    route: "rag",
    weight: 0.25,
    patterns: [/\b(what|how|when|where|who|which|can i|tell me|je|nini)\b/i],
  },
];

export function routeRules(input: string): { scores: Record<string, number>; signals: string[]; lang: "en" | "sw" | "mixed" } {
  const lang = detectLanguage(input).lang;
  const scores: Record<string, number> = {};
  const signals: string[] = [];
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(input)) {
        scores[rule.route] = (scores[rule.route] ?? 0) + rule.weight;
        signals.push(`${rule.route}:${p.source.slice(0, 28)}`);
        break;
      }
    }
  }
  return { scores, signals, lang };
}

export async function routeIntent(
  input: string,
  sessionId: string
): Promise<RouteDecision> {
  const { scores, signals, lang } = routeRules(input);

  // A fee/tariff word makes the message a QUESTION about cost, not a
  // transfer action ("how much does it cost to send…"). Fee answers route
  // to RAG where compute_fee runs deterministically.
  const FEE_QUESTION = /\b(fee|fees|charge|charges|tariff|cost|makato|ada|commission|galipo)\b/i;
  if (FEE_QUESTION.test(input) && scores.transfer) {
    delete scores.transfer;
    signals.push("fee-question overrides transfer");
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    return { route: "rag", confidence: 0.3, signals: ["default:rag"], lang, method: "rules" };
  }
  // Clear winner (top score 2x the runner-up, or sole hit with weight ≥ 0.9)
  const [topRoute, topScore] = ranked[0];
  const runnerUp = ranked[1];
  if (!runnerUp || topScore >= runnerUp[1] * 1.9 || (topScore >= 1.0 && !runnerUp)) {
    return {
      route: topRoute as Route,
      confidence: Math.min(0.98, 0.6 + topScore * 0.15),
      signals,
      lang,
      method: "rules",
    };
  }

  // Ambiguous → constrained LLM tie-break over the top-2 labels
  const labels = ranked.slice(0, 2).map(([r]) => r).join(" | ");
  const res = await gatewayChat(
    [
      {
        role: "system",
        content:
          "You are an intent classifier for a Kenyan bank chat. Reply with exactly one label, nothing else.",
      },
      {
        role: "user",
        content: `Labels: ${labels}\nCustomer message: "${input}"\nWhich label fits best? Reply with the label only.`,
      },
    ],
    { sessionId, tag: "route" }
  );
  const answer = res.content.trim().toLowerCase();
  const picked = ranked.slice(0, 2).find(([r]) => answer.includes(r));
  return {
    route: (picked ? picked[0] : topRoute) as Route,
    confidence: picked ? 0.75 : 0.55,
    signals,
    lang,
    method: "rules+llm_tiebreak",
  };
}
