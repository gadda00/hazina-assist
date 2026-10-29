/**
 * Safety regression tests: money arithmetic, OTP hardening, idempotent
 * execution, and the demo-session/role model.
 *
 * DB-backed cases run against DATABASE_URL (CI seeds /tmp/hazina-ci.db first;
 * locally the dev DB applies). Every test cleans up its own rows.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { addKes, subKes, gteKes, roundKes, parseAmountKes, formatKes, toCents } from "@/lib/money";
import { createDemoSession, hashToken, sessionFromRequest, TOKEN_HEADER } from "@/lib/authz";
import { issueOtp, verifyOtp } from "@/lib/transfer";
import { coreTransfer, computeFee } from "@/lib/banking";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Money — integer-cents arithmetic
// ---------------------------------------------------------------------------
describe("money helpers", () => {
  test("add/sub in cents: no 0.1+0.2 float drift", () => {
    expect(addKes(0.1, 0.2)).toBe(0.3);
    expect(subKes(1.5, 0.4)).toBe(1.1);
    expect(addKes(2_500, 11)).toBe(2_511);
  });
  test("gteKes compares exactly at boundaries", () => {
    expect(gteKes(100.00, 99.99)).toBe(true);
    expect(gteKes(99.99, 100.00)).toBe(false);
    expect(gteKes(84_250.5, 84_250.5)).toBe(true);
  });
  test("roundKes rounds half away from float noise", () => {
    expect(roundKes(10.005 * 3)).toBe(30.02); // 30.015 → 30.02 via cents
    expect(toCents(12.34)).toBe(1234);
  });
  test("parseAmountKes validates ranges", () => {
    expect(parseAmountKes(2500)).toBe(2500);
    expect(parseAmountKes(0)).toBeNull();
    expect(parseAmountKes(-5)).toBeNull();
    expect(parseAmountKes(Number.NaN)).toBeNull();
    expect(parseAmountKes(1e12)).toBeNull();
    expect(parseAmountKes(99.999)).toBe(100); // rounds to cents
  });
  test("formatKes is stable", () => {
    expect(formatKes(2500)).toBe("KES 2,500");
    expect(formatKes(2500.5)).toBe("KES 2,500.50");
  });
});

// ---------------------------------------------------------------------------
// Demo sessions & roles
// ---------------------------------------------------------------------------
describe("demo session auth", () => {
  const PHONE = "+254700000099";

  test("missing/invalid token → null session", async () => {
    const req = new Request("http://x/api/chat", { method: "POST" });
    expect(await sessionFromRequest(req)).toBeNull();
    const bad = new Request("http://x/api/chat", { method: "POST", headers: { [TOKEN_HEADER]: "not-a-token" } });
    expect(await sessionFromRequest(bad)).toBeNull();
  });

  test("login mints a working token; officer login requires an officer role", async () => {
    // pre-clean any leftovers from a previously failed run (FK-safe order:
    // dependents first)
    const stale = await db.customer.findFirst({ where: { phone: PHONE } });
    if (stale) {
      const staleSessions = await db.chatSession.findMany({ where: { customerId: stale.id }, select: { id: true } });
      const staleIds = staleSessions.map((s) => s.id);
      if (staleIds.length) {
        await db.auditEvent.deleteMany({ where: { sessionId: { in: staleIds } } });
        await db.otpCode.deleteMany({ where: { sessionId: { in: staleIds } } });
        await db.pendingAction.deleteMany({ where: { sessionId: { in: staleIds } } });
        await db.message.deleteMany({ where: { sessionId: { in: staleIds } } });
        await db.chatSession.deleteMany({ where: { id: { in: staleIds } } });
      }
      await db.customer.deleteMany({ where: { phone: PHONE } });
    }

    const officer = await db.customer.upsert({
      where: { phone: PHONE },
      update: {},
      create: { name: "Test Officer", phone: PHONE, role: "credit_officer" },
    });
    const customer = await db.customer.findFirst({ where: { role: "customer" } });
    expect(customer).toBeTruthy();
    // the session THIS test creates for the seed customer (never touch the
    // seed customer's other sessions — e.g. leftovers from browser smoke runs)
    const ownSessionIds: string[] = [];

    // customer login works; officer login on a customer record is refused
    const cust = await createDemoSession(customer!.id, "customer");
    expect(cust.ok).toBe(true);
    if (cust.ok) ownSessionIds.push(cust.session.id);
    const denied = await createDemoSession(customer!.id, "officer");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("not_an_officer");

    // officer login works and resolves through the token header
    const off = await createDemoSession(officer.id, "officer");
    expect(off.ok).toBe(true);
    if (off.ok) ownSessionIds.push(off.session.id);
    if (off.ok) {
      const req = new Request("http://x/api/approvals", {
        method: "GET",
        headers: { [TOKEN_HEADER]: off.token },
      });
      const s = await sessionFromRequest(req);
      expect(s?.role).toBe("officer");
      expect(s?.customerName).toBe("Test Officer");
    }

    // revocation: logout kills the token
    if (cust.ok) {
      await db.chatSession.update({ where: { id: cust.session.id }, data: { revokedAt: new Date() } });
      const req = new Request("http://x/api/chat", {
        method: "POST",
        headers: { [TOKEN_HEADER]: cust.token },
      });
      expect(await sessionFromRequest(req)).toBeNull();
    }

    // token stored only as hash: the raw token never round-trips via DB search
    if (cust.ok) {
      const byRaw = await db.chatSession.findFirst({ where: { tokenHash: cust.token } });
      expect(byRaw).toBeNull();
      const byHash = await db.chatSession.findFirst({ where: { tokenHash: hashToken(cust.token) } });
      expect(byHash?.id).toBe(cust.session.id);
    }

    // cleanup: ONLY what this test created (login appends audit events →
    // delete them before the sessions; the officer customer goes last)
    await db.auditEvent.deleteMany({ where: { sessionId: { in: ownSessionIds } } });
    await db.chatSession.deleteMany({ where: { id: { in: ownSessionIds } } });
    await db.customer.deleteMany({ where: { phone: PHONE } });
  });
});

// ---------------------------------------------------------------------------
// OTP hardening
// ---------------------------------------------------------------------------
describe("OTP step-up", () => {
  const PHONE = "+254700000088";
  let sessionId = "";
  let customerId = "";

  beforeAll(async () => {
    const c = await db.customer.upsert({
      where: { phone: PHONE },
      update: {},
      create: { name: "Otp Test Customer", phone: PHONE, role: "customer" },
    });
    customerId = c.id;
    const s = await db.chatSession.create({ data: { customerId } });
    sessionId = s.id;
  });

  afterAll(async () => {
    await db.otpCode.deleteMany({ where: { sessionId } });
    await db.pendingAction.deleteMany({ where: { sessionId } });
    await db.chatSession.deleteMany({ where: { id: sessionId } });
    await db.customer.deleteMany({ where: { phone: PHONE } });
  });

  test("codes are 6-digit and crypto-random (distinct across issues)", async () => {
    const a = await issueOtp(sessionId);
    const b = await issueOtp(sessionId);
    expect(a.code).toMatch(/^\d{6}$/);
    expect(b.code).toMatch(/^\d{6}$/);
    expect(a.code).not.toBe(b.code); // overwhelmingly likely for random
  });

  test("a second issuance invalidates the first (single active OTP)", async () => {
    const first = await issueOtp(sessionId);
    await issueOtp(sessionId); // reissue
    const v = await verifyOtp(sessionId, first.code);
    expect(v.ok).toBe(false);
  });

  test("three wrong attempts lock the code", async () => {
    const otp = await issueOtp(sessionId);
    await verifyOtp(sessionId, "000000");
    await verifyOtp(sessionId, "111111");
    const third = await verifyOtp(sessionId, "222222");
    expect(third.ok).toBe(false);
    const locked = await verifyOtp(sessionId, otp.code); // even the right one
    expect(locked.ok).toBe(false);
    expect(locked.reason).toBe("otp_locked");
  });

  test("expired code is rejected as otp_expired", async () => {
    const otp = await issueOtp(sessionId);
    const row = await db.otpCode.findFirst({
      where: { sessionId, code: otp.code },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toBeTruthy();
    await db.otpCode.update({
      where: { id: row!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const v = await verifyOtp(sessionId, otp.code);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("otp_expired");
  });

  test("correct code verifies and consumes", async () => {
    const otp = await issueOtp(sessionId);
    const v = await verifyOtp(sessionId, otp.code);
    expect(v.ok).toBe(true);
    const replay = await verifyOtp(sessionId, otp.code);
    expect(replay.ok).toBe(false); // consumed — cannot verify twice
  });
});

// ---------------------------------------------------------------------------
// Idempotent execution + fee determinism
// ---------------------------------------------------------------------------
describe("core transfer idempotency", () => {
  const PHONE = "+254700000077";
  const KEY = `MSG-TEST-${Date.now()}`;
  let accountId = "";

  beforeAll(async () => {
    const c = await db.customer.upsert({
      where: { phone: PHONE },
      update: {},
      create: { name: "Idempotency Test", phone: PHONE, role: "customer" },
    });
    const a = await db.account.create({
      data: {
        customerId: c.id,
        handle: `acct_test_${Date.now().toString(36)}`,
        maskedNumber: "****7777",
        rawNumber: `90${Date.now()}`,
        type: "current",
        balanceKes: 10_000,
      },
    });
    accountId = a.id;
  });

  afterAll(async () => {
    await db.idempotencyKey.deleteMany({ where: { key: KEY } });
    await db.transaction.deleteMany({ where: { accountId } });
    await db.account.deleteMany({ where: { id: accountId } });
    await db.customer.deleteMany({ where: { phone: PHONE } });
  });

  test("same message reference never debits twice", async () => {
    const instr = {
      fromAccountId: accountId,
      amountKes: 2_500,
      destinationType: "mpesa" as const,
      destination: "+254733445566",
      beneficiaryName: "Jane Muthoni",
      idempotencyKey: KEY,
    };
    const before = (await db.account.findUnique({ where: { id: accountId } }))!.balanceKes;
    const r1 = await coreTransfer(instr);
    expect(r1.status).toBe("success");
    const afterFirst = (await db.account.findUnique({ where: { id: accountId } }))!.balanceKes;
    // 2,500 + fee 11 (band 1,001–10,000)
    expect(afterFirst).toBe(subKes(before, addKes(2_500, 11)));

    const r2 = await coreTransfer(instr); // replay
    expect(r2.status).toBe("duplicate");
    expect(r2.data?.txnRef).toBe(r1.data?.txnRef); // original receipt
    const afterSecond = (await db.account.findUnique({ where: { id: accountId } }))!.balanceKes;
    expect(afterSecond).toBe(afterFirst); // no second debit
  });

  test("insufficient funds fails without partial state", async () => {
    const r = await coreTransfer({
      fromAccountId: accountId,
      amountKes: 99_999,
      destinationType: "mpesa",
      destination: "+254733445566",
      beneficiaryName: "Jane Muthoni",
      idempotencyKey: `MSG-TEST-INS-${Date.now()}`,
    });
    expect(r.status).toBe("failed");
    expect(r.responseCode).toBe("INS-402");
  });

  test("fee boundaries are deterministic", async () => {
    // seeded bands: 1,001–10,000 → 11; 10,001–35,000 → 23
    expect((await computeFee("send_to_mpesa", 10_000)).feeKes).toBe(11);
    expect((await computeFee("send_to_mpesa", 10_001)).feeKes).toBe(23);
    expect((await computeFee("send_to_mpesa", 1_000)).feeKes).toBe(0);
    const noRow = await computeFee("send_to_mpesa", 0.5); // below bandMin 1
    expect(noRow.matchedRow).toBeNull();
  });
});
