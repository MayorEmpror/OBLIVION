import type { PoolClient, QueryResultRow } from "pg";
import { query } from "@/lib/db";
import type { Finding } from "@/lib/types";

/**
 * Data access for `public.sources` — the table the n8n "Collect HN" workflow
 * writes into. Column list is centralised so every read returns the same shape.
 */

/** Column list, kept in the table's physical order. */
export const FINDING_COLUMNS = [
  "id",
  "source",
  "external_id",
  "community",
  "title",
  "body",
  "url",
  "author_hash",
  "created_at",
  "processed",
  "workflow_id",
  "execution_id",
  "ingested_at",
].join(", ");

/** A row straight out of PostgreSQL (timestamps arrive as JS Date). */
export type RawFindingRow = Omit<Finding, "created_at" | "ingested_at"> & {
  created_at: Date | string | null;
  ingested_at: Date | string | null;
};

type Row = RawFindingRow & QueryResultRow;

/** Normalise DB timestamps into ISO strings for JSON transport. */
export function serializeFinding(row: RawFindingRow): Finding {
  return {
    id: row.id,
    source: row.source,
    external_id: row.external_id,
    community: row.community,
    title: row.title,
    body: row.body,
    url: row.url,
    author_hash: row.author_hash,
    created_at: toIso(row.created_at),
    processed: row.processed,
    workflow_id: row.workflow_id,
    execution_id: row.execution_id,
    ingested_at: toIso(row.ingested_at),
  };
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A validated finding ready to be persisted. */
export type IngestItem = {
  source: string;
  external_id: string;
  community?: string | null;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  author_hash?: string | null;
  created_at?: string | null;
  workflow_id?: string | null;
  execution_id?: string | null;
};

export type IngestOutcome =
  | { status: "created"; external_id: string; finding: Finding }
  | { status: "duplicate"; external_id: string; finding: Finding };

/**
 * Insert one finding idempotently.
 *
 * Idempotency rests on the pre-existing UNIQUE constraint
 * `sources_external_id_key` on (external_id). `ON CONFLICT DO NOTHING` means an
 * existing row is never overwritten: a retried n8n delivery leaves the stored
 * record byte-for-byte as it was and is reported back as `duplicate`, so the
 * caller knows not to publish a realtime event for it.
 */
export async function insertFinding(
  client: PoolClient,
  item: IngestItem,
  provenance: { workflow_id: string | null; execution_id: string | null },
): Promise<IngestOutcome> {
  const inserted = await client.query<Row>(
    `insert into public.sources
       (source, external_id, community, title, body, url, author_hash,
        created_at, workflow_id, execution_id, ingested_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     on conflict (external_id) do nothing
     returning ${FINDING_COLUMNS}`,
    [
      item.source,
      item.external_id,
      item.community ?? null,
      item.title ?? null,
      item.body ?? null,
      item.url ?? null,
      item.author_hash ?? null,
      parseTimestamp(item.created_at),
      item.workflow_id ?? provenance.workflow_id,
      item.execution_id ?? provenance.execution_id,
    ],
  );

  const created = inserted.rows[0];
  if (created) {
    return { status: "created", external_id: item.external_id, finding: serializeFinding(created) };
  }

  // No row returned => the conflict clause fired => the row already existed.
  const existing = await client.query<Row>(
    `select ${FINDING_COLUMNS} from public.sources where external_id = $1`,
    [item.external_id],
  );
  return {
    status: "duplicate",
    external_id: item.external_id,
    finding: serializeFinding(existing.rows[0]),
  };
}

/** Newest findings first, for the dashboard's initial server-rendered load. */
export async function listRecentFindings(limit = 50): Promise<Finding[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const { rows } = await query<Row>(
    `select ${FINDING_COLUMNS}
       from public.sources
      order by ingested_at desc nulls last, id desc
      limit $1`,
    [safeLimit],
  );
  return rows.map(serializeFinding);
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
