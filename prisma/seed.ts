/**
 * Seed CLI: synthetic customers, accounts/transactions, tariff guide,
 * knowledge base, beneficiaries and officers.
 *
 * The dataset lives in src/lib/seed-data.ts so the server-side auto-heal
 * (src/lib/ensure-seed.ts) replays the SAME data when the demo DB is found
 * empty at runtime — running `bun run seed` manually is now optional.
 * 100% synthetic data — safe for demos.
 */
import { PrismaClient } from "@prisma/client";
import { seedAll } from "../src/lib/seed-data";

const db = new PrismaClient();

async function main() {
  console.log("Seeding Hazina Assist demo data…");
  await seedAll(db);
  console.log("Seed complete:", {
    customers: await db.customer.count(),
    accounts: await db.account.count(),
    transactions: await db.transaction.count(),
    tariffRows: await db.tariffRow.count(),
    chunks: await db.knowledgeChunk.count(),
    beneficiaries: await db.beneficiary.count(),
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
