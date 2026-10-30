/**
 * HITL approval decisions — the single implementation shared by
 * POST /api/approvals (officer console) and the runtime auto-heal curator
 * (src/lib/ensure-seed.ts), so curated demo history is produced by the SAME
 * code path a real officer click takes.
 *
 * IDEMPOTENT: the task status is claimed atomically (`updateMany where
 * status:"open"`) so two simultaneous clicks decide exactly once; replaying
 * a decided task returns the ORIGINAL receipt instead of an error — a
 * double-click can never double-debit.
 *
 * IDENTITY (deep-review P1-7): the recorded actor is DERIVED FROM THE
 * AUTHENTICATED OFFICER SESSION by the caller, never from client input.
 */
import { db } from "@/lib/db";
import { executeIntent } from "@/lib/transfer";
import { appendEvent } from "@/lib/audit";

export type DecisionResult =
  | { kind: "replay"; status: string; txnRef?: string | null; feeKes?: number | null; messageRef?: string | null }
  | { kind: "executed"; txnRef?: string; feeKes?: number; messageRef?: string; replayed?: boolean }
  | { kind: "rejected_intent" }
  | { kind: "loan_pack_decided"; status: "approved" | "declined" }
  | { kind: "execution_refused"; reason: string }
  | { kind: "unknown_type"; type: string }
  | { kind: "not_found" };

export async function decideApprovalTask(
  taskId: string,
  decision: "approve" | "reject",
  officerName: string,
  reason?: string
): Promise<DecisionResult> {
  const task = await db.approvalTask.findUnique({ where: { id: taskId } });
  if (!task) return { kind: "not_found" };

  // --- guarded claim: exactly one decision wins the race ------------------
  const claimed = await db.approvalTask.updateMany({
    where: { id: taskId, status: "open" },
    data: {
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: officerName,
      decidedAt: new Date(),
      reason: reason ?? null,
    },
  });

  if (claimed.count === 0) {
    // Replay: someone already decided. Return the original outcome.
    const decided = await db.approvalTask.findUnique({ where: { id: taskId } });
    if (task.type === "transfer" && decided?.status === "approved") {
      const intent = await db.transferIntent.findUnique({ where: { id: task.refId } });
      return {
        kind: "replay",
        status: "approved",
        txnRef: intent?.executedTxnRef,
        feeKes: intent?.executedFeeKes,
        messageRef: intent?.idempotencyKey,
      };
    }
    return { kind: "replay", status: decided?.status ?? "decided" };
  }

  // --- first decision: execute the effect ---------------------------------
  if (task.type === "transfer") {
    if (decision === "approve") {
      const res = await executeIntent(task.refId, officerName);
      if (!res.ok) {
        await db.approvalTask.update({
          where: { id: taskId },
          data: { status: "rejected", reason: `execution rejected: ${res.reason}` },
        });
        await postCustomerMessage(
          task.sessionId,
          `Your transfer request could not be completed (${res.reason}). No money has left your account — nothing was charged.`,
          { route: "transfer", kind: "transfer_failed", reason: res.reason }
        );
        return { kind: "execution_refused", reason: res.reason };
      }
      const intent = await db.transferIntent.findUnique({ where: { id: task.refId } });
      await postCustomerMessage(
        task.sessionId,
        `Good news — your transfer of KES ${(intent?.amount ?? 0).toLocaleString()} to ${intent?.beneficiaryName ?? "the beneficiary"} has been approved and completed${res.txnRef ? ` (ref ${res.txnRef})` : ""}. Fee charged: KES ${(res.feeKes ?? 0).toLocaleString()}.`,
        { route: "transfer", kind: "transfer_executed", txnRef: res.txnRef, feeKes: res.feeKes }
      );
      return { kind: "executed", txnRef: res.txnRef, feeKes: res.feeKes, messageRef: res.messageRef, replayed: res.replayed };
    }

    // reject
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

/** Customer-visible status update (chat transcript), so closing the loop is
 *  visible in the customer app without polling the queue. */
export async function postCustomerMessage(sessionId: string, content: string, trace: Record<string, unknown>) {
  await db.message.create({
    data: { sessionId, role: "assistant", content, trace: JSON.stringify(trace) },
  });
}
