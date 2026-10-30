import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appendEvent } from "@/lib/audit";
import { SAMPLE_PAYSLIPS, buildPayslipPack, processPayslipSample } from "@/lib/idp";
import { requireCustomerSession, assertSessionOwnsCustomer } from "@/lib/authz";
import { ERR, IdpPostSchema, SessionQuerySchema, parseBody, parseQuery, reqId } from "@/lib/schemas";

/** GET /api/idp — payslip samples + previously built packs for this session
 *  (own session only — cross-customer reads are rejected). */
export async function GET(req: Request) {
  const auth = await requireCustomerSession(req);
  if (!auth.ok) return auth.response;

  const parsed = parseQuery(req, SessionQuerySchema);
  if (!parsed.ok) return parsed.response;
  const owns = assertSessionOwnsCustomer(auth.data, parsed.data.sessionId);
  if (!owns.ok) return owns.response;
  const sessionId = parsed.data.sessionId;

  const packs = await db.payslipPack.findMany({ where: { sessionId }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({
    samples: SAMPLE_PAYSLIPS,
    packs: packs.map((p) => ({
      id: p.id,
      fileName: p.fileName,
      docKind: p.docKind,
      status: p.status,
      summary: p.summary,
      fields: JSON.parse(p.fields),
      validation: JSON.parse(p.validation),
      affordability: JSON.parse(p.affordability),
      createdAt: p.createdAt,
    })),
  });
}

/**
 * POST /api/idp — payslip text → extraction + validation + affordability →
 * pack for a human credit officer. The system recommends; it never decides
 * (DPA 2019 s.35). Samples: clean / scanned / flagged (tampered NET PAY —
 * deterministic validation catches it).
 */
export async function POST(req: Request) {
  const auth = await requireCustomerSession(req);
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(req, IdpPostSchema);
  if (!parsed.ok) return parsed.response;
  const { sessionId, sampleKey, text, requestedAmountKes, tenorMonths } = parsed.data;

  const owns = assertSessionOwnsCustomer(auth.data, sessionId);
  if (!owns.ok) return owns.response;

  try {
    if (sampleKey) {
      // fixed synthetic fixture — the pipeline is shared with the auto-heal
      const result = await processPayslipSample({
        sessionId,
        sampleKey,
        requestedAmountKes: requestedAmountKes ?? 300_000,
        tenorMonths: tenorMonths ?? 24,
      });
      return NextResponse.json({
        ok: true,
        taskId: result.taskId,
        extracted: result.extracted,
        validation: result.validation,
        affordability: result.affordability,
        summary: result.summary,
      });
    }

    // free-text upload path (raw payslip text)
    if (!text || !text.trim()) {
      return ERR.validation("no readable payslip text was provided (empty upload?)", reqId(req));
    }
    const sess = await db.chatSession.findUnique({ where: { id: sessionId }, include: { customer: true } });
    if (!sess) return ERR.notFound("Session", reqId(req));

    const result = await buildPayslipPack({
      sessionId,
      fileName: "upload.txt",
      docKind: "user_upload",
      text,
      requestedAmountKes: requestedAmountKes ?? 300_000,
      tenorMonths: tenorMonths ?? 24,
    });
    const task = await db.approvalTask.create({
      data: {
        sessionId,
        type: "loan_pack",
        refId: result.pack.id,
        riskLevel: result.validation.ok ? "medium" : "high",
        payload: JSON.stringify({
          packId: result.pack.id,
          customer: sess.customer.name,
          fileName: "upload.txt",
          netKes: result.extracted.net.value,
          validationOk: result.validation.ok,
          recommendation: result.affordability.recommendation,
          requestedAmountKes: requestedAmountKes ?? 300_000,
          tenorMonths: tenorMonths ?? 24,
        }),
      },
    });
    await db.message.create({
      data: {
        sessionId,
        role: "assistant",
        content:
          `Payslip processed (upload.txt). Net pay KES ${(result.extracted.net.value ?? 0).toLocaleString()}, ` +
          `validation ${result.validation.ok ? "passed" : "flagged (" + result.validation.rules.filter((r) => !r.passed).map((r) => r.rule).join(", ") + ")"}. ` +
          `I've prepared a recommendation pack for a credit officer — they make the final call. Status: AWAITING REVIEW (task ${task.id.slice(-6)}).`,
        trace: JSON.stringify({
          route: "idp",
          kind: "idp_pack_created",
          hitl: { taskId: task.id, riskLevel: task.riskLevel },
        }),
      },
    });
    await appendEvent({
      sessionId,
      actor: `customer:${sess.customerId}`,
      eventType: "idp_uploaded",
      payload: { fileName: "upload.txt", docKind: "user_upload" },
    });
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      extracted: result.extracted,
      validation: result.validation,
      affordability: result.affordability,
      summary: result.summary,
    });
  } catch (e) {
    console.error("[idp]", e);
    return ERR.internal(reqId(req));
  }
}
