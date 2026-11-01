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
import { coreTransfer, type CoreResult, type TransferInstruction } from "@/lib/banking";
import { isDemo, otpRevealEnabled } from "@/lib/deployment";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { toCents, parseAmountStrictKes as strictAmount } from "@/lib/money";
import { z } from "zod";

export type DestinationType = "mpesa" | "internal" | "pesalink";

const DestTypeSchema = z.enum(["mpesa", "internal", "pesalink"]);

/** LLM gap-fill output must validate against this schema — never trusted raw. */
const LlmExtractionSchema = z.object({
  amount: z.number().finite().nonnegative().nullable().optional(),
  destination_type: DestTypeSchema.nullable().optional(),
  destination: z.string().min(3).max(120).nullable().optional(),
  beneficiary_name: z.string().min(1).max(80).nullable().optional(),
});

export interface TransferProposal {
  fromAccountHandle: string | null;
  beneficiaryName: string | null;
  destinationType: DestinationType | null;
  destination: string | null;
  amountKes: number | null;
  purpose: string | null;
}

const AMOUNT_RE = /(?:kes|ksh|shilingi)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b/i;

const MPESA_RE = /(\+?254[17]\d{8}|(?<!\d)0[17]\d{8}(?!\d))/;
const PESALINK_RE = /(pesalink|other bank|equity|kcb|absa|dtb|stanbic|family bank)/i;
const INTERNAL_RE = /(internal|same bank|co-?op|hazina|within the bank|kwenda hazina)/i;

function parseAmountFromText(text: string): number | null {
  const m = text.match(AMOUNT_RE);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(v)) return null;
  // "15k", "2k kwa Jane" — thousands suffix; all money goes through the
  // STRICT cents validator: sub-cent precision is refused, never rounded
  // silently into a persisted transfer (deep-review P1-5).
  return strictAmount((m[2] || "").toLowerCase() === "k" ? v * 1000 : v);
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

  proposal.amountKes = parseAmountFromText(input);

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
  const sess = await db.chatSession.findUnique({
    where: { id: sessionId },
    include: { customer: { include: { accounts: true, beneficiaries: true } } },
  });
  const primary = sess?.customer.accounts.find((a) => a.type === "current") ?? sess?.customer.accounts[0];
  proposal.fromAccountHandle = primary?.handle ?? null;
  if (proposal.destinationType === "internal" && !proposal.destination && primary) {
    // internal transfers to "my savings" style intents default to the customer's other account
    const other = sess?.customer.accounts.find((a) => a.id !== primary.id);
    if (other) proposal.destination = other.rawNumber;
  }

  // Saved-beneficiary resolution: when the customer names a payee on file
  // ("Tuma 2500 kwa Jane"), the channel + destination come from the
  // beneficiary record — no number re-entry for established payees, and the
  // deterministic path stays LLM-free. Full-name or first-name match,
  // case-insensitive.
  if (proposal.beneficiaryName && !proposal.destination && sess) {
    const mentioned = proposal.beneficiaryName.toLowerCase();
    const saved = sess.customer.beneficiaries.find((b) => {
      const name = b.name.toLowerCase();
      const first = name.split(/\s+/)[0];
      return name === mentioned || first === mentioned;
    });
    if (saved) {
      const savedType = DestTypeSchema.safeParse(saved.destinationType);
      proposal.destinationType = proposal.destinationType ?? (savedType.success ? savedType.data : null);
      proposal.destination = proposal.destination ?? saved.destination;
      proposal.beneficiaryName = saved.name;
    }
  }

  // LLM gap-fill for missing fields (constrained JSON, schema-validated —
  // an unexpected shape is discarded, never cast)
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
        const raw = JSON.parse(g.content.replace(/```json?|```/g, "").trim()) as unknown;
        const j = LlmExtractionSchema.parse(raw); // unsafe shape → caught below
        if (proposal.amountKes == null && j.amount != null) {
          // STRICT boundary: LLM-gap-filled amounts must be exactly
          // representable in cents (finite, positive, ≤2dp, in range).
          proposal.amountKes = strictAmount(j.amount);
        }
        if (!proposal.destinationType && j.destination_type) proposal.destinationType = j.destination_type;
        if (!proposal.destination && j.destination) proposal.destination = j.destination;
        if (!proposal.beneficiaryName && j.beneficiary_name) proposal.beneficiaryName = j.beneficiary_name;
      } catch { /* keep rules-only result */ }
    }
  }

  return { proposal, method, policyNotes: [] };
}

/** Deterministic policy gate before any OTP / signing happens.
 *  Discriminated result: consumers narrow via `allowed` — no unsafe casts. */
export type PolicyGateResult =
  | { allowed: false; reason: string; executedToday: number }
  | {
      allowed: true;
      riskLevel: "low" | "medium";
      notes: string[];
      acct: { id: string; handle: string; maskedNumber: string };
      beneficiary: { id: string; firstUsedAt: Date | null } | null;
      executedToday: number;
    };

export async function policyGate(sessionId: string, p: TransferProposal): Promise<PolicyGateResult> {
  const sess = await db.chatSession.findUnique({ where: { id: sessionId }, include: { customer: true } });
  if (!sess) return { allowed: false, reason: "no_session", executedToday: 0 };

  const acct = await db.account.findUnique({ where: { handle: p.fromAccountHandle ?? "" } });
  if (!acct || acct.customerId !== sess.customerId) {
    return { allowed: false, reason: "account_not_found", executedToday: 0 };
  }

  // today's outbound total — summed in cents, no float drift
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const todays = await db.transaction.findMany({
    where: { accountId: acct.id, direction: "debit", type: "transfer_out", ts: { gte: startOfDay }, status: "completed" },
  });
  const executedToday = toCents(todays.reduce((a, t) => a + t.amount, 0)) / 100;

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
  if (!decision.allowed) {
    return { allowed: false, reason: decision.reason, executedToday };
  }
  return {
    allowed: true,
    riskLevel: decision.riskLevel,
    notes: decision.notes,
    acct: { id: acct.id, handle: acct.handle, maskedNumber: acct.maskedNumber },
    beneficiary,
    executedToday,
  };
}

// ---------------------------------------------------------------------------
// OTP step-up (mock channel, outside the LLM context)
//
// Cryptographically random code, bound to the staged intent (session +
// staged action + destination + amount + beneficiary), single-active (a new
// issuance consumes every earlier code), 5-minute expiry, 3-attempt lockout,
// issue cooldown + per-hour issuance cap, and HASH-ONLY STORAGE: the DB keeps
// a keyed HMAC of the code, never the plaintext (deep-review P1-8).
// The code is only ever returned to the caller at ISSUANCE time when the demo
// OTP reveal is enabled (demo mode default; DEMO_MODE=false hides it — and in
// operational mode transfers refuse to run at all without a real delivery
// provider, see src/lib/deployment.ts — hiding a code is NOT an SMS).
// ---------------------------------------------------------------------------

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 3;

/** Demo OTP reveal: the 6-digit code is shown in the chat UI as the
 *  synthetic "SMS channel". Demo mode only — never in operational mode. */
export function demoMode(): boolean {
  return otpRevealEnabled();
}

/** Issue/verify rate limits — runtime-overridable so tests can exercise the
 *  limits deterministically without sleeping. Production defaults: 30s
 *  resend cooldown, 5 codes per session per hour (deep-review P1-8). */
function otpLimits(): { cooldownMs: number; maxPerHour: number } {
  const int = (v: string | undefined, d: number) => {
    const n = parseInt(v ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    cooldownMs: int(process.env.HAZINA_OTP_COOLDOWN_MS, 30_000),
    maxPerHour: int(process.env.HAZINA_OTP_MAX_PER_HOUR, 5),
  };
}

/** Domain-separated HMAC key for OTP hashing + binding fingerprints. */
function otpHashKey(): string {
  const secret = process.env.HAZINA_OTP_HASH_KEY?.trim() || process.env.HAZINA_INTENT_SECRET?.trim();
  // in operational mode the deployment boundary guarantees a real secret;
  // in demo mode the dev fallback keeps the synthetic flow runnable.
  return secret ?? "dev-only-secret-rotate-me";
}

function hashCode(code: string): string {
  return createHmac("sha256", otpHashKey()).update(`otp-code:v1:${code.trim()}`).digest("hex");
}

function codesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Shape of the staged intent a pending action carries. */
interface StagedProposal {
  destination: string | null;
  amountKes: number | null;
  beneficiaryName: string | null;
}

async function readStagedProposal(
  sessionId: string
): Promise<{ stagedActionId: string | null; proposal: StagedProposal | null }> {
  const staged = await db.pendingAction.findFirst({ where: { sessionId, kind: "intent_staged" } });
  if (!staged) return { stagedActionId: null, proposal: null };
  const parsed = StagedIntentSchema.safeParse(JSON.parse(staged.payload) as unknown);
  return {
    stagedActionId: staged.id,
    proposal: parsed.success
      ? {
          destination: parsed.data.proposal.destination ?? null,
          amountKes: parsed.data.proposal.amountKes ?? null,
          beneficiaryName: parsed.data.proposal.beneficiaryName ?? null,
        }
      : null,
  };
}

/** Binding fingerprint: session + staged intent + destination + amount +
 *  beneficiary. A code issued for one transaction summary can never verify a
 *  modified destination or amount (deep-review P1-8). */
function intentFingerprint(
  sessionId: string,
  stagedActionId: string | null,
  p: StagedProposal | null
): string | null {
  return createHmac("sha256", otpHashKey())
    .update(
      `otp-bind:v1:${sessionId}:${stagedActionId ?? "none"}:${p?.destination ?? ""}:${toCents(p?.amountKes ?? 0)}:${p?.beneficiaryName ?? ""}`
    )
    .digest("hex");
}

export type IssueOtpResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; reason: "cooldown" | "rate_limited"; retryInSeconds?: number };

export async function issueOtp(sessionId: string): Promise<IssueOtpResult> {
  const limits = otpLimits();
  // housekeeping: purge consumed codes older than a day (expiry sweep)
  await db.otpCode
    .deleteMany({ where: { consumed: true, expiresAt: { lt: new Date(Date.now() - 24 * 3600_000) } } })
    .catch(() => undefined);

  // the currently staged intent decides whether a new code is a RESEND (same
  // intent — cooldown applies) or a genuinely NEW transfer (supersedes the
  // pending code; blocking it would break legitimate banking usage).
  const { stagedActionId, proposal } = await readStagedProposal(sessionId);

  // issue rate limits (per session)
  const recent = await db.otpCode.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, consumed: true, stagedActionId: true },
  });
  if (recent && limits.cooldownMs > 0) {
    const isResendOfSameIntent =
      !recent.consumed && recent.stagedActionId !== null && recent.stagedActionId === stagedActionId;
    if (isResendOfSameIntent) {
      const since = Date.now() - recent.createdAt.getTime();
      if (since < limits.cooldownMs) {
        return { ok: false, reason: "cooldown", retryInSeconds: Math.ceil((limits.cooldownMs - since) / 1000) };
      }
    }
  }
  if (limits.maxPerHour > 0) {
    const hourAgo = new Date(Date.now() - 3600_000);
    const issuedLastHour = await db.otpCode.count({ where: { sessionId, createdAt: { gte: hourAgo } } });
    if (issuedLastHour >= limits.maxPerHour) {
      return { ok: false, reason: "rate_limited", retryInSeconds: 3600 };
    }
  }

  const code = String(randomInt(100_000, 1_000_000)); // crypto random, no Math.random
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  // invalidate every earlier code for this session (single active OTP)
  await db.otpCode.updateMany({
    where: { sessionId, consumed: false },
    data: { consumed: true },
  });
  // bind to the currently staged intent + its transaction summary
  await db.otpCode.create({
    data: {
      sessionId,
      codeHash: hashCode(code), // plaintext is never persisted
      expiresAt,
      stagedActionId,
      boundFingerprint: intentFingerprint(sessionId, stagedActionId, proposal),
      // delivery status never contains the code: demo reveal marks the
      // synthetic channel; the operational adapter's provider callback
      // updates this to delivered/failed with a provider message id.
      deliveryStatus: otpRevealEnabled() ? "demo_revealed" : "provider_pending",
    },
  });
  await db.pendingAction.deleteMany({ where: { sessionId, kind: "otp_wait" } });
  await db.pendingAction.create({ data: { sessionId, kind: "otp_wait", payload: JSON.stringify({ issuedAt: Date.now() }) } });
  return { ok: true, code, expiresAt };
}

export async function verifyOtp(sessionId: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  const pending = await db.pendingAction.findFirst({ where: { sessionId, kind: "otp_wait" } });
  if (!pending) return { ok: false, reason: "no_otp_pending" };
  const otp = await db.otpCode.findFirst({
    where: { sessionId, consumed: false },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return { ok: false, reason: "no_otp_pending" };
  // binding: the code must match the intent staged NOW — a restaged transfer
  // (new request after a failed/expired attempt) kills older codes
  const { stagedActionId, proposal } = await readStagedProposal(sessionId);
  if (otp.stagedActionId && stagedActionId !== otp.stagedActionId) {
    return { ok: false, reason: "otp_stale" };
  }
  if (
    otp.boundFingerprint &&
    otp.boundFingerprint !== intentFingerprint(sessionId, stagedActionId, proposal)
  ) {
    // destination / amount / beneficiary changed since issuance
    return { ok: false, reason: "otp_stale" };
  }
  if (otp.expiresAt < new Date()) return { ok: false, reason: "otp_expired" };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "otp_locked" };
  if (!codesEqual(hashCode(code), otp.codeHash)) {
    await db.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: "otp_wrong" };
  }
  // ATOMIC consumption: the conditional update claims the code exactly once,
  // so two simultaneous submissions of the same valid code can never both
  // pass (deep-review P1: step-up races).
  const consumed = await db.otpCode.updateMany({
    where: { id: otp.id, consumed: false },
    data: { consumed: true },
  });
  if (consumed.count !== 1) return { ok: false, reason: "otp_already_used" };
  await db.pendingAction.deleteMany({ where: { sessionId, kind: "otp_wait" } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Signed intent + HITL staging
// ---------------------------------------------------------------------------

/** HMAC key for intent signing. In demo mode a development fallback keeps
 *  the synthetic flow runnable; in operational mode a missing/known-default
 *  secret is a hard error (fail-closed — deep-review P0-3). */
const INTENT_SECRET = (() => {
  const s = process.env.HAZINA_INTENT_SECRET;
  if (s && s.trim()) return s;
  if (isDemo()) return "dev-only-secret-rotate-me";
  throw new Error(
    "[hazina] HAZINA_INTENT_SECRET is required in operational mode (refusing to sign intents with a development secret)"
  );
})();

/** Staged pending-action payload — schema-validated, never `as never`. */
const StagedIntentSchema = z.object({
  proposal: z.object({
    fromAccountHandle: z.string().nullable(),
    beneficiaryName: z.string().nullable(),
    destinationType: DestTypeSchema.nullable(),
    destination: z.string().nullable(),
    amountKes: z.number().finite().nonnegative().nullable(),
    purpose: z.string().nullable(),
    riskLevel: z.enum(["low", "medium", "high"]).optional(),
  }),
  acctId: z.string().min(1),
});
type StagedIntent = z.infer<typeof StagedIntentSchema>;

/**
 * OTP step-up completion — called by the orchestrator BEFORE routing when a
 * 6-digit code arrives while an OTP is pending. Verifies the code, stages the
 * signed intent, and raises the HITL approval task.
 */
export async function completeOtpFlow(sessionId: string, code: string) {
  const pendingOtp = await db.pendingAction.findFirst({ where: { sessionId, kind: "otp_wait" } });
  if (!pendingOtp) return { handled: false as const };
  const staged = await db.pendingAction.findFirst({ where: { sessionId, kind: "intent_staged" } });
  const parsedStage = staged
    ? StagedIntentSchema.safeParse(JSON.parse(staged.payload) as unknown)
    : null;
  const p = parsedStage?.success ? parsedStage.data : null;
  const v = await verifyOtp(sessionId, code);
  if (!v.ok) {
    return {
      handled: true as const,
      ok: false as const,
      reason: v.reason,
    };
  }
  if (!p) return { handled: true as const, ok: false as const, reason: "no_staged_intent" };
  const intent = await stageSignedIntent(sessionId, p.proposal, p.acctId);
  await db.pendingAction.deleteMany({ where: { sessionId } });
  const task = await createApprovalForIntent(intent.id, p.proposal.riskLevel ?? "low");
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

/**
 * The EXECUTE node — an explicit, durable state machine (deep-review P1-4):
 *
 *   pending_approval → executing → executed
 *                            ↘ execution_failed (retryable re-claim)
 *   staged/otp_verified → expired (signature/expiry/nonce failure)
 *
 * The intent is CLAIMED atomically (conditional updateMany) before the provider
 * call, so two concurrent executions cannot both run; a crash after the claim
 * leaves `executing` behind for reconcileStuckTasks() to resolve against the
 * durable intent state. The provider call goes through an injectable seam so
 * ambiguity ("timeout" — effect unknown) and retry semantics are EXPLICIT
 * rather than accidental.
 */
export type TransferProvider = (
  instr: TransferInstruction
) => Promise<CoreResult<{ txnRef: string; feeKes: number }>>;

/** The default provider: the mock core-banking adapter. Tests (and the
 *  operational adapter boundary) may inject fault-injecting or real providers
 *  via setTransferProvider — the executor's contract is unchanged. */
let transferProvider: TransferProvider = coreTransfer;

export function setTransferProvider(p: TransferProvider): void {
  transferProvider = p;
}

export function resetTransferProvider(): void {
  transferProvider = coreTransfer;
}

export type ExecuteResult =
  | { ok: true; txnRef?: string; feeKes?: number; messageRef: string; replayed?: boolean }
  | { ok: false; reason: string; retryable?: boolean };

/** Codes that can never succeed on retry (vs. funds/cap states that can). */
const PERMANENT_FAILURE_CODES = new Set(["ACCT-404"]);

export async function executeIntent(
  intentId: string,
  approver: string
): Promise<ExecuteResult> {
  const intent = await db.transferIntent.findUnique({ where: { id: intentId } });
  if (!intent) return { ok: false, reason: "intent_missing" };
  if (intent.status === "executed") {
    // idempotent replay: original receipt, flagged as replayed
    return {
      ok: true,
      txnRef: intent.executedTxnRef ?? undefined,
      feeKes: intent.executedFeeKes ?? undefined,
      messageRef: intent.idempotencyKey ?? `MSG-${intent.nonce.toUpperCase()}`,
      replayed: true,
    };
  }
  if (intent.status === "executing") {
    // another executor holds the intent (or crashed mid-flight — see the
    // reconciler); we refuse rather than pile on.
    return { ok: false, reason: "execution_in_progress" };
  }

  // --- guarded claim: exactly one executor transitions into `executing` ----
  // claimable: a fresh approval, or a retryable earlier failure
  const claimableStatuses = ["pending_approval", "execution_failed"];
  if (!claimableStatuses.includes(intent.status)) {
    return { ok: false, reason: `intent_not_claimable (${intent.status})` };
  }
  const claimed = await db.transferIntent.updateMany({
    where: { id: intentId, status: { in: claimableStatuses } },
    data: { status: "executing", executionAttempts: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    const now = await db.transferIntent.findUnique({ where: { id: intentId } });
    if (now?.status === "executed") return { ok: true, txnRef: now.executedTxnRef ?? undefined, feeKes: now.executedFeeKes ?? undefined, messageRef: now.idempotencyKey ?? `MSG-${now.nonce.toUpperCase()}`, replayed: true };
    return { ok: false, reason: "execution_in_progress" };
  }

  const signed = { body: JSON.parse(intent.signedBody) as { sid: string; intent: Record<string, unknown>; exp: number; nonce: string }, sig: intent.sig };
  const v = await verifyIntent(INTENT_SECRET, signed, intent.sessionId, {
    isNonceUsed: async (n) => {
      const used = await db.transferIntent.findFirst({ where: { nonce: n, status: "executed" } });
      return !!used;
    },
  });
  if (!v.ok) {
    await db.transferIntent.update({
      where: { id: intentId },
      data: { status: "expired", lastExecutionError: v.reason ?? "verification_failed" },
    });
    await appendEvent({ sessionId: intent.sessionId, actor: `approver:${approver}`, eventType: "execute_rejected", payload: { intentId, reason: v.reason } });
    return { ok: false, reason: v.reason ?? "verification_failed", retryable: false };
  }

  const idempotencyKey = `MSG-${intent.nonce.toUpperCase()}`;
  const instruction: TransferInstruction = {
    fromAccountId: intent.fromAccountId,
    amountKes: intent.amount,
    destinationType: intent.destinationType as "internal" | "mpesa" | "pesalink",
    destination: intent.destination,
    beneficiaryName: intent.beneficiaryName,
    purpose: intent.purpose ?? undefined,
    idempotencyKey,
  };

  let res = await transferProvider(instruction);
  if (res.status === "timeout") {
    // AMBIGUOUS provider outcome: the effect may or may not have landed.
    // The safe answer is exactly ONE retry with the SAME idempotency key —
    // the duplicate receipt resolves the ambiguity without double effects.
    await appendEvent({
      sessionId: intent.sessionId,
      actor: `approver:${approver}`,
      eventType: "execution_ambiguous",
      payload: { intentId, idempotencyKey, action: "single_idempotent_retry" },
    });
    res = await transferProvider(instruction);
  }

  if (res.status === "success" || res.status === "duplicate") {
    await db.transferIntent.update({
      where: { id: intentId },
      data: { status: "executed", executedTxnRef: res.data?.txnRef, executedFeeKes: res.data?.feeKes, idempotencyKey, lastExecutionError: null },
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
    return { ok: true, txnRef: res.data?.txnRef, feeKes: res.data?.feeKes, messageRef: idempotencyKey, replayed: res.status === "duplicate" };
  }

  // permanent / provider failure: honest failed state, retryability explicit
  const retryable = res.status === "timeout" || !PERMANENT_FAILURE_CODES.has(res.responseCode);
  const failStatus = retryable ? "execution_failed" : "expired";
  await db.transferIntent.update({
    where: { id: intentId },
    data: { status: failStatus, lastExecutionError: res.responseCode },
  });
  await appendEvent({
    sessionId: intent.sessionId,
    actor: `approver:${approver}`,
    eventType: "transfer_failed",
    payload: { intentId, responseCode: res.responseCode, retryable },
  });
  return { ok: false, reason: res.responseCode, retryable };
}
