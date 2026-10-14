/**
 * Sends a mock n8n-style payload to the ingestion endpoint.
 *
 * Use it to demo or test the pipeline without running a real workflow:
 *
 *   npm run db:seed-mock
 *   npm run db:seed-mock -- --count 5
 *   npm run db:seed-mock -- --url http://localhost:3000/api/n8n/results
 *
 * The payload matches exactly what the "Build ingestion payload" node in
 * `workflows/01 - Collect HN.json` produces. Rows are written with a
 * `test_oblivion_mock_*` external_id so they are easy to spot and delete.
 *
 * Reading from .env gives N8N_WEBHOOK_SECRET (required) and OBLIVION_INGEST_URL
 * (optional default target).
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const url = flag("url", "http://localhost:3000/api/n8n/results");
const count = Number(flag("count", "3"));
const secret = process.env.N8N_WEBHOOK_SECRET;

if (!secret) {
  console.error("N8N_WEBHOOK_SECRET is not set (expected in .env). Aborting.");
  process.exit(1);
}

const run = Date.now().toString(36);

const payload = {
  workflow_id: "kxArCA8xEFniTAL6",
  execution_id: `mock_${run}`,
  items: Array.from({ length: count }, (_, i) => ({
    source: "hackernews",
    external_id: `test_oblivion_mock_${run}_${i}`,
    community: "HN",
    title: `Mock finding ${i + 1} of ${count}`,
    body: "Synthetic finding sent by scripts/send-mock-results.mjs.",
    url: `https://news.ycombinator.com/item?id=mock${run}${i}`,
    author_hash: `mock-author-${i}`,
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
  })),
};

console.log(`POST ${url}  (${count} findings)`);

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-n8n-secret": secret },
  body: JSON.stringify(payload),
});

const body = await res.json().catch(() => null);
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(body, null, 2));

if (!res.ok) process.exit(1);
console.log(`\nOpen the dashboard to watch them arrive: http://localhost:3000`);
