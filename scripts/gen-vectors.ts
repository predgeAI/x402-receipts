// Regenerates vectors/. Ed25519 is deterministic, so output is stable. TEST-ONLY keys.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { canonicalize, computeEnvelopeHash, hashJson } from "../src/canonical.js";
import { issueReceipt } from "../src/issue.js";
import { signBytes } from "../src/keys.js";
import type { ReceiptEnvelope, ReceiptPayload } from "../src/types.js";
import { buildCantonReceiptPayload, updateByIdRequest } from "../src/canton.js";
import * as C from "../test/support/canton-fixtures.js";
import { EXPIRED_KID, EXPIRED_SEED, OTHER_SEED, TEST_KID, TEST_SEED, testKeyset } from "../test/support/test-keys.js";

const dir = new URL("../vectors/", import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const requirements = {
  scheme: "exact", network: "eip155:84532", amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", maxTimeoutSeconds: 60,
};
const base = (kid = TEST_KID, issuedAt = "2026-03-01T12:00:05Z"): ReceiptPayload => ({
  version: "1",
  receiptId: "0192f3a0-7b1e-7c3a-9d52-5a1c0e7b4f10",
  payer: "eip155:84532:0x857b06519E91e3A54538791bDbb0E22373e36b66",
  payee: "eip155:84532:0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  asset: "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  settlement: {
    network: "eip155:84532",
    reference: "0x1f4e9c0d5a7b8c2e3d4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f801",
    settledAt: "2026-03-01T12:00:03Z",
  },
  x402: { resource: "https://api.example.com/v1/weather", paymentRequirementsHash: hashJson(requirements) },
  issuer: { id: "https://api.example.com", kid },
  issuedAt,
});

const rehash = (e: Omit<ReceiptEnvelope, "envelopeHash">): ReceiptEnvelope =>
  ({ ...e, envelopeHash: computeEnvelopeHash(e as unknown as Record<string, unknown>) });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const write = (name: string, doc: unknown) =>
  writeFileSync(dir + name, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2) + "\n");

write("keyset.json", testKeyset());
write("README.md", "# Test vectors\n\nTEST-ONLY keys (seeds are public strings in test/support/test-keys.ts). Regenerate with `npm run vectors:gen`; run with `npm run vectors`.\n\nEach file: `{ description, expect: { ok, reason }, envelope }`. Verify against `keyset.json`.\n\nCanton vectors (`*-canton-*`) may also carry `ledger: { readAs, request, response }` and `expectLedger: { ok, reason }`: `request` is the exact body `checkAgainstLedger` must POST to `/v2/updates/update-by-id`, `response` is a hand-built JSON Ledger API v2 response (not captured from a node). Parties and update ids are fabricated test values. See docs/canton-profile.md.\n");

const valid = issueReceipt(base(), TEST_SEED, TEST_KID);
write("valid-001.json", { description: "Valid receipt, Base Sepolia USDC settlement", expect: { ok: true, reason: "ok" }, envelope: valid });

const neg: Array<[string, string, string, unknown]> = [];
const add = (name: string, reason: string, description: string, envelope: unknown) => neg.push([name, reason, description, envelope]);

// bad_signature: payload edited AND canonical + hash recomputed by an attacker who lacks the key.
{
  const p = base(); p.amount = "1";
  const e = clone(valid); e.payload = p; e.canonical = canonicalize(p);
  add("neg-bad-signature-forged-payload", "bad_signature", "Payload, canonical and envelopeHash all rewritten consistently, signature left stale", rehash(e));
}
{
  const e = clone(valid); e.signature = signBytes(OTHER_SEED, Buffer.from(valid.canonical));
  add("neg-bad-signature-wrong-key", "bad_signature", "Signature produced by a different key under the trusted kid", rehash(e));
}
// canonical_mismatch: payload mutated, canonical untouched, hash recomputed.
{
  const e = clone(valid); e.payload.amount = "999999999";
  add("neg-canonical-mismatch-mutated-payload", "canonical_mismatch", "payload.amount mutated; canonical string untouched; envelopeHash recomputed", rehash(e));
}
{
  const e = clone(valid); e.canonical = JSON.stringify(valid.payload, null, 2);
  add("neg-canonical-mismatch-not-jcs", "canonical_mismatch", "canonical is valid JSON of the same payload but not JCS (pretty-printed)", rehash(e));
}
// envelope_hash_mismatch
{
  const e = clone(valid); e.payload.settlement.reference = "0xdeadbeef";
  add("neg-envelope-hash-mutated-payload", "envelope_hash_mismatch", "payload mutated without recomputing envelopeHash", e);
}
{
  const e = clone(valid); e.signature = e.signature.slice(0, -2) + (e.signature.endsWith("AA") ? "BB" : "AA");
  add("neg-envelope-hash-mutated-envelope-field", "envelope_hash_mismatch", "envelope.signature field mutated without recomputing envelopeHash", e);
}
// unknown_kid
{
  const k = "unlisted-key-2026";
  add("neg-unknown-kid", "unknown_kid", "Validly signed receipt whose kid is not in the keyset", issueReceipt(base(k), OTHER_SEED, k));
}
// key_not_valid_at_issuedAt
add("neg-key-not-valid-expired", "key_not_valid_at_issuedAt", "Signed with a key whose validTo precedes issuedAt", issueReceipt(base(EXPIRED_KID), EXPIRED_SEED, EXPIRED_KID));
add("neg-key-not-valid-before-validFrom", "key_not_valid_at_issuedAt", "issuedAt precedes the key's validFrom", issueReceipt(base(TEST_KID, "2025-06-01T00:00:00Z"), TEST_SEED, TEST_KID));
// schema_invalid
{
  const p: any = base(); delete p.settlement;
  const c = canonicalize(p);
  add("neg-schema-missing-field", "schema_invalid", "Correctly signed, hashed payload that lacks settlement", rehash({ payload: p, canonical: c, signature: signBytes(TEST_SEED, Buffer.from(c)), kid: TEST_KID, alg: "ed25519" }));
}
{
  const p = base(); p.amount = "1.5";
  const c = canonicalize(p);
  add("neg-schema-bad-amount", "schema_invalid", "amount is not a base-unit integer string", rehash({ payload: p, canonical: c, signature: signBytes(TEST_SEED, Buffer.from(c)), kid: TEST_KID, alg: "ed25519" }));
}
{
  const e: any = clone(valid); e.alg = "none";
  add("neg-schema-bad-alg", "schema_invalid", "alg other than ed25519", rehash(e));
}

// ---- Canton profile (docs/canton-profile.md). Level 1 = offline verify, Level 2 = ledger cross-check.
const cantonPayload = (kid = TEST_KID) => buildCantonReceiptPayload({
  requirements: C.requirements, settle: C.settle, resource: "https://api.example.com/v1/weather",
  receiptId: "0192f3a0-7b1e-7c3a-9d52-5a1c0e7b4f20", issuer: { id: "https://api.example.com", kid },
  settledAt: C.RECORD_TIME, issuedAt: "2026-10-16T09:00:04Z",
});
const ledger = (readAs: string, response: unknown) =>
  ({ readAs, request: updateByIdRequest(C.UPDATE_ID, readAs), response });
const cantonValid = issueReceipt(cantonPayload(), TEST_SEED, TEST_KID);
const cantonVectors: Array<[string, string, unknown, unknown, unknown?, unknown?]> = [];
cantonVectors.push(["valid-canton-001", "Valid Canton receipt (exact scheme, 0.1 CC on canton:devnet); payee-side ledger view confirms payee, amount, instrument",
  { ok: true, reason: "ok" }, cantonValid, ledger(C.PAYEE, C.payeeView()), { ok: true, reason: "ok" }]);
cantonVectors.push(["valid-canton-002-payer-view", "Same receipt checked from the payer's participant: the TransferFactory_Transfer exercise confirms payer too",
  { ok: true, reason: "ok" }, cantonValid, ledger(C.PAYER, C.payerView()), { ok: true, reason: "ok" }]);
{
  const p = cantonPayload(); p.amount = "100000000000"; // 10 CC instead of 0.1
  const e = clone(cantonValid); e.payload = p; e.canonical = canonicalize(p);
  cantonVectors.push(["neg-canton-tampered-amount", "amount raised from 0.1 to 10 CC; canonical and envelopeHash recomputed, signature stale. Ledger also disagrees",
    { ok: false, reason: "bad_signature" }, rehash(e), ledger(C.PAYEE, C.payeeView()), { ok: false, reason: "amount_mismatch" }]);
}
{
  // The issuer itself signs a receipt naming the wrong payee: Level 1 passes, only the ledger check catches it.
  const p = cantonPayload(); p.payee = `${C.NETWORK}:${encodeURIComponent(C.OTHER)}`;
  cantonVectors.push(["neg-canton-wrong-party", "Correctly signed receipt naming a payee that did not receive the funds: offline check passes, ledger check fails",
    { ok: true, reason: "ok" }, issueReceipt(p, TEST_SEED, TEST_KID), ledger(C.PAYER, C.payerView()), { ok: false, reason: "payee_mismatch" }]);
}
{
  const k = "unlisted-key-2026";
  cantonVectors.push(["neg-canton-unknown-kid", "Canton receipt signed under a kid that is not in the keyset",
    { ok: false, reason: "unknown_kid" }, issueReceipt(cantonPayload(k), OTHER_SEED, k)]);
}
for (const [name, description, expect, envelope, led, expectLedger] of cantonVectors)
  write(name + ".json", led ? { description, expect, envelope, ledger: led, expectLedger } : { description, expect, envelope });

for (const [name, reason, description, envelope] of neg)
  write(name + ".json", { description, expect: { ok: false, reason }, envelope });
console.log(`wrote ${neg.length + 1 + cantonVectors.length} vectors to vectors/`);
