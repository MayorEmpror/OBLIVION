import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret authentication for the n8n ingestion endpoint.
 *
 * The secret lives only in the server environment (`N8N_WEBHOOK_SECRET`); it is
 * never sent to the browser and never has a `NEXT_PUBLIC_` counterpart. n8n
 * presents it either as `x-n8n-secret: <secret>` or as
 * `Authorization: Bearer <secret>`.
 */

const SECRET_HEADER = "x-n8n-secret";

/** Pull the presented secret out of the request headers, if any. */
export function extractPresentedSecret(req: Request): string | null {
  const direct = req.headers.get(SECRET_HEADER);
  if (direct && direct.trim() !== "") return direct.trim();

  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice("bearer ".length).trim();
    if (token !== "") return token;
  }
  return null;
}

export type SecretCheck = "ok" | "missing" | "invalid" | "not_configured";

/**
 * Constant-time comparison of the presented secret against the configured one.
 * Fails closed: if the server has no secret configured, nothing authenticates.
 */
export function checkWebhookSecret(presented: string | null): SecretCheck {
  const expected = process.env.N8N_WEBHOOK_SECRET;
  if (!expected) return "not_configured";
  if (!presented) return "missing";

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, and a length check leaks only
  // the length of the secret (not its contents), which is acceptable here.
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "ok" : "invalid";
}
