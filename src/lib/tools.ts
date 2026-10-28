/**
 * Tool layer — typed function tools with least-privilege scopes and
 * server-side identity. Tool arguments NEVER carry real identity: the LLM
 * sees opaque handles ("acct_7f3a") which the server resolves to the
 * authenticated customer's accounts (resolution fails if not theirs).
 */
import { db } from "@/lib/db";
import { coreGetBalance, coreMiniStatement, computeFee } from "@/lib/banking";
import { z } from "zod";

export interface Session {
  sessionId: string;
  customerId: string;
  scopes: string[]; // "accounts:read" | "fees:read" | ...
}

// ---------------------------------------------------------------------------
// Typed argument schemas (Pydantic-equivalent)
// ---------------------------------------------------------------------------

export const MiniStatementArgs = z.object({
  account_ref: z.string().regex(/^acct_[a-z0-9]+$/, "must be an opaque account handle"),
  count: z.number().int().min(1).max(10).default(5),
});

export const GetBalanceArgs = z.object({
  account_ref: z.string().regex(/^acct_[a-z0-9]+$/),
});

export const ComputeFeeArgs = z.object({
  channel: z.enum([
    "send_to_mpesa",
    "internal_transfer",
    "pesalink_out",
    "withdrawal_agent",
    "withdrawal_atm",
    "balance_check",
  ]),
  amount: z.number().positive(),
});

// ---------------------------------------------------------------------------
// Tool spec registry
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  scope: string;
  readOnly: boolean;
  argsSchema: z.ZodTypeAny;
  /** Executes with server-side identity; receives the RESOLVED account id. */
  fn: (session: Session, args: Record<string, unknown>) => Promise<unknown>;
}

async function resolveHandle(session: Session, handle: string): Promise<string> {
  const acct = await db.account.findUnique({ where: { handle }, select: { id: true, customerId: true } });
  if (!acct || acct.customerId !== session.customerId) {
    throw new ToolError("account_not_yours", `Handle ${handle} does not belong to this session's customer`);
  }
  return acct.id;
}

export class ToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const REGISTRY: Record<string, ToolSpec> = {
  get_balance: {
    name: "get_balance",
    description: "Get the current balance for one of the customer's accounts (opaque handle).",
    scope: "accounts:read",
    readOnly: true,
    argsSchema: GetBalanceArgs,
    fn: async (session, args) => {
      const parsed = GetBalanceArgs.parse(args);
      const accountId = await resolveHandle(session, parsed.account_ref);
      const res = await coreGetBalance(accountId);
      return res;
    },
  },
  mini_statement: {
    name: "mini_statement",
    description: "Get the last N transactions (1-10, default 5) for one of the customer's accounts.",
    scope: "accounts:read",
    readOnly: true,
    argsSchema: MiniStatementArgs,
    fn: async (session, args) => {
      const parsed = MiniStatementArgs.parse(args);
      const accountId = await resolveHandle(session, parsed.account_ref);
      const res = await coreMiniStatement(accountId, parsed.count);
      return res;
    },
  },
  compute_fee: {
    name: "compute_fee",
    description:
      "Deterministic tariff lookup: channel + amount → exact fee. NEVER let the model guess fees.",
    scope: "fees:read",
    readOnly: true,
    argsSchema: ComputeFeeArgs,
    fn: async (_session, args) => {
      const parsed = ComputeFeeArgs.parse(args);
      const res = await computeFee(parsed.channel, parsed.amount);
      return {
        channel: parsed.channel,
        amount: parsed.amount,
        feeKes: res.feeKes,
        matchedRow: res.matchedRow,
      };
    },
  },
};

export function listTools() {
  return Object.values(REGISTRY).map((t) => ({
    name: t.name,
    description: t.description,
    scope: t.scope,
    readOnly: t.readOnly,
  }));
}

/**
 * The single entrypoint for tool execution: parse args against the schema,
 * check the scope against the session, then run. Mirrors the spec's
 * `call_tool` with least privilege.
 */
export async function callTool(session: Session, name: string, args: Record<string, unknown>) {
  const spec = REGISTRY[name];
  if (!spec) throw new ToolError("unknown_tool", `No tool named ${name}`);
  if (!session.scopes.includes(spec.scope)) {
    throw new ToolError("scope_denied", `Session lacks scope ${spec.scope} for ${name}`);
  }
  let parsed: unknown;
  try {
    parsed = spec.argsSchema.parse(args);
  } catch (e) {
    throw new ToolError("invalid_args", (e as Error).message);
  }
  const result = await spec.fn(session, parsed as Record<string, unknown>);
  return { spec, result };
}
