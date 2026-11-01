import { NextResponse } from "next/server";
import { getChain, verifyDbChain, verifySessionProjection, DEFAULT_ORG } from "@/lib/audit";
import { requireDemoOfficer } from "@/lib/authz";
import { db } from "@/lib/db";
import { ERR, reqId } from "@/lib/schemas";

/** GET /api/audit?sessionId=&limit= — hash-chained audit viewer + chain proof.
 *  Officer-only (audit is console surface, not customer surface).
 *
 *  VERIFICATION (deep-review P1-6): the whole per-org chain is recomputed —
 *  org-scoped sequences, prev-hash links, payload hash recomputation, and the
 *  signed archival checkpoint chain. The FIRST broken link is reported with
 *  its exact position and failure kind. A session filter NEVER weakens the
 *  answer: the session projection is additionally proven against its
 *  surrounding org-chain links.
 *
 *  VERIFIED RANGE HONESTY (deep-review P2-9): the response says exactly what
 *  was checked — `coverage` is "full-history" only when every surviving event
 *  was verified, and events archived under a signed checkpoint are reported
 *  as `archivedUnder`. The chain is tamper-evident within the verified range;
 *  it is NOT immutable storage — a privileged DB writer could still rewrite
 *  history and recompute hashes. Anchoring to independent storage is future
 *  work (see threat-model). */
export async function GET(req: Request) {
  const auth = await requireDemoOfficer(req);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "120", 10) || 120));
    const rows = await getChain(limit, sessionId);

    const verification = await verifyDbChain();
    const projection = sessionId ? await verifySessionProjection(sessionId) : null;
    const totalInDb = await db.auditEvent.count();

    return NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        orgId: r.orgId,
        sessionId: r.sessionId,
        actor: r.actor,
        eventType: r.eventType,
        payload: JSON.parse(r.payload),
        prevHash: r.prevHash.slice(0, 16),
        hash: r.hash,
        requestId: r.requestId,
        createdAt: r.createdAt,
      })),
      verification: {
        ok: verification.ok && (projection?.ok ?? true),
        brokenAt: verification.brokenLink ? verification.brokenLink.seq : null,
        brokenLink: verification.brokenLink,
        sessionProjection: projection,
        verifiedEvents: verification.checkedEvents,
        totalEventsInDb: totalInDb,
        orgs: verification.orgs.length > 0 ? verification.orgs : [{ orgId: DEFAULT_ORG, events: 0, headSeq: 0 }],
        checkpoints: verification.checkpoints,
        coverage:
          verification.checkedEvents >= totalInDb
            ? "full-history"
            : `suffix-window (newest ${Math.min(totalInDb, 10_000)})`,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error("[audit]", e);
    return ERR.internal(reqId(req));
  }
}
