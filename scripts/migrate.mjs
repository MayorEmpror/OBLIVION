// Applies every `db/migrations/*.sql` file in filename order, exactly once,
// recording applied files in `public.schema_migrations`.
//
// The research database is managed with plain SQL (there is no ORM), so this is
// a deliberately small forward-only runner. Each migration runs in its own
// transaction; a failure rolls that migration back and stops the run.
//
//   npm run db:migrate
//
// Requires DATABASE_URL (loaded from .env via `node --env-file=.env`).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "db", "migrations");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set (expected in .env). Aborting.");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

await client.query(`
  create table if not exists public.schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  )
`);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
const { rows } = await client.query("select filename from public.schema_migrations");
const applied = new Set(rows.map((r) => r.filename));

let appliedCount = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip   ${file}`);
    continue;
  }
  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into public.schema_migrations (filename) values ($1)", [file]);
    await client.query("commit");
    appliedCount += 1;
    console.log(`apply  ${file}`);
  } catch (err) {
    await client.query("rollback");
    console.error(`FAILED ${file}: ${err.message}`);
    process.exitCode = 1;
    break;
  }
}

await client.end();
console.log(appliedCount === 0 ? "Nothing to apply." : `Applied ${appliedCount} migration(s).`);
