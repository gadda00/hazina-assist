import { NextResponse } from "next/server";
import { listTools } from "@/lib/tools";
import { availableLabels } from "@/lib/categoriser";
import { breakerState } from "@/lib/gateway";

/** GET /api/tools — registered tool specs (least-privilege surface, for the UI). */
export async function GET() {
  return NextResponse.json({
    tools: listTools(),
    categoriser: {
      labels: availableLabels(),
      backend: process.env.CATEGORISER_URL ? "ds-service (configured)" : "local-fallback",
      contract: "services/categoriser/openapi.yaml",
    },
    gateway: breakerState(),
  });
}
