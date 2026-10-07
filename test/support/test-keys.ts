// TEST-ONLY KEYS. Derived from public, fixed seed strings. Never use for real receipts.
import { createHash } from "node:crypto";
import { keysetEntry } from "../../src/keys.js";
import type { Keyset } from "../../src/types.js";

export const seed = (label: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(`x402-receipts TEST-ONLY seed: ${label}`).digest());

export const TEST_KID = "test-key-2026-01";
export const TEST_SEED = seed("primary");
export const OTHER_SEED = seed("attacker");
export const EXPIRED_KID = "test-key-2025-expired";
export const EXPIRED_SEED = seed("expired");

export const testKeyset = (): Keyset => ({
  keys: [
    keysetEntry(TEST_SEED, TEST_KID, "2026-01-01T00:00:00Z", null),
    keysetEntry(EXPIRED_SEED, EXPIRED_KID, "2025-01-01T00:00:00Z", "2025-12-31T23:59:59Z"),
  ],
});
