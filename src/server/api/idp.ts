import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SAMPLE_PAYSLIPS, buildPayslipPack } from "@/lib/idp";
import { appendEvent } from "@/lib/audit";
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
 * (DPA 2019 s.35).
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
    const sess = await db.chatSession.findUnique({ where: { id: sessionId } });
    if (!sess) return ERR.notFound("Session", reqId(req));

    const source = sampleKey
      ? SAMPLE_PAYSLIPS.find((s) => s.key === sampleKey)
      : { key: "user_upload", label: "upload.txt", text: text ?? "" };
    if (!source || !source.text.trim()) {
      return ERR.validation("no readable payslip text was provided (empty upload?)", reqId(req));
    }

    const result = await buildPayslipPack({
      sessionId,
      fileName: source.label,
      docKind: sampleKey === "scanned" ? "scanned" : sampleKey === "clean" ? "clean" : "user_upload",
      text: source.text,
      requestedAmountKes: requestedAmountKes ?? 300_000,
      tenorMonths: tenorMonths ?? 24,
    });

    // Raise the HITL task for the credit officer
    const task = await db.approvalTask.create({
      data: {
        sessionId,
        type: "loan_pack",
        refId: result.pack.id,
        riskLevel: result.validation.ok ? "medium" : "high",
        payload: JSON.stringify({
          packId: result.pack.id,
          customer: sess.customerId,
          fileName: source.label,
          netKes: result.extracted.net.value,
          validationOk: result.validation.ok,
          recommendation: result.affordability.recommendation,
          requestedAmountKes: requestedAmountKes ?? 300_000,
          tenorMonths: tenorMonths ?? 24,
        }),
      },
    });

    // Post an assistant message into the chat so the customer sees the outcome
    await db.message.create({
      data: {
        sessionId,
        role: "assistant",
        content:
          `Payslip processed (${source.label}). Net pay KES ${(result.extracted.net.value ?? 0).toLocaleString()}, ` +
          `validation ${result.validation.ok ? "passed" : "flagged (" + result.validation.rules.filter((r) => !r.passed).map((r) => r.rule).join(", ") + ")"}. ` +
          `I've prepared a recommendation pack for a credit officer — they make the final call. Status: AWAITING REVIEW (task ${task.id.slice(-6)}).`,
        trace: JSON.stringify({
          route: "idp",
          kind: "idp_pack_created",
          hitl: { taskId: task.id, riskLevel: task.riskLevel },
          avgConfidence:
            Math.round(
              ([result.extracted.employer, result.extracted.employeeName, result.extracted.kraPin, result.extracted.gross, result.extracted.net].reduce((a, f) => a + f.confidence, 0) / 5) * 100
            ) / 100,
        }),
      },
    });

    await appendEvent({
      sessionId,
      actor: `customer:${sess.customerId}`,
      eventType: "idp_uploaded",
      payload: { fileName: source.label, docKind: result.pack.docKind },
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
