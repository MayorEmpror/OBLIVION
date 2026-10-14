import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { publishFinding } from "@/lib/events";
import { MAX_ITEMS, findingSchema, normalizePayload } from "@/lib/ingest-schema";
import { insertFinding, type IngestItem } from "@/lib/sources";
import type { Finding } from "@/lib/types";
import { checkWebhookSecret, extractPresentedSecret } from "@/lib/webhook-auth";

/**
 * POST /api/n8n/results — the single write path from n8n into the research
 * database.
 *
 * Flow:  authenticate -> parse -> validate -> persist (transactional, idempotent)
 *        -> publish realtime event -> respond with per-item outcomes.
 *
 * Contract notes:
 *  - Auth is a shared secret (`N8N_WEBHOOK_SECRET`) presented as
 *    `x-n8n-secret` or `Authorization: Bearer ...`. Server-only, never public.
 *  - Idempotent: re-sending the same findings creates no duplicates and is
 *    reported as `duplicate`. Existing rows are never overwritten.
 *  - Persist-before-publish: realtime events are emitted only after COMMIT, so
 *    the database always remains the source of truth.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ItemResult = {
  external_id: string | null;
  status: "created" | "duplicate" | "error";
  id?: number;
  error?: string;
};

export async function POST(req: Request): Promise<NextResponse> {
  // ── 1. Authenticate ───────────────────────────────────────────────────────
  const auth = checkWebhookSecret(extractPresentedSecret(req));
  if (auth === "not_configured") {
    // Fail closed and loudly: an unconfigured server must never accept writes.
    return json(
      { ok: false, error: "Ingestion is not configured (N8N_WEBHOOK_SECRET is unset)." },
      500,
    );
  }
  if (auth === "missing") {
    return json({ ok: false, error: "Missing webhook secret." }, 401);
  }
  if (auth === "invalid") {
    return json({ ok: false, error: "Invalid webhook secret." }, 403);
  }

  // ── 2. Parse ──────────────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "Request body is not valid JSON." }, 400);
  }

  const normalized = normalizePayload(raw);
  if (!normalized.ok) return json({ ok: false, error: normalized.error }, 400);
  if (normalized.items.length === 0) {
    return json({ ok: false, error: "Payload contains no findings." }, 400);
  }
  if (normalized.items.length > MAX_ITEMS) {
    return json(
      { ok: false, error: `Too many findings in one request (max ${MAX_ITEMS}).` },
      413,
    );
  }

  // ── 3. Validate per item ──────────────────────────────────────────────────
  // Malformed items are reported individually; well-formed siblings still go
  // through, so one bad row cannot block a whole batch.
  const results: ItemResult[] = [];
  const pending: { index: number; item: IngestItem }[] = [];

  normalized.items.forEach((rawItem, index) => {
    const parsed = findingSchema.safeParse(rawItem);
    if (parsed.success) {
      pending.push({ index, item: parsed.data });
      return;
    }
    results[index] = {
      external_id: readExternalId(rawItem),
      status: "error",
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  });

  if (pending.length === 0) {
    return json({ ok: false, error: "No valid findings in payload.", results }, 422);
  }

  // ── 4. Persist (one transaction; either all valid rows land or none do) ────
  let created = 0;
  let duplicates = 0;
  const toPublish: Finding[] = [];

  try {
    await withTransaction(async (client) => {
      for (const { index, item } of pending) {
        const outcome = await insertFinding(client, item, {
          workflow_id: item.workflow_id ?? normalized.workflow_id,
          execution_id: item.execution_id ?? normalized.execution_id,
        });
        if (outcome.status === "created") {
          created += 1;
          toPublish.push(outcome.finding);
        } else {
          duplicates += 1;
        }
        results[index] = {
          external_id: outcome.external_id,
          status: outcome.status,
          id: outcome.finding.id,
        };
      }
    });
  } catch (err) {
    return databaseErrorResponse(err);
  }

  // ── 5. Publish, only after the data is durable ────────────────────────────
  for (const finding of toPublish) publishFinding(finding);

  // ── 6. Respond ────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === "error").length;
  return json(
    {
      ok: true,
      received: normalized.items.length,
      created,
      duplicates,
      failed,
      results,
    },
    200,
  );
}

/** Reject anything that is not a POST with a clear, machine-readable body. */
export async function GET(): Promise<NextResponse> {
  return json({ ok: false, error: "Use POST to submit findings." }, 405);
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function readExternalId(item: unknown): string | null {
  if (item !== null && typeof item === "object") {
    const value = (item as Record<string, unknown>).external_id;
    if (typeof value === "string") return value;
  }
  return null;
}

function databaseErrorResponse(err: unknown): NextResponse {
  const code = (err as { code?: string } | null)?.code ?? null;
  const message = String((err as Error | null)?.message ?? "");

  // Connection-level failures (server down, wrong host, auth rejected at the
  // socket, pool exhausted) are transient from n8n's point of view: 503 tells a
  // retry to come back later. Anything else is a genuine server error.
  const connectionLevel =
    ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET", "EPIPE", "57P03", "3D000", "28P01"].includes(
      code ?? "",
    ) || /timeout exceeded when trying to connect/i.test(message);

  console.error("[api/n8n/results] database error:", err);

  return json(
    {
      ok: false,
      error: connectionLevel ? "Research database is unavailable." : "Failed to persist findings.",
      code,
    },
    connectionLevel ? 503 : 500,
  );
}
