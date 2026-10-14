import { NextResponse } from "next/server";
import { listRecentFindings } from "@/lib/sources";

/**
 * GET /api/findings?limit=50 — read the most recent findings.
 *
 * Used by the dashboard for its initial render (server-side) and to reconcile
 * after an SSE reconnect. It is a plain read of already-public research data and
 * holds no secrets; add your own auth here if the dashboard becomes
 * multi-tenant.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const rawLimit = new URL(req.url).searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);

  try {
    const findings = await listRecentFindings(Number.isFinite(limit) ? limit : 50);
    return NextResponse.json(
      { ok: true, findings },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[api/findings] database error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to load findings." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
