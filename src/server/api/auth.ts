import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appendEvent } from "@/lib/audit";
import { createDemoSession, revokeSessionByToken, tokenFromRequest } from "@/lib/authz";
import { deploymentMode } from "@/lib/deployment";
import { ERR, LoginSchema, parseBody, reqId } from "@/lib/schemas";

/**
 * POST /api/auth/login — demo login: pick a synthetic customer (or, with
 * `as: "officer"`, open a demo officer session for the ops console). Returns
 * a server-side session + a bearer token; every protected endpoint resolves
 * the session from that token (src/lib/authz.ts).
 *
 * DEMO IAM ONLY: this endpoint is the synthetic identity picker. In
 * DEPLOYMENT_MODE=operational it is refused outright — fail-closed — because
 * this build ships no real OIDC provider (deep-review P0-1). The startup
 * assertions in src/lib/deployment.ts already block that boot, but the guard
 * here defends in depth (e.g. a misconfigured proxy or edge runtime).
 *
 * GET /api/auth/login — list the demo customers + officers.
 *
 * POST /api/auth/logout — revoke the session bound to the caller's token.
 *
 * Handlers live in src/server/api/* instead of per-endpoint files under
 * src/app/api so the whole API ships as ONE serverless function
 * (src/app/api/[[...path]]/route.ts).
 */
export async function POST(req: Request) {
  if (deploymentMode() !== "demo") {
    return NextResponse.json(
      {
        error: {
          code: "demo_login_disabled",
          message:
            "The demo identity picker is disabled in operational mode. This build ships demo IAM only; integrate a real OIDC provider before running operational.",
        },
      },
      { status: 403 }
    );
  }
  const parsed = await parseBody(req, LoginSchema);
  if (!parsed.ok) return parsed.response;
  const { customerId, as } = parsed.data;

  try {
    const result = await createDemoSession(customerId, as);
    if (!result.ok) {
      if (result.code === "not_an_officer") {
        return ERR.forbidden(reqId(req));
      }
      return ERR.notFound("Customer", reqId(req));
    }
    const { session, token, customer } = result;

    if (as === "officer") {
      await appendEvent({
        sessionId: session.id,
        actor: `officer:${customer.id}`,
        eventType: "officer_session_opened",
        payload: { officer: customer.name, scopes: ["approvals:decide", "audit:read", "evals:read"] },
      });
      return NextResponse.json({
        session: { id: session.id, token, role: "officer", createdAt: session.createdAt },
        customer: { id: customer.id, name: customer.name, role: customer.role },
        accounts: [],
        beneficiaries: [],
      });
    }

    const full = await db.customer.findUnique({
      where: { id: customer.id },
      include: { accounts: true, beneficiaries: true },
    });
    await appendEvent({
      sessionId: session.id,
      actor: `customer:${customer.id}`,
      eventType: "session_opened",
      payload: { customer: customer.name, scopes: ["accounts:read", "fees:read", "transfers:propose"] },
    });
    return NextResponse.json({
      session: { id: session.id, token, role: "customer", createdAt: session.createdAt },
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      accounts: (full?.accounts ?? []).map((a) => ({
        handle: a.handle,
        maskedNumber: a.maskedNumber,
        type: a.type,
        currency: a.currency,
      })),
      beneficiaries: (full?.beneficiaries ?? []).map((b) => ({
        name: b.name,
        destinationType: b.destinationType,
        masked: b.destination.replace(/.(?=.{4})/g, "*"),
        established: !!b.firstUsedAt,
      })),
    });
  } catch (e) {
    console.error("[auth:login]", e);
    return ERR.internal(reqId(req));
  }
}

export async function GET() {
  const [customers, officers] = await Promise.all([
    db.customer.findMany({ where: { role: "customer" }, include: { accounts: true } }),
    db.customer.findMany({ where: { role: { in: ["credit_officer", "approver"] } } }),
  ]);
  return NextResponse.json({
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone.replace(/.(?=.{4})/g, "*"),
      accounts: c.accounts.map((a) => ({ handle: a.handle, type: a.type, maskedNumber: a.maskedNumber })),
    })),
    officers: officers.map((o) => ({
      id: o.id,
      name: o.name,
      role: o.role,
    })),
  });
}

/** POST /api/auth/logout — revoke the caller's token (idempotent). */
export async function PUT(req: Request) {
  const token = tokenFromRequest(req);
  if (token) await revokeSessionByToken(token);
  return NextResponse.json({ ok: true, loggedOut: true });
}
