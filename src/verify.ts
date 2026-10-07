import { canonicalize, computeEnvelopeHash } from "./canonical.js";
import { verifyBytes } from "./keys.js";
import { isTimestamp, validateEnvelopeShape } from "./schema.js";
import type { Keyset, ReceiptEnvelope, VerifyResult } from "./types.js";

/**
 * Offline verification. Check order (first failure wins):
 * schema_invalid, envelope_hash_mismatch, canonical_mismatch, unknown_kid,
 * key_not_valid_at_issuedAt, bad_signature.
 */
export function verifyReceipt(envelope: unknown, keyset: Keyset): VerifyResult {
  const errs = validateEnvelopeShape(envelope);
  if (errs.length) return { ok: false, reason: "schema_invalid", detail: errs[0] };
  const env = envelope as ReceiptEnvelope;

  if (computeEnvelopeHash(env as unknown as Record<string, unknown>) !== env.envelopeHash)
    return { ok: false, reason: "envelope_hash_mismatch" };

  if (canonicalize(env.payload) !== env.canonical) return { ok: false, reason: "canonical_mismatch" };

  const key = keyset?.keys?.find((k) => k.kid === env.kid);
  if (!key) return { ok: false, reason: "unknown_kid", detail: env.kid };

  const issued = Date.parse(env.payload.issuedAt);
  const from = isTimestamp(key.validFrom) ? Date.parse(key.validFrom) : NaN;
  const to = key.validTo == null ? Infinity : isTimestamp(key.validTo) ? Date.parse(key.validTo) : NaN;
  if (Number.isNaN(from) || Number.isNaN(to) || issued < from || issued > to)
    return { ok: false, reason: "key_not_valid_at_issuedAt" };

  if (!verifyBytes(key.publicKey, Buffer.from(env.canonical, "utf8"), env.signature))
    return { ok: false, reason: "bad_signature" };

  return { ok: true, reason: "ok", payload: env.payload };
}
