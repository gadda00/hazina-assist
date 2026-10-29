/**
 * Demo authorization — server-side sessions with bearer tokens.
 *
 * The customer picker is still synthetic (no real OIDC), but authorization no
 * longer trusts a raw sessionId from the request body:
 *
 *  - login mints a random 192-bit token; only its SHA-256 hash is stored
 *  - every protected endpoint resolves the session from the token header
 *    (`x-demo-token`, or `Authorization: Bearer …`)
 *  - customer endpoints assert the body's sessionId belongs to the caller
 *    (cross-customer access → 403 cross_session_access)
 *  - officer endpoints (approvals, audit, evals, metrics) require a session
 *    opened with `as: "officer"` on a customer record whose role is an
 *    officer role — customers can never mutate approval tasks
 *  - logout revokes the session server-side
 *
 * It is a demo IAM, deliberately visible and simple — not production IAM.
 */
import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ERR, reqId } from "@/lib/schemas";

export const TOKEN_HEADER = "x-demo-token";
const OFFICER_ROLES = new Set(["credit_officer", "approver"]);

export interface DemoSession {
  id: string;
  customerId: string;
  role: "customer" | "officer";
  customerName: string;
  customerRole: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintToken(): string {
  return randomBytes(24).toString("base64url"); // 192-bit, URL-safe
}

/** Create a session row + its bearer token. */
export async function createDemoSession(customerId: string, as: "customer" | "officer") {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) return { ok: false as const, code: "customer_not_found" };
  if (as === "officer" && !OFFICER_ROLES.has(customer.role)) {
    return { ok: false as const, code: "not_an_officer" };
  }
  const token = mintToken();
  const session = await db.chatSession.create({
    data: {
      customerId,
      role: as,
      tokenHash: hashToken(token),
      status: "active",
    },
  });
  return { ok: true as const, session, token, customer };
}

/** Resolve the session from the request's token header. Null when absent/invalid/revoked. */
export async function sessionFromRequest(req: Request): Promise<DemoSession | null> {
  const header =
    req.headers.get(TOKEN_HEADER) ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const token = header.trim();
  if (!token || token.length > 128) return null;
  const row = await db.chatSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { customer: true },
  });
  if (!row) return null;
  if (row.revokedAt || row.status !== "active") return null;
  return {
    id: row.id,
    customerId: row.customerId,
    role: row.role === "officer" ? "officer" : "customer",
    customerName: row.customer.name,
    customerRole: row.customer.role,
  };
}

type Guard<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** Any authenticated demo session (customer or officer). */
export async function requireDemoSession(req: Request): Promise<Guard<DemoSession>> {
  const s = await sessionFromRequest(req);
  if (!s) return { ok: false, response: ERR.unauthorized(reqId(req)) };
  return { ok: true, data: s };
}

/** Customer app endpoints (chat, idp). */
export async function requireCustomerSession(req: Request): Promise<Guard<DemoSession>> {
  const s = await sessionFromRequest(req);
  if (!s) return { ok: false, response: ERR.unauthorized(reqId(req)) };
  if (s.role !== "customer") {
    return { ok: false, response: ERR.forbidden(reqId(req)) };
  }
  return { ok: true, data: s };
}

/** Officer console endpoints (approvals, audit, evals, metrics). */
export async function requireDemoOfficer(req: Request): Promise<Guard<DemoSession>> {
  const s = await sessionFromRequest(req);
  if (!s) return { ok: false, response: ERR.unauthorized(reqId(req)) };
  if (s.role !== "officer" || !OFFICER_ROLES.has(s.customerRole)) {
    return { ok: false, response: ERR.forbidden(reqId(req)) };
  }
  return { ok: true, data: s };
}

/** The body/query sessionId must belong to the caller's session. */
export function assertSessionOwnsCustomer(
  session: DemoSession,
  sessionId: string
): Guard<true> {
  if (session.id !== sessionId) {
    return { ok: false, response: ERR.crossSession() };
  }
  return { ok: true, data: true as const };
}

/** Revoke (logout). Idempotent: unknown tokens still return ok. */
export async function revokeSessionByToken(token: string): Promise<void> {
  await db.chatSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date(), status: "closed" },
  });
}

export function tokenFromRequest(req: Request): string {
  return (
    req.headers.get(TOKEN_HEADER) ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    ""
  ).trim();
}
