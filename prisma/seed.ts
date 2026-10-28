/**
 * Seed: synthetic customers, Co-opConnect-shaped accounts/transactions,
 * a tariff guide dated 2026-10-22 (structured rows + prose chunks),
 * beneficiaries (one established, one new → cooling-off demo).
 * 100% synthetic data — safe for demos.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("Seeding Hazina Assist demo data…");

  // ---- customers ----
  const amima = await db.customer.upsert({
    where: { phone: "+254712345678" },
    update: {},
    create: {
      name: "Amina Wanjiru",
      phone: "+254712345678",
      email: "amina.wanjiru@example.co.ke",
      kraPin: "A123456789Z",
      role: "customer",
    },
  });
  const brian = await db.customer.upsert({
    where: { phone: "+254723456789" },
    update: {},
    create: {
      name: "Brian Otieno",
      phone: "+254723456789",
      email: "brian.otieno@example.co.ke",
      kraPin: "P987654321K",
      role: "customer",
    },
  });

  // ---- accounts (opaque handles + server-side raw numbers) ----
  const acctA1 = await db.account.upsert({
    where: { handle: "acct_7f3a" },
    update: {},
    create: {
      customerId: amima.id,
      handle: "acct_7f3a",
      maskedNumber: "****1234",
      rawNumber: "9012345678901",
      type: "current",
      balanceKes: 84_250.5,
    },
  });
  const acctA2 = await db.account.upsert({
    where: { handle: "acct_9c1e" },
    update: {},
    create: {
      customerId: amima.id,
      handle: "acct_9c1e",
      maskedNumber: "****5678",
      rawNumber: "9012345678902",
      type: "savings",
      balanceKes: 210_000,
    },
  });
  const acctB1 = await db.account.upsert({
    where: { handle: "acct_4d8b" },
    update: {},
    create: {
      customerId: brian.id,
      handle: "acct_4d8b",
      maskedNumber: "****9012",
      rawNumber: "9012345678903",
      type: "current",
      balanceKes: 38_900,
    },
  });

  // ---- transactions (Kenyan merchant narratives) ----
  const daysAgo = (n: number, h = 10) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(h, 15, 0, 0);
    return d;
  };
  const txns: Array<[string, string, string, string, number, string, string | null, string]> = [
    [acctA1.id, "TXN-1001", "MR-1001", "Salary — Savanna Logistics", 145_000, "credit", "income", "deposit"],
    [acctA1.id, "TXN-1002", "MR-1002", "KPLC electricity tokens", 2_400, "debit", "utilities", "fee"],
    [acctA1.id, "TXN-1003", "MR-1003", "Naivas Westlands groceries", 8_650, "debit", "groceries", "transfer_out"],
    [acctA1.id, "TXN-1004", "MR-1004", "Safaricom airtime & data", 1_500, "debit", "airtime_data", "transfer_out"],
    [acctA1.id, "TXN-1005", "MR-1005", "Bolt ride — town", 620, "debit", "transport", "transfer_out"],
    [acctA1.id, "TXN-1006", "MR-1006", "Transfer to Jane Muthoni — M-PESA", 5_000, "debit", "savings_transfer", "transfer_out"],
    [acctA1.id, "TXN-1007", "MR-1007", "Tariff charge", 33, "debit", "fees_charges", "fee"],
    [acctA1.id, "TXN-1008", "MR-1008", "Nairobi Water bill", 1_180, "debit", "utilities", "fee"],
    [acctA1.id, "TXN-1009", "MR-1009", "Java House brunch", 2_350, "debit", "food_dining", "transfer_out"],
    [acctA1.id, "TXN-1010", "MR-1010", "Rent — Kasarana apartments", 45_000, "debit", "rent_housing", "transfer_out"],
    [acctA2.id, "TXN-2001", "MR-2001", "Interest credit", 890, "credit", "income", "interest"],
    [acctA2.id, "TXN-2002", "MR-2002", "Standing order — savings top-up", 20_000, "credit", "savings_transfer", "deposit"],
    [acctB1.id, "TXN-3001", "MR-3001", "Salary — Tulivu Retail Group", 82_500, "credit", "income", "deposit"],
    [acctB1.id, "TXN-3002", "MR-3002", "Quickmart Ngong Road groceries", 6_120, "debit", "groceries", "transfer_out"],
    [acctB1.id, "TXN-3003", "MR-3003", "Matatu fare CBD", 60, "debit", "transport", "transfer_out"],
  ];
  let day = 1;
  for (const [accountId, txnRef, messageRef, narrative, amount, direction, category, type] of txns) {
    await db.transaction.upsert({
      where: { txnRef },
      update: {},
      create: {
        accountId,
        txnRef,
        messageRef,
        type,
        direction,
        amount,
        channel: /M-PESA|Bolt|Safaricom|Quickmart|Java|Naivas/i.test(narrative) ? "mpesa" : "internal",
        counterparty: narrative.split(" — ")[0],
        narrative,
        category,
        status: "completed",
        ts: daysAgo(day++, 9 + (day % 8)),
      },
    });
  }

  // ---- beneficiaries: Jane established (firstUsed 2 months ago), Kevin NEW ----
  const jane = await db.beneficiary.findFirst({ where: { customerId: amima.id, destination: "+254733445566" } });
  if (!jane) {
    await db.beneficiary.create({
      data: {
        customerId: amima.id,
        name: "Jane Muthoni",
        destinationType: "mpesa",
        destination: "+254733445566",
        firstUsedAt: daysAgo(60),
      },
    });
  }
  const grace = await db.beneficiary.findFirst({ where: { customerId: amima.id, destination: "+254701998877" } });
  if (!grace) {
    await db.beneficiary.create({
      data: {
        customerId: amima.id,
        name: "Grace Achieng",
        destinationType: "mpesa",
        destination: "+254701998877",
        firstUsedAt: null, // NEW beneficiary → cooling-off demo
      },
    });
  }

  // ---- tariff rows (public tariff guide, effective 2026-10-22) ----
  const tariff: Array<[string, string, number, number | null, string, number, number | null, number | null]> = [
    ["Eazzy Banking / Mobile", "send_to_mpesa", 1, 100_000, "flat-tiered", 0, 0, null], // filled below with banded rows
  ];
  // Replace with explicit banded rows for the demo guide:
  const tariffRows: Array<{ product: string; channel: string; bandMin: number; bandMax: number | null; feeType: string; feeValue: number; minFee: number | null; maxFee: number | null; effectiveDate: string; docId: string; page: number }> = [
    { product: "Eazzy Banking / Mobile", channel: "send_to_mpesa", bandMin: 1, bandMax: 1000, feeType: "flat", feeValue: 0, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 3 },
    { product: "Eazzy Banking / Mobile", channel: "send_to_mpesa", bandMin: 1001, bandMax: 10_000, feeType: "flat", feeValue: 11, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 3 },
    { product: "Eazzy Banking / Mobile", channel: "send_to_mpesa", bandMin: 10_001, bandMax: 35_000, feeType: "flat", feeValue: 23, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 3 },
    { product: "Eazzy Banking / Mobile", channel: "send_to_mpesa", bandMin: 35_001, bandMax: 70_000, feeType: "flat", feeValue: 52, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 3 },
    { product: "Eazzy Banking / Mobile", channel: "send_to_mpesa", bandMin: 70_001, bandMax: null, feeType: "flat", feeValue: 75, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 3 },
    { product: "Current Account", channel: "internal_transfer", bandMin: 1, bandMax: null, feeType: "flat", feeValue: 0, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 4 },
    { product: "Current Account", channel: "pesalink_out", bandMin: 1, bandMax: 10_000, feeType: "flat", feeValue: 35, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 4 },
    { product: "Current Account", channel: "pesalink_out", bandMin: 10_001, bandMax: 150_000, feeType: "flat", feeValue: 110, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 4 },
    { product: "Current Account", channel: "pesalink_out", bandMin: 150_001, bandMax: 999_999, feeType: "flat", feeValue: 205, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 4 },
    { product: "Current Account", channel: "withdrawal_agent", bandMin: 1, bandMax: 2_500, feeType: "flat", feeValue: 30, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 5 },
    { product: "Current Account", channel: "withdrawal_agent", bandMin: 2_501, bandMax: 25_000, feeType: "percent", feeValue: 0.65, minFee: 30, maxFee: 180, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 5 },
    { product: "Current Account", channel: "withdrawal_agent", bandMin: 25_001, bandMax: 70_000, feeType: "percent", feeValue: 0.55, minFee: 180, maxFee: 320, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 5 },
    { product: "Current Account", channel: "withdrawal_atm", bandMin: 1, bandMax: 2_000, feeType: "flat", feeValue: 60, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 5 },
    { product: "Current Account", channel: "withdrawal_atm", bandMin: 2_001, bandMax: 40_000, feeType: "flat", feeValue: 110, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 5 },
    { product: "Eazzy Banking / Mobile", channel: "balance_check", bandMin: 0, bandMax: null, feeType: "flat", feeValue: 0, minFee: null, maxFee: null, effectiveDate: "2026-10-22", docId: "tariff-guide-2026-10-22", page: 6 },
  ];
  for (const r of tariffRows) {
    const existing = await db.tariffRow.findFirst({
      where: { channel: r.channel, bandMin: r.bandMin, effectiveDate: r.effectiveDate },
    });
    if (!existing) await db.tariffRow.create({ data: r });
  }

  // ---- knowledge chunks (prose with breadcrumbs + effective dates) ----
  const chunks: Array<{ docId: string; page: number; title: string; breadcrumb: string; text: string; effectiveDate?: string; keywords: string }> = [
    {
      docId: "tariff-guide-2026-10-22",
      page: 2,
      title: "How to read this tariff guide",
      breadcrumb: "Fees & Tariffs > Introduction",
      text: "This guide lists charges for personal accounts with effect from 22 October 2026. Tariffs differ by channel: Eazzy Banking mobile app and USSD transfers cost less than branch-counter transactions. Government levies such as excise duty on fees apply where required by law. All amounts are in Kenya Shillings.",
      effectiveDate: "2026-10-22",
      keywords: "tariff guide charges fees effective 22 october 2026 channels eazzy ussd branch excise",
    },
    {
      docId: "tariff-guide-2026-10-22",
      page: 3,
      title: "Sending money to M-Pesa from the app",
      breadcrumb: "Fees & Tariffs > Eazzy Banking > Send to M-Pesa",
      text: "Transfers from Eazzy Banking to any M-Pesa number are charged per band: amounts up to KES 1,000 attract no charge; KES 1,001 to 10,000 cost KES 11; KES 10,001 to 35,000 cost KES 23; KES 35,001 to 70,000 cost KES 52; above 70,000 the charge is KES 75. There is no daily cap on the number of sends, but the per-transaction limit is KES 70,000 on mobile channels. Funds reach M-Pesa instantly.",
      effectiveDate: "2026-10-22",
      keywords: "mpesa send fee band 11 23 52 75 70,000 limit instant eazzy",
    },
    {
      docId: "tariff-guide-2026-10-22",
      page: 4,
      title: "Internal transfers and PesaLink",
      breadcrumb: "Fees & Tariffs > Current Account > Transfers",
      text: "Transfers between your own Hazina accounts and to other Hazina customers are free on all digital channels. PesaLink transfers to other banks cost KES 35 for amounts up to 10,000; KES 110 for 10,001 to 150,000; and KES 205 for 150,001 to 999,999. PesaLink transfers above 999,999 are not available on mobile and must be initiated at a branch.",
      effectiveDate: "2026-10-22",
      keywords: "pesalink other banks fee 35 110 205 branch internal free",
    },
    {
      docId: "product-faq",
      page: 1,
      title: "Opening a personal account — requirements",
      breadcrumb: "Products > Personal Accounts > Requirements",
      text: "To open a personal current account you need: original national ID or valid passport, KRA PIN certificate, one passport-size photograph, and proof of address such as a utility bill dated within three months. The minimum opening balance for the Eazzy Plus current account is KES 1,000. Students opening the student account need no minimum balance and present a student ID together with their national ID.",
      keywords: "open account requirements documents id kra pin photo utility bill minimum balance student",
    },
    {
      docId: "product-faq",
      page: 2,
      title: "Personal loan eligibility",
      breadcrumb: "Products > Loans > Personal Loan",
      text: "Personal loans are available to customers with at least six months of confirmed salary earnings credited to a Hazina account. The minimum loan is KES 50,000 and the maximum unsecured personal loan is KES 1,500,000. Repayment tenors run from 6 to 48 months. Interest is priced from 14.5% per annum on a reducing balance. Applicants provide their latest three payslips, a copy of their national ID and KRA PIN, and the bank's stamped six-month bank statement.",
      keywords: "loan eligibility salary six months 50,000 1,500,000 tenor 6 48 months interest 14.5 payslips statement",
    },
    {
      docId: "product-faq",
      page: 3,
      title: "Eazzy Banking app features",
      breadcrumb: "Products > Digital > Eazzy Banking",
      text: "The Eazzy Banking app lets you check balances, buy airtime, send money to M-Pesa and other banks, pay bills such as KPLC and Nairobi Water, buy government securities in the new tap-and-invest feature, and freeze your card instantly if it is lost. The app is free to download and balance checks are free. Mini-statements for the last five transactions are free on the app; full PDF statements cost KES 110 per request.",
      keywords: "eazzy app features airtime bills kplc water freeze card balance free mini statement pdf 110",
    },
    {
      docId: "product-faq",
      page: 4,
      title: "Account dormancy and reactivation",
      breadcrumb: "Products > Personal Accounts > Dormancy",
      text: "An account becomes dormant after six months with no customer-initiated activity. Dormant accounts attract a monthly ledger fee of KES 50 after twelve months of inactivity. To reactivate a dormant account, visit any branch with your original national ID; reactivation is completed the same working day at no charge.",
      keywords: "dormant dormancy six months ledger fee 50 reactivate branch id free",
    },
    {
      docId: "product-faq",
      page: 5,
      title: "Card replacement and withdrawal limits",
      breadcrumb: "Products > Cards > Replacement",
      text: "Replacing a lost or damaged debit card costs KES 500 and the card is ready for collection at your home branch within three working days. Daily ATM withdrawal limit is KES 40,000 per card. Agent withdrawal limits follow the tariff bands on page 5 of the fees guide. Cash withdrawals at the branch counter above KES 100,000 require 24-hour notice.",
      keywords: "card replacement 500 lost damaged atm limit 40,000 agent branch counter notice 100,000",
    },
    {
      docId: "product-faq",
      page: 6,
      title: "Holding deposits and cheque clearing",
      breadcrumb: "Products > Payments > Cheques",
      text: "Local cheque deposits clear on T+1 for amounts up to KES 200,000; larger amounts follow T+2 clearing. Upcountry cheques take up to three working days. A returned cheque attracts a handling fee of KES 1,050. The bank may place a hold on cheque deposits exceeding KES 500,000 pending verification.",
      keywords: "cheque clearing t+1 t+2 upcountry returned fee 1,050 hold 500,000",
    },
    {
      docId: "product-faq",
      page: 7,
      title: "M-Shwari-style savings and goal accounts",
      breadcrumb: "Products > Savings > Goal Account",
      text: "The Hazina Goal savings account pays interest of up to 5% per annum, credited quarterly, with no minimum balance and no ledger fee. Withdrawals are free twice a month; thereafter each withdrawal costs KES 60. Standing orders into a Goal account are free and can be scheduled monthly or weekly.",
      keywords: "goal savings interest 5% quarterly withdrawals free twice month 60 standing order",
    },
  ];
  for (const c of chunks) {
    const existing = await db.knowledgeChunk.findFirst({ where: { docId: c.docId, page: c.page, title: c.title } });
    if (!existing) await db.knowledgeChunk.create({ data: c });
  }

  // ---- users for the ops console ----
  await db.customer.upsert({
    where: { phone: "+254700000001" },
    update: {},
    create: { name: "Officer Njeri (Credit)", phone: "+254700000001", role: "credit_officer", email: "njeri@example.co.ke" },
  });

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
