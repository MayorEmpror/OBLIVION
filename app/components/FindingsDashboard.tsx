"use client";

import { useEffect, useState } from "react";
import { SSE_EVENT_FINDING, SSE_EVENT_READY, type Finding } from "@/lib/types";

type ConnectionState = "connecting" | "live" | "reconnecting";

const MAX_ROWS = 200;
const RECONCILE_LIMIT = 50;

export default function FindingsDashboard({
  initialFindings,
  loadError,
}: {
  initialFindings: Finding[];
  loadError: string | null;
}) {
  const [findings, setFindings] = useState<Finding[]>(() => initialFindings.slice(0, MAX_ROWS));
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  // ids that arrived over the live stream (as opposed to the initial DB load)
  const [liveIds, setLiveIds] = useState<number[]>([]);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;

    const applyIncoming = (incoming: Finding[]) => {
      setFindings((current) => {
        let next = current;
        for (const finding of incoming) next = mergeFinding(next, finding);
        return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
      });
    };

    /**
     * Re-read the database and merge the result in.
     *
     * Runs on connect and after every reconnect — NOT on a timer. SSE gives no
     * replay guarantee, so anything committed while we were disconnected is
     * picked up here. The database, not the event stream, is the source of truth.
     */
    const reconcile = async () => {
      try {
        const res = await fetch(`/api/findings?limit=${RECONCILE_LIMIT}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { findings?: Finding[] };
        if (disposed || !Array.isArray(body.findings)) return;
        applyIncoming(body.findings);
      } catch {
        // Transient failure — EventSource retries and we reconcile again.
      }
    };

    source = new EventSource("/api/events");

    source.addEventListener("open", () => {
      if (!disposed) setConnection("live");
    });

    source.addEventListener(SSE_EVENT_READY, () => {
      if (disposed) return;
      setConnection("live");
      void reconcile();
    });

    source.addEventListener(SSE_EVENT_FINDING, (event) => {
      if (disposed) return;
      let finding: Finding;
      try {
        finding = JSON.parse((event as MessageEvent).data) as Finding;
      } catch {
        return;
      }
      applyIncoming([finding]);
      setLiveIds((prev) => (prev.includes(finding.id) ? prev : [finding.id, ...prev].slice(0, MAX_ROWS)));
    });

    source.addEventListener("error", () => {
      // EventSource reconnects by itself; reflect that in the UI.
      if (!disposed) setConnection("reconnecting");
    });

    return () => {
      disposed = true;
      source?.close(); // clean unsubscribe: closes the HTTP stream, server drops its listener
      source = null;
    };
  }, []);

  return (
    <main className="mx-auto w-full max-w-6xl p-6 font-sans sm:p-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">OBLIVION</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Live findings ingested from n8n
          </p>
        </div>
        <ConnectionBadge state={connection} count={findings.length} />
      </header>

      {loadError ? (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Could not load existing findings from PostgreSQL.</strong>
          <div className="mt-1 font-mono text-xs">{loadError}</div>
          <div className="mt-1">Live updates will still appear if the database recovers.</div>
        </div>
      ) : null}

      {findings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500 dark:border-gray-700">
          No findings yet. Run the n8n workflow to ingest some.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 font-medium">Community</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Author</th>
                <th className="px-3 py-2 font-medium">Created (UTC)</th>
                <th className="px-3 py-2 font-medium">Ingested (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => {
                const isLive = liveIds.includes(finding.id);
                return (
                  <tr
                    key={finding.id}
                    className={`border-t border-gray-200 align-top dark:border-gray-800 ${
                      isLive ? "bg-emerald-50/70 dark:bg-emerald-950/40" : ""
                    }`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {finding.community ?? "—"}
                      {isLive ? (
                        <span className="ml-2 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">
                          live
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {finding.url ? (
                        <a
                          href={finding.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400"
                        >
                          {finding.title || finding.url}
                        </a>
                      ) : (
                        finding.title || "—"
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-400">
                      {finding.source ?? "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-gray-600 dark:text-gray-400">
                      {finding.author_hash || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-gray-600 dark:text-gray-400">
                      {formatUtc(finding.created_at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-gray-600 dark:text-gray-400">
                      {formatUtc(finding.ingested_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function ConnectionBadge({ state, count }: { state: ConnectionState; count: number }) {
  const styles: Record<ConnectionState, string> = {
    connecting: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    live: "bg-emerald-600 text-white",
    reconnecting: "bg-amber-500 text-white",
  };
  const label: Record<ConnectionState, string> = {
    connecting: "Connecting…",
    live: "Live",
    reconnecting: "Reconnecting…",
  };
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-gray-500 dark:text-gray-400">{count} rows</span>
      <span className={`rounded-full px-3 py-1 font-semibold ${styles[state]}`}>{label[state]}</span>
    </div>
  );
}

/**
 * Insert or update one finding, never duplicating a row.
 * Keyed on the surrogate `id`, with `external_id` as a secondary guard so a
 * record that arrives twice cannot produce two rows.
 */
function mergeFinding(list: Finding[], incoming: Finding): Finding[] {
  const index = list.findIndex((f) => f.id === incoming.id);
  if (index !== -1) {
    const existing = list[index];
    if (existing === incoming) return list;
    const next = list.slice();
    next[index] = { ...existing, ...incoming };
    return next;
  }
  if (list.some((f) => f.external_id === incoming.external_id)) return list;
  return [incoming, ...list];
}

/**
 * Deterministic UTC formatting — identical on the server and the client, so it
 * cannot cause a hydration mismatch.
 */
function formatUtc(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
