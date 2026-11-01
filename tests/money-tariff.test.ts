/**
 * Money validation + tariff boundary determinism (deep-review P1-5).
 *
 * Every external money input is validated STRICTLY at the transfer boundary
 * (finite, positive, non-negative-zero, ≤2dp, in range), fee computation is
 * exact at every tariff band edge, and band identity is enforced by a
 * DATABASE unique constraint — not by a findFirst convention.
 */
import { describe, expect, test } from "bun:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { parseAmountStrictKes, parseAmountKes, addKes, subKes, toCents } from "../src/lib/money";
import { computeFee } from "../src/lib/banking";

const db = new PrismaClient();

describe("strict money-input validation (parseAmountStrictKes)", () => {
  test("accepts exactly-representable positive amounts", () => {
    expect(parseAmountStrictKes(1)).toBe(1);
    expect(parseAmountStrictKes(2500)).toBe(2500);
    expect(parseAmountStrictKes(2500.5)).toBe(2500.5);
    expect(parseAmountStrictKes(2500.55)).toBe(2500.55);
    expect(parseAmountStrictKes(0.01)).toBe(0.01);
    expect(parseAmountStrictKes(1_000_000_000)).toBe(1_000_000_000);
  });

  test("rejects non-finite values", () => {
    expect(parseAmountStrictKes(NaN)).toBeNull();
    expect(parseAmountStrictKes(Infinity)).toBeNull();
    expect(parseAmountStrictKes(-Infinity)).toBeNull();
  });

  test("rejects zero, negative zero, and negatives", () => {
    expect(parseAmountStrictKes(0)).toBeNull();
    expect(parseAmountStrictKes(-0)).toBeNull(); // negative zero
    expect(parseAmountStrictKes(-0.01)).toBeNull();
    expect(parseAmountStrictKes(-2500)).toBeNull();
  });

  test("rejects sub-cent precision instead of silently rounding", () => {
    expect(parseAmountStrictKes(10.001)).toBeNull();
    expect(parseAmountStrictKes(10.999)).toBeNull();
    expect(parseAmountStrictKes(0.001)).toBeNull();
    // contrast: the display-tolerant parser rounds, the strict one refuses —
    // consequential writes must never round a customer's stated amount
    expect(parseAmountKes(10.001)).toBe(10);
    expect(parseAmountStrictKes(10.001)).toBeNull();
  });

  test("rejects out-of-range amounts", () => {
    expect(parseAmountStrictKes(1_000_000_001)).toBeNull();
    expect(parseAmountStrictKes(1e12)).toBeNull();
    expect(parseAmountStrictKes(null)).toBeNull();
    expect(parseAmountStrictKes(undefined)).toBeNull();
  });

  test("cents arithmetic never drifts across operations", () => {
    expect(addKes(0.1, 0.2)).toBe(0.3); // classic float trap, dodged
    expect(addKes(1_000_000.01, 0.99)).toBe(1_000_001);
    expect(subKes(1_000_000.01, 0.01)).toBe(1_000_000);
    expect(toCents(12_345.67)).toBe(1_234_567);
  });
});

describe("tariff band boundaries — exact fee at every edge", () => {
  test("send_to_mpesa: every band edge charges exactly the tariff", async () => {
    const cases: Array<[number, number]> = [
      [1, 0], // band 1–1,000 → free
      [1_000, 0], // upper edge still free
      [1_001, 11], // first shilling of the next band
      [10_000, 11],
      [10_001, 23],
      [35_000, 23],
      [35_001, 52],
      [70_000, 52],
      [70_001, 75], // open-ended band
      [150_000, 75],
    ];
    for (const [amount, fee] of cases) {
      const r = await computeFee("send_to_mpesa", amount);
      expect(r.feeKes).toBe(fee);
    }
  });

  test("pesalink_out: band edges charge exactly the tariff", async () => {
    const cases: Array<[number, number]> = [
      [1, 35],
      [10_000, 35],
      [10_001, 110],
      [150_000, 110],
      [150_001, 205],
      [999_999, 205],
    ];
    for (const [amount, fee] of cases) {
      const r = await computeFee("pesalink_out", amount);
      expect(r.feeKes).toBe(fee);
    }
  });

  test("withdrawal_agent: percent bands with min/max clamps behave at every edge", async () => {
    const cases: Array<[number, number]> = [
      [1, 30], // 0.65% ≈ 0.0065 → min fee 30 clamps UP
      [2_500, 30], // 16.25 → still clamped to min
      [2_501, 30], // band switch: 0.65% of 2501 = 16.2565 → min 30
      [5_000, 32.5], // 0.65% = 32.5 — above the min, exact
      [25_000, 162.5], // band top: 0.65% = 162.5
      [25_001, 180], // band switch: 0.55% = 137.505 → min 180 clamps
      [32_728, 180], // 0.55% = 180.004 — just past the min
      [70_000, 320], // 0.55% = 385 → max 320 clamps DOWN
    ];
    for (const [amount, fee] of cases) {
      const r = await computeFee("withdrawal_agent", amount);
      expect(r.feeKes).toBe(fee);
    }
  });

  test("internal_transfer is free at every point of its single band", async () => {
    for (const amount of [1, 500, 5_000, 500_000]) {
      const r = await computeFee("internal_transfer", amount);
      expect(r.feeKes).toBe(0);
    }
  });
});

describe("tariff band identity is a database constraint", () => {
  test("inserting a duplicate band (product, channel, bandMin, effectiveDate) is rejected by the DB", async () => {
    const dup = {
      product: "Eazzy Banking / Mobile",
      channel: "send_to_mpesa",
      bandMin: 1,
      bandMax: 1000,
      feeType: "flat",
      feeValue: 0,
      minFee: null,
      maxFee: null,
      effectiveDate: "2026-10-22",
      docId: "tariff-guide-2026-10-22",
      page: 3,
    };
    // this row exists in the seeded tariff table — a second one must fail
    // the composite unique constraint instead of shadowing the first.
    let duplicateRejected = false;
    try {
      await db.tariffRow.create({ data: dup });
    } catch (e) {
      duplicateRejected =
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
    }
    expect(duplicateRejected).toBe(true);
  });

  test("the same band for a DIFFERENT effective date is allowed (versioned tariffs)", async () => {
    const versioned = await db.tariffRow.create({
      data: {
        product: "Eazzy Banking / Mobile",
        channel: "send_to_mpesa",
        bandMin: 1,
        bandMax: 1000,
        feeType: "flat",
        feeValue: 0,
        minFee: null,
        maxFee: null,
        effectiveDate: "2027-01-01", // future version — distinct identity
        docId: "tariff-guide-2027-01-01",
        page: 3,
      },
    });
    expect(versioned.id).toBeTruthy();
    await db.tariffRow.delete({ where: { id: versioned.id } }); // cleanup
  });
});
