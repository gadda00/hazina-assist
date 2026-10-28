import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runOrchestrator } from "@/lib/orchestrator";
import { appendEvent } from "@/lib/audit";
import { redactPii } from "@hazina/kit";

/** POST /api/chat — message → orchestrator state machine → reply + trace. */
export async function POST(req: Request) {
  try {
    const { sessionId, message } = (await req.json()) as { sessionId?: string; message?: string };
    if (!sessionId || !message?.trim()) {
      return NextResponse.json({ error: "sessionId and message required" }, { status: 400 });
    }
    const sess = await db.chatSession.findUnique({ where: { id: sessionId } });
    if (!sess) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

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
    return NextResponse.json({ error: "orchestrator_failure" }, { status: 500 });
  }
}

/** GET /api/chat?sessionId= — conversation history with traces. */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
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
}
