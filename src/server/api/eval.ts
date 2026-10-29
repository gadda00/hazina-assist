import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireDemoOfficer } from "@/lib/authz";
import { ERR, reqId } from "@/lib/schemas";

/** GET /api/eval — latest eval run (rendered by the Ops console Evals tab).
 *  Officer-only. */
export async function GET(req: Request) {
  const auth = await requireDemoOfficer(req);
  if (!auth.ok) return auth.response;
  try {
    const run = await db.evalRun.findFirst({ orderBy: { startedAt: "desc" } });
    if (!run) return NextResponse.json({ run: null });
    return NextResponse.json({
      run: {
        id: run.id,
        model: run.model,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        passed: run.passed,
        totals: JSON.parse(run.totals),
        cases: JSON.parse(run.cases),
      },
    });
  } catch (e) {
    console.error("[eval]", e);
    return ERR.internal(reqId(req));
  }
}
