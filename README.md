# x402-receipts

Open-source prototype: signed, offline-verifiable receipts for [x402](https://x402.org) payments. Chain-agnostic TypeScript library, spec and test vectors. MIT licensed. Status: M1 prototype, not audited.

## Why receipts matter

x402 settles a payment, but the payer is usually left with an HTTP 200 and the gateway's word that it happened. A signed receipt changes this: the recipient (or an auditor, accountant, or another agent) can verify who paid whom, how much, for what resource, and where it settled, using only the issuer's public key. No call to the gateway, no trust in the gateway's logs at audit time, and any edit to the stored file is detected. Receipts use CAIP identifiers so the same format covers EVM chains today and other ledgers (Canton planned) tomorrow.

## 30-minute quickstart

Requires Node 20+.

```bash
git clone https://github.com/predgeAI/x402-receipts && cd x402-receipts
npm install                 # ~85 packages, dev-only (express, tsx, typescript)
npm test                    # 21 tests, includes all vectors and the express example
npm run vectors             # human-readable vector report
```

Run the example (two terminals):

```bash
npm run example:server      # 402 server with mocked settlement, http://localhost:4021/weather
npm run example:client      # pays (mock), gets receipt, verifies it offline
```

Use the library:

```ts
import { issueReceipt, verifyReceipt, fetchKeyset, hashJson } from "x402-receipts";

// issuer side
const envelope = issueReceipt(payload, signingSeed /* 32-byte seed or KeyObject */, "key-2026-01");

// verifier side (keyset fetched once, then cached; verification is offline)
const keyset = await fetchKeyset("https://api.example.com"); // /.well-known/x402-receipt-keys.json
const r = verifyReceipt(envelope, keyset);
if (!r.ok) console.error(r.reason); // bad_signature | canonical_mismatch | envelope_hash_mismatch | unknown_kid | key_not_valid_at_issuedAt | schema_invalid
```

Walk-through: read [SPEC.md](SPEC.md) (10 min), run the example and read `examples/x402-express/*.ts` (10 min), open `vectors/` and flip a byte in `valid-001.json` to watch the reason code change (10 min).

Layout: `src/` library, `vectors/` conformance vectors (`npm run vectors:gen` regenerates), `examples/x402-express/` server and client, `test/` node:test suites.

## Design notes

- Ed25519 via `node:crypto`; RFC 8785 JCS implemented in about 25 lines; zero runtime dependencies.
- Signature covers the canonical payload; `envelopeHash` covers the whole envelope, so file tampering is caught even outside the payload.
- All keys in this repo's tests, vectors and example are TEST-ONLY, derived from public seed strings. Never use them in production.

## Roadmap

- M1 (this repo): spec, library, vectors, express example.
- M2: Daml template on Canton that records and validates receipts on-ledger, with ledger update ids as `settlement.reference`.
- M3: SDK polish and integration guide (packaging, more languages for verification, key-rotation and revocation guidance).
- M4: p402 adapter.

## Support development

This repo is open source (MIT) and maintained by a solo developer as part of Predge. If it is useful to you, you can support its development with a crypto donation. Donations cover RPC and hosting costs, test vectors and ongoing maintenance of the open-source tools. A donation does not buy a service, a token or any special treatment.

- EVM (Base preferred; the same address works on Arbitrum and Arc): `0x9084f5000E07C7133D6dA5eE4f271AB6D1821144`
- Solana: `9dxMRRtC7RKZH5rFZpUywjmnQ87H9qHhtW43u5LYmpV`

These are the same addresses Predge already uses to receive x402 payments. Send USDC or the network's native token only. You can also fund the repo through [Drips](https://www.drips.network/app/projects/github/predgeAI/x402-receipts). All options are listed on the [support page](https://predgeai.github.io/erc8004-outcome-validator/support/).

## License

MIT, see [LICENSE](LICENSE).
