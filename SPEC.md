# x402 Signed Receipt Specification, v1 (draft)

Status: draft, prototype. Key words MUST/SHOULD are as in RFC 2119.

A receipt is a signed statement, issued by the party that served an x402-protected resource, that a specific payment was settled. A third party can verify it offline using only the issuer's published public keys.

## 1. Payload

A JSON object with exactly these fields (unknown fields MUST be rejected):

| Field | Type | Rules |
|---|---|---|
| `version` | string | `"1"` |
| `receiptId` | string | 1-128 chars, unique per issuer (UUIDv7 recommended) |
| `payer` | string | CAIP-10 style account id: `namespace:reference:address` |
| `payee` | string | CAIP-10 style account id |
| `asset` | string | CAIP-19 asset id |
| `amount` | string | base-10 integer in asset base units, no sign, no leading zeros (`0` allowed) |
| `settlement.network` | string | CAIP-2 chain/ledger id |
| `settlement.reference` | string | tx hash or ledger update id |
| `settlement.settledAt` | string | RFC 3339 UTC, `YYYY-MM-DDTHH:MM:SS[.sss]Z` |
| `x402.resource` | string | URL of the resource that was paid for |
| `x402.paymentRequirementsHash` | string | `sha256:` + 64 lowercase hex over the JCS of the accepted x402 `PaymentRequirements` object |
| `issuer.id` | string | issuer identifier (typically an origin) |
| `issuer.kid` | string | key id used to sign; MUST equal `envelope.kid` |
| `issuedAt` | string | RFC 3339 UTC |

CAIP-10 note: the account part is widened to also allow `:` and `_` so ledger party ids such as Canton's `party::fingerprint` are representable. Amounts are strings to avoid IEEE-754 loss.

Example payload: see `vectors/valid-001.json`.

## 2. Canonicalisation

`canonical` is the RFC 8785 (JCS) serialisation of `payload`: lexicographic key order by UTF-16 code units, no insignificant whitespace, ES `JSON.stringify` string escaping, ES number serialisation. All payload values are strings or objects, so number edge cases do not arise in v1.

## 3. Signature

`signature = base64url( Ed25519.sign(privateKey, UTF8(canonical)) )` (RFC 8032, pure Ed25519, 64 bytes, unpadded base64url, 86 chars).

## 4. Envelope

```json
{
  "payload": { ... },
  "canonical": "<JCS string>",
  "signature": "<base64url>",
  "kid": "<key id>",
  "alg": "ed25519",
  "envelopeHash": "sha256:<hex>"
}
```

`envelopeHash = "sha256:" + hex(SHA-256(UTF8(JCS(envelope without envelopeHash))))`.

The signature covers only the payload bytes; the envelope hash additionally binds `canonical`, `signature`, `kid` and `alg`, so any edit to the stored file is detected. It is an integrity check, not authentication: an attacker can recompute it, which is why the signature check is still required. Receipts may be transported as a response body field or as the `X-402-Receipt` header (base64url of the envelope JSON).

## 5. Key discovery

Issuers publish `https://<issuer-origin>/.well-known/x402-receipt-keys.json`:

```json
{ "keys": [
  { "kid": "key-2026-01", "publicKey": "<base64url raw 32-byte Ed25519>", "validFrom": "2026-01-01T00:00:00Z", "validTo": null }
] }
```

`validTo` may be `null` or absent for an open-ended key. A key is valid for a receipt when `validFrom <= payload.issuedAt <= validTo`. Retired keys SHOULD remain listed, with `validTo` set, so old receipts keep verifying. Fetching MUST use https (localhost excepted) and SHOULD NOT follow redirects. Verifiers SHOULD cache or pin the keyset; verification itself needs no network.

## 6. Verification

Steps run in order; the first failure is returned as `{ ok: false, reason }`.

1. `schema_invalid`: envelope or payload shape/format wrong, `alg` not `ed25519`, unknown fields, or `payload.issuer.kid != kid`.
2. `envelope_hash_mismatch`: recomputed `envelopeHash` differs.
3. `canonical_mismatch`: `JCS(payload) != canonical`.
4. `unknown_kid`: `kid` not in keyset.
5. `key_not_valid_at_issuedAt`: `issuedAt` outside the key's validity window.
6. `bad_signature`: Ed25519 verification of `canonical` fails.

Success is `{ ok: true, reason: "ok" }`.

## 7. Verifier responsibilities beyond this spec

A valid receipt proves the issuer attests to the statement. A payer SHOULD also check that `paymentRequirementsHash`, `amount` and `payee` match what it agreed to pay (the example client does), and MAY check `settlement.reference` on-chain. Receipts do not prove the settlement happened unless the verifier trusts the issuer or checks the ledger.

## 8. Security considerations

- Issuer key compromise: rotate by adding a new kid and setting `validTo` on the old one; receipts issued after the compromise window cannot be distinguished by this version of the spec (no revocation list yet).
- `issuedAt` is issuer-asserted; key validity windows are only as strong as the issuer's clock honesty.
- Test keys in this repo are public and for tests only.

## 9. Test vectors

`vectors/` holds one valid receipt and negative cases covering every reason code. Conforming implementations MUST produce the listed reason for each.
