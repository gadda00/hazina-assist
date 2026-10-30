import { NextResponse } from "next/server";
import { db, dbDiagnostics } from "@/lib/db";
import { listTools } from "@/lib/tools";
import { breakerState } from "@/lib/gateway";
import { availableLabels } from "@/lib/categoriser";
import { demoMode } from "@/lib/transfer";
import { deploymentMode } from "@/lib/deployment";

/**
 * GET /api/health — dependency snapshot for the monitoring tab.
 *
 * PROBES (deep-review P2-13) — Kubernetes/deploy healthchecks should use:
 *   /api/health?probe=live   → liveness: is the process able to answer at
 *                              all? Never fails on a *dependency* hiccup, so
 *                              a categoriser outage must not restart the pod.
 *   /api/health?probe=ready  → readiness: can we actually serve traffic
 *                              (database reachable)?
 *   /api/health              → full report (UI/monitoring; same body shape
 *                              as before, plus probe/mode fields).
 *
 * NEVER throws: if the database is unreachable the endpoint reports a
 * degraded status plus safe diagnostics (paths searched, init error class)
 * instead of an anonymous 500 — a broken deployment becomes debuggable from
 * the outside.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const probe = url.searchParams.get("probe"); // undefined | "live" | "ready"

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

  if (probe === "live") {
    // liveness: process answering HTTP is alive. Deliberately does NOT fail
    // on database state — that is readiness, not liveness.
    return NextResponse.json({ status: "alive", probe: "live", time: new Date().toISOString() });
  }
  if (probe === "ready") {
    // readiness: we can serve real traffic (DB reachable).
    return NextResponse.json(
      {
        status: database.ok ? "ready" : "not-ready",
        probe: "ready",
        ...(database.ok ? {} : { diagnostics: dbDiagnostics }),
        time: new Date().toISOString(),
      },
      { status: database.ok ? 200 : 503 }
    );
  }

  const mode = deploymentMode();
  return NextResponse.json({
    status: database.ok ? "ok" : "degraded",
    probe: "full",
    mode, // demo | operational — makes the deployment boundary inspectable
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
