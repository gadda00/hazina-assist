/**
 * Transfer flow — the model PROPOSES, it never moves money.
 *
 * propose (extract structured TransferIntent) → deterministic policy check
 * (caps + new-beneficiary cooling-off) → step-up OTP (outside LLM context)
 * → HMAC-signed intent (short TTL, single-use nonce) → HITL approval task
 * → execute node verifies signature/expiry/nonce and calls the core API with
 * an idempotency key.
 */
import { db } from "@/lib/db";
import { signIntent, verifyIntent, checkTransferPolicy, DEFAULT_LIMITS } from "@hazina/kit";
import { gatewayChat } from "@/lib/gateway";
import { appendEvent } from "@/lib/audit";
import { coreTransfer } from "@/lib/banking";
import { randomUUID } from "node:crypto";

export interface TransferProposal {
  fromAccountHandle: string | null;
  beneficiaryName: string | null;
  destinationType: "mpesa" | "internal" | "pesalink" | null;
  destination: string | null;
  amountKes: number | null;
  purpose: string | null;
}

const AMOUNT_RE = /(?:kes|ksh|shilingi)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b/i;

const MPESA_RE = /(\+?254[17]\d{8}|(?<!\d)0[17]\d{8}(?!\d))/;
const PESALINK_RE = /(pesalink|other bank|equity|kcb|absa|dtb|stanbic|family bank)/i;
const INTERNAL_RE = /(internal|same bank|co-?op|hazina|within the bank|kwenda hazina)/i;

function parseAmountKes(text: string): number | null {
  const m = text.match(AMOUNT_RE);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(v)) return null;
  if ((m[2] || "").toLowerCase() === "k") return v * 1000; // "15k", "2k kwa Jane"
  return v;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
  if (/^\+?254[17]\d{8}$/.test(digits)) {
    const local = digits.replace(/^\+?254/, "");
    return `+254${local}`;
  }
  return null;
}

/** Structured extraction via deterministic rules first; LLM only fills gaps. */
export async function proposeTransfer(
  sessionId: string,
  input: string
): Promise<{ proposal: TransferProposal; method: "rules" | "rules+llm"; policyNotes: string[] }> {
  const proposal: TransferProposal = {
    fromAccountHandle: null,
    beneficiaryName: null,
    destinationType: null,
    destination: null,
    amountKes: null,
    purpose: null,
  };

  proposal.amountKes = parseAmountKes(input);

  const mpesa = input.match(MPESA_RE);
  if (mpesa) {
    proposal.destinationType = "mpesa";
    proposal.destination = normalizePhone(mpesa[1]);
  } else if (PESALINK_RE.test(input)) {
    proposal.destinationType = "pesalink";
  } else if (INTERNAL_RE.test(input)) {
    proposal.destinationType = "internal";
  }

  // Beneficiary name heuristics: "to Jane", "kwa Jane", "send X to NAME on/at ..."
  const nameMatch =
    input.match(/\b(?:to|kwa|for|kwa ajili ya)\s+([A-Z][a-zA-Z'’-]{1,20}(?:\s+[A-Z][a-zA-Z'’-]{1,20})?)/) ??
    input.match(/\b(?:to|kwa)\s+([a-z]{2,15})\s+(?:on|at|kwa)\s+(?:mpesa|m-pesa|phone|simu)/i);
  if (nameMatch) proposal.beneficiaryName = nameMatch[1];

  if (/(rent|deki|fare|chool|school fees|bill|kplc|water|shopping|matunda|chakula)/i.test(input)) {
    proposal.purpose = input.match(/(rent|school fees|bill|kplc|water|shopping|fare)/i)?.[1] ?? null;
  }

  // Default account: the customer's first current account (server-side)
  const sess = await db.chatSession.findUnique({ where: { id: sessionId }, include: { customer: { include: { accounts: true } } } });
  const primary = sess?.customer.accounts.find((a) => a.type === "current") ?? sess?.customer.accounts[0];
  proposal.fromAccountHandle = primary?.handle ?? null;
  if (proposal.destinationType === "internal" && !proposal.destination && primary) {
    // internal transfers to "my savings" style intents default to the customer's other account
    const other = sess?.customer.accounts.find((a) => a.id !== primary.id);
    if (other) proposal.destination = other.rawNumber;
  }

  // LLM gap-fill for missing fields (constrained JSON)
  const missing = !proposal.amountKes || !proposal.destinationType || !proposal.destination;
  let method: "rules" | "rules+llm" = "rules";
  if (missing) {
    method = "rules+llm";
    const g = await gatewayChat(
      [
        {
          role: "system",
          content:
            'Extract a money-transfer instruction to JSON with keys amount (number, KES), destination_type ("mpesa"|"internal"|"pesalink"), destination (string), beneficiary_name (string). Use null for unknown values. Reply with JSON only.',
        },
        { role: "user", content: input },
      ],
      { sessionId, tag: "transfer_extract" }
    );
    if (g.backend === "external") {
      try {
        const j = JSON.parse(g.content.replace(/```json?|```/g, "").trim());
        if (proposal.amountKes == null && typeof j.amount === "number") proposal.amountKes = j.amount;
        if (!proposal.destinationType && j.destination_type) proposal.destinationType = j.destination_type;
        if (!proposal.destination && j.destination) proposal.destination = String(j.destination);
        if (!proposal.beneficiaryName && j.beneficiary_name) proposal.beneficiaryName = String(j.beneficiary_name);
      } catch { /* keep rules-only result */ }
    }
  }

  return { proposal, method, policyNotes: [] };
}

/** Deterministic policy gate before any OTP / signing happens. */
export async function policyGate(sessionId: string, p: TransferProposal) {
  const sess = await db.chatSession.findUnique({ where: { id: sessionId }, include: { customer: true } });
  if (!sess) return { allowed: false as const, reason: "no_session" };

  const acct = await db.account.findUnique({ where: { handle: p.fromAccountHandle ?? "" } });
  if (!acct || acct.customerId !== sess.customerId) return { allowed: false as const, reason: "account_not_found" };

  // today's outbound total
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const todays = await db.transaction.findMany({
    where: { accountId: acct.id, direction: "debit", type: "transfer_out", ts: { gte: startOfDay }, status: "completed" },
  });
  const executedToday = todays.reduce((a, t) => a + t.amount, 0);

  // beneficiary state
  let beneficiary = null as { id: string; firstUsedAt: Date | null } | null;
  if (p.destination) {
    const b = await db.beneficiary.findFirst({
      where: { customerId: sess.customerId, destination: p.destination },
    });
    beneficiary = b ? { id: b.id, firstUsedAt: b.firstUsedAt } : null;
  }
  // Own-account internal transfers are not "new beneficiaries"
  const ownInternal =
    p.destinationType === "internal" &&
    !!(await db.account.findFirst({ where: { customerId: sess.customerId, rawNumber: p.destination ?? "" } }));
  const beneficiaryAgeMinutes = ownInternal
    ? 100_000
    : p.destination == null
      ? 0 // unknown destination will fail later anyway
      : beneficiary?.firstUsedAt
        ? (Date.now() - beneficiary.firstUsedAt.getTime()) / 60000
        : null;

  const decision = checkTransferPolicy(
    { amountKes: p.amountKes ?? 0, executedTodayKes: executedToday, beneficiaryAgeMinutes },
    DEFAULT_LIMITS
  );
  return { allowed: decision.allowed as boolean, decision, acct, beneficiary, executedToday };
}

// ---------------------------------------------------------------------------
// OTP step-up (mock channel, outside the LLM context)
// ---------------------------------------------------------------------------

export async function issueOtp(sessionId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  await db.otpCode.create({ data: { sessionId, code, expiresAt } });
  await db.pendingAction.deleteMany({ where: { sessionId, kind: "otp_wait" } });
  await db.pendingAction.create({ data: { sessionId, kind: "otp_wait", payload: JSON.stringify({ issuedAt: Date.now() }) } });
  return { code, expiresAt };
}

export async function verifyOtp(sessionId: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  const pending = await db.pendingAction.findFirst({ where: { sessionId, kind: "otp_wait" } });
  if (!pending) return { ok: false, reason: "no_otp_pending" };
  const otp = await db.otpCode.findFirst({
    where: { sessionId, consumed: false },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return { ok: false, reason: "no_otp_pending" };
  if (otp.expiresAt < new Date()) return { ok: false, reason: "otp_expired" };
  if (otp.attempts >= 3) return { ok: false, reason: "otp_locked" };
  if (otp.code !== code.trim()) {
    await db.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: "otp_wrong" };
  }
  await db.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });
  await db.pendingAction.deleteMany({ where: { sessionId, kind: "otp_wait" } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Signed intent + HITL staging
// ---------------------------------------------------------------------------

const INTENT_SECRET = process.env.HAZINA_INTENT_SECRET ?? "dev-only-secret-rotate-me";

/**
 * OTP step-up completion — called by the orchestrator BEFORE routing when a
 * 6-digit code arrives while an OTP is pending. Verifies the code, stages the
 * signed intent, and raises the HITL approval task.
 */
export async function completeOtpFlow(sessionId: string, code: string) {
  const pendingOtp = await db.pendingAction.findFirst({ where: { sessionId, kind: "otp_wait" } });
  if (!pendingOtp) return { handled: false as const };
  const staged = await db.pendingAction.findFirst({ where: { sessionId, kind: "intent_staged" } });
  const p = staged ? (JSON.parse(staged.payload) as { proposal: Record<string, unknown>; acctId: string }) : null;
  const v = await verifyOtp(sessionId, code);
  if (!v.ok) {
    return {
      handled: true as const,
      ok: false as const,
      reason: v.reason,
    };
  }
  if (!p) return { handled: true as const, ok: false as const, reason: "no_staged_intent" };
  const intent = await stageSignedIntent(sessionId, p.proposal as never, p.acctId);
  await db.pendingAction.deleteMany({ where: { sessionId } });
  const task = await createApprovalForIntent(intent.id, (p.proposal as { riskLevel?: string }).riskLevel ?? "low");
  return {
    handled: true as const,
    ok: true as const,
    intent,
    task,
    riskLevel: task.riskLevel,
  };
}

export async function stageSignedIntent(sessionId: string, p: TransferProposal, acctId: string) {
  const intentPayload = {
    from_account_id: acctId,
    beneficiary_name: p.beneficiaryName ?? "unverified",
    destination_type: p.destinationType ?? "mpesa",
    destination: p.destination ?? "unverified",
    amount_kes: p.amountKes ?? 0,
    currency: "KES",
    purpose: p.purpose ?? null,
  };
  const signed = signIntent(INTENT_SECRET, sessionId, intentPayload, 900); // 15-min TTL for the demo
  const intent = await db.transferIntent.create({
    data: {
      sessionId,
      fromAccountId: acctId,
      beneficiaryName: intentPayload.beneficiary_name,
      destinationType: intentPayload.destination_type,
      destination: intentPayload.destination,
      amount: intentPayload.amount_kes,
      purpose: intentPayload.purpose,
      signedBody: JSON.stringify(signed.body),
      sig: signed.sig,
      nonce: signed.body.nonce,
      exp: signed.body.exp,
      status: "otp_verified",
    },
  });
  await appendEvent({
    sessionId,
    actor: "system:transfer",
    eventType: "intent_signed",
    payload: { intentId: intent.id, amount_kes: intentPayload.amount_kes, ttl: 900 },
  });
  return intent;
}

export async function createApprovalForIntent(intentId: string, riskLevel: string) {
  const intent = await db.transferIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new Error("intent missing");
  const sess = await db.chatSession.findUnique({ where: { id: intent.sessionId }, include: { customer: true } });
  const acct = await db.account.findUnique({ where: { id: intent.fromAccountId } });
  const task = await db.approvalTask.create({
    data: {
      sessionId: intent.sessionId,
      type: "transfer",
      refId: intent.id,
      riskLevel,
      payload: JSON.stringify({
        customer: sess?.customer.name ?? "customer",
        fromAccount: acct?.maskedNumber,
        beneficiary: intent.beneficiaryName,
        destinationType: intent.destinationType,
        destination: intent.destination.replace(/.(?=.{4})/g, "*"),
        amountKes: intent.amount,
        purpose: intent.purpose,
        intentId: intent.id,
      }),
    },
  });
  await db.transferIntent.update({ where: { id: intentId }, data: { status: "pending_approval" } });
  await appendEvent({
    sessionId: intent.sessionId,
    actor: "system:hitl",
    eventType: "hitl_raised",
    payload: { taskId: task.id, type: "transfer", amount_kes: intent.amount, risk: riskLevel },
  });
  return task;
}

/** The EXECUTE node: verify signature, expiry, nonce — then idempotent core call. */
export async function executeIntent(intentId: string, approver: string) {
  const intent = await db.transferIntent.findUnique({ where: { id: intentId } });
  if (!intent) return { ok: false, reason: "intent_missing" };
  if (intent.status === "executed") return { ok: false, reason: "already_executed" };

  const signed = { body: JSON.parse(intent.signedBody) as { sid: string; intent: Record<string, unknown>; exp: number; nonce: string }, sig: intent.sig };
  const v = await verifyIntent(INTENT_SECRET, signed, intent.sessionId, {
    isNonceUsed: async (n) => {
      const used = await db.transferIntent.findFirst({ where: { nonce: n, status: "executed" } });
      return !!used;
    },
  });
  if (!v.ok) {
    await db.transferIntent.update({ where: { id: intentId }, data: { status: "expired" } });
    await appendEvent({ sessionId: intent.sessionId, actor: `approver:${approver}`, eventType: "execute_rejected", payload: { intentId, reason: v.reason } });
    return { ok: false, reason: v.reason };
  }

  const idempotencyKey = `MSG-${intent.nonce.toUpperCase()}`;
  const res = await coreTransfer({
    fromAccountId: intent.fromAccountId,
    amountKes: intent.amount,
    destinationType: intent.destinationType as "internal" | "mpesa" | "pesalink",
    destination: intent.destination,
    beneficiaryName: intent.beneficiaryName,
    purpose: intent.purpose ?? undefined,
    idempotencyKey,
  });

  if (res.status === "success" || res.status === "duplicate") {
    await db.transferIntent.update({
      where: { id: intentId },
      data: { status: "executed", executedTxnRef: res.data?.txnRef, idempotencyKey },
    });
    // record first use of beneficiary
    const sess = await db.chatSession.findUnique({ where: { id: intent.sessionId } });
    if (sess) {
      const b = await db.beneficiary.findFirst({ where: { customerId: sess.customerId, destination: intent.destination } });
      if (b && !b.firstUsedAt) {
        await db.beneficiary.update({ where: { id: b.id }, data: { firstUsedAt: new Date() } });
      } else if (!b) {
        await db.beneficiary.create({
          data: {
            customerId: sess.customerId,
            name: intent.beneficiaryName,
            destinationType: intent.destinationType,
            destination: intent.destination,
            firstUsedAt: new Date(),
          },
        });
      }
    }
    await appendEvent({
      sessionId: intent.sessionId,
      actor: `approver:${approver}`,
      eventType: "transfer_executed",
      payload: { intentId, txnRef: res.data?.txnRef, amount_kes: intent.amount, idempotencyKey, status: res.status },
    });
    return { ok: true, txnRef: res.data?.txnRef, feeKes: res.data?.feeKes, messageRef: idempotencyKey };
  }
  await appendEvent({
    sessionId: intent.sessionId,
    actor: `approver:${approver}`,
    eventType: "transfer_failed",
    payload: { intentId, responseCode: res.responseCode },
  });
  return { ok: false, reason: res.responseCode };
}
