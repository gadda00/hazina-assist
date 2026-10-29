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
import { addKes, gteKes, toCents } from "@/lib/money";

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

  const fee = await computeFee(instr.destinationType === "internal" ? "internal_transfer" : instr.destinationType === "mpesa" ? "send_to_mpesa" : "pesalink_out", instr.amountKes);
  const feeKes = fee.feeKes;
  // integer-cents arithmetic: amount + fee and the funds check never drift
  const totalDebit = addKes(instr.amountKes, feeKes);

  if (!gteKes(acct.balanceKes, totalDebit)) {
    const res: CoreResult<{ txnRef: string; feeKes: number }> = {
      messageReference: instr.idempotencyKey,
      status: "failed",
      responseCode: "INS-402",
      responseDescription: "Insufficient funds",
    };
    await db.idempotencyKey.create({ data: { key: instr.idempotencyKey, response: JSON.stringify(res) } });
    return res;
  }

  const txnRef = `TXN-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;

  await db.$transaction(async (tx) => {
    await tx.account.update({
      where: { id: instr.fromAccountId },
      data: { balanceKes: { decrement: toCents(totalDebit) / 100 } },
    });
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
    if (feeKes > 0) {
      await tx.transaction.create({
        data: {
          accountId: instr.fromAccountId,
          txnRef: `FEE-${txnRef.slice(4)}`,
          messageRef: instr.idempotencyKey,
          type: "fee",
          direction: "debit",
          amount: feeKes,
          channel: instr.destinationType,
          counterparty: "Hazina Bank",
          narrative: "Tariff charge",
          status: "completed",
        },
      });
    }
    // The idempotency record is written in the SAME transaction as the debit:
    // a crash between debit and key-store can no longer allow a double debit
    // on replay.
    const res: CoreResult<{ txnRef: string; feeKes: number }> = {
      messageReference: instr.idempotencyKey,
      status: "success",
      responseCode: "0",
      responseDescription: "Success",
      data: { txnRef, feeKes },
    };
    await tx.idempotencyKey.create({ data: { key: instr.idempotencyKey, response: JSON.stringify(res) } });
  });

  return {
    messageReference: instr.idempotencyKey,
    status: "success",
    responseCode: "0",
    responseDescription: "Success",
    data: { txnRef, feeKes },
  };
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

export async function computeFee(channel: string, amountKes: number): Promise<FeeResult> {
  const rows = await db.tariffRow.findMany({ where: { channel } });
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
