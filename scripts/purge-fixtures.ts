/**
 * Purge test/eval fixture identities (Race*, Eval Fixture) AFTER an eval run,
 * keeping the EvalRun record and the curated showcase tasks. FK-safe: removes
 * every row that references the fixture's chat sessions before the sessions.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const fixtures = await db.customer.findMany({
    where: { OR: [{ name: { startsWith: "Race " } }, { name: "Eval Fixture" }] },
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
    console.log("purged fixture:", f.name);
  }
  console.log("customers:", (await db.customer.findMany({ select: { name: true } })).map((c) => c.name));
  console.log("evalRuns kept:", await db.evalRun.count(), "| open tasks:", await db.approvalTask.count({ where: { status: "open" } }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
