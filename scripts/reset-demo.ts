/**
 * Reset transactional demo data (keep seeded reference data), then verify
 * the reference tables are intact. Follow-up steps (run separately):
 *   1. bun run eval            → fresh EvalRun for the Evaluations tab
 *   2. curate-showcase.ts      → one pending transfer + one loan pack
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // Wipe in FK-safe order: everything that references ChatSession first,
  // then the sessions themselves, then standalone tables.
  await db.message.deleteMany();
  await db.auditEvent.deleteMany();
  await db.approvalTask.deleteMany();
  await db.transferIntent.deleteMany();
  await db.otpCode.deleteMany();
  await db.pendingAction.deleteMany();
  await db.payslipPack.deleteMany();
  await db.evalRun.deleteMany();
  await db.chatSession.deleteMany();
  await db.idempotencyKey.deleteMany();
  await db.pseudonymVault.deleteMany();

  // Purge test/eval fixture identities so the login screen shows only the
  // curated seed personas (Race* from transfer-race tests, Eval Fixture from
  // the eval harness, Test Officer from the safety suite — all recreate
  // themselves when their suites re-run). Mirrors RESIDUE_WHERE in
  // src/lib/ensure-seed.ts, including role "fixture".
  const fixtures = await db.customer.findMany({
    where: {
      OR: [
        { role: "fixture" },
        { name: { startsWith: "Race " } },
        { name: "Eval Fixture" },
        { name: "Test Officer" },
      ],
    },
    select: { id: true },
  });
  for (const f of fixtures) {
    // fixture identities may own chat sessions/messages (eval runs through
    // the real orchestrator) — remove those first (FK-safe)
    const sess = await db.chatSession.findMany({ where: { customerId: f.id }, select: { id: true } });
    for (const s of sess) await db.message.deleteMany({ where: { sessionId: s.id } });
    await db.chatSession.deleteMany({ where: { customerId: f.id } });
    await db.beneficiary.deleteMany({ where: { customerId: f.id } });
    await db.transaction.deleteMany({ where: { account: { customerId: f.id } } });
    await db.account.deleteMany({ where: { customerId: f.id } });
    await db.customer.delete({ where: { id: f.id } });
  }

  console.log("Wiped transactional tables. Reference data retained:");
  console.log({
    customers: await db.customer.count(),
    accounts: await db.account.count(),
    transactions: await db.transaction.count(),
    tariffRows: await db.tariffRow.count(),
    knowledgeChunks: await db.knowledgeChunk.count(),
    beneficiaries: await db.beneficiary.count(),
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
