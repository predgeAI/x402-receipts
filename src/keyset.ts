import { isTimestamp } from "./schema.js";
import type { Keyset } from "./types.js";

export const WELL_KNOWN_PATH = "/.well-known/x402-receipt-keys.json";

export function parseKeyset(doc: unknown): Keyset {
  const keys = (doc as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new Error("keyset: missing keys array");
  for (const k of keys) {
    if (typeof k?.kid !== "string" || typeof k?.publicKey !== "string" || !isTimestamp(k?.validFrom) ||
        !(k.validTo == null || isTimestamp(k.validTo)))
      throw new Error("keyset: malformed key entry");
    if (Buffer.from(k.publicKey, "base64url").length !== 32) throw new Error("keyset: publicKey must be 32 bytes");
  }
  return { keys };
}

/**
 * Fetch and validate a keyset. `url` may be an origin (the well-known path is appended)
 * or a full URL to the JSON document. https is required except for localhost.
 */
export async function fetchKeyset(url: string, opts: { timeoutMs?: number } = {}): Promise<Keyset> {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("keyset url must be https");
  if (!u.pathname.endsWith(".json")) u.pathname = u.pathname.replace(/\/$/, "") + WELL_KNOWN_PATH;
  const res = await fetch(u, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), redirect: "error" });
  if (!res.ok) throw new Error(`keyset fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 256 * 1024) throw new Error("keyset too large");
  return parseKeyset(JSON.parse(text));
}
