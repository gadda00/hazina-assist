import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { listTools } from "@/lib/tools";
import { breakerState } from "@/lib/gateway";
import { availableLabels } from "@/lib/categoriser";

/** GET /api/health — liveness + dependency snapshot (used by the monitoring tab). */
export async function GET() {
  const auditCount = await db.auditEvent.count();
  return NextResponse.json({
    status: "ok",
    service: "hazina-assist",
    version: "0.1.0",
    dependencies: {
      database: "ok",
      modelGateway: breakerState().open ? "circuit_open (fallback active)" : "ok",
      categoriser: process.env.CATEGORISER_URL ? "configured" : "local-fallback",
    },
    counts: { auditEvents: auditCount },
    time: new Date().toISOString(),
  });
}

/** GET /api/health?tools=1 — also list the registered tool specs. */
export async function POST() {
  return NextResponse.json({
    tools: listTools(),
    categoriserLabels: availableLabels(),
    gatewayBreaker: breakerState(),
  });
}
