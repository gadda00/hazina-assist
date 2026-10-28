import { NextResponse } from "next/server";
import { getChain } from "@/lib/audit";
import { verifyChain } from "@hazina/kit";

/** GET /api/audit?sessionId=&verify=1 — hash-chained audit viewer + chain proof. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const limit = Math.min(500, parseInt(url.searchParams.get("limit") ?? "120"));
  const rows = await getChain(limit, sessionId);

  // Chain verification runs over the FULL chain (ascending), not just the page.
  const all = await getChain(10_000, sessionId);
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
