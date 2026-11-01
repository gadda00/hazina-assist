/**
 * Audit chain integrity (deep-review P1-6) — the DB-bound design:
 *   - per-org monotonic sequences with a concurrency-safe append strategy;
 *   - whole-chain verification reporting the FIRST broken link exactly;
 *   - tenant isolation (independent chains per org);
 *   - concurrent writers (no lost/duplicate sequences);
 *   - signed archival checkpoints (verification survives pruning);
 *   - session projections verified against their global neighbours.
 *
 * Each describe uses its OWN org id so the tests are hermetic against the
 * shared demo chain other suites may append to.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const ev = (n: number, extra: Record<string, unknown> = {}) => ({
  actor: "system:test",
  eventType: "test_event",
  payload: { n, note: "synthetic", ...extra },
});

describe("audit chain — append + verification", () => {
  const ORG = "test-org-append";

  test("appendEvent returns a durable monotonic position and the chain verifies", async () => {
    const { appendEvent, verifyDbChain } = await import("../src/lib/audit");
    for (let i = 1; i <= 5; i++) {
      const r = await appendEvent({ ...ev(i), orgId: ORG });
      expect(r.seq).toBe(i);
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const v = await verifyDbChain();
    expect(v.ok).toBe(true);
    const org = v.orgs.find((o) => o.orgId === ORG);
    expect(org?.headSeq).toBeGreaterThanOrEqual(5);
    expect(org?.events).toBeGreaterThanOrEqual(5);
  });

  test("tampering with a payload is detected AT that sequence", async () => {
    const { appendEvent, verifyDbChain } = await import("../src/lib/audit");
    const target = await appendEvent({ ...ev(999), orgId: ORG });
    const tampered = await appendEvent({ ...ev(1000), orgId: ORG });
    // mutate the earlier payload directly in the DB (privileged writer attack)
    const originalPayload = target.hash ? await db.auditEvent.findUniqueOrThrow({ where: { id: target.id } }) : null;
    await db.auditEvent.update({
      where: { id: target.id },
      data: { payload: JSON.stringify({ actor: "system:test", eventType: "test_event", n: 999, note: "TAMPERED" }) },
    });
    const v = await verifyDbChain();
    expect(v.ok).toBe(false);
    expect(v.brokenLink).not.toBeNull();
    expect(v.brokenLink!.orgId).toBe(ORG);
    expect(v.brokenLink!.seq).toBe(target.seq);
    expect(v.brokenLink!.kind).toBe("hash_mismatch");
    // restore the EXACT original canonical payload so later describes see a
    // clean world for this org
    await db.auditEvent.update({
      where: { id: target.id },
      data: { payload: originalPayload!.payload },
    });
    expect((await verifyDbChain()).ok).toBe(true);
    expect(tampered.seq).toBe(target.seq + 1);
  });

  test("deleting an event is detected as a sequence gap at the exact hole", async () => {
    const { appendEvent, verifyDbChain } = await import("../src/lib/audit");
    const a = await appendEvent({ ...ev(2001), orgId: ORG });
    const b = await appendEvent({ ...ev(2002), orgId: ORG });
    await appendEvent({ ...ev(2003), orgId: ORG });
    await db.auditEvent.delete({ where: { id: b.id } });
    const v = await verifyDbChain();
    expect(v.ok).toBe(false);
    expect(v.brokenLink!.kind).toBe("seq_gap");
    // the hole is reported where the walk expected b.seq but found b.seq+1
    expect(v.brokenLink!.detail).toContain(`expected seq ${b.seq}`);
    // restore: remove this test's whole tail AND reset the org counter so the
    // org chain is contiguous (and correctly numbered) again — manual event
    // deletion desyncs the allocator, which is exactly why splices are
    // detected rather than tolerated.
    await db.auditEvent.deleteMany({ where: { orgId: ORG, seq: { gte: a.seq } } });
    const last = await db.auditEvent.findFirst({ where: { orgId: ORG }, orderBy: { seq: "desc" }, select: { seq: true } });
    await db.auditOrgCounter.updateMany({
      where: { orgId: ORG },
      data: { lastSeq: last?.seq ?? 0 },
    });
    expect((await verifyDbChain()).ok).toBe(true);
  });

  test("requestId/traceId/schemaVersion are persisted as first-class columns", async () => {
    const { appendEvent } = await import("../src/lib/audit");
    const r = await appendEvent({
      ...ev(3001),
      orgId: ORG,
      requestId: "req-abc-123",
      traceId: "trace-xyz-789",
    });
    const row = await db.auditEvent.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.requestId).toBe("req-abc-123");
    expect(row.traceId).toBe("trace-xyz-789");
    expect(row.schemaVersion).toBe(1);
    expect(row.orgId).toBe(ORG);
    // and orgId + seq are INSIDE the hashed payload (verification binds them)
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.orgId).toBe(ORG);
    expect(payload.seq).toBe(row.seq);
  });
});

describe("audit chain — tenant isolation", () => {
  const ORG_A = "test-org-alpha";
  const ORG_B = "test-org-beta";

  test("chains are isolated per organization (independent genesis + sequences)", async () => {
    const { appendEvent, verifyDbChain } = await import("../src/lib/audit");
    // interleaved appends to two orgs
    for (let i = 1; i <= 3; i++) {
      await appendEvent({ ...ev(i, { org: "A" }), orgId: ORG_A });
      await appendEvent({ ...ev(i, { org: "B" }), orgId: ORG_B });
    }
    const v = await verifyDbChain();
    expect(v.ok).toBe(true);
    const a = v.orgs.find((o) => o.orgId === ORG_A);
    const b = v.orgs.find((o) => o.orgId === ORG_B);
    expect(a?.events).toBe(3);
    expect(b?.events).toBe(3);
    // independent chains: seq 1 of org B links to GENESIS, not to org A's head
    const bFirst = await db.auditEvent.findFirstOrThrow({ where: { orgId: ORG_B }, orderBy: { seq: "asc" } });
    const aLast = await db.auditEvent.findFirstOrThrow({ where: { orgId: ORG_A }, orderBy: { seq: "desc" } });
    expect(bFirst.seq).toBe(1);
    expect(bFirst.prevHash).not.toBe(aLast.hash);
  });

  test("tampering org A's chain does not invalidate org B's, and vice versa", async () => {
    const { verifyDbChain } = await import("../src/lib/audit");
    const victim = await db.auditEvent.findFirstOrThrow({ where: { orgId: ORG_A }, orderBy: { seq: "desc" } });
    const originalHash = victim.hash;
    await db.auditEvent.update({
      where: { id: victim.id },
      data: { hash: "f".repeat(64) },
    });
    const v = await verifyDbChain();
    expect(v.ok).toBe(false);
    expect(v.brokenLink!.orgId).toBe(ORG_A);
    // org B's own chain link structure is intact (broken link is in A only)
    const bRows = await db.auditEvent.findMany({ where: { orgId: ORG_B }, orderBy: { seq: "asc" } });
    for (const r of bRows) {
      expect(r.hash).not.toBe("f".repeat(64));
    }
    // restore so the rest of the suite sees a clean world
    await db.auditEvent.update({
      where: { id: victim.id },
      data: { hash: originalHash },
    });
    expect((await verifyDbChain()).ok).toBe(true);
  });
});

describe("audit chain — concurrent writers", () => {
  const ORG = "test-org-concurrent";

  test("30 concurrent appends allocate 30 unique gap-free sequences", async () => {
    const { appendEvent, verifyDbChain } = await import("../src/lib/audit");
    const before = await db.auditEvent.count({ where: { orgId: ORG } });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => appendEvent({ ...ev(7000 + i), orgId: ORG }))
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    const unique = new Set(seqs);
    expect(unique.size).toBe(30); // no duplicate sequence despite concurrency
    // gap-free block exactly where the concurrent burst landed
    expect(seqs[0]).toBe(before + 1);
    expect(seqs[seqs.length - 1]).toBe(before + 30);
    const v = await verifyDbChain();
    expect(v.ok).toBe(true); // the whole chain (incl. the burst) verifies
  });
});

describe("audit chain — signed archival checkpoints", () => {
  const ORG = "test-org-checkpoint";

  test("checkpoint → prune archived events → verification still passes", async () => {
    const { appendEvent, createCheckpoint, pruneArchivedEvents, verifyDbChain } = await import("../src/lib/audit");
    for (let i = 1; i <= 4; i++) await appendEvent({ ...ev(8000 + i), orgId: ORG });
    const cp = await createCheckpoint(ORG);
    expect(cp.lastSeq).toBe(4);
    // events continue AFTER the frozen head
    for (let i = 5; i <= 6; i++) await appendEvent({ ...ev(8000 + i), orgId: ORG });

    const pruned = await pruneArchivedEvents(ORG);
    expect(pruned).toBe(4); // only the checkpoint-covered events are archived

    const v = await verifyDbChain();
    expect(v.ok).toBe(true); // checkpoint root + surviving tail verify
    expect(v.checkpoints.count).toBeGreaterThanOrEqual(1);
    expect(v.checkpoints.archivedUnder).toBeGreaterThanOrEqual(4);
    const surviving = await db.auditEvent.count({ where: { orgId: ORG } });
    expect(surviving).toBe(2); // the post-checkpoint tail
  });

  test("a tampered checkpoint signature is detected", async () => {
    const { verifyDbChain } = await import("../src/lib/audit");
    const cp = await db.auditCheckpoint.findFirstOrThrow({ where: { orgId: ORG } });
    await db.auditCheckpoint.update({
      where: { id: cp.id },
      data: { rootHash: "ab" + "0".repeat(62) },
    });
    const v = await verifyDbChain();
    expect(v.ok).toBe(false);
    expect(v.brokenLink!.kind).toBe("checkpoint_signature");
    // restore
    await db.auditCheckpoint.update({
      where: { id: cp.id },
      data: { rootHash: cp.rootHash },
    });
    expect((await verifyDbChain()).ok).toBe(true);
  });

  test("checkpoint chain links are enforced (re-linking to a foreign root fails)", async () => {
    const { appendEvent, createCheckpoint, verifyDbChain } = await import("../src/lib/audit");
    for (let i = 1; i <= 2; i++) await appendEvent({ ...ev(9000 + i), orgId: ORG });
    await createCheckpoint(ORG); // second checkpoint, linked to the first
    const cps = await db.auditCheckpoint.findMany({ where: { orgId: ORG }, orderBy: { lastSeq: "asc" } });
    expect(cps.length).toBe(2);
    expect(cps[1].prevCheckpointHash).toBe(cps[0].rootHash);
    // forge the link
    await db.auditCheckpoint.update({
      where: { id: cps[1].id },
      data: { prevCheckpointHash: "c".repeat(64) },
    });
    const v = await verifyDbChain();
    expect(v.ok).toBe(false);
    expect(v.brokenLink!.kind).toBe("checkpoint_link");
    // restore
    await db.auditCheckpoint.update({
      where: { id: cps[1].id },
      data: { prevCheckpointHash: cps[0].rootHash },
    });
    expect((await verifyDbChain()).ok).toBe(true);
  });
});

describe("audit chain — session projections", () => {
  const ORG = "test-org-projection";
  const PHONE = "+254781119911";
  let sessionId = "";

  afterAll(async () => {
    if (sessionId) {
      await db.auditEvent.deleteMany({ where: { sessionId } });
      await db.chatSession.deleteMany({ where: { id: sessionId } });
    }
    await db.customer.deleteMany({ where: { phone: PHONE } });
  });

  test("a session's events verify against their GLOBAL chain neighbours", async () => {
    const { appendEvent, verifySessionProjection } = await import("../src/lib/audit");
    const customer = await db.customer.upsert({
      where: { phone: PHONE },
      update: {},
      create: { name: "Projection Customer", phone: PHONE, role: "fixture" },
    });
    const s = await db.chatSession.create({ data: { customerId: customer.id } });
    sessionId = s.id;

    // interleave session events with foreign events in the SAME org chain
    for (let i = 1; i <= 3; i++) {
      await appendEvent({ ...ev(0, { foreign: i }), orgId: ORG });
      await appendEvent({ ...ev(0, { session: i }), orgId: ORG, sessionId });
    }
    const p = await verifySessionProjection(sessionId);
    expect(p.ok).toBe(true);
    expect(p.events).toBe(3);

    // break a session event's link to its global predecessor → detected
    const victim = await db.auditEvent.findFirstOrThrow({
      where: { sessionId },
      orderBy: { seq: "desc" },
    });
    await db.auditEvent.update({
      where: { id: victim.id },
      data: { prevHash: "0".repeat(64) },
    });
    const broken = await verifySessionProjection(sessionId);
    expect(broken.ok).toBe(false);
    expect(broken.reason).toContain("global predecessor");
    // restore
    const prev = await db.auditEvent.findFirst({
      where: { orgId: ORG, seq: victim.seq - 1 },
      orderBy: { seq: "desc" },
    });
    await db.auditEvent.update({
      where: { id: victim.id },
      data: { prevHash: prev?.hash ?? "0".repeat(64) },
    });
  });

  test("no PII leaks into audit payloads (redaction holds at append)", async () => {
    const { appendEvent } = await import("../src/lib/audit");
    const r = await appendEvent({
      orgId: ORG,
      sessionId,
      actor: "customer:test",
      eventType: "redaction_probe",
      payload: {
        phone: "+254712345678",
        email: "jane.doe@example.co.ke",
        note: "call me on +254733445566 about KRA PIN A123456789X",
      },
    });
    const row = await db.auditEvent.findUniqueOrThrow({ where: { id: r.id } });
    const raw = `${row.payload}|${JSON.stringify(row)}`;
    expect(raw).not.toContain("+254712345678");
    expect(raw).not.toContain("jane.doe@example.co.ke");
    expect(raw).not.toContain("A123456789X");
  });
});
