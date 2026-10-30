/**
 * Runtime auto-heal for the demo database.
 *
 * WHY: the workspace/demo DB can be re-provisioned with schema but zero rows
 * (observed in practice). The login screen then shows an empty directory and
 * the officer console an empty queue — "everything is blank". Instead of
 * asking a presenter to run `bun run seed` mid-demo, the first
 * GET /api/auth/login detects the empty DB and rebuilds the full showcase:
 *
 *   1. reference data (customers, accounts, txns, tariffs, KB, officers)
 *      — awaited, so the directory answers immediately after
 *   2. curated demo state (warm chats, OTP-verified pending transfers,
 *      payslip packs incl. a tampered one, executed + rejected history)
 *      — produced by the SAME orchestrator/IDP/approval code paths a real
 *        demo click takes, in the background
 *
 * The login screen polls `demoState` until it is "ready". Idempotent:
 * the seed uses upserts; the curator only runs when NOTHING has happened yet
 * (zero chat sessions), so a reset-demo followed by a reload rebuilds the
 * showcase, while a live demo is never touched.
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

/** Public entry: call at the top of GET /api/auth/login. Never throws. */
export async function ensureSeeded(): Promise<void> {
  try {
    // "real" demo identities only: test/eval fixtures use role "fixture" so
    // they never appear in (nor satisfy) the demo directory.
    const realCustomers = await db.customer.count({ where: { role: { in: ["customer", "credit_officer", "approver"] } } });
    const sessions = await db.chatSession.count();
    if (realCustomers > 0 && sessions > 0) {
      state = "ready";
      return; // live DB — never touch it
    }
    if (!g.__hazinaEnsure) {
      g.__hazinaEnsure = rebuild(realCustomers === 0).finally(() => {
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

async function rebuild(needsSeed: boolean): Promise<void> {
  state = "seeding";
  if (needsSeed) {
    console.log("[ensure-seed] demo DB is empty — seeding reference data…");
    await seedAll(db);
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
