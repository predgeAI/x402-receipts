import { canonicalize, computeEnvelopeHash } from "./canonical.js";
import { signBytes, type SigningKey } from "./keys.js";
import { validatePayload } from "./schema.js";
import type { ReceiptEnvelope, ReceiptPayload } from "./types.js";

/** Sign a receipt payload. payload.issuer.kid must equal `kid`. Throws on invalid payload. */
export function issueReceipt(payload: ReceiptPayload, signingKey: SigningKey, kid: string): ReceiptEnvelope {
  const errs = validatePayload(payload);
  if (errs.length) throw new Error("invalid receipt payload: " + errs.join("; "));
  if (payload.issuer.kid !== kid) throw new Error("payload.issuer.kid must equal kid");
  const canonical = canonicalize(payload);
  const signature = signBytes(signingKey, Buffer.from(canonical, "utf8"));
  const body = { payload, canonical, signature, kid, alg: "ed25519" as const };
  return { ...body, envelopeHash: computeEnvelopeHash(body) };
}
