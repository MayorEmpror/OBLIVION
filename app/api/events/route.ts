import { subscribeToFindings } from "@/lib/events";
import { SSE_EVENT_FINDING, SSE_EVENT_READY, type Finding } from "@/lib/types";

/**
 * GET /api/events — Server-Sent Events stream of newly persisted findings.
 *
 * Why SSE and not WebSockets here: the dashboard only ever needs a one-way
 * server->client push, SSE rides on plain HTTP (no extra dependency, no custom
 * upgrade handling) and `EventSource` reconnects on its own. It runs on the
 * Node.js runtime so the request stays open, which is why this app is served by
 * a long-lived Node process (local `next dev` / `next start`) rather than
 * serverless functions. See README "Production / multi-instance".
 *
 * Contract:
 *  - Events carry the same shape as a row in `public.sources`.
 *  - `event: finding`  -> a finding that was just committed (id set for Last-Event-ID)
 *  - `event: ready`    -> stream is live; clients reconcile their state here
 *  - comment lines     -> keepalive, ignored by EventSource
 *  - The stream never writes to the database. It only forwards committed data.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keepalive cadence; comfortably below typical 60s proxy idle timeouts. */
const PING_INTERVAL_MS = 25_000;

export async function GET(req: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client vanished between the check and the enqueue.
          cleanup();
        }
      };

      const sendEvent = (event: string, data: unknown, id?: number) => {
        const lines = [`event: ${event}`];
        if (id !== undefined) lines.push(`id: ${id}`);
        lines.push(`data: ${JSON.stringify(data)}`);
        write(`${lines.join("\n")}\n\n`);
      };

      // Ask the browser to reconnect quickly, then announce readiness. Clients
      // treat `ready` as "re-sync from the database now": anything published
      // while we were disconnected is picked up here, which is how the app
      // stays correct without polling.
      write("retry: 2000\n\n");
      sendEvent(SSE_EVENT_READY, { at: new Date().toISOString() });

      const unsubscribe = subscribeToFindings((finding: Finding) => {
        sendEvent(SSE_EVENT_FINDING, finding, finding.id);
      });

      const ping = setInterval(() => write(`: keepalive ${Date.now()}\n\n`), PING_INTERVAL_MS);

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      }

      // The browser closing the tab (or navigating away) aborts the request;
      // drop the bus subscription and the timer so nothing leaks.
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell reverse proxies not to buffer, so events flush immediately.
      "x-accel-buffering": "no",
    },
  });
}
