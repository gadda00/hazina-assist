import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executeIntent } from "@/lib/transfer";
import { appendEvent } from "@/lib/audit";

/** GET /api/approvals — the HITL queue (transfers + loan packs). */
export async function GET() {
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
}

/** POST /api/approvals — officer decision (approve/reject) on a task. */
export async function POST(req: Request) {
  try {
    const { taskId, decision, officer, reason } = (await req.json()) as {
      taskId?: string;
      decision?: "approve" | "reject";
      officer?: string;
      reason?: string;
    };
    if (!taskId || !decision) return NextResponse.json({ error: "taskId and decision required" }, { status: 400 });
    const task = await db.approvalTask.findUnique({ where: { id: taskId } });
    if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
    if (task.status !== "open") return NextResponse.json({ error: "task_already_decided" }, { status: 409 });

    if (task.type === "transfer") {
      if (decision === "approve") {
        const res = await executeIntent(task.refId, officer ?? "officer");
        if (!res.ok) {
          await db.approvalTask.update({
            where: { id: taskId },
            data: { status: "rejected", reason: `execution rejected: ${res.reason}`, decidedBy: officer, decidedAt: new Date() },
          });
          return NextResponse.json({ ok: false, reason: res.reason }, { status: 200 });
        }
        await db.approvalTask.update({
          where: { id: taskId },
          data: { status: "approved", decidedBy: officer, decidedAt: new Date() },
        });
        return NextResponse.json({ ok: true, txnRef: res.txnRef, feeKes: res.feeKes, messageRef: res.messageRef });
      }
      await db.transferIntent.update({ where: { id: task.refId }, data: { status: "rejected" } });
      await appendEvent({
        sessionId: task.sessionId,
        actor: `approver:${officer ?? "officer"}`,
        eventType: "hitl_rejected",
        payload: { taskId, type: "transfer", reason: reason ?? "officer judgement" },
      });
    } else if (task.type === "loan_pack") {
      const newStatus = decision === "approve" ? "approved" : "declined";
      await db.payslipPack.update({
        where: { id: task.refId },
        data: { status: newStatus, decidedBy: officer, decidedAt: new Date() },
      });
    }

    await db.approvalTask.update({
      where: { id: taskId },
      data: {
        status: decision === "approve" ? "approved" : "rejected",
        reason: reason ?? null,
        decidedBy: officer,
        decidedAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[approvals]", e);
    return NextResponse.json({ error: "decision_failed" }, { status: 500 });
  }
}
