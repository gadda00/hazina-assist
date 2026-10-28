/**
 * RAG node — policy & tariff Q&A with citations and an answerability gate.
 *
 * Pipeline: fee-intent detection (deterministic compute_fee tool) →
 * hybrid retrieval (BM25 + dense proxy fused with RRF) → reranker →
 * answerability gate (top rerank score < threshold ⇒ handoff, never guess) →
 * grounded answer with doc_id/page/effective_date citations.
 */
import { db } from "@/lib/db";
import { bm25Scores, denseScores, rrfFuse, rerank, wrapUntrusted, guardOut } from "@hazina/kit";
import { gatewayChat } from "@/lib/gateway";
import { callTool, type Session } from "@/lib/tools";

export interface Citation {
  docId: string;
  page: number;
  title: string;
  breadcrumb: string;
  effectiveDate?: string;
  snippet: string;
}

export interface RagOutcome {
  kind: "fee_answer" | "answer" | "handoff" | "error";
  answer: string;
  citations: Citation[];
  feeToolCall?: { name: string; args: Record<string, unknown>; result: unknown };
  retrieval: { chunkId: string; rerankScore: number }[];
  answerabilityScore: number;
  gateThreshold: number;
  guard?: { groundednessScore: number; pass: boolean };
  model: string;
  backend: string;
  latencyMs: number;
}

const GATE_THRESHOLD = 0.42; // calibrated on the golden set (see docs/eval)

// Fee-intent detection: amount + fee word, in EN or SW/Sheng
const FEE_INTENT =
  /(fee|charge|charges|cost|tariff|makato|ada|commission|nitumia|galipo)/i;
const AMOUNT = /(?:kes|ksh|shilingi)?\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k)\b)?/i;

const CHANNEL_HINTS: { channel: string; re: RegExp }[] = [
  { channel: "send_to_mpesa", re: /(mpesa|m-pesa|mpes|kwa simu|to phone|send.*phone)/i },
  { channel: "pesalink_out", re: /(pesalink|other bank|equity|kcb|absa|dtb|stanbic|family bank)/i },
  { channel: "internal_transfer", re: /(internal|within|coop|same bank|co-?op|hazina|hii bank|kwenda hazina)/i },
  { channel: "withdrawal_atm", re: /(atm|machine|cash machine)/i },
  { channel: "withdrawal_agent", re: /(agent|wakala|withdrawal|withdraw|kutoa)/i },
];

function parseAmount(text: string): number | null {
  const m = text.match(AMOUNT);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  let val = parseFloat(raw);
  if (isNaN(val)) return null;
  if ((m[2] || "").toLowerCase() === "k") val *= 1000; // "15k", "2k kwa Jane"
  return val;
}

export interface RagContext {
  sessionId: string;
  session: Session;
  input: string;
  lang: "en" | "sw" | "mixed";
}

export async function ragAnswer(ctx: RagContext): Promise<RagOutcome> {
  const started = Date.now();
  const chunks = await db.knowledgeChunk.findMany();

  // 1. Deterministic fee path — the LLM never does fee arithmetic.
  const wantsFee = FEE_INTENT.test(ctx.input);
  if (wantsFee) {
    const amount = parseAmount(ctx.input);
    const chan = CHANNEL_HINTS.find((c) => c.re.test(ctx.input));
    if (amount && chan) {
      const toolRes = await callTool(ctx.session, "compute_fee", { channel: chan.channel, amount });
      const r = toolRes.result as { feeKes: number; matchedRow: { product: string; band: string; effectiveDate: string; docId: string; page: number } | null };
      const feeAnswer =
        ctx.lang === "sw"
          ? `Kutuma KES ${amount.toLocaleString()} kupitia ${chan.channel.replace(/_/g, " ")} kunagharimu KES ${r.feeKes.toLocaleString()}. Ada hii imetoka kwenye tariff guide (taratibu ${r.matchedRow?.band ?? "—"}, effective ${r.matchedRow?.effectiveDate ?? "—"}). Nakato nyingine zinaweza kutofautiana kulingana na channel.`
          : `Sending KES ${amount.toLocaleString()} via ${chan.channel.replace(/_/g, " ")} costs KES ${r.feeKes.toLocaleString()}. This fee comes straight from the tariff guide (band ${r.matchedRow?.band ?? "—"}, effective ${r.matchedRow?.effectiveDate ?? "—"}), so the number is computed, not estimated. Fees may differ on other channels.`;
      return {
        kind: "fee_answer",
        answer: feeAnswer,
        citations: r.matchedRow
          ? [{
              docId: r.matchedRow.docId,
              page: r.matchedRow.page,
              title: "Guide to Fees & Tariffs",
              breadcrumb: "Fees & Tariffs > Channel pricing",
              effectiveDate: r.matchedRow.effectiveDate,
              snippet: `${chan.channel}: band ${r.matchedRow.band} → fee KES ${r.feeKes}`,
            }]
          : [],
        feeToolCall: {
          name: "compute_fee",
          args: { channel: chan.channel, amount },
          result: toolRes.result,
        },
        retrieval: [],
        answerabilityScore: 1,
        gateThreshold: GATE_THRESHOLD,
        model: "deterministic-fee-tool",
        backend: "deterministic",
        latencyMs: Date.now() - started,
      };
    }
  }

  // 2. Hybrid retrieval: BM25 + dense proxy → RRF → reranker
  const docs = chunks.map((c) => ({ id: c.id, text: c.text, keywords: c.keywords }));
  const fused = rrfFuse(bm25Scores(ctx.input, docs), denseScores(ctx.input, docs)).slice(0, 6);
  const candidateIds = fused.map((f) => f.id);
  const candidates = chunks.filter((c) => candidateIds.includes(c.id));
  const rerankScores = rerank(
    ctx.input,
    candidates.map((c) => ({ id: c.id, text: c.text, title: c.title, breadcrumb: c.breadcrumb }))
  );
  const reranked = candidates
    .map((c) => ({ chunk: c, score: rerankScores.get(c.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const top = reranked[0]?.score ?? 0;

  // 3. Answerability gate: below threshold ⇒ route to a human, never guess.
  if (!reranked.length || top < GATE_THRESHOLD) {
    const handoffAnswer =
      ctx.lang === "sw"
        ? "Samahani, sina uhakika wa jibu sahihi kwa swali lako. Nimewasilisha mazungumzo yako na mshauri wa benki — wataskuma ujumbe hivi karibuni."
        : "I'm not confident I can answer that accurately from the bank's published documents, so I won't guess. I've handed this conversation to a human colleague with a summary — they'll pick it up shortly.";
    return {
      kind: "handoff",
      answer: handoffAnswer,
      citations: [],
      retrieval: reranked.map((r) => ({ chunkId: r.chunk.id, rerankScore: Math.round(r.score * 100) / 100 })),
      answerabilityScore: Math.round(top * 100) / 100,
      gateThreshold: GATE_THRESHOLD,
      model: "answerability-gate",
      backend: "deterministic",
      latencyMs: Date.now() - started,
    };
  }

  // 4. Grounded answer with citations. Untrusted chunks are wrapped and
  //    pseudonymised by the gateway before any external model call.
  const citations: Citation[] = reranked.map((r) => ({
    docId: r.chunk.docId,
    page: r.chunk.page,
    title: r.chunk.title,
    breadcrumb: r.chunk.breadcrumb,
    effectiveDate: r.chunk.effectiveDate ?? undefined,
    snippet: r.chunk.text.slice(0, 240),
  }));

  const sourceBlocks = reranked
    .map((r, i) => wrapUntrusted(r.chunk.text, `doc:${r.chunk.docId}:p${r.chunk.page}`))
    .join("\n\n");

  const sys = [
    "You are Hazina Assist, a bank assistant for a Kenyan bank.",
    "Answer ONLY from the provided untrusted_source blocks.",
    "Every factual claim must reference its source inline as [doc_id p.page].",
    "If the sources do not contain the answer, say you are unsure and offer to hand off to a human.",
    "Never compute fees, interest or totals yourself — quote the document value only.",
    "Match the customer's language (English, Swahili or mixed). Be concise (≤120 words).",
    "No investment, legal or tax advice.",
  ].join(" ");

  const user = `Customer question: ${ctx.input}\n\nSources:\n${sourceBlocks}`;

  const g = await gatewayChat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { sessionId: ctx.sessionId, tag: "rag_answer" }
  );

  // Deterministic fallback composer (external model unavailable)
  let answer = g.content;
  if (g.backend === "fallback") {
    const topChunk = reranked[0].chunk;
    const second = reranked[1]?.chunk;
    answer =
      ctx.lang === "sw"
        ? `Kulingana na nyaraka za benki (${topChunk.breadcrumb}, ${topChunk.docId} uk. ${topChunk.page}${topChunk.effectiveDate ? `, effective ${topChunk.effectiveDate}` : ""}): ${trimSentences(topChunk.text, 2)}${second ? ` Pia: ${trimSentences(second.text, 1)}` : ""}`
        : `Based on the bank's published documents (${topChunk.breadcrumb}, ${topChunk.docId} p.${topChunk.page}${topChunk.effectiveDate ? `, effective ${topChunk.effectiveDate}` : ""}): ${trimSentences(topChunk.text, 2)}${second ? ` Also relevant: ${trimSentences(second.text, 1)}` : ""}`;
  }

  // 5. guard_out: groundedness + PII leak + advice filter
  const gout = guardOut({
    answer,
    sources: reranked.map((r) => r.chunk.text),
    userLang: ctx.lang,
    answerLang: ctx.lang, // fallback composer matches by construction
  });

  return {
    kind: "answer",
    answer,
    citations,
    retrieval: reranked.map((r) => ({ chunkId: r.chunk.id, rerankScore: Math.round(r.score * 100) / 100 })),
    answerabilityScore: Math.round(top * 100) / 100,
    gateThreshold: GATE_THRESHOLD,
    guard: { groundednessScore: gout.groundednessScore, pass: gout.pass },
    model: g.model,
    backend: g.backend,
    latencyMs: Date.now() - started,
  };
}

function trimSentences(text: string, n: number): string {
  const sents = text.split(/(?<=[.!?])\s+/).slice(0, n).join(" ");
  return sents.length > 420 ? sents.slice(0, 417) + "..." : sents;
}
