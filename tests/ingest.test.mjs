/**
 * End-to-end tests for the n8n -> Next.js ingestion pipeline.
 *
 * They exercise the REAL stack: HTTP against a running Next.js server, the real
 * research PostgreSQL database, and a real SSE connection. Run with:
 *
 *   npm test
 *
 * (which is `node --env-file=.env --test tests/`, so DATABASE_URL and
 * N8N_WEBHOOK_SECRET come from .env). Point BASE_URL elsewhere if the server is
 * not on localhost:3000.
 *
 * Test rows use an `test_oblivion_*` external_id prefix and are deleted in the
 * teardown, so real research records are never touched.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.N8N_WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SECRET) throw new Error("N8N_WEBHOOK_SECRET is not set — run the suite via `npm test`.");
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set — run the suite via `npm test`.");

const RUN = Date.now().toString(36);
const externalId = (suffix) => `test_oblivion_${RUN}_${suffix}`;

let db;

before(async () => {
  db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
});

after(async () => {
  if (db) {
    // Only ever remove rows this run created.
    await db.query("delete from public.sources where external_id like $1", [`test_oblivion_${RUN}_%`]);
    await db.end();
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

function mockFinding(suffix, overrides = {}) {
  return {
    source: "hackernews",
    external_id: externalId(suffix),
    community: "HN",
    title: `Test finding ${suffix}`,
    body: "A body produced by a test, not by a real workflow.",
    url: `https://example.test/item/${suffix}`,
    author_hash: "test-author",
    created_at: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

function postResults(body, { secret = SECRET, raw = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers["x-n8n-secret"] = secret;
  return fetch(`${BASE_URL}/api/n8n/results`, {
    method: "POST",
    headers,
    body: raw ? body : JSON.stringify(body),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countRows(extId) {
  const { rows } = await db.query("select count(*)::int as n from public.sources where external_id = $1", [extId]);
  return rows[0].n;
}

// ── 1. happy path ───────────────────────────────────────────────────────────

test("a valid batch is accepted, persisted and returns record ids", async () => {
  const a = mockFinding("batch_a");
  const b = mockFinding("batch_b");

  const res = await postResults({
    workflow_id: "kxArCA8xEFniTAL6",
    execution_id: `exec_${RUN}`,
    items: [a, b],
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.received, 2);
  assert.equal(body.created, 2);
  assert.equal(body.duplicates, 0);
  assert.equal(body.failed, 0);
  for (const item of body.results) {
    assert.equal(item.status, "created");
    assert.equal(typeof item.id, "number");
  }

  // Persisted, with provenance recorded.
  const { rows } = await db.query(
    `select source, community, title, url, author_hash, created_at, workflow_id, execution_id, ingested_at
       from public.sources where external_id = $1`,
    [a.external_id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "hackernews");
  assert.equal(rows[0].community, "HN");
  assert.equal(rows[0].title, a.title);
  assert.equal(rows[0].url, a.url);
  assert.equal(rows[0].author_hash, "test-author");
  assert.equal(rows[0].created_at.toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(rows[0].workflow_id, "kxArCA8xEFniTAL6");
  assert.equal(rows[0].execution_id, `exec_${RUN}`);
  assert.ok(rows[0].ingested_at instanceof Date);
});

test("a bare array of findings is accepted", async () => {
  const res = await postResults([mockFinding("arr_a"), mockFinding("arr_b")]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 2);
});

test("a single finding object is accepted", async () => {
  const res = await postResults(mockFinding("single"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.received, 1);
  assert.equal(body.created, 1);
});

// ── 2. validation ───────────────────────────────────────────────────────────

test("malformed JSON is rejected with 400", async () => {
  const res = await postResults("{not json", { raw: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test("a payload with no findings is rejected with 400", async () => {
  const res = await postResults({ items: [] });
  assert.equal(res.status, 400);
});

test("findings missing required fields are rejected", async () => {
  const res = await postResults({ items: [{ source: "hackernews" }] });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.results[0].status, "error");
  assert.match(body.results[0].error, /external_id/);
});

test("an unparseable created_at is rejected per item", async () => {
  const res = await postResults({ items: [mockFinding("bad_date", { created_at: "not-a-date" })] });
  assert.equal(res.status, 422);
  assert.match((await res.json()).results[0].error, /ISO-8601/);
});

test("a partially valid batch stores the good rows and reports the bad one", async () => {
  const good = mockFinding("partial_ok");
  const res = await postResults({ items: [good, { source: "hackernews" }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 1);
  assert.equal(body.failed, 1);
  assert.equal(await countRows(good.external_id), 1);
});

// ── 3. authentication ───────────────────────────────────────────────────────

test("a request with no secret is rejected with 401", async () => {
  const res = await postResults(mockFinding("no_auth"), { secret: null });
  assert.equal(res.status, 401);
});

test("a request with the wrong secret is rejected with 403", async () => {
  const res = await postResults(mockFinding("bad_auth"), { secret: "definitely-not-the-secret" });
  assert.equal(res.status, 403);
});

test("the bearer-token form of the secret is accepted", async () => {
  const finding = mockFinding("bearer");
  const res = await fetch(`${BASE_URL}/api/n8n/results`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ items: [finding] }),
  });
  assert.equal(res.status, 200);
  assert.equal(await countRows(finding.external_id), 1);
});

// ── 4. idempotency ──────────────────────────────────────────────────────────

test("re-sending the same findings creates no duplicates and is reported as duplicate", async () => {
  const finding = mockFinding("idem");
  const payload = { workflow_id: "kxArCA8xEFniTAL6", execution_id: `exec_${RUN}`, items: [finding] };

  const first = await (await postResults(payload)).json();
  assert.equal(first.created, 1);

  const second = await (await postResults(payload)).json();
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(second.results[0].status, "duplicate");

  // Exactly one row, and the id is stable across both deliveries.
  assert.equal(await countRows(finding.external_id), 1);
  assert.equal(second.results[0].id, first.results[0].id);
});

test("a retry never overwrites an existing row", async () => {
  const finding = mockFinding("no_overwrite", { title: "Original title" });
  await postResults({ items: [finding] });

  // Same external_id, different content — must be ignored, not merged.
  await postResults({ items: [{ ...finding, title: "Mutated title" }] });

  const { rows } = await db.query("select title from public.sources where external_id = $1", [finding.external_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Original title");
});

// ── 5. reads ────────────────────────────────────────────────────────────────

test("GET /api/findings returns stored findings", async () => {
  const finding = mockFinding("readable");
  await postResults({ items: [finding] });

  const res = await fetch(`${BASE_URL}/api/findings?limit=200`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const match = body.findings.find((f) => f.external_id === finding.external_id);
  assert.ok(match, "the new finding should be present in the initial-load payload");
  assert.equal(typeof match.ingested_at, "string");
});

// ── 6. realtime ─────────────────────────────────────────────────────────────

function parseSseBlock(block) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (data === "") return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

async function openEventStream() {
  const controller = new AbortController();
  const res = await fetch(`${BASE_URL}/api/events`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseBlock(block);
          if (parsed) events.push(parsed);
        }
      }
    } catch {
      // aborted by close()
    }
  })();

  return {
    events,
    async waitFor(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = events.find(predicate);
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error(`timed out waiting for an SSE event (saw ${events.length})`);
    },
    close() {
      controller.abort();
    },
  };
}

test("a newly persisted finding is pushed over SSE", async () => {
  const stream = await openEventStream();
  try {
    // The server announces readiness on connect.
    await stream.waitFor((e) => e.event === "ready", 5000);

    const finding = mockFinding("live");
    const res = await postResults({ items: [finding] });
    assert.equal(res.status, 200);

    const event = await stream.waitFor(
      (e) => e.event === "finding" && e.data?.external_id === finding.external_id,
    );
    assert.equal(event.data.title, finding.title);
    assert.equal(event.data.community, "HN");
    assert.equal(typeof event.data.id, "number");
  } finally {
    stream.close();
  }
});

test("a duplicate delivery does NOT emit a realtime event", async () => {
  const finding = mockFinding("live_dup");
  await postResults({ items: [finding] }); // first delivery, before we subscribe

  const stream = await openEventStream();
  try {
    await stream.waitFor((e) => e.event === "ready", 5000);
    await postResults({ items: [finding] }); // duplicate
    await sleep(750); // give a (wrong) event time to arrive
    const spurious = stream.events.filter(
      (e) => e.event === "finding" && e.data?.external_id === finding.external_id,
    );
    assert.equal(spurious.length, 0);
  } finally {
    stream.close();
  }
});

test("the SSE stream unsubscribes when the client disconnects", async () => {
  const stream = await openEventStream();
  await stream.waitFor((e) => e.event === "ready", 5000);
  stream.close();
  // If the server leaked the listener this would keep growing; a fresh stream
  // still working afterwards is the observable signal that cleanup did not
  // break the bus.
  await sleep(200);
  const second = await openEventStream();
  try {
    await second.waitFor((e) => e.event === "ready", 5000);
  } finally {
    second.close();
  }
});
