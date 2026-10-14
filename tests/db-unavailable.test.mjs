/**
 * Verifies the "database is unavailable" contract: the ingestion endpoint must
 * answer 503 (retryable) instead of 500, and must not pretend to have stored
 * anything.
 *
 * This needs a server process started with an UNREACHABLE DATABASE_URL, so it
 * is skipped unless BAD_DB_BASE_URL points at one. Reproduce with:
 *
 *   DATABASE_URL="postgresql://research:x@127.0.0.1:59999/research" \
 *     npx next start -p 3100 &
 *   BAD_DB_BASE_URL=http://localhost:3100 npm test
 *
 * (Start that server from a directory with its own .env, or export the bad URL
 * so it wins over .env.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const BAD_DB_BASE_URL = process.env.BAD_DB_BASE_URL;
const SECRET = process.env.N8N_WEBHOOK_SECRET ?? "irrelevant";

test(
  "returns 503 when the research database is unreachable",
  { skip: BAD_DB_BASE_URL ? false : "set BAD_DB_BASE_URL to a server with an unreachable DATABASE_URL" },
  async () => {
    const res = await fetch(`${BAD_DB_BASE_URL}/api/n8n/results`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-secret": SECRET },
      body: JSON.stringify({
        items: [
          {
            source: "hackernews",
            external_id: `test_oblivion_downtest_${Date.now()}`,
            title: "should never be stored",
          },
        ],
      }),
    });

    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /unavailable/i);
  },
);
