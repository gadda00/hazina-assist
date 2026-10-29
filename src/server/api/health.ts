import { NextResponse } from "next/server";
import { db, dbDiagnostics } from "@/lib/db";
import { listTools } from "@/lib/tools";
import { breakerState } from "@/lib/gateway";
import { availableLabels } from "@/lib/categoriser";
import { demoMode } from "@/lib/transfer";

/**
 * GET /api/health — liveness + dependency snapshot (used by the monitoring
 * tab). NEVER throws: if the database is unreachable the endpoint reports a
 * degraded status plus safe diagnostics (paths searched, init error class)
 * instead of an anonymous 500 — a broken deployment becomes debuggable from
 * the outside.
 */
export async function GET() {
  let database: { ok: boolean; auditEvents: number; error?: string } = { ok: false, auditEvents: 0 };
  try {
    const auditCount = await db.auditEvent.count();
    database = { ok: true, auditEvents: auditCount };
  } catch (e) {
    database = {
      ok: false,
      auditEvents: 0,
      error: e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e).slice(0, 200),
    };
  }

  return NextResponse.json({
    status: database.ok ? "ok" : "degraded",
    service: "hazina-assist",
    version: "0.2.0",
    dependencies: {
      database,
      modelGateway: breakerState().open ? "circuit_open (fallback active)" : "ok",
      categoriser: process.env.CATEGORISER_URL ? "configured" : "local-fallback",
      demoMode: demoMode() ? "on (OTP code visible in UI)" : "off",
    },
    ...(database.ok ? {} : { diagnostics: dbDiagnostics }),
    time: new Date().toISOString(),
  });
}

/** POST /api/health — also list the registered tool specs. */
export async function POST() {
  return NextResponse.json({
    tools: listTools(),
    categoriserLabels: availableLabels(),
    gatewayBreaker: breakerState(),
  });
}
