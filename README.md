# x402-receipts

Open-source prototype: signed, offline-verifiable receipts for [x402](https://x402.org) payments. Chain-agnostic TypeScript library, spec and test vectors. Apache-2.0 licensed. Status: prototype, not audited. M1 done; M2a (Canton profile + ledger cross-check) done; M2b (Daml on-ledger receipt record) compiled, tested and run on a local Canton sandbox.

## Why receipts matter

x402 settles a payment, but the payer is usually left with an HTTP 200 and the gateway's word that it happened. A signed receipt changes this: the recipient (or an auditor, accountant, or another agent) can verify who paid whom, how much, for what resource, and where it settled, using only the issuer's public key. No call to the gateway, no trust in the gateway's logs at audit time, and any edit to the stored file is detected. Receipts use CAIP identifiers so the same format covers EVM chains and Canton (see the [Canton profile](docs/canton-profile.md)).

## 30-minute quickstart

Requires Node 20+.

```bash
git clone https://github.com/predgeAI/x402-receipts && cd x402-receipts
npm install                 # ~85 packages, dev-only (express, tsx, typescript)
npm test                    # 42 tests, includes all vectors, the Canton profile and the express example
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

Canton (x402 `exact` scheme, facilitator `SettlementResponse` with an `updateId`):

```ts
import { buildCantonReceiptPayload, issueReceipt, verifyReceipt, checkAgainstLedger } from "x402-receipts";

// issuer: turn the facilitator's settle response into a signed receipt
const payload = buildCantonReceiptPayload({ requirements, settle, resource, receiptId, issuer, settledAt, issuedAt });
const envelope = issueReceipt(payload, signingSeed, issuer.kid);

// payee or payer: Level 1 offline, then Level 2 against your own participant's JSON Ledger API
verifyReceipt(envelope, keyset);
const r = await checkAgainstLedger(envelope, fetch, { ledgerUrl: "http://localhost:7575", readAs: myParty, token });
// r.reason: ok | payee_mismatch | payer_mismatch | amount_mismatch | asset_mismatch | update_not_found | ...
```

Field mapping, the exact JSON API request, what each party can prove under Canton privacy, and the assumptions not yet tested on a live node: [docs/canton-profile.md](docs/canton-profile.md).

On-ledger record (Daml SDK 3.6, needs `dpm` and JDK 17+; see [section 5 of the Canton profile](docs/canton-profile.md#5-on-ledger-receipt-record-m2b)):

```bash
cd daml && dpm build --all && (cd x402-receipt-test && dpm test)   # 6 Daml Script tests
dpm sandbox --json-api-port 7575                                    # terminal 1: local participant
npm run canton:demo                                                 # terminal 2: record + read back + acknowledge
```

Layout: `src/` library (`src/canton.ts` for Canton), `docs/` profiles, `vectors/` conformance vectors (`npm run vectors:gen` regenerates), `examples/x402-express/` server and client, `test/` node:test suites, `daml/` the Daml package and its Daml Script tests, `docs/runs/` captured test and sandbox output.

## Design notes

- Ed25519 via `node:crypto`; RFC 8785 JCS implemented in about 25 lines; zero runtime dependencies.
- Signature covers the canonical payload; `envelopeHash` covers the whole envelope, so file tampering is caught even outside the payload.
- All keys in this repo's tests, vectors and example are TEST-ONLY, derived from public seed strings. Never use them in production.

## Roadmap

- M1 (done): spec, library, vectors, express example.
- M2a (done): Canton profile. Receipt fields for the x402 exact-Canton scheme (`settlement.reference` = ledger `updateId`, party ids, CIP-56 instrument ids), a builder from the facilitator's settle response, and `checkAgainstLedger`, which cross-checks payer, payee, amount and asset against the verifier's own participant via the JSON Ledger API v2.
- M2b (partly done): Daml `ReceiptRecord` template (signatory issuer, observer payer; payer `Acknowledge` co-signs; no custody of funds) recorded in a follow-up transaction that references the settlement `updateId`. Done: compiles on Daml SDK 3.6.0, 6 Daml Script tests pass, and a run on a local Canton 3.6.1 sandbox through the JSON Ledger API v2 (create, payer and outsider views, acknowledge, Level 2 call), with the captured log in `docs/runs/`. The live run found and fixed a `checkAgainstLedger` bug (participants without the token-standard package returned `PACKAGE_NAMES_NOT_FOUND`, misreported as `update_not_found`). Not done yet: a LocalNet/DevNet run with a real Canton Coin transfer, so Level 2 has still only been tested positive against mocked responses, and update ids that others can check.
- M3: SDK polish and integration guide (packaging, more languages for verification, key-rotation and revocation guidance).
- M4 (planned): p402 adapter.

## Support development

This repo is open source (Apache-2.0) and maintained by a solo developer as part of Predge. If it is useful to you, you can support its development with a crypto donation. Donations cover RPC and hosting costs, test vectors and ongoing maintenance of the open-source tools. A donation does not buy a service, a token or any special treatment.

- EVM (Base preferred; the same address works on Arbitrum and Arc): `0x9084f5000E07C7133D6dA5eE4f271AB6D1821144`
- Solana: `9dxMRRtC7RKZH5rFZpUywjmnQ87H9qHhtW43u5LYmpV`

These are the same addresses Predge already uses to receive x402 payments. Send USDC or the network's native token only. You can also fund the repo through [Drips](https://www.drips.network/app/projects/github/predgeAI/x402-receipts). All options are listed on the [support page](https://predgeai.github.io/erc8004-outcome-validator/support/).

## License

Apache-2.0, see [LICENSE](LICENSE).
