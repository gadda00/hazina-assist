import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireCustomerSession } from "@/lib/authz";
import { ERR, reqId } from "@/lib/schemas";

/**
 * GET /api/accounts — the customer's own account overview (scoped to the
 * caller's authenticated session, server-side resolved — never to a
 * client-supplied id). Powers the "My accounts" panel in the chat view so
 * balances are visible without asking the assistant, mirroring a real
 * banking app's landing state. Balances are the customer's own data; raw
 * account numbers stay server-side (only handles + masked numbers leave).
 */
export async function GET(req: Request) {
  const auth = await requireCustomerSession(req);
  if (!auth.ok) return auth.response;

  try {
    const full = await db.customer.findUnique({
      where: { id: auth.data.customerId },
      include: {
        accounts: { include: { transactions: { orderBy: { ts: "desc" }, take: 1 } } },
        beneficiaries: true,
      },
    });
    if (!full) return ERR.notFound("Customer", reqId(req));

    return NextResponse.json({
      accounts: full.accounts.map((a) => ({
        handle: a.handle,
        maskedNumber: a.maskedNumber,
        type: a.type,
        currency: a.currency,
        balanceKes: a.balanceKes,
        lastActivityAt: a.transactions[0]?.ts ?? null,
      })),
      beneficiaries: full.beneficiaries.map((b) => ({
        name: b.name,
        destinationType: b.destinationType,
        masked: b.destination.replace(/.(?=.{4})/g, "*"),
        established: !!b.firstUsedAt,
      })),
    });
  } catch (e) {
    console.error("[accounts:get]", e);
    return ERR.internal(reqId(req));
  }
}
