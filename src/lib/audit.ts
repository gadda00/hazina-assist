/**
 * Append-only, hash-chained audit trail (Prisma-bound).
 * Pure crypto lives in @hazina/kit; this module handles serialised writes.
 */
import { db } from "@/lib/db";
import { eventHash, GENESIS_HASH, canonicalEvent, redactPii } from "@hazina/kit";

export interface AuditEventInput {
  sessionId?: string | null;
  actor: string; // "customer:<id>" | "approver:<name>" | "system:<node>"
  eventType: string;
  payload: Record<string, unknown>;
}

/** Redact PII inside STRING VALUES only — JSON structure stays intact. */
function redactPayload(obj: unknown): unknown {
  if (typeof obj === "string") return redactPii(obj);
  if (Array.isArray(obj)) return obj.map(redactPayload);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, redactPayload(v)]));
  }
  return obj;
}

/**
 * Append an event. Writes are serialised through a Prisma interactive
 * transaction (SQLite single-writer ⇒ chain stays linear, matching the
 * Postgres advisory-lock design in production — see ADR-006).
 */
export async function appendEvent(e: AuditEventInput): Promise<{ id: number; hash: string }> {
  const redacted = redactPayload(e.payload) as Record<string, unknown>;
  return await db.$transaction(async (tx) => {
    const prev = await tx.auditEvent.findFirst({ orderBy: { id: "desc" }, select: { hash: true } });
    const prevHash = prev?.hash ?? GENESIS_HASH;
    // Canonical (sorted-key) serialisation — the EXACT string that is stored
    // is the string that is hashed, so verification can recompute 1:1.
    const payloadJson = canonicalEvent({
      actor: e.actor,
      eventType: e.eventType,
      ...redacted,
    });
    const hash = eventHash(prevHash, JSON.parse(payloadJson));
    const row = await tx.auditEvent.create({
      data: {
        sessionId: e.sessionId ?? null,
        actor: e.actor,
        eventType: e.eventType,
        payload: payloadJson,
        prevHash,
        hash,
      },
    });
    return { id: row.id, hash: row.hash };
  });
}

export async function getChain(limit = 500, sessionId?: string) {
  const rows = await db.auditEvent.findMany({
    where: sessionId ? { sessionId } : undefined,
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.reverse();
}
