import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appendEvent } from "@/lib/audit";

/** Demo login: pick a synthetic customer, open a chat session. */
export async function POST(req: Request) {
  try {
    const { customerId } = (await req.json()) as { customerId?: string };
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      include: { accounts: true, beneficiaries: true },
    });
    if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

    const session = await db.chatSession.create({ data: { customerId: customer.id } });
    await appendEvent({
      sessionId: session.id,
      actor: `customer:${customer.id}`,
      eventType: "session_opened",
      payload: { customer: customer.name, scopes: ["accounts:read", "fees:read", "transfers:propose"] },
    });
    return NextResponse.json({
      session: { id: session.id, createdAt: session.createdAt },
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      accounts: customer.accounts.map((a) => ({
        handle: a.handle,
        maskedNumber: a.maskedNumber,
        type: a.type,
        currency: a.currency,
      })),
      beneficiaries: customer.beneficiaries.map((b) => ({
        name: b.name,
        destinationType: b.destinationType,
        masked: b.destination.replace(/.(?=.{4})/g, "*"),
        established: !!b.firstUsedAt,
      })),
    });
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
}

export async function GET() {
  const customers = await db.customer.findMany({
    where: { role: "customer" },
    include: { accounts: true },
  });
  return NextResponse.json({
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone.replace(/.(?=.{4})/g, "*"),
      accounts: c.accounts.map((a) => ({ handle: a.handle, type: a.type, maskedNumber: a.maskedNumber })),
    })),
  });
}
