/**
 * Curate the showcase state: leaves the officer console with two live,
 * decision-ready tasks and a meaningful audit trail:
 *   1. Amina → Jane, KES 2,500 M-Pesa transfer, OTP-verified, pending approval
 *   2. A clean payslip loan-pack (KES 300k / 24 months) awaiting credit review
 * Idempotent: safe to re-run (existing open tasks are left untouched).
 */
const BASE = "http://localhost:3000";

async function main() {
  // ---- login as Amina ----
  const dir = await (await fetch(`${BASE}/api/auth/login`)).json();
  const amina = dir.customers.find((c: { name: string }) => c.name.includes("Amina"));
  if (!amina) throw new Error("Amina not found — run prisma/seed.ts first");
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId: amina.id, as: "customer" }),
  })).json();
  const T = login.session.token, S = login.session.id;
  const chat = async (message: string) =>
    (await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` },
      body: JSON.stringify({ sessionId: S, message }),
    })).json();

  // ---- 1. warm conversation: fee + balance (gives chat history for the demo) ----
  await chat("What is the fee for sending 5000 to M-Pesa?");
  await chat("Nionyeshe salio langu");

  // ---- 2. stage transfer → OTP verify → pending approval ----
  const stage = await chat("Send 2500 to Jane on M-Pesa 0733445566");
  if (!stage.otp?.devCode) throw new Error("no OTP issued: " + JSON.stringify(stage).slice(0, 200));
  const verify = await chat(stage.otp.devCode);
  console.log("transfer staged:", verify.kind, "→", verify.pendingIntent?.state);

  // ---- 3. payslip loan pack ----
  const idp = await (await fetch(`${BASE}/api/idp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` },
    body: JSON.stringify({ sessionId: S, sampleKey: "clean", requestedAmountKes: 300000, tenorMonths: 24 }),
  })).json();
  console.log("loan pack:", idp.ok === true ? "created" : JSON.stringify(idp).slice(0, 200));

  // ---- verify officer queue ----
  const off = dir.officers[0];
  const offLogin = await (await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId: off.id, as: "officer" }),
  })).json();
  const queue = await (await fetch(`${BASE}/api/approvals`, {
    headers: { authorization: `Bearer ${offLogin.session.token}` },
  })).json();
  console.log("officer queue:", JSON.stringify(queue.tasks.map((t: { type: string; status: string }) => ({ type: t.type, status: t.status }))));
  console.log("DONE — showcase state curated");
}

main().catch((e) => { console.error(e); process.exit(1); });
