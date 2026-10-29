import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
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
 * The dispatcher also mints a request id (x-request-id) and converts any
 * uncaught handler error into the shared error envelope — no stack traces,
 * no raw database errors.
 *
 * Routes (unchanged URLs — the frontend is untouched):
 *   GET/POST /api/auth/login   demo login + customer/officer list
 *   POST     /api/auth/logout  revoke the caller's demo session
 *   POST/GET /api/chat         orchestrator turn + history (own session only)
 *   GET/POST /api/approvals    HITL queue + officer decision (officer-only)
 *   GET/POST /api/idp          payslip samples + loan-pack build (own session)
 *   GET      /api/audit        hash-chained audit viewer (officer-only)
 *   GET      /api/metrics      Prometheus exposition (officer-only)
 *   GET/POST /api/health       liveness + tool specs
 *   GET      /api/tools        least-privilege tool surface
 *   GET      /api/eval         latest golden-set run (officer-only)
 */

type Handler = (req: Request) => Promise<Response>;

// Vercel: headroom for a cold instance (Prisma engine spin-up, /tmp DB clone)
// plus the 6 s external-model deadline before the deterministic fallback
// composes the answer. 30 s sits inside every plan's function limit.
export const maxDuration = 30;

const ROUTES: Record<string, Partial<Record<"GET" | "POST" | "PUT", Handler>>> = {
  "auth/login": { GET: auth.GET, POST: auth.POST },
  "auth/logout": { PUT: auth.PUT, POST: auth.PUT },
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
  method: "GET" | "POST" | "PUT",
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  // request id: minted here, visible to handlers via x-request-id and echoed
  // in every error envelope (see src/lib/schemas.ts).
  const requestId = `req_${randomBytes(6).toString("hex")}`;
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.body) {
    init.body = req.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const scoped = new Request(req.url, init);

  const { path } = await ctx.params;
  const key = (path ?? []).join("/");
  try {
    const route = ROUTES[key];
    if (!route) {
      return NextResponse.json(
        { error: { code: "not_found", message: `No such endpoint: /api/${key}`, requestId } },
        { status: 404 }
      );
    }
    const handler = route[method];
    if (!handler) {
      return NextResponse.json(
        { error: { code: "method_not_allowed", message: `${method} /api/${key} is not supported`, requestId } },
        { status: 405 }
      );
    }
    return await handler(scoped);
  } catch (e) {
    console.error(`[api:${key}]`, requestId, e);
    return NextResponse.json(
      {
        error: {
          code: "internal_error",
          message: "Something went wrong on our side. Please retry — nothing was double-charged.",
          requestId,
        },
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return dispatch("GET", req, ctx);
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return dispatch("POST", req, ctx);
}

export async function PUT(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return dispatch("PUT", req, ctx);
}
