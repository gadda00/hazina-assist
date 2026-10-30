import { db } from "@/lib/db";
import { requireDemoOfficer } from "@/lib/authz";
import { ERR } from "@/lib/schemas";
import { timingSafeEqual } from "node:crypto";

/**
 * GET /api/metrics — Prometheus text exposition format, fed by REAL data:
 * guardrail trip counts, escalation rate, latency and cost aggregates from
 * the audit chain (newest ≤5,000 events — the documented window; counters
 * reset when the demo DB resets). The Ops console "Monitoring" tab renders
 * the same numbers directly.
 *
 * AUTHORIZATION (deep-review P1-5) — one of:
 *   1. a dedicated scrape token: `Authorization: Bearer <HAZINA_METRICS_TOKEN>`
 *      (or `x-scrape-token: …`) — the read-only identity Prometheus uses in
 *      the Compose/K8s deployment (deploy/prometheus.yml). Rotation is a
 *      coordinated env change on both sides.
 *   2. an officer demo session (the ops console).
 * Metrics never become fully public: without either credential this returns
 * 401 — a scraper without auth is a red flag, not a working dashboard.
 */
function scrapeTokenOk(req: Request): boolean {
  const expected = process.env.HAZINA_METRICS_TOKEN?.trim() ?? "";
  if (!expected) return false;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const header = req.headers.get("x-scrape-token")?.trim() ?? "";
  const supplied = bearer || header;
  if (!supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export async function GET(req: Request) {
  const scrapeAuthorized = scrapeTokenOk(req);
  if (!scrapeAuthorized) {
    const auth = await requireDemoOfficer(req);
    if (!auth.ok) return auth.response;
  }
  try {
  const events = await db.auditEvent.findMany({ take: 5000 });
  const payloads = events.map((e) => {
    try { return JSON.parse(e.payload) as Record<string, unknown>; } catch { return {}; }
  });

  const respond = events.filter((e) => e.eventType === "respond");
  const latencies = respond.map((e) => (JSON.parse(e.payload) as { latency_ms?: number }).latency_ms ?? 0).filter((n) => n > 0);
  const costs = respond.map((e) => (JSON.parse(e.payload) as { cost_usd?: number }).cost_usd ?? 0);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

  const guardIn = payloads.filter((_, i) => events[i].eventType === "guard_in");
  const injectionTrips = guardIn.filter((g) => (g.injection_score as number) > 0).length;
  const piiDetections = guardIn.filter((g) => Array.isArray(g.pii_types) && (g.pii_types as string[]).length > 0).length;
  const refusals = events.filter((e) => e.eventType === "refused").length;
  const handoffs = events.filter((e) => e.eventType === "handoff_raised").length;
  const hitlRaised = events.filter((e) => e.eventType === "hitl_raised").length;
  const transfersExecuted = events.filter((e) => e.eventType === "transfer_executed").length;
  const otpIssued = events.filter((e) => e.eventType === "otp_issued").length;
  const totalRespond = respond.length || 1;

  const lines = [
    "# HELP hazina_requests_total Total orchestrator responses (audit-derived, newest 5000-event window)",
    "# TYPE hazina_requests_total counter",
    `hazina_requests_total ${respond.length}`,
    "# HELP hazina_request_latency_ms Orchestrator latency in milliseconds",
    "# TYPE hazina_request_latency_ms gauge",
    `hazina_request_latency_ms{quantile="0.5"} ${p(0.5)}`,
    `hazina_request_latency_ms{quantile="0.95"} ${p(0.95)}`,
    "# HELP hazina_cost_usd_total Estimated model spend in USD",
    "# TYPE hazina_cost_usd_total counter",
    `hazina_cost_usd_total ${costs.reduce((a, b) => a + b, 0).toFixed(4)}`,
    "# HELP hazina_guardrail_trips_total Guardrail activations by kind",
    "# TYPE hazina_guardrail_trips_total counter",
    `hazina_guardrail_trips_total{kind="injection"} ${injectionTrips}`,
    `hazina_guardrail_trips_total{kind="pii_detected"} ${piiDetections}`,
    `hazina_guardrail_trips_total{kind="refusal"} ${refusals}`,
    "# HELP hazina_escalation_rate Escalations over total responses",
    "# TYPE hazina_escalation_rate gauge",
    `hazina_escalation_rate ${((handoffs + hitlRaised) / totalRespond).toFixed(4)}`,
    "# HELP hazina_hitl_raised_total Human-in-the-loop tasks raised",
    "# TYPE hazina_hitl_raised_total counter",
    `hazina_hitl_raised_total ${hitlRaised}`,
    "# HELP hazina_transfers_executed_total Transfers executed after approval",
    "# TYPE hazina_transfers_executed_total counter",
    `hazina_transfers_executed_total ${transfersExecuted}`,
    "# HELP hazina_otp_issued_total Step-up OTP codes issued",
    "# TYPE hazina_otp_issued_total counter",
    `hazina_otp_issued_total ${otpIssued}`,
    "# HELP hazina_audit_events_total Audit chain length",
    "# TYPE hazina_audit_events_total counter",
    `hazina_audit_events_total ${events.length}`,
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
  } catch (e) {
    console.error("[metrics]", e);
    return ERR.internal();
  }
}
