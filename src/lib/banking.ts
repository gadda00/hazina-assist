/**
 * Mock core banking shaped like Co-opConnect:
 *  - messageReference on every call (idempotency key)
 *  - account-information services (balance, mini/full statement)
 *  - transactional services (internal transfer, PesaLink, send-to-M-Pesa)
 *  - transaction status endpoint
 * The customer-facing data is 100% synthetic.
 */
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { addKes, toCents } from "@/lib/money";
import { DEFAULT_LIMITS } from "@hazina/kit";
import { Prisma } from "@prisma/client";

export interface CoreResult<T> {
  messageReference: string;
  status: "success" | "duplicate" | "failed";
  responseCode: string;
  responseDescription: string;
  data?: T;
}

function messageRef(): string {
  return `MR-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

export async function coreGetBalance(accountId: string): Promise<CoreResult<{ balanceKes: number; currency: string }>> {
  const acct = await db.account.findUnique({ where: { id: accountId } });
  if (!acct) {
    return { messageReference: messageRef(), status: "failed", responseCode: "ACCT-404", responseDescription: "Account not found" };
  }
  return {
    messageReference: messageRef(),
    status: "success",
    responseCode: "0",
    responseDescription: "Success",
    data: { balanceKes: acct.balanceKes, currency: acct.currency },
  };
}

export async function coreMiniStatement(
  accountId: string,
  count: number
): Promise<CoreResult<{ transactions: Array<{ txnRef: string; ts: string; narrative: string; amount: number; direction: string; channel?: string | null; category?: string | null; runningCategory?: string | null }> }>> {
  const txns = await db.transaction.findMany({
    where: { accountId },
    orderBy: { ts: "desc" },
    take: count,
  });
  return {
    messageReference: messageRef(),
    status: "success",
    responseCode: "0",
    responseDescription: "Success",
    data: {
      transactions: txns.map((t) => ({
        txnRef: t.txnRef,
        ts: t.ts.toISOString(),
        narrative: t.narrative,
        amount: t.amount,
        direction: t.direction,
        channel: t.channel,
        category: t.category,
        runningCategory: t.category,
      })),
    },
  };
}

export interface TransferInstruction {
  fromAccountId: string;
  amountKes: number;
  destinationType: "internal" | "mpesa" | "pesalink";
  destination: string;
  beneficiaryName: string;
  purpose?: string;
  idempotencyKey: string; // messageReference from the signed intent
}

/**
 * Execute a transfer with idempotency-by-message-reference: replaying the
 * same key returns the original result instead of moving money twice.
 *
 * ATOMICITY (deep-review P0-2): balance sufficiency, the daily cap and the
 * debit are enforced inside ONE transaction:
 *   1. a conditional `UPDATE … WHERE balanceKes >= total` — the funds check
 *      and the debit are a single atomic statement, and it takes the row
 *      lock that serialises competing transfers on the same account;
 *   2. the daily-cap recount happens AFTER that update, i.e. under the same
 *      per-account lock, so two intents racing the cap cannot both pass;
 *   3. the idempotency record is written in the same transaction, and a
 *      concurrent same-key duplicate fails the unique constraint and rolls
 *      back — replaying/competing calls can never double-debit.
 */
export async function coreTransfer(instr: TransferInstruction): Promise<CoreResult<{ txnRef: string; feeKes: number }>> {
  const existing = await db.idempotencyKey.findUnique({ where: { key: instr.idempotencyKey } });
  if (existing) {
    const prior = JSON.parse(existing.response) as CoreResult<{ txnRef: string; feeKes: number }>;
    return { ...prior, status: "duplicate", responseDescription: "Duplicate message reference — original result returned" };
  }

  const acct = await db.account.findUnique({ where: { id: instr.fromAccountId } });
  if (!acct) {
    return { messageReference: instr.idempotencyKey, status: "failed", responseCode: "ACCT-404", responseDescription: "Account not found" };
  }

  class ControlError extends Error {
    constructor(readonly responseCode: string, readonly responseDescription: string) {
      super(responseCode);
    }
  }

  const txnRef = `TXN-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;

  try {
    const feeKes = await db.$transaction(async (tx) => {
      const fee = await computeFee(
        instr.destinationType === "internal" ? "internal_transfer" : instr.destinationType === "mpesa" ? "send_to_mpesa" : "pesalink_out",
        instr.amountKes,
        tx
      );
      const feeValue = fee.feeKes;
      // integer-cents arithmetic: amount + fee and the funds check never drift
      const totalDebit = addKes(instr.amountKes, feeValue);

      // (1) conditional debit — atomic funds check + row lock
      const debited = await tx.$executeRaw`
        UPDATE "Account" SET "balanceKes" = "balanceKes" - ${totalDebit}
        WHERE "id" = ${instr.fromAccountId} AND "balanceKes" >= ${totalDebit}`;
      if (debited !== 1) {
        throw new ControlError("INS-402", "Insufficient funds");
      }

      // (2) daily cap, recounted under the account row lock taken in (1)
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const todays = await tx.transaction.findMany({
        where: { accountId: instr.fromAccountId, direction: "debit", type: "transfer_out", ts: { gte: startOfDay }, status: "completed" },
        select: { amount: true },
      });
      const executedTodayCents = todays.reduce((a, t) => a + toCents(t.amount), 0);
      if (executedTodayCents + toCents(instr.amountKes) > toCents(DEFAULT_LIMITS.dailyKes)) {
        throw new ControlError("CAP-403", `Daily transfer cap of KES ${DEFAULT_LIMITS.dailyKes.toLocaleString()} exceeded`);
      }

      await tx.transaction.create({
        data: {
          accountId: instr.fromAccountId,
          txnRef,
          messageRef: instr.idempotencyKey,
          type: "transfer_out",
          direction: "debit",
          amount: instr.amountKes,
          channel: instr.destinationType,
          counterparty: `${instr.beneficiaryName} (${maskDestination(instr.destination)})`,
          narrative: `Transfer to ${instr.beneficiaryName} — ${instr.destinationType.toUpperCase()}${instr.purpose ? ` — ${instr.purpose}` : ""}`,
          status: "completed",
        },
      });
      if (feeValue > 0) {
        await tx.transaction.create({
          data: {
            accountId: instr.fromAccountId,
            txnRef: `FEE-${txnRef.slice(4)}`,
            messageRef: instr.idempotencyKey,
            type: "fee",
            direction: "debit",
            amount: feeValue,
            channel: instr.destinationType,
            counterparty: "Hazina Bank",
            narrative: "Tariff charge",
            status: "completed",
          },
        });
      }
      // (3) idempotency record in the SAME transaction as the debit — a
      // concurrent same-key writer fails the unique constraint and the whole
      // transaction (including its debit) rolls back.
      const res: CoreResult<{ txnRef: string; feeKes: number }> = {
        messageReference: instr.idempotencyKey,
        status: "success",
        responseCode: "0",
        responseDescription: "Success",
        data: { txnRef, feeKes: feeValue },
      };
      await tx.idempotencyKey.create({ data: { key: instr.idempotencyKey, response: JSON.stringify(res) } });
      return feeValue;
    });

    return {
      messageReference: instr.idempotencyKey,
      status: "success",
      responseCode: "0",
      responseDescription: "Success",
      data: { txnRef, feeKes },
    };
  } catch (e) {
    // same-key race: a concurrent execution wrote the receipt first — its
    // debit stands, ours rolled back. Return the original result.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const prior = await db.idempotencyKey.findUnique({ where: { key: instr.idempotencyKey } });
      if (prior) {
        const original = JSON.parse(prior.response) as CoreResult<{ txnRef: string; feeKes: number }>;
        return { ...original, status: "duplicate", responseDescription: "Duplicate message reference — original result returned" };
      }
    }
    if (e instanceof ControlError) {
      const res: CoreResult<{ txnRef: string; feeKes: number }> = {
        messageReference: instr.idempotencyKey,
        status: "failed",
        responseCode: e.responseCode,
        responseDescription: e.responseDescription,
      };
      // deterministic failure receipt (best-effort; a concurrent writer may
      // have recorded it already)
      await db.idempotencyKey.create({ data: { key: instr.idempotencyKey, response: JSON.stringify(res) } }).catch(() => undefined);
      return res;
    }
    throw e;
  }
}

export async function coreTransactionStatus(txnRef: string): Promise<CoreResult<{ txnRef: string; status: string }>> {
  const t = await db.transaction.findFirst({ where: { txnRef } });
  if (!t) {
    return { messageReference: messageRef(), status: "failed", responseCode: "TXN-404", responseDescription: "Transaction not found" };
  }
  return {
    messageReference: messageRef(),
    status: "success",
    responseCode: "0",
    responseDescription: "Success",
    data: { txnRef: t.txnRef, status: t.status },
  };
}

function maskDestination(d: string): string {
  if (d.length <= 4) return d;
  return `${"*".repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Deterministic fee computation — an LLM must never do fee arithmetic.
// ---------------------------------------------------------------------------

export interface FeeResult {
  feeKes: number;
  matchedRow: { product: string; channel: string; band: string; feeType: string; feeValue: number; effectiveDate: string; docId: string; page: number } | null;
}

export async function computeFee(
  channel: string,
  amountKes: number,
  tx?: Prisma.TransactionClient
): Promise<FeeResult> {
  const client = tx ?? db;
  const rows = await client.tariffRow.findMany({ where: { channel } });
  const row = rows.find((r) => amountKes >= r.bandMin && (r.bandMax === null || amountKes <= r.bandMax));
  if (!row) {
    return { feeKes: 0, matchedRow: null };
  }
  let fee = row.feeType === "percent" ? (amountKes * row.feeValue) / 100 : row.feeValue;
  if (row.minFee !== null && fee < row.minFee) fee = row.minFee;
  if (row.maxFee !== null && fee > row.maxFee) fee = row.maxFee;
  fee = Math.round(fee * 100) / 100;
  return {
    feeKes: fee,
    matchedRow: {
      product: row.product,
      channel: row.channel,
      band: row.bandMax === null ? `≥ ${row.bandMin.toLocaleString()}` : `${row.bandMin.toLocaleString()} – ${row.bandMax.toLocaleString()}`,
      feeType: row.feeType,
      feeValue: row.feeValue,
      effectiveDate: row.effectiveDate,
      docId: row.docId,
      page: row.page,
    },
  };
}
