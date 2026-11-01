import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decideApprovalTask, reconcileStuckTasks } from "@/lib/approvals";
import { requireDemoOfficer } from "@/lib/authz";
import { ApprovalPostSchema, ERR, parseBody, reqId } from "@/lib/schemas";

/** GET /api/approvals — the HITL queue (transfers + loan packs). Officer-only.
 *  Crash recovery runs lazily on every read: tasks abandoned mid-execution
 *  (crashed claim past its lease) are reconciled against the durable intent
 *  state BEFORE the queue is rendered, so the console never shows a phantom
 *  "in-flight" task that no process is actually executing. */
export async function GET(req: Request) {
  const auth = await requireDemoOfficer(req);
  if (!auth.ok) return auth.response;

  try {
    await reconcileStuckTasks();
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
 * Officer-only and IDEMPOTENT; the decision itself lives in
 * src/lib/approvals.ts (shared with the auto-heal curator).
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
    const r = await decideApprovalTask(taskId, decision, officerName, reason);
    switch (r.kind) {
      case "not_found":
        return ERR.notFound("Approval task", reqId(req));
      case "unknown_type":
        return ERR.validation(`unknown task type: ${r.type}`, reqId(req));
      case "execution_refused":
        return NextResponse.json({ ok: false, reason: r.reason, retryable: r.retryable ?? false, attempts: r.attempts });
      case "in_progress":
        // a live claim is executing this task right now (or its lease has not
        // expired) — the officer UI surfaces this instead of silently no-op'ing
        return NextResponse.json(
          { ok: false, reason: "already_being_executed" },
          { status: 409 }
        );
      case "replay":
        return NextResponse.json({
          ok: true,
          replayed: true,
          status: r.status,
          txnRef: r.txnRef,
          feeKes: r.feeKes,
          messageRef: r.messageRef,
        });
      case "executed":
        return NextResponse.json({
          ok: true,
          txnRef: r.txnRef,
          feeKes: r.feeKes,
          messageRef: r.messageRef,
          replayed: r.replayed,
        });
      default:
        return NextResponse.json({ ok: true });
    }
  } catch (e) {
    console.error("[approvals:post]", e);
    return ERR.internal(reqId(req));
  }
}
