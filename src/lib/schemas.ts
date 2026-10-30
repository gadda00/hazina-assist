/**
 * Shared request schemas (Zod) + the consistent error envelope.
 *
 * Every API endpoint validates its input through these before touching the
 * database, and every error response uses `jsonError` so clients always see:
 *
 *   { "error": { "code": "...", "message": "...", "requestId": "req_..." } }
 *
 * requestId is generated per-request in the catch-all router and threaded
 * into handlers via the `req` header `x-request-id` (set by the dispatcher).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

export const LoginSchema = z.object({
  customerId: z.string().min(1).max(64),
  as: z.enum(["customer", "officer"]).optional().default("customer"),
});

export const ChatPostSchema = z.object({
  sessionId: z.string().min(1).max(64),
  message: z.string().min(1).max(2000),
});

export const ChatGetSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

export const ApprovalPostSchema = z.object({
  taskId: z.string().min(1).max(64),
  decision: z.enum(["approve", "reject"]),
  // `officer` was removed (deep-review P1-7): the recorded actor is derived
  // from the authenticated officer session server-side, never from input.
  reason: z.string().min(1).max(500).optional(),
});

export const IdpPostSchema = z
  .object({
    sessionId: z.string().min(1).max(64),
    sampleKey: z.enum(["clean", "scanned"]).optional(),
    text: z.string().max(20_000).optional(), // input-size limit even for the demo
    requestedAmountKes: z.number().int().min(1_000).max(5_000_000).optional(),
    tenorMonths: z.number().int().min(1).max(84).optional(),
  })
  .refine((v) => v.sampleKey != null || (v.text != null && v.text.trim().length > 0), {
    message: "sampleKey or non-empty text is required",
  });

export const SessionQuerySchema = z.object({
  sessionId: z.string().min(1).max(64),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type ChatPostInput = z.infer<typeof ChatPostSchema>;
export type ApprovalPostInput = z.infer<typeof ApprovalPostSchema>;
export type IdpPostInput = z.infer<typeof IdpPostSchema>;

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  requestId?: string
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: { code, message, ...(requestId ? { requestId } : {}) } }, { status });
}

export const ERR = {
  badJson: (rid?: string) => jsonError("invalid_json", "Request body must be valid JSON.", 400, rid),
  validation: (detail: string, rid?: string) =>
    jsonError("validation_failed", `Invalid request: ${detail}`, 400, rid),
  unauthorized: (rid?: string) =>
    jsonError("unauthorized", "Sign in first — a demo session token is required.", 401, rid),
  forbidden: (rid?: string) =>
    jsonError("forbidden", "This action requires a demo officer session.", 403, rid),
  crossSession: (rid?: string) =>
    jsonError("cross_session_access", "Sessions can only read their own data.", 403, rid),
  notFound: (what: string, rid?: string) => jsonError("not_found", `${what} not found.`, 404, rid),
  internal: (rid?: string) =>
    jsonError("internal_error", "Something went wrong on our side. Please retry — nothing was double-charged.", 500, rid),
} as const;

/** Parse+validate a JSON body; returns either parsed data or an error response. */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: ERR.badJson(reqId(req)) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return { ok: false, response: ERR.validation(detail, reqId(req)) };
  }
  return { ok: true, data: parsed.data };
}

/** Validate URL query params the same way. */
export function parseQuery<T>(
  req: Request,
  schema: z.ZodType<T>
): { ok: true; data: T } | { ok: false; response: NextResponse } {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "query"}: ${i.message}`)
      .join("; ");
    return { ok: false, response: ERR.validation(detail, reqId(req)) };
  }
  return { ok: true, data: parsed.data };
}

/** Request ID set by the catch-all dispatcher (x-request-id header). */
export function reqId(req: Request): string | undefined {
  const id = req.headers.get("x-request-id");
  return id ?? undefined;
}
