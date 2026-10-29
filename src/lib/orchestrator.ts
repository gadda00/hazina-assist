/**
 * Orchestrator — an explicit state machine, not a free-roaming agent
 * (OWASP LLM01/LLM06: prompt injection + excessive agency).
 *
 *   guard_in → route → [rag | account_tools | transfer_flow | idp_flow]
 *           → policy_check → HITL interrupt → execute → guard_out → respond
 *
 * Every node appends a redacted audit event to the hash chain and feeds the
 * explainability trace the chat UI renders ("why I answered / why I escalated").
 */
import { db } from "@/lib/db";
import {
  detectPii,
  detectInjection,
  detectLanguage,
  guardOut,
  wrapUntrusted,
  type PiiMatch,
} from "@hazina/kit";
import { appendEvent } from "@/lib/audit";
import { routeIntent, type RouteDecision } from "@/lib/router";
import { ragAnswer } from "@/lib/rag";
import { callTool, listTools, type Session } from "@/lib/tools";
import { proposeTransfer, policyGate, issueOtp, verifyOtp, stageSignedIntent, createApprovalForIntent, completeOtpFlow, demoMode } from "@/lib/transfer";
import { gatewayChat } from "@/lib/gateway";
import { categorise } from "@/lib/categoriser";

export interface TraceEvent {
  node: string;
  at: number; // ms since run start
  detail: Record<string, unknown>;
}

export interface OrchestratorResult {
  reply: string;
  route: string;
  kind: string; // outcome kind for the UI
  citations?: { docId: string; page: number; title: string; breadcrumb: string; effectiveDate?: string; snippet?: string }[];
  toolCalls?: { name: string; args: Record<string, unknown>; resultSummary: string }[];
  guard: {
    piiDetected: string[];
    injectionScore: number;
    injectionSignals: string[];
    blocked: boolean;
    lang: string;
    outputGuard?: { groundednessScore: number; pass: boolean };
  };
  hitl?: { taskId: string; riskLevel: string };
  otp?: { issued: boolean; devCode?: string; expiresInSeconds: number };
  transferStatus?: string;
  txnRef?: string;
  pendingIntent?: { amountKes: number; beneficiary: string; destinationMasked: string; state: string };
  trace: TraceEvent[];
  latencyMs: number;
  modelCalls: { tag: string; model: string; backend: string; latencyMs: number; costUsd: number }[];
  auditChainTip?: string;
}

interface RunCtx {
  sessionId: string;
  session: Session;
  started: number;
  trace: TraceEvent[];
  modelCalls: OrchestratorResult["modelCalls"];
}

function trace(ctx: RunCtx, node: string, detail: Record<string, unknown>) {
  ctx.trace.push({ node, at: Date.now() - ctx.started, detail });
}

// ---------------------------------------------------------------------------
// Node: guard_in
// ---------------------------------------------------------------------------

async function guardIn(ctx: RunCtx, input: string) {
  const pii: PiiMatch[] = detectPii(input).filter((m) => m.score >= 0.6);
  const inj = detectInjection(input);
  const lang = detectLanguage(input).lang;
  if (input.length > 2000) {
    trace(ctx, "guard_in", { verdict: "blocked", reason: "input_too_long" });
    return { blocked: true, reason: "input_too_long", pii, inj, lang };
  }
  // Bank-grade posture: ANY injection flag (score ≥ threshold) refuses the
  // request outright; we never "sanitise and continue" an instruction attack.
  const blocked = inj.flagged;
  trace(ctx, "guard_in", {
    verdict: blocked ? "blocked" : inj.action,
    piiTypes: [...new Set(pii.map((p) => p.type))],
    injectionScore: inj.score,
    injectionSignals: inj.signals,
    lang,
  });
  await appendEvent({
    sessionId: ctx.sessionId,
    actor: `customer:${ctx.session.customerId}`,
    eventType: "guard_in",
    payload: {
      lang,
      pii_types: [...new Set(pii.map((p) => p.type))],
      injection_score: inj.score,
      injection_signals: inj.signals,
      verdict: blocked ? "blocked" : inj.action,
      input_length: input.length,
    },
  });
  return { blocked, reason: "injection", pii, inj, lang };
}

// ---------------------------------------------------------------------------
// Node: account_tools (read-only, opaque handles, scoped)
// ---------------------------------------------------------------------------

async function accountNode(ctx: RunCtx, input: string, lang: string) {
  const wantsBalance = /(balance|bal|salio|remaining|ngapi.*nina|how much.*(have|left))/i.test(input);
  const wantsStatement = /(statement|mini|transactions?|historia|matukio|last)/i.test(input);

  const cust = await db.customer.findUnique({
    where: { id: ctx.session.customerId },
    include: { accounts: true },
  });
  const accounts = cust?.accounts ?? [];
  const handleMentioned = accounts.find((a) => input.toLowerCase().includes(a.handle.toLowerCase()));
  const primary = accounts.find((a) => a.type === "current") ?? accounts[0];

  const toolCalls: NonNullable<OrchestratorResult["toolCalls"]> = [];
  let reply = "";

  if (wantsStatement) {
    const target = handleMentioned ?? primary;
    const countMatch = input.match(/(?:last|last)\D*(\d{1,2})/i);
    const count = Math.min(10, Math.max(1, countMatch ? parseInt(countMatch[1]) : 5));
    const r = await callTool(ctx.session, "mini_statement", { account_ref: target.handle, count });
    const data = (r.result as { data?: { transactions: Array<{ ts: string; narrative: string; amount: number; direction: string; category?: string | null }> } }).data;
    const txns = data?.transactions ?? [];
    // Enrich via the DS categoriser service (integration proof-point)
    const cat = await categorise(txns[0]?.narrative ?? "");
    toolCalls.push({ name: "mini_statement", args: { account_ref: target.handle, count }, resultSummary: `${txns.length} transactions, categoriser ${cat.backend}:${cat.category}` });
    reply =
      lang === "sw"
        ? `Taarifa za hivi karibuni kwa account ****${target.maskedNumber.slice(-4)}:\n` +
          txns.map((t) => `${new Date(t.ts).toLocaleDateString("en-KE")} ${t.direction === "debit" ? "−" : "+"} KES ${t.amount.toLocaleString()} — ${t.narrative}`).join("\n")
        : `Recent activity on account ${target.handle} (****${target.maskedNumber.slice(-4)}):\n` +
          txns.map((t) => `${new Date(t.ts).toLocaleDateString("en-KE")} ${t.direction === "debit" ? "−" : "+"} KES ${t.amount.toLocaleString()} — ${t.narrative}`).join("\n") +
          `\n\n(Detected model: the DS categoriser labelled the top narrative "${cat.category}" via ${cat.backend}.)`;
  } else {
    const target = handleMentioned ?? primary;
    const r = await callTool(ctx.session, "get_balance", { account_ref: target.handle });
    const data = (r.result as { data?: { balanceKes: number } }).data;
    toolCalls.push({ name: "get_balance", args: { account_ref: target.handle }, resultSummary: `KES ${data?.balanceKes?.toLocaleString()}` });
    reply =
      lang === "sw"
        ? `Salio lako kwa account ${target.handle}: KES ${(data?.balanceKes ?? 0).toLocaleString()}.`
        : `Your balance on account ${target.handle}: KES ${(data?.balanceKes ?? 0).toLocaleString()}.`;
  }

  trace(ctx, "account_tools", { tools: toolCalls.map((t) => t.name) });
  await appendEvent({
    sessionId: ctx.sessionId,
    actor: "system:account_tools",
    eventType: "tool_call",
    payload: { tools: toolCalls.map((t) => ({ name: t.name, args: t.args })) },
  });
  return { reply, toolCalls };
}

// ---------------------------------------------------------------------------
// Node: transfer flow (multi-turn: propose → otp → staged → hitl)
// ---------------------------------------------------------------------------

async function transferNode(ctx: RunCtx, input: string, lang: string): Promise<Partial<OrchestratorResult>> {
  // OTP submission is handled pre-route by runOrchestrator (completeOtpFlow).
  // Fresh transfer request → propose → policy gate
  const { proposal, method } = await proposeTransfer(ctx.sessionId, input);
  trace(ctx, "transfer_propose", { proposal, method });

  if (proposal.amountKes == null || !proposal.destinationType || !proposal.destination) {
    return {
      reply:
        lang === "sw"
          ? "Naweza kukusaidia kutuma pesa. Nambie: kiasi (kwa mfano 'KES 2,000'), njia (M-Pesa, ndani ya benki, au PesaLink) na namba ya mpokeaji."
          : "I can help you send money. Tell me: the amount (e.g. 'KES 2,000'), the channel (M-Pesa, internal, or PesaLink) and the recipient's number.",
      route: "transfer",
      kind: "transfer_needs_details",
    };
  }

  const gate = await policyGate(ctx.sessionId, proposal);
  await appendEvent({
    sessionId: ctx.sessionId,
    actor: "system:policy_check",
    eventType: "policy_check",
    payload: {
      amount_kes: proposal.amountKes,
      allowed: gate.allowed,
      reason: gate.allowed ? undefined : gate.reason,
      notes: gate.allowed ? gate.notes : undefined,
    },
  });
  trace(ctx, "policy_check", { allowed: gate.allowed, notes: gate.allowed ? gate.notes : [] });

  if (!gate.allowed) {
    const reason = gate.reason;
    let reply: string;
    if (String(reason).startsWith("new_beneficiary_cooling_off")) {
      reply =
        lang === "sw"
          ? `Mnunuzi huyu ni mpya — kwa usalama, lazima subiri dakika 30 kabla ya kutuma kwa mara ya kwanza. Nitakumbuka baada ya hapo.`
          : `${(proposal.beneficiaryName ?? "This recipient").toString()} is a new beneficiary, so a 30-minute cooling-off period applies before the first send (fraud control). Try again shortly — or send to an existing beneficiary now.`;
    } else if (String(reason).startsWith("exceeds_per_transaction_limit")) {
      reply = `This amount exceeds the per-transaction mobile limit of KES 70,000. Please visit a branch or split it across days (daily cap KES 200,000).`;
    } else if (String(reason).startsWith("exceeds_daily_limit")) {
      reply = `You've hit your daily transfer cap of KES 200,000. The limit resets at midnight.`;
    } else {
      reply = `I couldn't validate this transfer: ${reason}. A human officer can review it if you contact the bank.`;
    }
    return { reply, route: "transfer", kind: "transfer_policy_blocked" };
  }

  // C. Policy passed → step-up OTP
  const otp = await issueOtp(ctx.sessionId);
  await db.pendingAction.create({
    data: {
      sessionId: ctx.sessionId,
      kind: "intent_staged",
      payload: JSON.stringify({ proposal: { ...proposal, riskLevel: gate.riskLevel }, acctId: gate.acct.id }),
    },
  });
  await appendEvent({
    sessionId: ctx.sessionId,
    actor: "system:transfer",
    eventType: "otp_issued",
    payload: { amount_kes: proposal.amountKes, channel: proposal.destinationType },
  });
  // The demo SMS card: the code is only revealed when DEMO_MODE is on
  // (default on — synthetic channel; DEMO_MODE=false simulates real SMS).
  const demoCode = demoMode() ? otp.code : null;
  const codeHint =
    lang === "sw"
      ? demoCode
        ? ` (demo: msimbo ni ${demoCode})`
        : ""
      : demoCode
        ? ` (demo SMS gateway shows it here: ${demoCode})`
        : "";
  return {
    reply:
      (lang === "sw"
        ? `Unataka kutuma KES ${(proposal.amountKes ?? 0).toLocaleString()} kwa ${(proposal.beneficiaryName ?? proposal.destination ?? "").toString()} (${proposal.destinationType?.toUpperCase()}). `
        : `You're sending KES ${(proposal.amountKes ?? 0).toLocaleString()} to ${(proposal.beneficiaryName ?? proposal.destination ?? "").toString()} via ${proposal.destinationType?.toUpperCase()}${proposal.destination ? ` (${proposal.destination.replace(/.(?=.{4})/g, "*")})` : ""}. `) +
      (lang === "sw"
        ? `Kwa usalama, nimetuma msimbo wa 6 taratibu kwa simu yako${codeHint}. Ukitipe, tutaendelea.`
        : `For security I've sent a 6-digit code to your phone${codeHint}. Enter it to continue — the money moves only after a bank officer also approves.`),
    route: "transfer",
    kind: "otp_required",
    otp: { issued: true, devCode: demoCode ?? undefined, expiresInSeconds: 300 },
    pendingIntent: {
      amountKes: proposal.amountKes ?? 0,
      beneficiary: proposal.beneficiaryName ?? proposal.destination ?? "",
      destinationMasked: (proposal.destination ?? "").replace(/.(?=.{4})/g, "*"),
      state: "awaiting_otp",
    },
  };
}

// ---------------------------------------------------------------------------
// Node: idp flow — payslip → pre-qualification pack
// ---------------------------------------------------------------------------

async function idpNode(ctx: RunCtx, lang: string): Promise<Partial<OrchestratorResult>> {
  trace(ctx, "idp_flow", { action: "offer_upload" });
  return {
    reply:
      lang === "sw"
        ? "Kwa ajili ya mkopo, nitahitaji payslip yako (PDF au picha). Pakia faili hapa — nitoa taarifa muhimu, nikague kanuni za benki, kisha mfanyi maamuzi ataangalia (sio mimi kutoa maamuzi).\n\nBonyeza kitufe cha 'Payslip samples' chini ya kisanduku cha ujumbe kutumia sampuli za majaribio."
        : "For loan pre-qualification I'll need your latest payslip. Upload it below (or use a synthetic sample from the message box) — I extract the key figures, run the bank's validation rules (KRA PIN format, net vs gross, the one-third deduction rule) and produce a recommendation pack. A human credit officer makes the actual decision — I recommend, I don't approve.\n\nClick the 'Payslip samples' button under the input box to try one.",
    route: "idp",
    kind: "idp_offer",
  };
}

// ---------------------------------------------------------------------------
// Node: rag (delegates to lib/rag)
// ---------------------------------------------------------------------------

async function ragNode(ctx: RunCtx, input: string, lang: string): Promise<Partial<OrchestratorResult>> {
  const r = await ragAnswer({ sessionId: ctx.sessionId, session: ctx.session, input, lang: lang as "en" | "sw" });
  trace(ctx, "rag", {
    kind: r.kind,
    answerability: r.answerabilityScore,
    gate: r.gateThreshold,
    retrieval: r.retrieval,
  });
  await appendEvent({
    sessionId: ctx.sessionId,
    actor: "system:rag",
    eventType: r.kind === "handoff" ? "handoff_raised" : "rag_answer",
    payload: {
      answerability: r.answerabilityScore,
      gate: r.gateThreshold,
      chunks: r.retrieval.map((x) => x.chunkId),
      fee_tool: r.feeToolCall ? { name: r.feeToolCall.name, args: r.feeToolCall.args } : undefined,
      guard: r.guard,
      model: r.model,
      backend: r.backend,
      latency_ms: r.latencyMs,
    },
  });
  return {
    reply: r.answer,
    route: "rag",
    kind: r.kind === "handoff" ? "handoff" : r.kind === "fee_answer" ? "fee_answer" : "rag_answer",
    citations: r.citations,
    toolCalls: r.feeToolCall ? [{ name: r.feeToolCall.name, args: r.feeToolCall.args, resultSummary: JSON.stringify(r.feeToolCall.result) }] : undefined,
    guard: undefined as never,
    modelCalls: [{ tag: "rag", model: r.model, backend: r.backend, latencyMs: r.latencyMs, costUsd: 0 }],
  };
}

// ---------------------------------------------------------------------------
// Main graph runner
// ---------------------------------------------------------------------------

const REFUSAL_EN =
  "I can't act on that request — it attempts to override my operating rules. I'm built to answer bank policy questions, show balances and statements, and stage transfers that a human officer approves. What would you like to do within those?";
const REFUSAL_SW =
  "Siwezi kutekeleza ombi hilo — linajaribu kubadilisha kanuni zangu za uendeshaji. Ninajibu maswali ya sera ya benki, huonyesha salio na taarifa, na naandaa uhamisho unaoidhiniwa na afisa wa benki. Nini kingine naweza kusaidia?";

export async function runOrchestrator(sessionId: string, userMessage: string): Promise<OrchestratorResult> {
  const started = Date.now();
  const sess = await db.chatSession.findUnique({ where: { id: sessionId } });
  if (!sess) throw new Error("session not found");
  const session: Session = {
    sessionId,
    customerId: sess.customerId,
    scopes: ["accounts:read", "fees:read", "transfers:propose"],
  };
  const ctx: RunCtx = { sessionId, session, started, trace: [], modelCalls: [] };

  // ---- guard_in ----
  const g = await guardIn(ctx, userMessage);
  const baseGuard: OrchestratorResult["guard"] = {
    piiDetected: [...new Set(g.pii.map((p) => p.type))],
    injectionScore: g.inj.score,
    injectionSignals: g.inj.signals,
    blocked: g.blocked,
    lang: g.lang,
  };
  if (g.blocked) {
    await appendEvent({ sessionId, actor: `customer:${session.customerId}`, eventType: "refused", payload: { reason: g.reason, injection: g.inj.signals } });
    trace(ctx, "respond", { refusal: true });
    return {
      reply: g.lang === "sw" ? REFUSAL_SW : REFUSAL_EN,
      route: "guard",
      kind: "refusal",
      guard: { ...baseGuard, blocked: true },
      trace: ctx.trace,
      latencyMs: Date.now() - started,
      modelCalls: ctx.modelCalls,
    };
  }

  // ---- step-up OTP short-circuit: a bare 6-digit code while an OTP is
  //      pending is OTP submission — it never reaches the router/LLM. ----
  const pendingOtp = await db.pendingAction.findFirst({ where: { sessionId, kind: "otp_wait" } });
  if (pendingOtp && /^\d{6}$/.test(userMessage.trim())) {
    const code = userMessage.trim();
    trace(ctx, "otp_verify", { code: "[redacted]" });
    const otp = await completeOtpFlow(sessionId, code);
    if (otp.handled) {
      if (otp.ok) {
        trace(ctx, "hitl", { taskId: otp.task.id, risk: otp.riskLevel });
        const reply =
          g.lang === "sw"
            ? `Asante! Uthibitisho umekamilika. Ombi la kutuma KES ${otp.intent.amount.toLocaleString()} kwa ${otp.intent.beneficiaryName} linaangaliwa na afisa wa benki sasa — hali: INASUBIRI RIDHAA. Nitakuambia mara tu likikamilika.`
            : `Thank you — identity verified. Your request to send KES ${otp.intent.amount.toLocaleString()} to ${otp.intent.beneficiaryName} is now with a bank officer for approval (status: PENDING APPROVAL). I'll confirm the moment it completes.`;
        const latencyMs = Date.now() - started;
        const auditTip = await appendEvent({
          sessionId,
          actor: `customer:${session.customerId}`,
          eventType: "respond",
          payload: { kind: "transfer_pending_approval", route: "transfer", latency_ms: latencyMs },
        });
        await db.message.create({
          data: {
            sessionId,
            role: "assistant",
            content: reply,
            trace: JSON.stringify({
              route: "transfer",
              kind: "transfer_pending_approval",
              hitl: { taskId: otp.task.id, riskLevel: otp.riskLevel },
              latencyMs,
              auditChainTip: auditTip.hash,
            }),
          },
        });
        return {
          reply,
          route: "transfer",
          kind: "transfer_pending_approval",
          guard: { ...baseGuard },
          hitl: { taskId: otp.task.id, riskLevel: otp.riskLevel },
          pendingIntent: {
            amountKes: otp.intent.amount,
            beneficiary: otp.intent.beneficiaryName,
            destinationMasked: otp.intent.destination.replace(/.(?=.{4})/g, "*"),
            state: "pending_approval",
          },
          trace: ctx.trace,
          latencyMs,
          modelCalls: ctx.modelCalls,
          auditChainTip: auditTip.hash,
        };
      }
      const retryReply =
        g.lang === "sw"
          ? `Msimbo haujasajiliwa (${otp.reason}). Tafadhali jaribu tena — una majaribio machache.`
          : `That code didn't verify (${otp.reason}). Please try again.`;
      return {
        reply: retryReply,
        route: "transfer",
        kind: "otp_retry",
        guard: { ...baseGuard },
        trace: ctx.trace,
        latencyMs: Date.now() - started,
        modelCalls: ctx.modelCalls,
      };
    }
  }

  // ---- route ----
  const decision: RouteDecision = await routeIntent(userMessage, sessionId);
  trace(ctx, "route", { route: decision.route, confidence: decision.confidence, method: decision.method, lang: decision.lang });
  await appendEvent({
    sessionId,
    actor: "system:route",
    eventType: "route",
    payload: { route: decision.route, confidence: decision.confidence, method: decision.method, lang: decision.lang },
  });

  // ---- branch nodes ----
  let outcome: Partial<OrchestratorResult> = {};
  switch (decision.route) {
    case "account":
      outcome = await accountNode(ctx, userMessage, decision.lang);
      break;
    case "transfer":
      outcome = await transferNode(ctx, userMessage, decision.lang);
      break;
    case "idp":
      outcome = await idpNode(ctx, decision.lang);
      break;
    case "rag":
    default:
      outcome = await ragNode(ctx, userMessage, decision.lang);
      break;
  }

  // ---- guard_out on any generated text (answer-channel journeys) ----
  const outputGuardResult = { groundednessScore: 1, pass: true };
  if (outcome.kind === "rag_answer") {
    const sources = (outcome.citations ?? []).map((c) => c.snippet ?? "");
    const og = guardOut({ answer: outcome.reply ?? "", sources, userLang: decision.lang, answerLang: decision.lang });
    outputGuardResult.groundednessScore = og.groundednessScore;
    outputGuardResult.pass = og.pass;
    if (!og.pass) {
      outcome.reply =
        "I generated an answer I couldn't fully ground in the bank's documents, so I'm withholding it and handing this to a human colleague instead.";
      outcome.kind = "handoff";
    }
    await appendEvent({ sessionId, actor: "system:guard_out", eventType: "guard_out", payload: { groundedness: og.groundednessScore, pass: og.pass, pii_leak: og.piiLeaked, advice: og.adviceViolations } });
    trace(ctx, "guard_out", { groundedness: og.groundednessScore, pass: og.pass });
  }

  // ---- respond + persist ----
  const latencyMs = Date.now() - started;
  const result: OrchestratorResult = {
    reply: outcome.reply ?? "",
    route: decision.route,
    kind: outcome.kind ?? "answer",
    citations: outcome.citations,
    toolCalls: outcome.toolCalls,
    guard: { ...baseGuard, outputGuard: outputGuardResult },
    hitl: outcome.hitl,
    otp: outcome.otp,
    pendingIntent: outcome.pendingIntent,
    trace: ctx.trace,
    latencyMs,
    modelCalls: [...ctx.modelCalls, ...(outcome.modelCalls ?? [])],
  };

  const auditTip = await appendEvent({
    sessionId,
    actor: "system:respond",
    eventType: "respond",
    payload: {
      kind: result.kind,
      route: result.route,
      latency_ms: latencyMs,
      models: result.modelCalls.map((m) => ({ tag: m.tag, model: m.model, backend: m.backend })),
      cost_usd: result.modelCalls.reduce((a, m) => a + (m.costUsd ?? 0), 0),
    },
  });
  result.auditChainTip = auditTip.hash;

  await db.message.create({
    data: {
      sessionId,
      role: "assistant",
      content: result.reply,
      trace: JSON.stringify({
        route: result.route,
        kind: result.kind,
        guard: result.guard,
        citations: result.citations,
        toolCalls: result.toolCalls,
        hitl: result.hitl,
        latencyMs: result.latencyMs,
        modelCalls: result.modelCalls,
        auditChainTip: result.auditChainTip,
        traceEvents: result.trace,
      }),
    },
  });

  return result;
}
