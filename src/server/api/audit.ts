import { NextResponse } from "next/server";
import { getChain } from "@/lib/audit";
import { verifyChain } from "@hazina/kit";
import { requireDemoOfficer } from "@/lib/authz";
import { db } from "@/lib/db";
import { ERR, reqId } from "@/lib/schemas";

/** GET /api/audit?sessionId=&limit= — hash-chained audit viewer + chain proof.
 *  Officer-only (audit is console surface, not customer surface).
 *
 *  VERIFIED RANGE HONESTY (deep-review P2-9): verification recomputes the
 *  chain over the newest ≤10,000 events, and the response says exactly that —
 *  `coverage` is "full-history" only when every event in the table was
 *  checked, otherwise "suffix-window" with both counts. The chain is
 *  tamper-evident within the verified range; it is NOT immutable storage —
 *  a privileged DB writer could still rewrite history and recompute hashes.
 *  Anchoring to independent storage is future work (see threat-model). */
export async function GET(req: Request) {
  const auth = await requireDemoOfficer(req);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "120", 10) || 120));
    const rows = await getChain(limit, sessionId);

    // Verification ALWAYS runs over the FULL global chain, not the session
    // slice: session events interleave with other sessions', so a filtered
    // slice can never verify standalone (its first prevHash points back into
    // the shared chain). The trust answer is "the one chain containing this
    // session's events is intact" — and that is what we recompute here.
    const all = await getChain(10_000);
    const verification = verifyChain(
      all.map((r) => ({ payload: r.payload, prevHash: r.prevHash, hash: r.hash }))
    );
    const totalInDb = await db.auditEvent.count();
    const verifiedCount = verification.length;

    return NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        actor: r.actor,
        eventType: r.eventType,
        payload: JSON.parse(r.payload),
        prevHash: r.prevHash.slice(0, 16),
        hash: r.hash,
        createdAt: r.createdAt,
      })),
      verification: {
        ok: verification.ok,
        brokenAt: verification.brokenAt,
        verifiedEvents: verifiedCount,
        totalEventsInDb: totalInDb,
        coverage: verifiedCount >= totalInDb ? "full-history" : "suffix-window (newest 10,000)",
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error("[audit]", e);
    return ERR.internal(reqId(req));
  }
}
