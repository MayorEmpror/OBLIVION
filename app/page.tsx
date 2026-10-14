import FindingsDashboard from "@/app/components/FindingsDashboard";
import { listRecentFindings } from "@/lib/sources";
import type { Finding } from "@/lib/types";

/**
 * The dashboard.
 *
 * Rendered per request (`force-dynamic`) so the initial rows always come fresh
 * from PostgreSQL — the page works even before the SSE stream connects, and
 * works at all if the browser has no EventSource. Live updates are layered on
 * top by the client component.
 */

export const dynamic = "force-dynamic";

export default async function Home() {
  let initialFindings: Finding[] = [];
  let loadError: string | null = null;

  try {
    initialFindings = await listRecentFindings(50);
  } catch (err) {
    // A dead database must not blank the page: render the shell plus the error
    // so the operator can see what is wrong.
    loadError = err instanceof Error ? err.message : String(err);
  }

  return <FindingsDashboard initialFindings={initialFindings} loadError={loadError} />;
}
