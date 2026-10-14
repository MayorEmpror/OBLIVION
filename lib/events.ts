import { EventEmitter } from "node:events";
import type { Finding } from "@/lib/types";

/**
 * In-process pub/sub bus that fans persisted findings out to connected SSE
 * clients.
 *
 * IMPORTANT ordering contract: a finding is published ONLY AFTER its row has
 * been committed to PostgreSQL. The database is the source of truth — if an
 * event is lost (nobody was listening, the process restarted) the data is still
 * there and the dashboard picks it up on its next load. Events are a
 * notification, never the storage.
 *
 * Scope: this is a single-process bus. It is exactly right for local
 * development (`next dev` is one Node process) and for a single long-lived Node
 * server. It does NOT fan out across multiple instances — see README
 * "Production / multi-instance" for the swap-in points (a managed pub/sub such
 * as Redis, Ably or Pusher, or a Postgres LISTEN/NOTIFY bridge).
 */

const globalForEvents = globalThis as unknown as { __oblivionBus?: EventEmitter };

function getBus(): EventEmitter {
  if (!globalForEvents.__oblivionBus) {
    const bus = new EventEmitter();
    // Each open dashboard tab adds a listener; don't warn at 10.
    bus.setMaxListeners(0);
    globalForEvents.__oblivionBus = bus;
  }
  return globalForEvents.__oblivionBus;
}

const FINDING_CHANNEL = "finding";

/** Publish a newly committed finding to every subscriber. */
export function publishFinding(finding: Finding): void {
  getBus().emit(FINDING_CHANNEL, finding);
}

/**
 * Subscribe to newly committed findings.
 * Returns an unsubscribe function — always call it on unmount / stream close so
 * listeners do not accumulate.
 */
export function subscribeToFindings(listener: (finding: Finding) => void): () => void {
  const bus = getBus();
  bus.on(FINDING_CHANNEL, listener);
  return () => {
    bus.off(FINDING_CHANNEL, listener);
  };
}

/** Number of live subscribers (used by tests and the SSE route's diagnostics). */
export function subscriberCount(): number {
  return getBus().listenerCount(FINDING_CHANNEL);
}
