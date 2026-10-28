import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** GET /api/eval — latest eval run (rendered by the Ops console Evals tab). */
export async function GET() {
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
}
