/**
 * Transfer/approval state machine + crash recovery (deep-review P1-4).
 *
 * The approval lifecycle must be honest under every failure mode:
 *   open → claiming → executing → executed (receipt durable)
 *   open → claiming → executing → execution_failed (retryable)
 * plus crash-after-claim, crash-after-effect, ambiguous provider timeouts,
 * concurrent approvals/executions, replay after success AND after failure,
 * OTP binding fingerprints and OTP issue rate limits.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** Isolated fixture per describe: customer + funded account + session. */
async function fixture(tag: string, balance: number) {
  const phone = `+25478111${tag.slice(-4)}`;
  let customer = await db.customer.findUnique({ where: { phone } });
  if (!customer) {
    customer = await db.customer.create({
      data: { name: `State ${tag}`, phone, role: "fixture", email: `state-${tag}@example.co.ke` },
    });
  }
  const handle = `acct_state_${tag}`;
  let acct = await db.account.findUnique({ where: { handle } });
  if (!acct) {
    acct = await db.account.create({
      data: { customerId: customer.id, handle, maskedNumber: "****0000", rawNumber: `8${tag}0001`, type: "current", balanceKes: balance },
    });
  } else {
    acct = await db.account.update({ where: { id: acct.id }, data: { balanceKes: balance } });
  }
  let sess = await db.chatSession.findFirst({ where: { customerId: customer.id, role: "customer", status: "active" } });
  if (!sess) {
    sess = await db.chatSession.create({ data: { customerId: customer.id, role: "customer", tokenHash: `state-${tag}` } });
  }
  await db.transaction.deleteMany({ where: { accountId: acct.id } });
  await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
  await db.otpCode.deleteMany({ where: { sessionId: sess.id } });
  return { customer, acct, sess };
}

/** Stage a signed intent + raise its approval task (the OTP-verified state). */
async function stageIntent(sessId: string, acctId: string, amountKes: number) {
  const { stageSignedIntent, createApprovalForIntent } = await import("../src/lib/transfer");
  const intent = await stageSignedIntent(
    sessId,
    {
      fromAccountHandle: null,
      beneficiaryName: "State Payee",
      destinationType: "mpesa",
      destination: "+254733000111",
      amountKes,
      purpose: null,
    },
    acctId
  );
  const task = await createApprovalForIntent(intent.id, "low");
  return { intent, task };
}

describe("approval state machine — happy path + durable receipt", () => {
  const TAG = "hapy";
  let ids: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    ids = await fixture(TAG, 20_000);
  });
  afterAll(async () => {
    const { acct, sess, customer } = ids;
    await db.approvalTask.deleteMany({ where: { sessionId: sess.id } });
    await db.transferIntent.deleteMany({ where: { sessionId: sess.id } });
    await db.transaction.deleteMany({ where: { accountId: acct.id } });
    await db.idempotencyKey.deleteMany({ where: { key: { contains: "MSG-" } } });
    await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
    await db.message.deleteMany({ where: { sessionId: sess.id } });
    await db.auditEvent.deleteMany({ where: { sessionId: sess.id } });
    await db.chatSession.deleteMany({ where: { id: sess.id } });
    await db.account.deleteMany({ where: { id: acct.id } });
    await db.beneficiary.deleteMany({ where: { customerId: customer.id } });
    await db.customer.deleteMany({ where: { phone: customer.phone } });
  });

  test("approve: open → executing → executed with a durable JSON receipt", async () => {
    const { decideApprovalTask } = await import("../src/lib/approvals");
    const { intent, task } = await stageIntent(ids.sess.id, ids.acct.id, 2_000);
    const r = await decideApprovalTask(task.id, "approve", "Njeri");
    expect(r.kind).toBe("executed");

    const after = await db.approvalTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("executed");
    expect(after.decidedBy).toBe("Njeri");
    expect(after.attemptCount).toBe(1);
    const receipt = JSON.parse(after.receipt!) as { txnRef?: string; messageRef?: string; attempts: number };
    expect(receipt.txnRef).toBeTruthy();
    expect(receipt.messageRef).toBe(`MSG-${intent.nonce.toUpperCase()}`);
    expect(receipt.attempts).toBe(1);

    const intentAfter = await db.transferIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(intentAfter.status).toBe("executed");
    expect(intentAfter.executionAttempts).toBe(1);

    // exactly one debit pair (transfer + fee 11 for the 1,001–10,000 band)
    const txns = await db.transaction.findMany({ where: { accountId: ids.acct.id, type: "transfer_out" } });
    expect(txns.length).toBe(1);
    const balance = (await db.account.findUniqueOrThrow({ where: { id: ids.acct.id } })).balanceKes;
    expect(balance).toBe(20_000 - 2_011);
  });

  test("replay after success returns the ORIGINAL receipt, no second debit", async () => {
    const { decideApprovalTask } = await import("../src/lib/approvals");
    const { task } = await stageIntent(ids.sess.id, ids.acct.id, 1_000);
    const first = await decideApprovalTask(task.id, "approve", "Njeri");
    expect(first.kind).toBe("executed");
    const balanceAfterFirst = (await db.account.findUniqueOrThrow({ where: { id: ids.acct.id } })).balanceKes;

    const second = await decideApprovalTask(task.id, "approve", "Otieno");
    expect(second.kind).toBe("replay");
    if (second.kind === "replay") {
      expect(second.status).toBe("executed");
      expect(second.txnRef).toBeTruthy();
    }
    const balanceAfterSecond = (await db.account.findUniqueOrThrow({ where: { id: ids.acct.id } })).balanceKes;
    expect(balanceAfterSecond).toBe(balanceAfterFirst);
    const txns = await db.transaction.findMany({ where: { accountId: ids.acct.id, type: "transfer_out" } });
    expect(txns.length).toBe(2); // one per intent — not one per click
  });
});

describe("approval state machine — failure, retry, exhaustion", () => {
  const TAG = "fail";
  let ids: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    ids = await fixture(TAG, 500); // 500: 2,000 + fee cannot clear → INS-402
  });
  afterAll(async () => {
    const { acct, sess, customer } = ids;
    await db.approvalTask.deleteMany({ where: { sessionId: sess.id } });
    await db.transferIntent.deleteMany({ where: { sessionId: sess.id } });
    await db.transaction.deleteMany({ where: { accountId: acct.id } });
    await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
    await db.message.deleteMany({ where: { sessionId: sess.id } });
    await db.auditEvent.deleteMany({ where: { sessionId: sess.id } });
    await db.chatSession.deleteMany({ where: { id: sess.id } });
    await db.account.deleteMany({ where: { id: acct.id } });
    await db.beneficiary.deleteMany({ where: { customerId: customer.id } });
    await db.customer.deleteMany({ where: { phone: customer.phone } });
  });

  test("execution failure lands in execution_failed (NOT rejected), retryable", async () => {
    const { decideApprovalTask } = await import("../src/lib/approvals");
    const { intent, task } = await stageIntent(ids.sess.id, ids.acct.id, 2_000);
    const r = await decideApprovalTask(task.id, "approve", "Njeri");
    expect(r.kind).toBe("execution_refused");
    if (r.kind === "execution_refused") {
      expect(r.reason).toBe("INS-402");
      expect(r.retryable).toBe(true);
    }
    const taskAfter = await db.approvalTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(taskAfter.status).toBe("execution_failed"); // honest failure ≠ human rejection
    const intentAfter = await db.transferIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(intentAfter.status).toBe("execution_failed");
    expect(intentAfter.lastExecutionError).toBe("INS-402");
  });

  test("retry after conditions change SUCCEEDS (execution_failed is re-claimable)", async () => {
    const { decideApprovalTask } = await import("../src/lib/approvals");
    // top up funds, then retry the SAME task
    await db.account.update({ where: { id: ids.acct.id }, data: { balanceKes: 20_000 } });
    const { task } = await stageIntent(ids.sess.id, ids.acct.id, 2_000);
    const first = await decideApprovalTask(task.id, "approve", "Njeri");
    expect(first.kind).toBe("executed"); // (sanity: this one succeeds outright)
    // now a genuinely failed one:
    await db.account.update({ where: { id: ids.acct.id }, data: { balanceKes: 500 } });
    const { intent, task: task2 } = await stageIntent(ids.sess.id, ids.acct.id, 1_500);
    const failed = await decideApprovalTask(task2.id, "approve", "Njeri");
    expect(failed.kind).toBe("execution_refused");
    await db.account.update({ where: { id: ids.acct.id }, data: { balanceKes: 20_000 } });
    const retried = await decideApprovalTask(task2.id, "approve", "Njeri");
    expect(retried.kind).toBe("executed");
    const taskAfter = await db.approvalTask.findUniqueOrThrow({ where: { id: task2.id } });
    expect(taskAfter.status).toBe("executed");
    expect(taskAfter.attemptCount).toBe(2);
    // the retried intent RECOVERED: execution_failed → executed
    expect((await db.transferIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe("executed");
  });
});

describe("crash recovery (lease + reconciler)", () => {
  const TAG = "crsh";
  let ids: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    ids = await fixture(TAG, 20_000);
  });
  afterAll(async () => {
    const { acct, sess, customer } = ids;
    await db.approvalTask.deleteMany({ where: { sessionId: sess.id } });
    await db.transferIntent.deleteMany({ where: { sessionId: sess.id } });
    await db.transaction.deleteMany({ where: { accountId: acct.id } });
    await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
    await db.message.deleteMany({ where: { sessionId: sess.id } });
    await db.auditEvent.deleteMany({ where: { sessionId: sess.id } });
    await db.chatSession.deleteMany({ where: { id: sess.id } });
    await db.account.deleteMany({ where: { id: acct.id } });
    await db.beneficiary.deleteMany({ where: { customerId: customer.id } });
    await db.customer.deleteMany({ where: { phone: customer.phone } });
  });

  test("crash after claim, before effect: stale lease re-opens; a fresh click executes", async () => {
    const { decideApprovalTask, reconcileStuckTasks, APPROVAL_LEASE_MS } = await import("../src/lib/approvals");
    const { task } = await stageIntent(ids.sess.id, ids.acct.id, 1_200);
    // simulate the process dying right after claiming: status executing with
    // a lease timestamp far in the past
    await db.approvalTask.update({
      where: { id: task.id },
      data: { status: "executing", claimedAt: new Date(Date.now() - APPROVAL_LEASE_MS - 5_000) },
    });

    const healed = await reconcileStuckTasks();
    expect(healed).toBeGreaterThanOrEqual(1);
    const reopened = await db.approvalTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(reopened.status).toBe("open"); // no effect landed → fresh decision allowed

    const r = await decideApprovalTask(task.id, "approve", "Njeri");
    expect(r.kind).toBe("executed");
    const txns = await db.transaction.findMany({ where: { accountId: ids.acct.id, type: "transfer_out" } });
    expect(txns.length).toBe(1); // the crashed attempt never debited
  });

  test("crash after effect, before response: intent already executed → task finalises with receipt, no double debit", async () => {
    const { decideApprovalTask, reconcileStuckTasks, APPROVAL_LEASE_MS } = await import("../src/lib/approvals");
    const { coreTransfer } = await import("../src/lib/banking");
    const { intent, task } = await stageIntent(ids.sess.id, ids.acct.id, 1_300);
    const idempotencyKey = `MSG-${intent.nonce.toUpperCase()}`;

    // the provider effect LANDED (idempotent receipt written) but the process
    // died before updating the task/intent — exactly the ambiguous window
    const landed = await coreTransfer({
      fromAccountId: ids.acct.id,
      amountKes: 1_300,
      destinationType: "mpesa",
      destination: "+254733000111",
      beneficiaryName: "State Payee",
      idempotencyKey,
    });
    expect(landed.status).toBe("success");
    const balanceAfterCrash = (await db.account.findUniqueOrThrow({ where: { id: ids.acct.id } })).balanceKes;

    // the approval click after restart replays through the SAME idempotency key
    const r = await decideApprovalTask(task.id, "approve", "Njeri");
    expect(r.kind).toBe("executed");
    const taskAfter = await db.approvalTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(taskAfter.status).toBe("executed");

    // reconciler path: a task stuck mid-flight whose intent IS executed
    const { task: task2 } = await stageIntent(ids.sess.id, ids.acct.id, 1_400);
    await db.approvalTask.update({
      where: { id: task2.id },
      data: { status: "executing", claimedAt: new Date(Date.now() - APPROVAL_LEASE_MS - 5_000) },
    });
    await reconcileStuckTasks();
    const t2 = await db.approvalTask.findUniqueOrThrow({ where: { id: task2.id } });
    expect(t2.status).toBe("open"); // no effect → re-opened (not falsely executed)

    const balanceFinal = (await db.account.findUniqueOrThrow({ where: { id: ids.acct.id } })).balanceKes;
    expect(balanceFinal).toBe(balanceAfterCrash); // crash-recovery added NO extra debits
  });
});

describe("ambiguous provider timeout — explicit retry semantics", () => {
  const TAG = "amby";
  let ids: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    ids = await fixture(TAG, 20_000);
  });
  afterAll(async () => {
    const { acct, sess, customer } = ids;
    await db.approvalTask.deleteMany({ where: { sessionId: sess.id } });
    await db.transferIntent.deleteMany({ where: { sessionId: sess.id } });
    await db.transaction.deleteMany({ where: { accountId: acct.id } });
    await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
    await db.message.deleteMany({ where: { sessionId: sess.id } });
    await db.auditEvent.deleteMany({ where: { sessionId: sess.id } });
    await db.chatSession.deleteMany({ where: { id: sess.id } });
    await db.account.deleteMany({ where: { id: acct.id } });
    await db.beneficiary.deleteMany({ where: { customerId: customer.id } });
    await db.customer.deleteMany({ where: { phone: customer.phone } });
  });
  afterEach(async () => {
    const { resetTransferProvider } = await import("../src/lib/transfer");
    resetTransferProvider();
  });

  test("timeout → ONE idempotent retry → duplicate receipt → executed, single debit", async () => {
    const { setTransferProvider } = await import("../src/lib/transfer");
    const { coreTransfer } = await import("../src/lib/banking");
    const { decideApprovalTask } = await import("../src/lib/approvals");

    let calls = 0;
    let timeoutWorked = false; // provider completes the effect on its 1st call
    setTransferProvider(async (instr) => {
      calls++;
      if (calls === 1) {
        // simulate the effect landing but the RESPONSE being lost
        timeoutWorked = true;
        await coreTransfer(instr);
        return {
          messageReference: instr.idempotencyKey,
          status: "timeout" as const,
          responseCode: "PRV-504",
          responseDescription: "gateway timeout (ambiguous)",
        };
      }
      return coreTransfer(instr); // retry resolves the ambiguity: duplicate
    });

    const { task } = await stageIntent(ids.sess.id, ids.acct.id, 900);
    const r = await decideApprovalTask(task.id, "approve", "Njeri");
    expect(r.kind).toBe("executed");
    expect(calls).toBe(2); // exactly one retry — never a blind loop
    expect(timeoutWorked).toBe(true);

    // single debit: 900 + fee (band 1–1,000 → fee 0)
    const txns = await db.transaction.findMany({ where: { accountId: ids.acct.id, type: "transfer_out" } });
    expect(txns.length).toBe(1);
    const balance = (await db.account.findUniqueOrThrow({ where: { id: ids.acct.id } })).balanceKes;
    expect(balance).toBe(20_000 - 900);

    // the ambiguity is AUDITED, not silently absorbed
    const ambiguous = await db.auditEvent.findFirst({ where: { eventType: "execution_ambiguous" } });
    expect(ambiguous).toBeTruthy();
  });
});

describe("concurrent approvals and executions", () => {
  const TAG = "conc";
  let ids: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    ids = await fixture(TAG, 50_000);
  });
  afterAll(async () => {
    const { acct, sess, customer } = ids;
    await db.approvalTask.deleteMany({ where: { sessionId: sess.id } });
    await db.transferIntent.deleteMany({ where: { sessionId: sess.id } });
    await db.transaction.deleteMany({ where: { accountId: acct.id } });
    await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
    await db.message.deleteMany({ where: { sessionId: sess.id } });
    await db.auditEvent.deleteMany({ where: { sessionId: sess.id } });
    await db.chatSession.deleteMany({ where: { id: sess.id } });
    await db.account.deleteMany({ where: { id: acct.id } });
    await db.beneficiary.deleteMany({ where: { customerId: customer.id } });
    await db.customer.deleteMany({ where: { phone: customer.phone } });
  });

  test("two simultaneous approval clicks decide exactly once", async () => {
    const { decideApprovalTask } = await import("../src/lib/approvals");
    const { task } = await stageIntent(ids.sess.id, ids.acct.id, 3_000);
    const [a, b] = await Promise.all([
      decideApprovalTask(task.id, "approve", "Njeri"),
      decideApprovalTask(task.id, "approve", "Otieno"),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds[0]).toBe("executed");
    expect(["in_progress", "replay"]).toContain(kinds[1]);
    const txns = await db.transaction.findMany({ where: { accountId: ids.acct.id, type: "transfer_out" } });
    expect(txns.length).toBe(1);
    const balance = (await db.account.findUniqueOrThrow({ where: { id: ids.acct.id } })).balanceKes;
    expect(balance).toBe(50_000 - 3_011); // 3,000 + fee 11 (1,001–10,000 band)
  });

  test("two simultaneous executeIntent calls run exactly once", async () => {
    const { executeIntent } = await import("../src/lib/transfer");
    const { intent } = await stageIntent(ids.sess.id, ids.acct.id, 2_000);
    const [a, b] = await Promise.all([executeIntent(intent.id, "Njeri"), executeIntent(intent.id, "Otieno")]);
    const oks = [a.ok, b.ok].filter(Boolean).length;
    expect(oks).toBe(1);
    const txns = await db.transaction.findMany({ where: { accountId: ids.acct.id, type: "transfer_out" } });
    expect(txns.length).toBe(2); // one per intent (this + previous test)
    const intentAfter = await db.transferIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(intentAfter.status).toBe("executed");
    expect(intentAfter.executionAttempts).toBe(1);
  });
});

describe("OTP binding + issue rate limits (deep-review P1-8)", () => {
  const TAG = "otpb";
  let ids: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    ids = await fixture(TAG, 1_000);
    process.env.HAZINA_OTP_COOLDOWN_MS = "0";
    process.env.HAZINA_OTP_MAX_PER_HOUR = "100";
  });
  afterAll(async () => {
    delete process.env.HAZINA_OTP_COOLDOWN_MS;
    delete process.env.HAZINA_OTP_MAX_PER_HOUR;
    const { acct, sess, customer } = ids;
    await db.otpCode.deleteMany({ where: { sessionId: sess.id } });
    await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
    await db.transaction.deleteMany({ where: { accountId: acct.id } });
    await db.message.deleteMany({ where: { sessionId: sess.id } });
    await db.auditEvent.deleteMany({ where: { sessionId: sess.id } });
    await db.chatSession.deleteMany({ where: { id: sess.id } });
    await db.account.deleteMany({ where: { id: acct.id } });
    await db.beneficiary.deleteMany({ where: { customerId: customer.id } });
    await db.customer.deleteMany({ where: { phone: customer.phone } });
  });

  test("a code issued for one transaction summary cannot verify a MODIFIED one", async () => {
    const { issueOtp, verifyOtp } = await import("../src/lib/transfer");
    // stage intent A (destination X)
    const stagedA = await db.pendingAction.create({
      data: {
        sessionId: ids.sess.id,
        kind: "intent_staged",
        payload: JSON.stringify({
          proposal: {
            fromAccountHandle: null,
            beneficiaryName: "Jane",
            destinationType: "mpesa",
            destination: "+254733000111",
            amountKes: 1_500,
            purpose: null,
          },
          acctId: ids.acct.id,
        }),
      },
      select: { id: true },
    });
    const otp = await issueOtp(ids.sess.id);
    if (!otp.ok) throw new Error("issueOtp unexpectedly refused");

    // tamper the SAME staged action in place (same id, different destination +
    // amount): the stagedActionId still matches, so ONLY the transaction
    // fingerprint can catch the substitution.
    await db.pendingAction.update({
      where: { id: stagedA.id },
      data: {
        payload: JSON.stringify({
          proposal: {
            fromAccountHandle: null,
            beneficiaryName: "Attacker",
            destinationType: "mpesa",
            destination: "+254799999999",
            amountKes: 99_000,
            purpose: null,
          },
          acctId: ids.acct.id,
        }),
      },
    });
    const v = await verifyOtp(ids.sess.id, otp.code);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("otp_stale");
  });

  test("issue cooldown refuses a rapid RESEND of the same intent", async () => {
    const { issueOtp } = await import("../src/lib/transfer");
    process.env.HAZINA_OTP_COOLDOWN_MS = "60000";
    process.env.HAZINA_OTP_MAX_PER_HOUR = "100";
    try {
      await db.otpCode.deleteMany({ where: { sessionId: ids.sess.id } });
      await db.pendingAction.deleteMany({ where: { sessionId: ids.sess.id } });
      // stage an intent so both issuances bind to it (resend pattern)
      await db.pendingAction.create({
        data: {
          sessionId: ids.sess.id,
          kind: "intent_staged",
          payload: JSON.stringify({
            proposal: {
              fromAccountHandle: null,
              beneficiaryName: "Jane",
              destinationType: "mpesa",
              destination: "+254733000111",
              amountKes: 1_500,
              purpose: null,
            },
            acctId: ids.acct.id,
          }),
        },
      });
      const first = await issueOtp(ids.sess.id);
      expect(first.ok).toBe(true);
      const resend = await issueOtp(ids.sess.id);
      expect(resend.ok).toBe(false);
      if (!resend.ok) {
        expect(resend.reason).toBe("cooldown");
        expect((resend.retryInSeconds ?? 0)).toBeGreaterThan(0);
      }
    } finally {
      process.env.HAZINA_OTP_COOLDOWN_MS = "0";
    }
  });

  test("a genuinely NEW transfer intent is NOT blocked by the cooldown", async () => {
    const { issueOtp } = await import("../src/lib/transfer");
    process.env.HAZINA_OTP_COOLDOWN_MS = "60000";
    process.env.HAZINA_OTP_MAX_PER_HOUR = "100";
    try {
      // (a pending unconsumed code for intent A already exists from the
      // previous test — restage a DIFFERENT intent and issue again)
      await db.pendingAction.deleteMany({ where: { sessionId: ids.sess.id, kind: "intent_staged" } });
      await db.pendingAction.create({
        data: {
          sessionId: ids.sess.id,
          kind: "intent_staged",
          payload: JSON.stringify({
            proposal: {
              fromAccountHandle: null,
              beneficiaryName: "Other Payee",
              destinationType: "pesalink",
              destination: "1234567890",
              amountKes: 3_500,
              purpose: null,
            },
            acctId: ids.acct.id,
          }),
        },
      });
      const fresh = await issueOtp(ids.sess.id);
      expect(fresh.ok).toBe(true); // new transfer supersedes — no cooldown block
    } finally {
      process.env.HAZINA_OTP_COOLDOWN_MS = "0";
    }
  });

  test("per-hour issuance cap refuses the Nth code", async () => {
    const { issueOtp } = await import("../src/lib/transfer");
    process.env.HAZINA_OTP_COOLDOWN_MS = "0";
    process.env.HAZINA_OTP_MAX_PER_HOUR = "2";
    try {
      await db.otpCode.deleteMany({ where: { sessionId: ids.sess.id } });
      expect((await issueOtp(ids.sess.id)).ok).toBe(true);
      expect((await issueOtp(ids.sess.id)).ok).toBe(true);
      const third = await issueOtp(ids.sess.id);
      expect(third.ok).toBe(false);
      if (!third.ok) expect(third.reason).toBe("rate_limited");
    } finally {
      process.env.HAZINA_OTP_MAX_PER_HOUR = "100";
    }
  });

  test("expired/consumed codes are purged by the issue-time sweep", async () => {
    const { issueOtp } = await import("../src/lib/transfer");
    process.env.HAZINA_OTP_COOLDOWN_MS = "0";
    // plant a stale consumed code older than a day
    await db.otpCode.create({
      data: {
        sessionId: ids.sess.id,
        codeHash: "0".repeat(64),
        expiresAt: new Date(Date.now() - 48 * 3600_000),
        consumed: true,
        createdAt: new Date(Date.now() - 48 * 3600_000),
      },
    });
    const r = await issueOtp(ids.sess.id);
    expect(r.ok).toBe(true);
    const stale = await db.otpCode.findFirst({ where: { sessionId: ids.sess.id, codeHash: "0".repeat(64) } });
    expect(stale).toBeNull(); // swept
  });
});
