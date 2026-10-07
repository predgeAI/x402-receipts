import { createHash } from "node:crypto";

/** RFC 8785 JSON Canonicalization Scheme. Throws on values JSON cannot represent. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value); // ES string serialisation == JCS string rules
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
      return Object.is(value, -0) ? "0" : String(value); // ES Number::toString == JCS
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
      const obj = value as Record<string, unknown>;
      // default sort compares UTF-16 code units, as RFC 8785 requires
      const keys = Object.keys(obj).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** "sha256:<hex>" over the JCS of any JSON value (used for paymentRequirementsHash). */
export function hashJson(value: unknown): string {
  return "sha256:" + sha256Hex(Buffer.from(canonicalize(value), "utf8"));
}

/** envelopeHash: sha256 over JCS of the envelope with `envelopeHash` removed. */
export function computeEnvelopeHash(envelope: Record<string, unknown>): string {
  const { envelopeHash: _omit, ...rest } = envelope;
  return hashJson(rest);
}
