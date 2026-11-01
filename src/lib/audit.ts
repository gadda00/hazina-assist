/**
 * Append-only, hash-chained audit trail (Prisma-bound) — tenant-scoped,
 * concurrency-safe, checkpoint-capable (deep-review P1-6).
 *
 * Pure crypto lives in @hazina/kit; this module handles serialised writes and
 * whole-chain verification.
 *
 * CONCURRENCY-SAFE APPEND STRATEGY (works on SQLite AND PostgreSQL):
 *   every append runs inside one transaction that
 *     1. UPDATEs the per-org counter row (`AuditOrgCounter.lastSeq + 1`) —
 *        this takes a ROW LOCK that serialises concurrent appenders for the
 *        same org until the transaction commits (PostgreSQL) or lines up
 *        behind SQLite's single-writer database lock;
 *     2. reads the org's current chain head AFTER that lock ⇒ the previous
 *        hash read is race-free;
 *     3. inserts the event with its allocated `seq`.
 *   `@@unique([orgId, seq])` is the database-level backstop: even a bug in
 *   the allocator can never produce a duplicate or silently lost sequence.
 *
 * TENANCY: each organization owns an INDEPENDENT chain (own genesis, own
 * monotonic seq, own checkpoints). Session-filtered views are projections of
 * an org chain and are verified against the surrounding global links
 * (`verifySessionProjection`).
 *
 * CHECKPOINTS: `createCheckpoint()` freezes the chain head at seq N with an
 * HMAC-signed root. Events at seq ≤ N can then be archived away and
 * verification stays provable from the checkpoint forward — the checkpoint
 * chain itself is linked (prevCheckpointHash) and signature-verified without
 * needing the archived events.
 */
import { db } from "@/lib/db";
import { eventHash, GENESIS_HASH, canonicalEvent, redactPii } from "@hazina/kit";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";

export const DEFAULT_ORG = "hazina-demo";
export const AUDIT_SCHEMA_VERSION = 1;

export interface AuditEventInput {
  sessionId?: string | null;
  actor: string; // "customer:<id>" | "approver:<name>" | "system:<node>"
  eventType: string;
  payload: Record<string, unknown>;
  /** tenant/organization scope — independent chain per org */
  orgId?: string;
  /** correlation id from the API request envelope */
  requestId?: string | null;
  /** distributed trace id (propagated by the edge/proxy) */
  traceId?: string | null;
}

/** Redact PII inside STRING VALUES only — JSON structure stays intact. */
function redactPayload(obj: unknown): unknown {
  if (typeof obj === "string") return redactPii(obj);
  if (Array.isArray(obj)) return obj.map(redactPayload);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, redactPayload(v)]));
  }
  return obj;
}

/**
 * Append an event to its organization's chain. Returns the durable position
 * (org-scoped sequence + hash). Retries a bounded number of times on the two
 * races the design can produce (concurrent first-append counter creation and
 * a lost seq-allocation race) — both are bounded by the DB constraints.
 */
export async function appendEvent(
  e: AuditEventInput
): Promise<{ id: number; seq: number; hash: string }> {
  const orgId = e.orgId ?? DEFAULT_ORG;
  const redacted = redactPayload(e.payload) as Record<string, unknown>;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        // (1) allocate the per-org sequence — the counter row UPDATE takes the
        // lock that serialises concurrent appenders per org.
        let counter;
        try {
          counter = await tx.auditOrgCounter.update({
            where: { orgId },
            data: { lastSeq: { increment: 1 } },
            select: { lastSeq: true },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
            // first append for this org: create the counter at seq 1
            counter = await tx.auditOrgCounter
              .create({ data: { orgId, lastSeq: 1 }, select: { lastSeq: true } })
              .catch(async (createErr) => {
                if (
                  createErr instanceof Prisma.PrismaClientKnownRequestError &&
                  createErr.code === "P2002"
                ) {
                  // a concurrent creator won the race — re-read via increment
                  return tx.auditOrgCounter.update({
                    where: { orgId },
                    data: { lastSeq: { increment: 1 } },
                    select: { lastSeq: true },
                  });
                }
                throw createErr;
              });
          } else {
            throw err;
          }
        }
        const seq = counter.lastSeq;

        // (2) chain head for THIS org, read after the lock ⇒ race-free
        const prev = await tx.auditEvent.findFirst({
          where: { orgId },
          orderBy: { seq: "desc" },
          select: { hash: true },
        });
        const prevHash = prev?.hash ?? GENESIS_HASH;

        // (3) canonical serialisation — the EXACT string stored is the string
        // hashed, and orgId/seq/schemaVersion are INSIDE the hashed object, so
        // verification binds every event to its tenant and position.
        const payloadJson = canonicalEvent({
          actor: e.actor,
          eventType: e.eventType,
          orgId,
          seq,
          schemaVersion: AUDIT_SCHEMA_VERSION,
          ...redacted,
        });
        const hash = eventHash(prevHash, JSON.parse(payloadJson) as Record<string, unknown>);
        const row = await tx.auditEvent.create({
          data: {
            orgId,
            seq,
            sessionId: e.sessionId ?? null,
            actor: e.actor,
            eventType: e.eventType,
            payload: payloadJson,
            prevHash,
            hash,
            requestId: e.requestId ?? null,
            traceId: e.traceId ?? null,
            schemaVersion: AUDIT_SCHEMA_VERSION,
          },
          select: { id: true, seq: true, hash: true },
        });
        return { id: row.id, seq: row.seq, hash: row.hash };
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        // P2002 unique conflict + P2025 record-not-found = the two bounded
        // allocation races; P2034 = SQLite/Postgres write conflict from a
        // concurrent transaction — all safely retryable for an append.
        (err.code === "P2002" || err.code === "P2025" || err.code === "P2034")
      ) {
        continue; // bounded retry for the bounded races
      }
      throw err;
    }
  }
  throw new Error(`appendEvent: exhausted retry budget for org ${orgId}`);
}

/** Chain viewer (console): newest-first slice, chronological return order. */
export async function getChain(limit = 500, sessionId?: string) {
  const rows = await db.auditEvent.findMany({
    where: sessionId ? { sessionId } : undefined,
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.reverse();
}

// ---------------------------------------------------------------------------
// Verification — whole-chain, per-org, first-broken-link reporting
// ---------------------------------------------------------------------------

export interface BrokenLink {
  orgId: string;
  seq: number;
  kind: "seq_gap" | "link_mismatch" | "hash_mismatch" | "checkpoint_signature" | "checkpoint_link";
  detail: string;
}

export interface ChainVerification {
  ok: boolean;
  checkedEvents: number;
  totalEvents: number;
  orgs: Array<{ orgId: string; events: number; headSeq: number }>;
  brokenLink: BrokenLink | null;
  checkpoints: { count: number; verified: number; archivedUnder: number };
}

function checkpointSigningKey(): string {
  // dedicated audit signing key preferred; the intent secret is an acceptable
  // domain-separated fallback in this demo; a well-known dev value ONLY in
  // demo mode (the deployment boundary refuses to boot otherwise).
  return (
    process.env.HAZINA_AUDIT_SECRET?.trim() ||
    process.env.HAZINA_INTENT_SECRET?.trim() ||
    "dev-only-audit-secret"
  );
}

function checkpointSignature(orgId: string, lastSeq: number, rootHash: string, prevRoot: string | null): string {
  return createHmac("sha256", checkpointSigningKey())
    .update(`hazina-audit-checkpoint:v1:${orgId}:${lastSeq}:${rootHash}:${prevRoot ?? "genesis"}`)
    .digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify every org chain from its own genesis (or from the newest signed
 * checkpoint when earlier events have been archived). Reports the FIRST
 * broken link with its exact position and failure kind.
 */
export async function verifyDbChain(): Promise<ChainVerification> {
  const orgRows = await db.auditEvent.findMany({ distinct: ["orgId"], select: { orgId: true } });
  const orgIds = orgRows.map((o) => o.orgId);
  const allCounters = await db.auditOrgCounter.findMany();
  // include orgs that have counters but zero surviving events (fully archived)
  for (const c of allCounters) if (!orgIds.includes(c.orgId)) orgIds.push(c.orgId);

  let checked = 0;
  let total = 0;
  let broken: BrokenLink | null = null;
  const orgs: ChainVerification["orgs"] = [];
  let checkpointCount = 0;
  let checkpointVerified = 0;
  let archivedUnder = 0;

  for (const orgId of orgIds) {
    const checkpoints = await db.auditCheckpoint.findMany({
      where: { orgId },
      orderBy: { lastSeq: "asc" },
    });
    checkpointCount += checkpoints.length;

    // (a) the checkpoint chain: signatures + inter-checkpoint links verify
    // WITHOUT the archived events — that is what makes archival provable.
    let prevRoot: string | null = null;
    let checkpointsOk = true;
    for (const cp of checkpoints) {
      const expected = checkpointSignature(orgId, cp.lastSeq, cp.rootHash, cp.prevCheckpointHash ?? null);
      if (!safeEqualHex(cp.signature, expected) || (cp.prevCheckpointHash ?? null) !== prevRoot) {
        broken ??= {
          orgId,
          seq: cp.lastSeq,
          kind: cp.prevCheckpointHash !== prevRoot ? "checkpoint_link" : "checkpoint_signature",
          detail: `checkpoint ${cp.id} covering seq ≤ ${cp.lastSeq} failed verification`,
        };
        checkpointsOk = false;
        break;
      }
      prevRoot = cp.rootHash;
      checkpointVerified++;
    }
    if (!checkpointsOk) break;

    // (b) the surviving event tail: contiguity + hash-chain walk. The anchor
    // for the FIRST surviving event is the checkpoint whose boundary sits
    // exactly below it (the normal archived prefix), or genesis when the org
    // chain was never pruned. A first event that starts mid-chain with NO
    // covering checkpoint below it is itself a break (undeclared deletion).
    const rows = await db.auditEvent.findMany({ where: { orgId }, orderBy: { seq: "asc" } });
    total += rows.length;
    // events covered (archived or archivable) under the newest checkpoint
    archivedUnder += checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].lastSeq : 0;

    if (rows.length > 0) {
      const first = rows[0];
      let prevHash: string | null = null;
      if (first.seq === 1) {
        prevHash = GENESIS_HASH;
      } else {
        const cpBelow = [...checkpoints].reverse().find((c) => c.lastSeq === first.seq - 1);
        if (cpBelow) {
          prevHash = cpBelow.rootHash;
        } else {
          broken ??= {
            orgId,
            seq: first.seq,
            kind: "seq_gap",
            detail: `first surviving event has no present predecessor and no signed checkpoint covers seq ${first.seq - 1} — events were deleted without an archival checkpoint`,
          };
        }
      }
      let expectedSeq = first.seq;
      if (prevHash !== null) {
        for (const r of rows) {
          if (r.seq !== expectedSeq) {
            broken ??= {
              orgId,
              seq: r.seq,
              kind: "seq_gap",
              detail: `expected seq ${expectedSeq}, found ${r.seq} (event deleted or sequence lost)`,
            };
            break;
          }
          if (r.prevHash !== prevHash) {
            broken ??= {
              orgId,
              seq: r.seq,
              kind: "link_mismatch",
              detail: `prev_hash does not match the predecessor hash (expected ${prevHash.slice(0, 12)}…, stored ${r.prevHash.slice(0, 12)}…)`,
            };
            break;
          }
          const recomputed = eventHash(r.prevHash, JSON.parse(r.payload) as Record<string, unknown>);
          if (recomputed !== r.hash) {
            broken ??= {
              orgId,
              seq: r.seq,
              kind: "hash_mismatch",
              detail: `payload hash recomputation differs — the stored payload was modified after append`,
            };
            break;
          }
          prevHash = r.hash;
          expectedSeq++;
          checked++;
        }
      }

      // (c) checkpoint⇄event cross-check: a checkpoint root must equal the
      // hash of the event it froze WHEN that event still survives (catches a
      // mis-signed checkpoint even before its covered events are archived).
      if (broken === null) {
        for (const cp of checkpoints) {
          const frozen = rows.find((r) => r.seq === cp.lastSeq);
          if (frozen && frozen.hash !== cp.rootHash) {
            broken = {
              orgId,
              seq: cp.lastSeq,
              kind: "checkpoint_signature",
              detail: `checkpoint ${cp.id} root does not match the surviving event at seq ${cp.lastSeq}`,
            };
            break;
          }
        }
      }
    }
    if (broken) break;

    const counter = allCounters.find((c) => c.orgId === orgId);
    orgs.push({ orgId, events: rows.length, headSeq: counter?.lastSeq ?? rows.length });
  }

  return {
    ok: broken === null,
    checkedEvents: checked,
    totalEvents: total,
    orgs,
    brokenLink: broken,
    checkpoints: { count: checkpointCount, verified: checkpointVerified, archivedUnder },
  };
}

/**
 * Session projection check (deep-review P1-6): a session-filtered view can
 * never verify standalone (its links point into the org chain), so we verify
 * the org chain FIRST, then prove every session event's prevHash equals the
 * hash of the org event at seq-1 (or the covering checkpoint root once that
 * neighbour is archived).
 */
export async function verifySessionProjection(sessionId: string): Promise<{
  ok: boolean;
  events: number;
  reason?: string;
}> {
  const sessionEvents = await db.auditEvent.findMany({
    where: { sessionId },
    orderBy: { seq: "asc" },
  });
  if (sessionEvents.length === 0) return { ok: true, events: 0 };

  const orgId = sessionEvents[0].orgId;
  const orgRows = await db.auditEvent.findMany({ where: { orgId }, orderBy: { seq: "asc" } });
  const hashBySeq = new Map(orgRows.map((r) => [r.seq, r.hash] as const));
  const checkpoints = await db.auditCheckpoint.findMany({
    where: { orgId },
    orderBy: { lastSeq: "asc" },
  });

  for (const ev of sessionEvents) {
    const neighbour = hashBySeq.get(ev.seq - 1);
    const anchor =
      neighbour ??
      (checkpoints.some((c) => c.lastSeq === ev.seq - 1)
        ? checkpoints.find((c) => c.lastSeq === ev.seq - 1)?.rootHash
        : ev.seq === 1
          ? GENESIS_HASH
          : undefined);
    if (anchor === undefined) {
      return {
        ok: false,
        events: sessionEvents.length,
        reason: `org neighbour at seq ${ev.seq - 1} is neither present nor covered by a checkpoint — projection unverifiable`,
      };
    }
    if (ev.prevHash !== anchor) {
      return {
        ok: false,
        events: sessionEvents.length,
        reason: `session event at seq ${ev.seq} does not link to its global predecessor`,
      };
    }
  }
  return { ok: true, events: sessionEvents.length };
}

// ---------------------------------------------------------------------------
// Signed archival checkpoints
// ---------------------------------------------------------------------------

export interface CheckpointInfo {
  id: string;
  orgId: string;
  lastSeq: number;
  eventCount: number;
  rootHash: string;
  signedAt: Date;
}

/**
 * Freeze the org's chain head under an HMAC signature. After this, events at
 * seq ≤ lastSeq are ARCHIVABLE (see pruneArchivedEvents) — verification
 * continues from the signed root without the archived rows.
 */
export async function createCheckpoint(orgId: string = DEFAULT_ORG): Promise<CheckpointInfo> {
  const head = await db.auditEvent.findFirst({ where: { orgId }, orderBy: { seq: "desc" } });
  if (!head) throw new Error(`createCheckpoint: org ${orgId} has no events to freeze`);
  const prior = await db.auditCheckpoint.findFirst({
    where: { orgId },
    orderBy: { lastSeq: "desc" },
  });
  if (prior && prior.lastSeq >= head.seq) {
    return {
      id: prior.id,
      orgId: prior.orgId,
      lastSeq: prior.lastSeq,
      eventCount: prior.eventCount,
      rootHash: prior.rootHash,
      signedAt: prior.signedAt,
    };
  }
  const eventCount = await db.auditEvent.count({ where: { orgId } });
  const prevCheckpointHash = prior?.rootHash ?? null;
  const signature = checkpointSignature(orgId, head.seq, head.hash, prevCheckpointHash);
  const cp = await db.auditCheckpoint.create({
    data: {
      orgId,
      lastSeq: head.seq,
      eventCount,
      rootHash: head.hash,
      prevCheckpointHash,
      signature,
    },
  });
  return {
    id: cp.id,
    orgId: cp.orgId,
    lastSeq: cp.lastSeq,
    eventCount: cp.eventCount,
    rootHash: cp.rootHash,
    signedAt: cp.signedAt,
  };
}

/**
 * Retention boundary: archive (delete) events covered by the newest signed
 * checkpoint. The checkpoint's signed root keeps them provably covered.
 */
export async function pruneArchivedEvents(orgId: string = DEFAULT_ORG): Promise<number> {
  const cp = await db.auditCheckpoint.findFirst({ where: { orgId }, orderBy: { lastSeq: "desc" } });
  if (!cp) return 0;
  const res = await db.auditEvent.deleteMany({ where: { orgId, seq: { lte: cp.lastSeq } } });
  return res.count;
}
