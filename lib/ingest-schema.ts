import { z } from "zod";

/**
 * Payload contract for POST /api/n8n/results.
 *
 * The field set mirrors exactly what the "01 - Collect HN" workflow's Code node
 * emits (source, external_id, community, title, body, url, author_hash,
 * created_at) plus two optional provenance fields. It matches the columns of
 * `public.sources`, so nothing the workflow produces is dropped.
 *
 * Unknown keys are stripped by zod rather than stored: `sources` has no column
 * to hold them. If a future workflow emits fields worth keeping, add a column
 * via a migration and extend this schema.
 */

/** Upper bound on findings per request, to keep a single delivery bounded. */
export const MAX_ITEMS = 500;

const optionalText = z.string().nullish();

const isoDateTime = z
  .string()
  .nullish()
  .refine(
    (v) => v == null || v === "" || !Number.isNaN(Date.parse(v)),
    { message: "must be an ISO-8601 date-time string" },
  );

export const findingSchema = z.object({
  // Required — `external_id` is the idempotency key and is UNIQUE in the table.
  source: z.string().min(1, "is required"),
  external_id: z.string().min(1, "is required"),

  community: optionalText,
  title: optionalText,
  body: optionalText,
  url: optionalText,
  author_hash: optionalText,
  created_at: isoDateTime,

  // Provenance, optionally per-item (overrides the batch-level values).
  workflow_id: optionalText,
  execution_id: optionalText,
});

export type FindingInput = z.infer<typeof findingSchema>;

export type NormalizedPayload =
  | { ok: true; workflow_id: string | null; execution_id: string | null; items: unknown[] }
  | { ok: false; error: string };

/**
 * Accepts the shapes n8n can realistically send:
 *   - a bare array of findings                       [ {...}, {...} ]
 *   - an envelope                                    { workflow_id, execution_id, items: [ ... ] }
 *   - a single finding object                        { source, external_id, ... }
 */
export function normalizePayload(raw: unknown): NormalizedPayload {
  if (Array.isArray(raw)) {
    return { ok: true, workflow_id: null, execution_id: null, items: raw };
  }
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return {
        ok: true,
        workflow_id: asString(obj.workflow_id),
        execution_id: asString(obj.execution_id),
        items: obj.items,
      };
    }
    if (typeof obj.external_id === "string") {
      return {
        ok: true,
        workflow_id: asString(obj.workflow_id),
        execution_id: asString(obj.execution_id),
        items: [obj],
      };
    }
    return {
      ok: false,
      error: "Body must be a finding, an array of findings, or an object with an `items` array.",
    };
  }
  return { ok: false, error: "Body must be a JSON object or array." };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
