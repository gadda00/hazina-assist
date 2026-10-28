import { NextResponse } from "next/server";
import * as auth from "@/server/api/auth";
import * as chat from "@/server/api/chat";
import * as approvals from "@/server/api/approvals";
import * as idp from "@/server/api/idp";
import * as audit from "@/server/api/audit";
import * as metrics from "@/server/api/metrics";
import * as health from "@/server/api/health";
import * as tools from "@/server/api/tools";
import * as evalRun from "@/server/api/eval";

/**
 * The ENTIRE API ships as one serverless function.
 *
 * Why not src/app/api/<name>/route.ts per endpoint? On Vercel, every route.ts
 * is compiled into its own lambda with its own isolated /tmp — so the demo
 * SQLite DB (cloned to /tmp by src/lib/db.ts) would fork per endpoint: a
 * transfer staged in the chat function would never surface in the approvals
 * queue, and the audit chain would fragment across functions. One optional
 * catch-all = one function = one shared /tmp copy = the cross-route HITL and
 * audit flows hold together. Handlers live in src/server/api/*.ts; this file
 * only dispatches, so endpoints stay as cohesive, individually testable
 * modules.
 *
 * Routes (unchanged URLs — the frontend is untouched):
 *   POST/GET /api/auth/login   demo login + customer list
 *   POST/GET /api/chat         orchestrator turn + history
 *   GET/POST /api/approvals    HITL queue + officer decision
 *   GET/POST /api/idp          payslip samples + loan-pack build
 *   GET      /api/audit        hash-chained audit viewer
 *   GET      /api/metrics      Prometheus exposition
 *   GET/POST /api/health       liveness + tool specs
 *   GET      /api/tools        least-privilege tool surface
 *   GET      /api/eval         latest golden-set run
 */

type Handler = (req: Request) => Promise<Response>;

// Vercel: headroom for a cold instance (Prisma engine spin-up, /tmp DB clone)
// plus the 6 s external-model deadline before the deterministic fallback
// composes the answer. 30 s sits inside every plan's function limit.
export const maxDuration = 30;

const ROUTES: Record<string, Partial<Record<"GET" | "POST", Handler>>> = {
  "auth/login": { GET: auth.GET, POST: auth.POST },
  chat: { GET: chat.GET, POST: chat.POST },
  approvals: { GET: approvals.GET, POST: approvals.POST },
  idp: { GET: idp.GET, POST: idp.POST },
  audit: { GET: audit.GET },
  metrics: { GET: metrics.GET },
  health: { GET: health.GET, POST: health.POST },
  tools: { GET: tools.GET },
  eval: { GET: evalRun.GET },
};

async function dispatch(
  method: "GET" | "POST",
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const { path } = await ctx.params;
  const key = (path ?? []).join("/");
  const route = ROUTES[key];
  if (!route) {
    return NextResponse.json({ error: "not_found", path: `/api/${key}` }, { status: 404 });
  }
  const handler = route[method];
  if (!handler) {
    return NextResponse.json({ error: "method_not_allowed", path: `/api/${key}`, method }, { status: 405 });
  }
  return handler(req);
}

export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return dispatch("GET", req, ctx);
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return dispatch("POST", req, ctx);
}
