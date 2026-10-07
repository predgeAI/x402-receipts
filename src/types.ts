export interface ReceiptPayload {
  version: "1";
  receiptId: string;
  /** CAIP-10 style account id, e.g. "eip155:8453:0xabc..." */
  payer: string;
  payee: string;
  /** CAIP-19 asset id */
  asset: string;
  /** Decimal integer string in asset base units */
  amount: string;
  settlement: {
    /** CAIP-2 chain / ledger id */
    network: string;
    /** Transaction hash or ledger update id */
    reference: string;
    /** RFC 3339 UTC timestamp */
    settledAt: string;
  };
  x402: {
    resource: string;
    /** "sha256:" + lowercase hex of SHA-256 over the JCS of the accepted PaymentRequirements */
    paymentRequirementsHash: string;
  };
  issuer: { id: string; kid: string };
  /** RFC 3339 UTC timestamp */
  issuedAt: string;
}

export interface ReceiptEnvelope {
  payload: ReceiptPayload;
  /** JCS (RFC 8785) serialisation of payload */
  canonical: string;
  /** base64url, ed25519 over UTF-8 bytes of `canonical` */
  signature: string;
  kid: string;
  alg: "ed25519";
  /** "sha256:" + hex over JCS of the envelope without this field */
  envelopeHash: string;
}

export interface KeysetEntry {
  kid: string;
  /** base64url raw 32-byte ed25519 public key */
  publicKey: string;
  validFrom: string;
  /** null or absent means open-ended */
  validTo?: string | null;
}

export interface Keyset {
  keys: KeysetEntry[];
}

export type FailureReason =
  | "bad_signature"
  | "canonical_mismatch"
  | "envelope_hash_mismatch"
  | "unknown_kid"
  | "key_not_valid_at_issuedAt"
  | "schema_invalid";

export type VerifyResult =
  | { ok: true; reason: "ok"; payload: ReceiptPayload }
  | { ok: false; reason: FailureReason; detail?: string };
