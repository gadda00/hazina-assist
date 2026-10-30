/**
 * Synthetic demo dataset — shared by `bun run seed` (prisma/seed.ts) and the
 * server-side auto-heal (src/lib/ensure-seed.ts).
 *
 * Contents: 5 customers (incl. edge-case profiles: business banking, young
 * saver, near-empty account), officers, Co-opConnect-shaped
 * accounts/transactions, a tariff guide dated 2026-10-22 (structured rows +
 * prose chunks), beneficiaries (established + new → cooling-off demo).
 * 100% synthetic data — safe for demos. Idempotent (upserts / find-create).
 */
import type { PrismaClient } from "@prisma/client";

const daysAgo = (n: number, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 15, 0, 0);
  return d;
};

export async function seedAll(db: PrismaClient): Promise<void> {
  // ---------------------------------------------------------------------
  // Customers — Amina & Brian (the original journey) + Kevin (business
  // banking / PesaLink), Zawadi (young saver), Grace (near-empty edge case)
  // ---------------------------------------------------------------------
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
  const kevin = await db.customer.upsert({
    where: { phone: "+254733456788" },
    update: {},
    create: {
      name: "Kevin Mutua",
      phone: "+254733456788",
      email: "kevin.mutua@example.co.ke",
      kraPin: "A555123478M",
      role: "customer",
    },
  });
  const zawadi = await db.customer.upsert({
    where: { phone: "+254741122334" },
    update: {},
    create: {
      name: "Zawadi Hassan",
      phone: "+254741122334",
      email: "zawadi.hassan@example.co.ke",
      kraPin: "A777889911Q",
      role: "customer",
    },
  });
  const grace = await db.customer.upsert({
    where: { phone: "+254745566778" },
    update: {},
    create: {
      name: "Grace Wanjala",
      phone: "+254745566778",
      email: "grace.wanjala@example.co.ke",
      kraPin: "P222333444L",
      role: "customer",
    },
  });

  // ---------------------------------------------------------------------
  // Accounts (opaque handles + server-side raw numbers)
  // ---------------------------------------------------------------------
  const acct = async (
    handle: string,
    customerId: string,
    maskedNumber: string,
    rawNumber: string,
    type: string,
    balanceKes: number
  ) =>
    db.account.upsert({
      where: { handle },
      update: {},
      create: { handle, customerId, maskedNumber, rawNumber, type, balanceKes },
    });

  const acctA1 = await acct("acct_7f3a", amima.id, "****1234", "9012345678901", "current", 84_250.5);
  const acctA2 = await acct("acct_9c1e", amima.id, "****5678", "9012345678902", "savings", 210_000);
  const acctB1 = await acct("acct_4d8b", brian.id, "****9012", "9012345678903", "current", 38_900);
  const acctK1 = await acct("acct_2e6c", kevin.id, "****3310", "9012345678911", "current", 412_750);
  const acctK2 = await acct("acct_8b4d", kevin.id, "****7721", "9012345678912", "savings", 88_400);
  const acctZ1 = await acct("acct_5a9e", zawadi.id, "****2045", "9012345678921", "current", 12_300);
  const acctZ2 = await acct("acct_3f7b", zawadi.id, "****8812", "9012345678922", "savings", 156_800);
  const acctG1 = await acct("acct_9d2f", grace.id, "****6650", "9012345678931", "current", 3_450);

  // ---------------------------------------------------------------------
  // Transactions (Kenyan merchant narratives, varied categories)
  // ---------------------------------------------------------------------
  const txns: Array<[string, string, string, string, number, string, string, string, string]> = [
    // Amina — salary earner, city spending
    [acctA1.id, "TXN-1001", "MR-1001", "Salary — Savanna Logistics", 145_000, "credit", "income", "deposit", "internal"],
    [acctA1.id, "TXN-1002", "MR-1002", "KPLC electricity tokens", 2_400, "debit", "utilities", "fee", "internal"],
    [acctA1.id, "TXN-1003", "MR-1003", "Naivas Westlands groceries", 8_650, "debit", "groceries", "transfer_out", "mpesa"],
    [acctA1.id, "TXN-1004", "MR-1004", "Safaricom airtime & data", 1_500, "debit", "airtime_data", "transfer_out", "mpesa"],
    [acctA1.id, "TXN-1005", "MR-1005", "Bolt ride — town", 620, "debit", "transport", "transfer_out", "mpesa"],
    [acctA1.id, "TXN-1006", "MR-1006", "Transfer to Jane Muthoni — M-PESA", 5_000, "debit", "savings_transfer", "transfer_out", "mpesa"],
    [acctA1.id, "TXN-1007", "MR-1007", "Tariff charge", 33, "debit", "fees_charges", "fee", "internal"],
    [acctA1.id, "TXN-1008", "MR-1008", "Nairobi Water bill", 1_180, "debit", "utilities", "fee", "internal"],
    [acctA1.id, "TXN-1009", "MR-1009", "Java House brunch", 2_350, "debit", "food_dining", "transfer_out", "mpesa"],
    [acctA1.id, "TXN-1010", "MR-1010", "Rent — Kasarana apartments", 45_000, "debit", "rent_housing", "transfer_out", "internal"],
    [acctA1.id, "TXN-1011", "MR-1011", "NHIF supplement — Afya Bora clinic", 1_900, "debit", "healthcare", "fee", "internal"],
    [acctA1.id, "TXN-1012", "MR-1012", "Netflix + Showmax bundle", 1_250, "debit", "entertainment", "transfer_out", "mpesa"],
    [acctA2.id, "TXN-2001", "MR-2001", "Interest credit", 890, "credit", "income", "interest", "internal"],
    [acctA2.id, "TXN-2002", "MR-2002", "Standing order — savings top-up", 20_000, "credit", "savings_transfer", "deposit", "internal"],
    // Brian — mid-balance, family remittances
    [acctB1.id, "TXN-3001", "MR-3001", "Salary — Tulivu Retail Group", 82_500, "credit", "income", "deposit", "internal"],
    [acctB1.id, "TXN-3002", "MR-3002", "Quickmart Ngong Road groceries", 6_120, "debit", "groceries", "transfer_out", "mpesa"],
    [acctB1.id, "TXN-3003", "MR-3003", "Matatu fare CBD", 60, "debit", "transport", "transfer_out", "mpesa"],
    [acctB1.id, "TXN-3004", "MR-3004", "Transfer to Otieno Senior — Hazina", 12_000, "debit", "family_support", "transfer_out", "internal"],
    [acctB1.id, "TXN-3005", "MR-3005", "School fees — Baraka Academy term 2", 28_500, "debit", "education", "transfer_out", "pesalink"],
    [acctB1.id, "TXN-3006", "MR-3006", "Jubilee insurance premium", 4_300, "debit", "insurance", "fee", "internal"],
    // Kevin — sole proprietor hardware supplies
    [acctK1.id, "TXN-4001", "MR-4001", "LPO settlement — Maji Road Contractors", 260_000, "credit", "business_income", "deposit", "pesalink"],
    [acctK1.id, "TXN-4002", "MR-4002", "Bulk stock — Devki Steel & Cement", 118_400, "debit", "business_supplies", "transfer_out", "internal"],
    [acctK1.id, "TXN-4003", "MR-4003", "KRA VAT — October filing", 31_200, "debit", "tax", "fee", "internal"],
    [acctK1.id, "TXN-4004", "MR-4004", "Supplier — Nairobi AgriHub (PesaLink)", 64_500, "debit", "business_supplies", "transfer_out", "pesalink"],
    [acctK1.id, "TXN-4005", "MR-4005", "Hardware staff wages — 4 hands", 52_000, "debit", "payroll", "transfer_out", "internal"],
    [acctK1.id, "TXN-4006", "MR-4006", "Diesel — pickup deliveries", 9_800, "debit", "transport", "transfer_out", "mpesa"],
    [acctK2.id, "TXN-4101", "MR-4101", "Interest credit", 410, "credit", "income", "interest", "internal"],
    [acctK2.id, "TXN-4102", "MR-4102", "Tax reserve sweep", 25_000, "credit", "savings_transfer", "deposit", "internal"],
    // Zawadi — young saver, goal account
    [acctZ1.id, "TXN-5001", "MR-5001", "Bursary disbursement — Elimu Fund", 18_000, "credit", "income", "deposit", "internal"],
    [acctZ1.id, "TXN-5002", "MR-5002", "Tuition — Nairobi Tech Institute", 12_500, "debit", "education", "transfer_out", "internal"],
    [acctZ1.id, "TXN-5003", "MR-5003", "Data bundle — Safaricom", 1_000, "debit", "airtime_data", "transfer_out", "mpesa"],
    [acctZ2.id, "TXN-5101", "MR-5101", "Goal savings — laptop fund", 5_000, "credit", "savings_transfer", "deposit", "internal"],
    [acctZ2.id, "TXN-5102", "MR-5102", "Interest credit", 240, "credit", "income", "interest", "internal"],
    // Grace — near-empty account (edge case: low balance, tiny history)
    [acctG1.id, "TXN-6001", "MR-6001", "Casual wage — Mwangaza farm", 2_800, "credit", "income", "deposit", "internal"],
    [acctG1.id, "TXN-6002", "MR-6002", "M-Pesa withdrawal", 700, "debit", "cash_withdrawal", "transfer_out", "mpesa"],
  ];
  let day = 1;
  for (const [accountId, txnRef, messageRef, narrative, amount, direction, category, type, channel] of txns) {
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
        channel,
        counterparty: narrative.split(" — ")[0],
        narrative,
        category,
        status: "completed",
        ts: daysAgo(day++, 9 + (day % 8)),
      },
    });
  }

  // ---------------------------------------------------------------------
  // Beneficiaries — established (firstUsed in the past) vs NEW (cooling-off)
  // ---------------------------------------------------------------------
  const bene = async (customerId: string, name: string, destinationType: string, destination: string, firstUsedAt: Date | null) => {
    const existing = await db.beneficiary.findFirst({ where: { customerId, destination } });
    if (!existing) {
      await db.beneficiary.create({ data: { customerId, name, destinationType, destination, firstUsedAt } });
    }
  };
  await bene(amima.id, "Jane Muthoni", "mpesa", "+254733445566", daysAgo(60));
  await bene(amima.id, "Grace Achieng", "mpesa", "+254701998877", null); // NEW → cooling-off demo
  await bene(brian.id, "Otieno Senior", "internal", "9012345678941", daysAgo(120));
  await bene(kevin.id, "Nairobi AgriHub", "pesalink", "0110223344551", daysAgo(45));
  await bene(kevin.id, "Baraka Traders", "internal", "9012345678951", daysAgo(90));
  await bene(zawadi.id, "Mama Fatuma", "mpesa", "+254711223344", daysAgo(30));

  // ---------------------------------------------------------------------
  // Tariff rows (public tariff guide, effective 2026-10-22)
  // NOTE: kept IDENTICAL to the eval-pinned numbers — the 55-case golden
  // gate asserts exact fee values from these bands.
  // ---------------------------------------------------------------------
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

  // ---------------------------------------------------------------------
  // Knowledge chunks (prose with breadcrumbs + effective dates).
  // The original set is eval-pinned (retrieval order matters for the golden
  // set); additions are NEW topics only so they cannot perturb golden cases.
  // ---------------------------------------------------------------------
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
    {
      docId: "product-faq",
      page: 8,
      title: "USSD banking on *667#",
      breadcrumb: "Products > Digital > USSD",
      text: "Customers without smartphones can bank on any handset using USSD short code *667#. Balance checks, mini-statements, M-Pesa sends and airtime purchases are available. USSD session fee is KES 10 per session, charged to airtime, not to the account. Daily transfer limits on USSD are lower than on the app: KES 20,000 per transaction and KES 50,000 per day.",
      keywords: "ussd 667 short code feature phone balance mini statement airtime session 10 limits 20,000 50,000 daily",
    },
    {
      docId: "product-faq",
      page: 9,
      title: "Card controls — freeze, limits and online use",
      breadcrumb: "Products > Cards > Controls",
      text: "From the app or *667# you can freeze and unfreeze your debit card instantly at no charge, set per-transaction and daily limits, and switch international e-commerce payments on or off. Freezing blocks all new authorisations within seconds; recurring mandates already on file are also blocked until you unfreeze. Card controls are free and unlimited.",
      keywords: "freeze card unfreeze block limits international ecommerce switch mandates free seconds",
    },
    {
      docId: "product-faq",
      page: 10,
      title: "Overdrafts on current accounts",
      breadcrumb: "Products > Loans > Overdraft",
      text: "Salary-account holders with six months of consistent credits may qualify for an arranged overdraft of up to 50% of monthly net salary, capped at KES 200,000. Overdrawn balances are charged 1.5% per month on the utilized amount. An arrangement fee of 1% applies at set-up. Unarranged overdrafts are not permitted; payments that would exceed the limit are declined outright.",
      keywords: "overdraft arranged current account salary 50% cap 200,000 1.5% monthly arrangement fee unarranged declined",
    },
    {
      docId: "product-faq",
      page: 11,
      title: "Fixed deposits",
      breadcrumb: "Products > Savings > Fixed Deposit",
      text: "Fixed deposits start at KES 50,000 for a minimum tenor of three months. Indicative rates: 3 months 4.5% per annum, 6 months 5.5%, 9 months 6.2% and 12 months 7.0%. Interest is paid at maturity or monthly to a current account at a 0.5% discount. Early withdrawal forfeits accrued interest and attracts a 2% penalty on principal. Holders may borrow up to 80% of the deposit value as a secured loan.",
      keywords: "fixed deposit fd rates 4.5 5.5 6.2 7.0 tenor maturity penalty early withdrawal secured loan 80%",
    },
  ];
  for (const c of chunks) {
    const existing = await db.knowledgeChunk.findFirst({ where: { docId: c.docId, page: c.page, title: c.title } });
    if (!existing) await db.knowledgeChunk.create({ data: c });
  }

  // ---------------------------------------------------------------------
  // Ops console users
  // ---------------------------------------------------------------------
  await db.customer.upsert({
    where: { phone: "+254700000001" },
    update: {},
    create: { name: "Officer Njeri (Credit)", phone: "+254700000001", role: "credit_officer", email: "njeri@example.co.ke" },
  });
  await db.customer.upsert({
    where: { phone: "+254700000002" },
    update: {},
    create: { name: "Officer Kamau (Payments)", phone: "+254700000002", role: "approver", email: "kamau@example.co.ke" },
  });
}
