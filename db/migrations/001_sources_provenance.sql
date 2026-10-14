-- 001_sources_provenance.sql
--
-- Adds provenance columns to public.sources so an ingested finding can be
-- traced back to the n8n workflow + execution that produced it.
--
-- Idempotent: safe to re-run, and it only ADDS nullable/defaulted columns —
-- existing rows and their data are preserved untouched.
--
-- Idempotency key for ingestion is the pre-existing UNIQUE constraint
-- `sources_external_id_key` on (external_id); no new unique constraint needed.

ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS workflow_id  text,
  ADD COLUMN IF NOT EXISTS execution_id text,
  ADD COLUMN IF NOT EXISTS ingested_at  timestamptz NOT NULL DEFAULT now();

-- The dashboard lists newest-first, and provenance lookups filter by workflow.
CREATE INDEX IF NOT EXISTS sources_ingested_at_idx ON public.sources (ingested_at DESC);
CREATE INDEX IF NOT EXISTS sources_workflow_id_idx ON public.sources (workflow_id);
