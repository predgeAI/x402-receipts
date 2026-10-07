import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { KeysetEntry } from "./types.js";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type SigningKey = KeyObject | Uint8Array;

/** Accepts a 32-byte ed25519 seed or a KeyObject. */
export function toPrivateKey(key: SigningKey): KeyObject {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new TypeError("ed25519 seed must be 32 bytes");
    return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, key]), format: "der", type: "pkcs8" });
  }
  return key;
}

export function publicKeyB64u(key: SigningKey): string {
  const jwk = createPublicKey(toPrivateKey(key)).export({ format: "jwk" });
  return jwk.x as string;
}

export function keysetEntry(key: SigningKey, kid: string, validFrom: string, validTo: string | null = null): KeysetEntry {
  return { kid, publicKey: publicKeyB64u(key), validFrom, validTo };
}

export function signBytes(key: SigningKey, data: Uint8Array): string {
  return sign(null, data, toPrivateKey(key)).toString("base64url");
}

export function verifyBytes(publicKeyB64urStr: string, data: Uint8Array, sigB64u: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64urStr, "base64url");
    if (raw.length !== 32) return false;
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, data, pub, Buffer.from(sigB64u, "base64url"));
  } catch {
    return false;
  }
}
