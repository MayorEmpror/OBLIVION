/**
 * Wire-format types shared by the ingestion API, the SSE stream and the
 * dashboard. Timestamps are ISO-8601 strings here so the same shape can travel
 * through JSON without date-reviving surprises.
 */

/** A finding as stored in `public.sources`, serialised for transport. */
export type Finding = {
  id: number;
  source: string | null;
  external_id: string;
  community: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  author_hash: string | null;
  created_at: string | null;
  processed: boolean | null;
  workflow_id: string | null;
  execution_id: string | null;
  ingested_at: string | null;
};

/** Server-sent event names used by /api/events. */
export const SSE_EVENT_FINDING = "finding";
export const SSE_EVENT_READY = "ready";
export const SSE_EVENT_PING = "ping";
