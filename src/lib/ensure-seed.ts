/**
 * Runtime auto-heal for the demo database.
 *
 * WHY: the workspace/demo DB can be re-provisioned with schema but partial or
 * test-only rows (observed in practice: a recycled workspace left a DB whose
 * ONLY contents were test fixtures — "Race *", "Eval Fixture" and a
 * "Test Officer" whose role is credit_officer). The login screen then shows a
 * polluted or empty directory, fee answers break (no tariff rows) and RAG
 * breaks (no knowledge chunks) — "everything is blank".
 *
 * The health check must therefore verify the ACTUAL demo ground truth, not
 * merely "some rows exist":
 *
 *   referenceOk  — the five known seed customers, both seed officers, at least
 *                  one tariff row and one knowledge chunk are present
 *   hasActivity  — real usage has happened (messages or audit events; session
 *                  husks with zero messages do NOT count)
 *
 *   referenceOk && hasActivity  → live demo: never touched
 *   otherwise                   → rebuild:
 *       1. purge test residue (fixtures / test officers) — FK-safe
 *       2. re-seed reference data (idempotent upserts — safe even if the
 *          demo is otherwise live and only the tariff/KB rows vanished)
 *       3. curate the showcase through the SAME orchestrator/IDP/approval
 *          code paths a real demo click takes — only when nothing has
 *          happened yet, so a live demo is never double-curated
 *
 * The login screen polls `demoState` until it is "ready".
 */
import { db } from "@/lib/db";
import { seedAll } from "@/lib/seed-data";
import { createDemoSession } from "@/lib/authz";
import { runOrchestrator } from "@/lib/orchestrator";
import { processPayslipSample } from "@/lib/idp";
import { decideApprovalTask } from "@/lib/approvals";

export type DemoState = "ready" | "seeding" | "curating" | "error";

const g = globalThis as unknown as { __hazinaDemoState?: DemoState; __hazinaEnsure?: Promise<void> };
let state: DemoState = (g.__hazinaDemoState ??= "ready");

export function demoState(): DemoState {
  return state;
}

/** The identities `seedAll` guarantees. Anything else in those roles is residue. */
const SEED_CUSTOMER_PHONES = [
  "+254712345678", // Amina Wanjiru
  "+254723456789", // Brian Otieno
  "+254733456788", // Kevin Mutua
  "+254741122334", // Zawadi Hassan
  "+254745566778", // Grace Wanjala
];
const SEED_OFFICER_PHONES = ["+254700000001", "+254700000002"]; // Njeri, Kamau

/** Rows that only ever come from tests/evals — never demo state. */
const RESIDUE_WHERE = {
  OR: [
    { role: "fixture" },
    { name: { startsWith: "Race " } },
    { name: "Eval Fixture" },
    { name: "Test Officer" },
  ],
};

/** Public entry: call at the top of GET /api/auth/login. Never throws. */
export async function ensureSeeded(): Promise<void> {
  try {
    const [seedCustomers, seedOfficers, tariffRows, chunks, messages, auditEvents, residue] =
      await Promise.all([
        db.customer.count({ where: { phone: { in: SEED_CUSTOMER_PHONES } } }),
        db.customer.count({ where: { phone: { in: SEED_OFFICER_PHONES } } }),
        db.tariffRow.count(),
        db.knowledgeChunk.count(),
        db.message.count(),
        db.auditEvent.count(),
        db.customer.count({ where: RESIDUE_WHERE }),
      ]);

    const referenceOk =
      seedCustomers === SEED_CUSTOMER_PHONES.length &&
      seedOfficers === SEED_OFFICER_PHONES.length &&
      tariffRows > 0 &&
      chunks > 0;
    // Real usage leaves messages AND audit events; a session husk with none
    // is interrupted curation, not a live demo.
    const hasActivity = messages > 0 || auditEvents > 0;

    if (referenceOk && hasActivity && residue === 0) {
      state = "ready";
      return; // live demo DB — never touch it
    }

    if (!g.__hazinaEnsure) {
      g.__hazinaEnsure = rebuild(referenceOk, hasActivity).finally(() => {
        g.__hazinaEnsure = undefined;
      });
    }
    // await with a hard cap: seeding is fast (~200 ms); curation may involve
    // external model calls, so we don't hold the HTTP response for all of it
    // — the login screen polls demoState until ready.
    await Promise.race([
      g.__hazinaEnsure,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  } catch (e) {
    console.error("[ensure-seed]", e);
    state = "error";
  }
}

async function rebuild(referenceOk: boolean, hasActivity: boolean): Promise<void> {
  state = "seeding";
  try {
    await purgeResidue();
  } catch (e) {
    console.error("[ensure-seed] residue purge incomplete (continuing):", e);
  }
  if (!referenceOk) {
    console.log("[ensure-seed] demo reference data incomplete — re-seeding (idempotent)…");
    await seedAll(db);
  }
  if (hasActivity) {
    // Reference repaired, but the demo already has history: never re-curate.
    state = "ready";
    return;
  }
  state = "curating";
  try {
    await curateShowcase();
    state = "ready";
    console.log("[ensure-seed] showcase curated — demo ready");
  } catch (e) {
    // Reference data is in place even if curation hiccupped: the app works,
    // the presenter can drive any flow manually; log and move on.
    console.error("[ensure-seed] curation incomplete:", e);
    state = "ready";
  }
}

/**
 * Remove test/eval identities FK-safely. Mirrors scripts/purge-fixtures.ts.
 * Only ever runs on a rebuild path — a live demo (activity + full reference
 * data + no residue) returns before this is reached.
 */
async function purgeResidue(): Promise<void> {
  const fixtures = await db.customer.findMany({
    where: RESIDUE_WHERE,
    select: { id: true, name: true },
  });
  for (const f of fixtures) {
    const sess = await db.chatSession.findMany({ where: { customerId: f.id }, select: { id: true } });
    for (const s of sess) {
      await db.message.deleteMany({ where: { sessionId: s.id } });
      await db.auditEvent.deleteMany({ where: { sessionId: s.id } });
      await db.otpCode.deleteMany({ where: { sessionId: s.id } });
      await db.pendingAction.deleteMany({ where: { sessionId: s.id } });
      await db.transferIntent.deleteMany({ where: { sessionId: s.id } });
      await db.payslipPack.deleteMany({ where: { sessionId: s.id } });
      await db.approvalTask.deleteMany({ where: { sessionId: s.id } });
    }
    await db.chatSession.deleteMany({ where: { customerId: f.id } });
    await db.beneficiary.deleteMany({ where: { customerId: f.id } });
    await db.transaction.deleteMany({ where: { account: { customerId: f.id } } });
    await db.account.deleteMany({ where: { customerId: f.id } });
    await db.customer.delete({ where: { id: f.id } });
    console.log("[ensure-seed] purged test residue:", f.name);
  }
}

// ---------------------------------------------------------------------------
// The curator — runs REAL flows through the production code paths
// ---------------------------------------------------------------------------

async function curateShowcase(): Promise<void> {
  const amina = await db.customer.findFirst({ where: { name: "Amina Wanjiru" } });
  const brian = await db.customer.findFirst({ where: { name: "Brian Otieno" } });
  const kevin = await db.customer.findFirst({ where: { name: "Kevin Mutua" } });
  const zawadi = await db.customer.findFirst({ where: { name: "Zawadi Hassan" } });
  const grace = await db.customer.findFirst({ where: { name: "Grace Wanjala" } });
  const njeri = await db.customer.findFirst({ where: { name: "Officer Njeri (Credit)" } });
  if (!amina || !njeri) return;

  const open = async (customerId: string, as: "customer" | "officer" = "customer") => {
    const r = await createDemoSession(customerId, as);
    if (!r.ok) throw new Error(`curate: cannot open session for ${customerId}`);
    return r.session;
  };
  const turn = (sessionId: string, message: string) => runOrchestrator(sessionId, message);

  // ---- Amina: warm history + OTP-verified transfer pending approval ----
  const aminaS = await open(amina.id);
  await turn(aminaS.id, "What is the fee for sending 5000 to M-Pesa?");
  await turn(aminaS.id, "Nionyeshe salio langu");
  const stage = await turn(aminaS.id, "Send 2500 to Jane on M-Pesa 0733445566");
  if (stage.otp?.devCode) {
    const verify = await turn(aminaS.id, stage.otp.devCode);
    console.log("[ensure-seed] Amina transfer:", verify.kind, "→", verify.pendingIntent?.state);
  }
  // clean payslip pack → open loan task (KES 300k / 24 mo)
  await processPayslipSample({ sessionId: aminaS.id, sampleKey: "clean", requestedAmountKes: 300_000, tenorMonths: 24 });

  // ---- Kevin (business banking): PesaLink journey, open task ----
  if (kevin) {
    const kevinS = await open(kevin.id);
    await turn(kevinS.id, "What is the PesaLink charge for 45000 to another bank?");
    await turn(kevinS.id, "Show my balance");
    const k = await turn(kevinS.id, "Send 45000 to Nairobi AgriHub on PesaLink");
    if (k.otp?.devCode) await turn(kevinS.id, k.otp.devCode);
  }

  // ---- Grace: TAMPERED payslip → validation must flag it (open, high risk)
  if (grace) {
    const graceS = await open(grace.id);
    await turn(graceS.id, "I want to apply for a loan");
    const p = await processPayslipSample({ sessionId: graceS.id, sampleKey: "flagged", requestedAmountKes: 150_000, tenorMonths: 12 });
    console.log("[ensure-seed] tampered payslip validation ok =", p.validation.ok, "(expected false)");
  }

  // ---- Brian: executed history (officer approves a real internal transfer)
  if (brian) {
    const brianS = await open(brian.id);
    await turn(brianS.id, "Show my last 3 transactions");
    const b = await turn(brianS.id, "Send 1500 to Otieno Senior on Hazina account 9012345678941");
    if (b.otp?.devCode) {
      await turn(brianS.id, b.otp.devCode);
      const task = await db.approvalTask.findFirst({
        where: { sessionId: brianS.id, type: "transfer", status: "open" },
      });
      if (task) {
        const r = await decideApprovalTask(task.id, "approve", njeri.name);
        console.log("[ensure-seed] executed transfer:", r.kind);
      }
    }
    // scanned payslip pack → officer RECOMMENDS PROCEED (decided pack history)
    const pack = await processPayslipSample({ sessionId: brianS.id, sampleKey: "scanned", requestedAmountKes: 600_000, tenorMonths: 36 });
    await decideApprovalTask(pack.taskId, "approve", njeri.name);
  }

  // ---- Zawadi: rejected history (officer declines with a recorded reason)
  if (zawadi) {
    const zawadiS = await open(zawadi.id);
    const z = await turn(zawadiS.id, "Send 800 to Mama Fatuma on M-Pesa 0711223344");
    if (z.otp?.devCode) {
      await turn(zawadiS.id, z.otp.devCode);
      const task = await db.approvalTask.findFirst({
        where: { sessionId: zawadiS.id, type: "transfer", status: "open" },
      });
      if (task) {
        await decideApprovalTask(task.id, "reject", njeri.name, "Customer called the branch: transaction not recognised");
      }
    }
  }
}
