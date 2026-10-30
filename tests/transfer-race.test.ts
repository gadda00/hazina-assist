/**
 * Transfer atomicity races (deep-review P0-2 + P1 OTP race).
 *
 * Two separately-approved intents competing for the SAME funds must never
 * both debit; two intents racing the DAILY CAP must never both pass; two
 * simultaneous submissions of the same valid OTP must succeed exactly once.
 * These run against the seeded CI DB (db:push + seed run first in CI).
 */
import { describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** Create (or reuse) an isolated fixture: customer + account + chat session. */
async function fixture(name: string, balance: number) {
  const phone = `+25478000${name.slice(-4)}`;
  let customer = await db.customer.findUnique({ where: { phone } });
  if (!customer) {
    customer = await db.customer.create({
      data: { name: `Race ${name}`, phone, role: "customer", email: `race-${name}@example.co.ke` },
    });
  }
  const handle = `acct_race_${name}`;
  let acct = await db.account.findUnique({ where: { handle } });
  if (!acct) {
    acct = await db.account.create({
      data: { customerId: customer.id, handle, maskedNumber: "****0000", rawNumber: `9${name}0001`, type: "current", balanceKes: balance },
    });
  } else {
    acct = await db.account.update({ where: { id: acct.id }, data: { balanceKes: balance } });
  }
  let sess = await db.chatSession.findFirst({ where: { customerId: customer.id, role: "customer", status: "active" } });
  if (!sess) {
    sess = await db.chatSession.create({ data: { customerId: customer.id, role: "customer", tokenHash: `race-${name}`, status: "active" } });
  }
  // wipe this account's transactional noise so the cap test is deterministic
  await db.transaction.deleteMany({ where: { accountId: acct.id } });
  return { customer, acct, sess };
}

describe("coreTransfer atomicity", () => {
  test("two intents racing for the last funds debit exactly once", async () => {
    const { acct, sess } = await fixture("fund1", 50_100);
    const { coreTransfer } = await import("../src/lib/banking");

    const instr = (amount: number) => ({
      fromAccountId: acct.id,
      amountKes: amount,
      destinationType: "mpesa" as const,
      destination: "+254733445566",
      beneficiaryName: "Race Payee",
      idempotencyKey: `MR-RACE-FUND-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    // balance 50,100; each transfer of 50,000 attracts the 35,001–70,000 band
    // fee of 52 → total 50,052: only ONE can land. Run both concurrently.
    const [a, b] = await Promise.all([coreTransfer(instr(50_000)), coreTransfer(instr(50_000))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["failed", "success"]);

    const after = await db.account.findUniqueOrThrow({ where: { id: acct.id } });
    expect(after.balanceKes).toBe(50_100 - 50_052); // exactly one debit

    const txns = await db.transaction.findMany({ where: { accountId: acct.id, type: "transfer_out" } });
    expect(txns.length).toBe(1);
    // session not used by this path, but keeps the fixture shape uniform
    expect(sess.id).toBeTruthy();
  });

  test("two intents racing the daily cap cannot both pass", async () => {
    // balance 400,000 — funds are NOT the constraint; the 200,000 daily cap is.
    const { acct } = await fixture("cap1", 400_000);
    const { coreTransfer } = await import("../src/lib/banking");

    const instr = () => ({
      fromAccountId: acct.id,
      amountKes: 150_000,
      destinationType: "mpesa" as const,
      destination: "+254733445566",
      beneficiaryName: "Race Payee",
      idempotencyKey: `MR-RACE-CAP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    const [a, b] = await Promise.all([coreTransfer(instr()), coreTransfer(instr())]);
    const statuses = [a.status, b.status].sort();
    // 150k + 150k = 300k > 200k daily cap → exactly one succeeds
    expect(statuses).toEqual(["failed", "success"]);
    const failed = a.status === "failed" ? a : b;
    expect(failed.responseCode).toBe("CAP-403");

    const after = await db.account.findUniqueOrThrow({ where: { id: acct.id } });
    expect(after.balanceKes).toBe(400_000 - 150_075); // one 150k + fee 75
  });

  test("same-key replay never double-debits", async () => {
    const { acct } = await fixture("idem1", 10_000);
    const { coreTransfer } = await import("../src/lib/banking");
    const key = `MR-RACE-IDEM-${Date.now()}`;
    const instr = {
      fromAccountId: acct.id,
      amountKes: 2_000, // 1,001–10,000 band → fee 11
      destinationType: "mpesa" as const,
      destination: "+254733445566",
      beneficiaryName: "Race Payee",
      idempotencyKey: key,
    };
    const first = await coreTransfer(instr);
    expect(first.status).toBe("success");
    const replay = await coreTransfer(instr);
    expect(replay.status).toBe("duplicate");
    expect(replay.data?.txnRef).toBe(first.data?.txnRef);
    const after = await db.account.findUniqueOrThrow({ where: { id: acct.id } });
    expect(after.balanceKes).toBe(10_000 - 2_011); // debited once
  });
});

describe("OTP atomic consumption", () => {
  test("two simultaneous submissions of the same code succeed exactly once", async () => {
    const { sess } = await fixture("otp01", 1_000);
    // clear leftovers from previous runs so issuance starts from a clean slate
    await db.pendingAction.deleteMany({ where: { sessionId: sess.id } });
    await db.otpCode.deleteMany({ where: { sessionId: sess.id } });
    const { issueOtp, verifyOtp } = await import("../src/lib/transfer");
    const { code } = await issueOtp(sess.id);
    const [a, b] = await Promise.all([
      verifyOtp(sess.id, code),
      verifyOtp(sess.id, code),
    ]);
    const oks = [a.ok, b.ok].filter(Boolean).length;
    expect(oks).toBe(1);
    // the loser's reason depends on interleaving: either it lost the
    // conditional consumption ("otp_already_used") or the winner already
    // removed the pending marker before the loser's pre-check ran
    // ("no_otp_pending"). Both are safe failures — exactly one verify wins.
    const loser = a.ok ? b : a;
    expect(["otp_already_used", "no_otp_pending"]).toContain(loser.reason);
  });
});
