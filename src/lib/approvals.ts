/**
 * HITL approval decisions — the single implementation shared by
 * POST /api/approvals (officer console) and the runtime auto-heal curator
 * (src/lib/ensure-seed.ts), so curated demo history is produced by the SAME
 * code path a real officer click takes.
 *
 * EXPLICIT STATE MACHINE (deep-review P1-4) — a task is never marked success
 * before the effect AND its receipt are durably reconciled:
 *
 *   open → claiming → executing → executed
 *                        ↘ execution_failed (retryable via re-claim, bounded)
 *   open → rejected
 *
 *   - the CLAIM is atomic (`updateMany` on a guarded status set), so two
 *     simultaneous officer clicks decide exactly once;
 *   - a crash between claim and effect leaves claiming/executing behind a
 *     LEASE (claimedAt + APPROVAL_LEASE_MS); `reconcileStuckTasks()` resolves
 *     those against the durable intent state — executed intents finalise the
 *     task with the receipt, anything else re-opens for a fresh decision;
 *   - replaying a decided task returns the ORIGINAL receipt instead of an
 *     error — a double-click can never double-debit;
 *   - execution failure is an HONEST `execution_failed` state (distinct from
 *     a human rejection), retryable until MAX_APPROVAL_ATTEMPTS is exhausted.
 *
 * IDENTITY (deep-review P1-7): the recorded actor is DERIVED FROM THE
 * AUTHENTICATED OFFICER SESSION by the caller, never from client input.
 */
import { db } from "@/lib/db";
import { executeIntent } from "@/lib/transfer";
import { appendEvent } from "@/lib/audit";

/** Lease for a claimed task: a claim older than this is assumed crashed. */
export const APPROVAL_LEASE_MS = 60_000;
/** Bounded retries: after this many guarded attempts the task fails permanently. */
export const MAX_APPROVAL_ATTEMPTS = 3;

export type DecisionResult =
  | { kind: "replay"; status: string; txnRef?: string | null; feeKes?: number | null; messageRef?: string | null }
  | { kind: "executed"; txnRef?: string; feeKes?: number; messageRef?: string; replayed?: boolean }
  | { kind: "rejected_intent" }
  | { kind: "loan_pack_decided"; status: "approved" | "declined" }
  | { kind: "execution_refused"; reason: string; retryable?: boolean; attempts?: number }
  | { kind: "in_progress" }
  | { kind: "unknown_type"; type: string }
  | { kind: "not_found" };

interface ExecutionReceipt {
  txnRef?: string;
  feeKes?: number;
  messageRef?: string;
  executedAt: string;
  approver: string;
  attempts: number;
}

/** Statuses a new decision can claim: a fresh task, a bounded retryable
 *  failure, or a crashed claim whose lease has expired. */
function claimableFilter(taskId: string, staleBefore: Date) {
  return {
    OR: [
      { id: taskId, status: "open" },
      { id: taskId, status: "execution_failed" },
      // crash recovery: an abandoned claim past its lease is claimable again
      {
        id: taskId,
        status: { in: ["claiming", "executing"] },
        claimedAt: { lt: staleBefore },
      },
    ],
  };
}

export async function decideApprovalTask(
  taskId: string,
  decision: "approve" | "reject",
  officerName: string,
  reason?: string
): Promise<DecisionResult> {
  const task = await db.approvalTask.findUnique({ where: { id: taskId } });
  if (!task) return { kind: "not_found" };

  if (task.type === "transfer" && decision === "approve") {
    return decideTransferApproval(task, officerName, reason);
  }

  // --- reject (any type) + loan_pack approve: single guarded claim --------
  const claimed = await db.approvalTask.updateMany({
    where: claimableFilter(taskId, new Date(Date.now() - APPROVAL_LEASE_MS)),
    data: {
      status: decision === "approve" ? "executed" : "rejected",
      decidedBy: officerName,
      decidedAt: new Date(),
      reason: reason ?? null,
      claimedAt: new Date(),
      attemptCount: { increment: 1 },
    },
  });

  if (claimed.count === 0) {
    return replayOf(task);
  }

  if (task.type === "transfer") {
    // reject: the intent is dead — no effect can occur later
    await db.transferIntent.update({ where: { id: task.refId }, data: { status: "rejected" } });
    await appendEvent({
      sessionId: task.sessionId,
      actor: `approver:${officerName}`,
      eventType: "hitl_rejected",
      payload: { taskId, type: "transfer", reason: reason ?? "officer judgement" },
    });
    await postCustomerMessage(
      task.sessionId,
      `Your transfer request was declined by a bank officer${reason ? ` (${reason})` : ""}. No money has left your account. You can start a new request in chat if you still need it.`,
      { route: "transfer", kind: "transfer_declined" }
    );
    return { kind: "rejected_intent" };
  }

  if (task.type === "loan_pack") {
    const newStatus = decision === "approve" ? "approved" : "declined";
    await db.payslipPack.update({
      where: { id: task.refId },
      data: { status: newStatus, decidedBy: officerName, decidedAt: new Date() },
    });
    await appendEvent({
      sessionId: task.sessionId,
      actor: `approver:${officerName}`,
      eventType: decision === "approve" ? "loan_pack_approved" : "loan_pack_declined",
      payload: { taskId, packId: task.refId, reason: reason ?? undefined },
    });
    await postCustomerMessage(
      task.sessionId,
      decision === "approve"
        ? "Your loan pre-qualification pack was reviewed and approved by a credit officer. The lending team will contact you with the next steps."
        : `Your loan pre-qualification pack was reviewed and declined by a credit officer${reason ? ` (${reason})` : ""}. You may book an appointment to discuss alternatives.`,
      { route: "idp", kind: decision === "approve" ? "loan_pack_approved" : "loan_pack_declined" }
    );
    return { kind: "loan_pack_decided", status: newStatus };
  }

  return { kind: "unknown_type", type: task.type };
}

/** The transfer approve path: claim → execute → reconcile receipt. */
async function decideTransferApproval(
  task: { id: string; sessionId: string; type: string; refId: string; attemptCount: number; status: string },
  officerName: string,
  reason?: string
): Promise<DecisionResult> {
  // --- guarded claim: exactly one decision wins the race ------------------
  const staleBefore = new Date(Date.now() - APPROVAL_LEASE_MS);
  const claimed = await db.approvalTask.updateMany({
    where: claimableFilter(task.id, staleBefore),
    data: {
      status: "claiming",
      decidedBy: officerName,
      claimedAt: new Date(),
      attemptCount: { increment: 1 },
      reason: reason ?? null,
    },
  });

  if (claimed.count === 0) {
    const fresh = await db.approvalTask.findUnique({ where: { id: task.id } });
    if (fresh && (fresh.status === "executed" || fresh.status === "rejected")) {
      return replayOf(fresh);
    }
    // someone else is mid-execution with a live lease
    return { kind: "in_progress" };
  }

  const current = await db.approvalTask.findUniqueOrThrow({ where: { id: task.id } });
  if (current.attemptCount > MAX_APPROVAL_ATTEMPTS) {
    await db.approvalTask.update({
      where: { id: task.id },
      data: {
        status: "execution_failed",
        reason: `execution attempts exhausted (${current.attemptCount - 1} retries)`,
        decidedAt: new Date(),
      },
    });
    await postCustomerMessage(
      task.sessionId,
      "Your transfer request could not be completed after repeated execution attempts. No unresolved charge remains on your account — please contact the bank or start a new request.",
      { route: "transfer", kind: "transfer_attempts_exhausted" }
    );
    return { kind: "execution_refused", reason: "attempts_exhausted", retryable: false, attempts: current.attemptCount };
  }

  await db.approvalTask.update({ where: { id: task.id }, data: { status: "executing" } });
  const res = await executeIntent(task.refId, officerName);

  if (res.ok) {
    // durable receipt — the task is only now marked success
    const receipt: ExecutionReceipt = {
      txnRef: res.txnRef,
      feeKes: res.feeKes,
      messageRef: res.messageRef,
      executedAt: new Date().toISOString(),
      approver: officerName,
      attempts: current.attemptCount,
    };
    await db.approvalTask.update({
      where: { id: task.id },
      data: { status: "executed", decidedAt: new Date(), receipt: JSON.stringify(receipt), reason: null },
    });
    const intent = await db.transferIntent.findUnique({ where: { id: task.refId } });
    await postCustomerMessage(
      task.sessionId,
      `Good news — your transfer of KES ${(intent?.amount ?? 0).toLocaleString()} to ${intent?.beneficiaryName ?? "the beneficiary"} has been approved and completed${res.txnRef ? ` (ref ${res.txnRef})` : ""}. Fee charged: KES ${(res.feeKes ?? 0).toLocaleString()}.`,
      { route: "transfer", kind: "transfer_executed", txnRef: res.txnRef, feeKes: res.feeKes, messageRef: res.messageRef }
    );
    return { kind: "executed", txnRef: res.txnRef, feeKes: res.feeKes, messageRef: res.messageRef, replayed: res.replayed };
  }

  // execution failure: honest failed state, retryability explicit
  const retryable = res.retryable ?? false;
  await db.approvalTask.update({
    where: { id: task.id },
    data: {
      status: "execution_failed",
      reason: `execution failed: ${res.reason}`,
      decidedAt: new Date(),
    },
  });
  await appendEvent({
    sessionId: task.sessionId,
    actor: `approver:${officerName}`,
    eventType: "execution_failed",
    payload: { taskId: task.id, intentId: task.refId, reason: res.reason, retryable, attempts: current.attemptCount },
  });
  await postCustomerMessage(
    task.sessionId,
    `Your transfer request could not be completed (${res.reason}). No money has left your account — nothing was charged.${retryable ? " An officer may retry the execution." : ""}`,
    { route: "transfer", kind: "transfer_failed", reason: res.reason }
  );
  return { kind: "execution_refused", reason: res.reason, retryable, attempts: current.attemptCount };
}

/** Replay: someone already decided. Return the original outcome + receipt. */
async function replayOf(task: {
  id: string;
  type: string;
  refId: string;
  status: string;
  receipt: string | null;
}): Promise<DecisionResult> {
  if (task.type === "transfer" && (task.status === "executed" || task.status === "execution_failed")) {
    let receipt: ExecutionReceipt | null = null;
    try {
      receipt = task.receipt ? (JSON.parse(task.receipt) as ExecutionReceipt) : null;
    } catch {
      receipt = null;
    }
    if (receipt) {
      return {
        kind: "replay",
        status: task.status,
        txnRef: receipt.txnRef ?? null,
        feeKes: receipt.feeKes ?? null,
        messageRef: receipt.messageRef ?? null,
      };
    }
    const intent = await db.transferIntent.findUnique({ where: { id: task.refId } });
    return {
      kind: "replay",
      status: task.status,
      txnRef: intent?.executedTxnRef,
      feeKes: intent?.executedFeeKes,
      messageRef: intent?.idempotencyKey,
    };
  }
  return { kind: "replay", status: task.status };
}

/**
 * Crash recovery (deep-review P1-4): tasks abandoned mid-execution —
 * claiming/executing past their lease — are reconciled against the DURABLE
 * intent state:
 *   intent executed  → the task finalises as executed with the receipt
 *   intent otherwise → the task re-opens for a fresh officer decision
 * Called lazily from GET /api/approvals and from the runtime auto-heal, so a
 * restarted process self-heals the queue without manual intervention.
 */
export async function reconcileStuckTasks(leaseMs = APPROVAL_LEASE_MS): Promise<number> {
  const staleBefore = new Date(Date.now() - leaseMs);
  const stuck = await db.approvalTask.findMany({
    where: { status: { in: ["claiming", "executing"] }, claimedAt: { lt: staleBefore } },
    take: 100,
  });
  let healed = 0;
  for (const t of stuck) {
    if (t.type === "transfer") {
      const intent = await db.transferIntent.findUnique({ where: { id: t.refId } });
      if (intent?.status === "executed") {
        // effect + receipt are durable — finalise the task from them
        const receipt: ExecutionReceipt = {
          txnRef: intent.executedTxnRef ?? undefined,
          feeKes: intent.executedFeeKes ?? undefined,
          messageRef: intent.idempotencyKey ?? undefined,
          executedAt: new Date().toISOString(),
          approver: t.decidedBy ?? "reconciler",
          attempts: t.attemptCount,
        };
        await db.approvalTask.update({
          where: { id: t.id },
          data: {
            status: "executed",
            decidedAt: new Date(),
            receipt: JSON.stringify(receipt),
            reason: "reconciled from durable intent state after lease expiry",
          },
        });
      } else {
        await db.approvalTask.update({
          where: { id: t.id },
          data: { status: "open", claimedAt: null, reason: "lease expired — re-opened by reconciler" },
        });
      }
    } else {
      await db.approvalTask.update({
        where: { id: t.id },
        data: { status: "open", claimedAt: null, reason: "lease expired — re-opened by reconciler" },
      });
    }
    healed++;
  }
  return healed;
}

/** Customer-visible status update (chat transcript), so closing the loop is
 *  visible in the customer app without polling the queue. */
export async function postCustomerMessage(sessionId: string, content: string, trace: Record<string, unknown>) {
  await db.message.create({
    data: { sessionId, role: "assistant", content, trace: JSON.stringify(trace) },
  });
}
