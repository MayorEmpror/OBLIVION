import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

/**
 * Server-only PostgreSQL access.
 *
 * This is the single place the application talks to the research database.
 * It deliberately uses `node-postgres` with parameterised SQL rather than an
 * ORM: the existing `research` database was created and is written by raw SQL
 * (the n8n Postgres node inserts straight into `public.sources`), so raw SQL is
 * the project's actual convention and the schema stays owned by SQL migrations.
 *
 * `DATABASE_URL` is a server-only secret. It is never exposed to the browser
 * (there is no `NEXT_PUBLIC_` variant of it).
 */

const globalForDb = globalThis as unknown as { __oblivionPool?: Pool };

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and provide the research database URL.",
    );
  }
  return new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * Returns the process-wide connection pool.
 *
 * The pool is created lazily and cached on `globalThis` so that Next.js
 * re-evaluating modules during development does not leak a new pool (and its
 * connections) on every hot reload.
 */
export function getPool(): Pool {
  if (!globalForDb.__oblivionPool) {
    globalForDb.__oblivionPool = createPool();
  }
  return globalForDb.__oblivionPool;
}

/** Run a single parameterised query against the pool. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/**
 * Run `fn` inside a transaction on a dedicated connection.
 * Commits on success, rolls back on any thrown error, always releases the client.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; nothing useful to do but surface the
      // original error below.
    }
    throw err;
  } finally {
    client.release();
  }
}
