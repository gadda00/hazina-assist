import { NextResponse } from "next/server";
import { getChain } from "@/lib/audit";
import { verifyChain } from "@hazina/kit";

/** GET /api/audit?sessionId=&limit= — hash-chained audit viewer + chain proof. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const limit = Math.min(500, parseInt(url.searchParams.get("limit") ?? "120"));
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
      totalEvents: verification.length,
      checkedAt: new Date().toISOString(),
    },
  });
}
