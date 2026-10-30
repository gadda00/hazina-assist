import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executeIntent } from "@/lib/transfer";
import { appendEvent } from "@/lib/audit";
import { requireDemoOfficer } from "@/lib/authz";
import { ApprovalPostSchema, ERR, parseBody, reqId } from "@/lib/schemas";

/** GET /api/approvals — the HITL queue (transfers + loan packs). Officer-only. */
export async function GET(req: Request) {
  const auth = await requireDemoOfficer(req);
  if (!auth.ok) return auth.response;

  try {
    const tasks = await db.approvalTask.findMany({
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 100,
    });
    const packs = await db.payslipPack.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    return NextResponse.json({
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        refId: t.refId,
        riskLevel: t.riskLevel,
        status: t.status,
        reason: t.reason,
        decidedBy: t.decidedBy,
        decidedAt: t.decidedAt,
        createdAt: t.createdAt,
        payload: JSON.parse(t.payload),
      })),
      packs: packs.map((p) => ({
        id: p.id,
        sessionId: p.sessionId,
        fileName: p.fileName,
        docKind: p.docKind,
        status: p.status,
        decidedBy: p.decidedBy,
        decidedAt: p.decidedAt,
        createdAt: p.createdAt,
        summary: p.summary,
        fields: JSON.parse(p.fields),
        validation: JSON.parse(p.validation),
        affordability: JSON.parse(p.affordability),
      })),
    });
  } catch (e) {
    console.error("[approvals:get]", e);
    return ERR.internal(reqId(req));
  }
}

/**
 * POST /api/approvals — officer decision (approve/reject) on a task.
 * Officer-only, and IDEMPOTENT:
 *  - the task status is claimed atomically (`updateMany where status:"open"`)
 *    so two simultaneous clicks decide exactly once
 *  - replaying a decided task returns the ORIGINAL receipt (ok + replayed)
 *    instead of an error — a double-click can never double-debit
 *
 * IDENTITY (deep-review P1-7): the recorded actor is DERIVED FROM THE
 * AUTHENTICATED OFFICER SESSION, never from client-supplied input — the
 * audit chain cannot be attributed to a name typed into a browser field.
 */
export async function POST(req: Request) {
  const auth = await requireDemoOfficer(req);
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(req, ApprovalPostSchema);
  if (!parsed.ok) return parsed.response;
  const { taskId, decision, reason } = parsed.data;
  const officerName = auth.data.customerName; // server-derived identity

  try {
    const task = await db.approvalTask.findUnique({ where: { id: taskId } });
    if (!task) return ERR.notFound("Approval task", reqId(req));

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
        return NextResponse.json({
          ok: true,
          replayed: true,
          status: "approved",
          txnRef: intent?.executedTxnRef,
          feeKes: intent?.executedFeeKes,
          messageRef: intent?.idempotencyKey,
        });
      }
      return NextResponse.json({ ok: true, replayed: true, status: decided?.status ?? "decided" });
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
          return NextResponse.json({ ok: false, reason: res.reason });
        }
        const intent = await db.transferIntent.findUnique({ where: { id: task.refId } });
        await postCustomerMessage(
          task.sessionId,
          `Good news — your transfer of KES ${(intent?.amount ?? 0).toLocaleString()} to ${intent?.beneficiaryName ?? "the beneficiary"} has been approved and completed${res.txnRef ? ` (ref ${res.txnRef})` : ""}. Fee charged: KES ${(res.feeKes ?? 0).toLocaleString()}.`,
          { route: "transfer", kind: "transfer_executed", txnRef: res.txnRef, feeKes: res.feeKes }
        );
        return NextResponse.json({
          ok: true,
          txnRef: res.txnRef,
          feeKes: res.feeKes,
          messageRef: res.messageRef,
          replayed: res.replayed,
        });
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
      return NextResponse.json({ ok: true });
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
      return NextResponse.json({ ok: true });
    }

    return ERR.validation(`unknown task type: ${task.type}`, reqId(req));
  } catch (e) {
    console.error("[approvals:post]", e);
    return ERR.internal(reqId(req));
  }
}

/** Customer-visible status update (chat transcript), so closing the loop is
 *  visible in the customer app without polling the queue. */
async function postCustomerMessage(sessionId: string, content: string, trace: Record<string, unknown>) {
  await db.message.create({
    data: { sessionId, role: "assistant", content, trace: JSON.stringify(trace) },
  });
}
