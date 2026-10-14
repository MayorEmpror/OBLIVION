# OBLIVION

OBLIVION — An AI-powered market intelligence engine that discovers real-world problems across online communities, identifies recurring pain points, and uncovers promising SaaS opportunities through automated research and evidence-driven analysis.

---

## n8n → Next.js → PostgreSQL → realtime → dashboard

Workflow results are pushed from n8n into the app, persisted in the research
database, and surfaced on a live dashboard without a page reload and without
polling.

```
┌─────────────┐   POST /api/n8n/results   ┌──────────────────┐
│   n8n       │  x-n8n-secret: <secret>   │  Next.js         │
│  workflow   │ ────────────────────────► │  route handler   │
│ (Docker)    │                           │                  │
└─────────────┘                           └────────┬─────────┘
                                                   │ 1. INSERT ... ON CONFLICT
                                                   │    DO NOTHING (idempotent)
                                                   ▼
                                          ┌──────────────────┐
                                          │  PostgreSQL      │  ← source of truth
                                          │  public.sources  │
                                          └────────┬─────────┘
                                                   │ 2. only AFTER COMMIT
                                                   ▼
                                          ┌──────────────────┐
                                          │ in-process bus   │
                                          └────────┬─────────┘
                                                   │ 3. SSE
                                                   ▼
                                          ┌──────────────────┐
                                          │  dashboard       │  EventSource
                                          │  (app/page.tsx)  │
                                          └──────────────────┘
```

**Persist-before-publish.** A realtime event is emitted only after the row is
committed. If an event is lost, the database still holds the finding and the
dashboard picks it up on its next load or reconnect. Events are a notification;
PostgreSQL is the record.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 16 (App Router), TypeScript | existing |
| Database driver | `node-postgres` (`pg`), parameterised SQL | the `research` DB is created and written by raw SQL — the n8n Postgres node inserts straight into `public.sources`. No ORM, no second source of schema truth. |
| Migrations | plain `.sql` files + `scripts/migrate.mjs` | forward-only, idempotent, records applied files in `schema_migrations` |
| Validation | `zod` | schema validation for the ingest payload |
| Realtime | Server-Sent Events (`EventSource`) | one-way push, no extra dependency, automatic reconnect, no polling |

## Files

Created:

| Path | Purpose |
| --- | --- |
| `lib/db.ts` | pooled `pg` access (`query`, `withTransaction`) |
| `lib/types.ts` | wire types + SSE event names |
| `lib/sources.ts` | `public.sources` data access; idempotent `insertFinding` |
| `lib/ingest-schema.ts` | zod contract + payload normalisation |
| `lib/webhook-auth.ts` | constant-time shared-secret check |
| `lib/events.ts` | in-process pub/sub bus |
| `app/api/n8n/results/route.ts` | the ingestion endpoint |
| `app/api/events/route.ts` | SSE stream |
| `app/api/findings/route.ts` | recent findings (initial load + reconcile) |
| `app/components/FindingsDashboard.tsx` | client dashboard, `EventSource` subscriber |
| `db/migrations/001_sources_provenance.sql` | provenance columns + indexes |
| `scripts/migrate.mjs` | migration runner |
| `scripts/send-mock-results.mjs` | send a mock payload |
| `tests/ingest.test.mjs` | end-to-end pipeline tests |
| `tests/db-unavailable.test.mjs` | 503 contract when the DB is down |
| `.env.example` | env template |

Modified:

| Path | Change |
| --- | --- |
| `app/page.tsx` | was a placeholder; now the live dashboard (server-rendered initial rows) |
| `workflows/01 - Collect HN.json` | added "Build ingestion payload" + "POST findings to OBLIVION"; disabled the direct Postgres insert |
| `package.json` | dropped Prisma, added `pg` + `zod`; `db:migrate`, `db:seed-mock`, `test` scripts |
| `lib/db.ts` | Prisma client → `pg` pool |

Notable change outside this repo: `~/n8n/docker-compose.yml` gained the
`OBLIVION_INGEST_URL` and `N8N_WEBHOOK_SECRET` environment variables and an
`extra_hosts` entry (see [n8n configuration](#5-n8n-configuration)).

## Setup

### 1. Environment

```bash
cp .env.example .env
```

| Variable | Where it is read | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Next.js (server) | `postgresql://research:<password>@localhost:5432/research` |
| `N8N_WEBHOOK_SECRET` | Next.js (server) + n8n container | shared secret. **Never** prefix with `NEXT_PUBLIC_` |
| `OBLIVION_INGEST_URL` | n8n container only | e.g. `http://host.docker.internal:3000/api/n8n/results` |
| `PGPOOL_MAX` | Next.js (server), optional | connection pool size, default `10` |

Generate a secret with `openssl rand -hex 32`. `.env` is git-ignored; only
`.env.example` (placeholders) is committed.

### 2. Database migration

Adds `workflow_id`, `execution_id`, `ingested_at` and two indexes to
`public.sources`. Additive and idempotent — existing rows are untouched.

```bash
npm run db:migrate
```

The idempotency key is the pre-existing `sources_external_id_key` UNIQUE
constraint on `external_id`; no new constraint is needed.

### 3. Start the app

```bash
npm install
npm run dev            # http://localhost:3000
# or, for the long-lived Node server SSE needs:
npm run build && npm start
```

### 4. Start n8n

```bash
cd ~/n8n && docker compose up -d      # http://localhost:5678
```

### 5. n8n configuration

The workflow reads two values from the **n8n container's** environment, via
`$env` expressions:

```yaml
# ~/n8n/docker-compose.yml
services:
  n8n:
    environment:
      OBLIVION_INGEST_URL: "http://host.docker.internal:3000/api/n8n/results"
      N8N_WEBHOOK_SECRET: "<same value as the app's .env>"
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Networking, concretely:

| Where n8n runs | Where Next.js runs | URL to use |
| --- | --- | --- |
| Docker | macOS host (`npm run dev`) | `http://host.docker.internal:3000/api/n8n/results` |
| Docker | Docker, shared network | `http://<service-name>:3000/api/n8n/results` |
| Docker | Vercel / public host | `https://your-app.example.com/api/n8n/results` |

`localhost` inside the n8n container is the **container**, not your Mac — this
is the single most common cause of a silent integration failure. Verify it from
inside the container:

```bash
docker exec n8n nc -z -w3 host.docker.internal 3000 && echo REACHABLE
```

`extra_hosts` is a no-op on Docker Desktop (macOS/Windows resolve
`host.docker.internal` automatically) and makes the same name work on Linux.

If you would rather not put the secret in the container environment, create an
n8n **Header Auth** credential (`x-n8n-secret`) and select it on the HTTP
Request node instead of the `$env.N8N_WEBHOOK_SECRET` expression. n8n encrypts
credential data at rest, which is the stronger option in production.

### 6. Import the workflow

The repo copy is the source of truth:

```bash
docker cp "workflows/01 - Collect HN.json" n8n:/tmp/01-collect-hn.json
docker exec n8n n8n import:workflow --input=/tmp/01-collect-hn.json
```

Or in the n8n UI: **Workflows → Import from File**.

### 7. Run it

Open the workflow, click **Execute workflow**, then open
<http://localhost:3000>. New findings appear as they are committed, highlighted
with a `live` badge, with no page reload.

## API

### `POST /api/n8n/results`

Headers: `x-n8n-secret: <secret>` (or `Authorization: Bearer <secret>`).

Accepts any of:

```jsonc
// envelope (what the workflow sends)
{ "workflow_id": "...", "execution_id": "...", "items": [ { /* finding */ } ] }
// bare array
[ { /* finding */ } ]
// single finding
{ "source": "hackernews", "external_id": "hn_123" }
```

A finding maps 1:1 onto `public.sources`:

```jsonc
{
  "source":       "hackernews",                     // required
  "external_id":  "hn_123",                         // required — idempotency key
  "community":    "HN",
  "title":        "…",
  "body":         "…",
  "url":          "https://news.ycombinator.com/item?id=123",
  "author_hash":  "…",
  "created_at":   "2026-10-14T06:00:00.000Z",
  "workflow_id":  "…",                              // optional, per item
  "execution_id": "…"                               // optional, per item
}
```

Unknown keys are ignored — `sources` has no column for them.

Responses:

| Status | When |
| --- | --- |
| `200` | processed; body carries `created` / `duplicates` / `failed` and a per-item `results[]` |
| `400` | body is not JSON, or is not a finding / array / `{items:[]}` |
| `401` | secret missing |
| `403` | secret wrong |
| `413` | more than 500 findings in one request |
| `422` | every item failed validation |
| `500` | server error (including `N8N_WEBHOOK_SECRET` unset — fail closed) |
| `503` | database unreachable; safe to retry |

```jsonc
// 200
{
  "ok": true, "received": 2, "created": 1, "duplicates": 1, "failed": 0,
  "results": [
    { "external_id": "hn_1", "status": "created",   "id": 102 },
    { "external_id": "hn_2", "status": "duplicate", "id": 87  }
  ]
}
```

**Idempotency.** `INSERT … ON CONFLICT (external_id) DO NOTHING`. A retried
delivery creates nothing, overwrites nothing, and is reported as `duplicate` —
so no realtime event is emitted for it either.

**Batch semantics.** Malformed items are rejected individually and reported in
`results[]`; valid siblings are still stored. Database errors roll the whole
batch back, so a failed request never leaves a partial write.

### `GET /api/events`

`text/event-stream`. Events: `ready` (stream live — clients reconcile here),
`finding` (a committed row, with `id` for `Last-Event-ID`). Comment lines are
keepalives. The server drops its subscription when the client disconnects.

### `GET /api/findings?limit=50`

Most recent findings, newest first. Used for the server-rendered first paint and
to reconcile after an SSE reconnect. Read-only and secret-free; add your own
auth here if the dashboard becomes multi-tenant.

## Testing

```bash
npm test        # needs the app running and reachable at BASE_URL (default :3000)
```

Covers: valid batch / array / single-object ingestion, persistence and
provenance, malformed JSON, missing fields, unparseable `created_at`, partial
batches, missing and wrong secrets, bearer auth, duplicate suppression, no
overwrite on retry, the initial-load read, SSE delivery of a new finding, no
event for a duplicate, and stream cleanup.

The DB-down contract needs a second server started with an unreachable
`DATABASE_URL`:

```bash
DATABASE_URL="postgresql://research:x@127.0.0.1:59999/research" npx next start -p 3100 &
BAD_DB_BASE_URL=http://localhost:3100 npm test
```

### Watch it update live, by hand

With the app running, in one terminal:

```bash
curl -N -H 'accept: text/event-stream' http://localhost:3000/api/events
```

and in another:

```bash
npm run db:seed-mock -- --count 3
```

Three `event: finding` frames appear on the stream and three rows appear on
<http://localhost:3000> with no reload. Sending the same command twice with the
same ids would instead report `duplicate` and emit nothing.

Test rows use a `test_oblivion_*` `external_id`; the suite deletes them in
teardown and never touches real research records.

## Production / multi-instance

The realtime layer is an **in-process** event bus, which is correct for a single
long-lived Node process (`next dev`, `next start`, a container). Two things must
change before running more than one instance or on serverless:

1. **Fan-out.** Replace the `EventEmitter` inside `lib/events.ts` with a shared
   broker (Redis pub/sub, Ably, Pusher, Supabase Realtime) or a PostgreSQL
   `LISTEN`/`NOTIFY` bridge. Only `publishFinding` and `subscribeToFindings`
   need to change; nothing else knows how the bus is implemented.
2. **Long-lived connections.** SSE cannot run on an ordinary serverless
   function. Either host the app as a normal Node server, or move the stream to
   a managed realtime service and have `/api/events` issue client tokens.

Everything else is already stateless: the ingestion endpoint and the reads work
unchanged behind any number of replicas, because PostgreSQL is the source of
truth and the write is idempotent.
