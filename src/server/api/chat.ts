import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runOrchestrator } from "@/lib/orchestrator";
import { appendEvent } from "@/lib/audit";
import { redactPii } from "@hazina/kit";
import { requireCustomerSession, assertSessionOwnsCustomer } from "@/lib/authz";
import { ChatGetSchema, ChatPostSchema, ERR, parseBody, parseQuery, reqId } from "@/lib/schemas";

/** POST /api/chat — message → orchestrator state machine → reply + trace.
 *  Requires the caller's demo session token; the body sessionId must be the
 *  caller's own session (cross-customer access → 403). */
export async function POST(req: Request) {
  const auth = await requireCustomerSession(req);
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(req, ChatPostSchema);
  if (!parsed.ok) return parsed.response;
  const { sessionId, message } = parsed.data;

  const owns = assertSessionOwnsCustomer(auth.data, sessionId);
  if (!owns.ok) return owns.response;

  try {
    const sess = await db.chatSession.findUnique({ where: { id: sessionId } });
    if (!sess) return ERR.notFound("Session", reqId(req));

    // Persist user message (redacted copy in the audit log; full text in app DB)
    await db.message.create({ data: { sessionId, role: "user", content: message } });
    await appendEvent({
      sessionId,
      actor: `customer:${sess.customerId}`,
      eventType: "message_received",
      payload: { length: message.length, redacted: redactPii(message).slice(0, 200) },
    });

    const result = await runOrchestrator(sessionId, message);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[chat]", e);
    return ERR.internal(reqId(req));
  }
}

/** GET /api/chat?sessionId= — conversation history with traces (own session only). */
export async function GET(req: Request) {
  const auth = await requireCustomerSession(req);
  if (!auth.ok) return auth.response;

  const parsed = parseQuery(req, ChatGetSchema);
  if (!parsed.ok) return parsed.response;
  const { sessionId } = parsed.data;

  const owns = assertSessionOwnsCustomer(auth.data, sessionId);
  if (!owns.ok) return owns.response;

  try {
    const messages = await db.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return NextResponse.json({
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        trace: m.trace ? JSON.parse(m.trace) : null,
      })),
    });
  } catch (e) {
    console.error("[chat:get]", e);
    return ERR.internal(reqId(req));
  }
}
