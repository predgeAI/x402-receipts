# Canton profile for x402 receipts (M2a, M2b)

Status: draft, prototype (16 Oct 2026). Code: [`src/canton.ts`](../src/canton.ts). Vectors: `vectors/*canton*.json`.

This profile says how a v1 receipt ([SPEC.md](../SPEC.md)) describes an x402 payment settled on Canton with the `exact` scheme, and how the holder of a receipt checks it. It does not change the receipt format: a Canton receipt is a normal v1 receipt with Canton identifiers in it.

Live-node status (16 Oct 2026): the on-ledger record (M2b, [section 5](#5-on-ledger-receipt-record-m2b)) and the JSON Ledger API calls of `checkAgainstLedger` have been run against a local Canton 3.6.1 sandbox (single participant, in memory). The **positive** Level 2 path (confirming a real CIP-56 / Canton Coin transfer) has **not** been run on a live node yet, because a plain sandbox has no token-standard packages; those ledger responses in tests and vectors are still hand-built from the published OpenAPI schema. Every point where we had to infer behaviour is listed under [Assumptions and open questions](#assumptions-and-open-questions).

## Sources

| Topic | Source |
|---|---|
| x402 `exact` scheme on Canton (networks, `PaymentRequirements`, `SettlementResponse`, error codes) | [`specs/schemes/exact/scheme_exact_canton.md`](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md) in the x402 repo (read at commit `0e6e8c5`, 15 Oct 2026) |
| Facilitator, client SDK and middleware for that scheme | Canton Dev Fund [proposal #78](https://github.com/canton-foundation/canton-dev-fund/pull/78) ([proposal text](https://github.com/canton-foundation/canton-dev-fund/blob/main/proposals/2026-03-FTP-x402-protocol-integration.md)) and its reference types in [FTP-Tech-LLC/x402-canton-core](https://github.com/FTP-Tech-LLC/x402-canton-core/blob/main/packages/core/src/types.ts) |
| CAIP-2 / CAIP-10 / CAIP-19 for Canton | [ChainAgnostic/namespaces PR #201](https://github.com/ChainAgnostic/namespaces/pull/201) "Add Canton Namespace" (**open draft**, not merged) |
| JSON Ledger API v2, `POST /v2/updates/update-by-id` | [`openapi.yaml`](https://github.com/digital-asset/canton/blob/main/community/ledger/ledger-json-api/src/test/resources/json-api-docs/openapi.yaml) in digital-asset/canton (version `3.7.0-SNAPSHOT`, read 16 Oct 2026) |
| Party id format | [Canton core concepts, party identifier format](https://docs.canton.network/overview/understand/core-concepts) and [`Identifier.scala`](https://github.com/digital-asset/canton/blob/main/community/base/src/main/scala/com/digitalasset/canton/topology/Identifier.scala) (`UniqueIdentifier`) |
| CIP-56 `Transfer`, `TransferFactory_Transfer`, `Holding` view | [CIP-56](https://github.com/canton-foundation/cips/blob/main/cip-0056/cip-0056.md); Daml sources in [hyperledger-labs/splice `token-standard/`](https://github.com/hyperledger-labs/splice/tree/main/token-standard) (`TransferInstructionV1.daml`, `HoldingV1.daml`) |

## 1. What the payee gets today

In the exact-Canton scheme the client signs a CIP-56 `TransferFactory_Transfer` (sender = payer, receiver = merchant), the facilitator relays it and pays traffic, and the facilitator returns:

```json
{ "success": true, "payer": "agent_party::1220...", "transaction": "122038abc...", "network": "canton:mainnet" }
```

`transaction` is the Canton `updateId`. This response is unsigned, and a third party who is not a stakeholder of that transaction cannot look the `updateId` up, so it is not evidence anyone else can check. A receipt turns it into a signed, portable statement; the ledger check below lets a stakeholder confirm the statement against its own node.

## 2. Field mapping

`buildCantonReceiptPayload({ requirements, settle, resource, receiptId, issuer, settledAt, issuedAt })` produces the payload. Input: the `PaymentRequirements` the server advertised (and the payer accepted) plus the facilitator's `SettlementResponse`.

| Receipt field | Value | From |
|---|---|---|
| `settlement.network` | x402 network id, e.g. `canton:mainnet`, `canton:testnet`, `canton:devnet` | `requirements.network`; must equal `settle.network` when present |
| `settlement.reference` | the ledger `updateId` | `settle.transaction` |
| `settlement.settledAt` | ledger `recordTime` if the issuer read it, else the time the settle response arrived | issuer |
| `payer` | `<network>:<percent-encoded party id>` | `settle.payer` (the facilitator binds the payer from the signed transfer, scheme rule 8) |
| `payee` | `<network>:<percent-encoded party id>` | `requirements.payTo` |
| `asset` | `<network>/cip-56:<enc(admin)>.<enc(id)>` | `requirements.extra.instrumentId` (`{ admin: <DSO party>, id: "Amulet" }` for Canton Coin) |
| `amount` | atomic units, integer string; 1 CC = 10^10 | `requirements.amount` (the scheme requires the ledger amount to equal it exactly) |
| `x402.paymentRequirementsHash` | `sha256:` + hex over JCS of the requirements object | `requirements` |

Example (test values; see `vectors/valid-canton-001.json`):

```json
"payer": "canton:devnet:test-agent%3A%3A122069a7...f57b",
"payee": "canton:devnet:test-merchant%3A%3A1220b315...64d5",
"asset": "canton:devnet/cip-56:DSO%3A%3A12207412...f071.Amulet",
"amount": "1000000000",
"settlement": { "network": "canton:devnet", "reference": "122091ae...a1f5", "settledAt": "2026-10-16T09:00:03.120Z" }
```

### Identifier formats

- **Party id**: `<hint>::<namespace>`, e.g. `alice::1220f2fe...eb72`. Validated as: hint 1-185 chars of `[A-Za-z0-9:_- ]` without `::`; namespace 68 lowercase hex chars (the observed `1220` + SHA-256 form). Canton reserves 255 chars for the whole id.
- **Account id (payer/payee)**: the party id is percent-encoded (`::` becomes `%3A%3A`), following the CAIP-10 section of the Canton namespace draft. Parsers here also accept a raw `::` on input.
- **Asset id**: the CAIP-19 `cip-56` form from the same draft, which names the instrument by admin party and id. The draft also gives `<chain>/slip44:6767` for Canton Coin. We emit the `cip-56` form because it carries the admin party, so a ledger check needs no extra configuration. `slip44:6767` is accepted on input; checking it against a ledger needs the DSO party (`ccAdmin` option).
- **Network id**: see the open question on `canton:mainnet` vs `canton:mainnet-global` below. We use the value the x402 scheme and the facilitator use.
- **Update id**: lowercase hex. Observed values have the form `1220` + 64 hex; the validator accepts 8-255 lowercase hex chars.

`validateCantonPayload(p)` runs the generic schema check plus these rules, and requires payer, payee and asset to be on the same network as `settlement.network`.

## 3. Verifying a Canton receipt

### Level 1: offline signature check (anyone)

Exactly as in SPEC.md section 6: `verifyReceipt(envelope, keyset)`. No network access. It proves that the issuer signed these exact facts with a key valid at `issuedAt`. It does not prove the payment happened.

### Level 2: cross-check against your own participant (stakeholders only)

The payee (or payer) is a stakeholder of the settlement, so its own participant node can return the transaction. `checkAgainstLedger(receipt, fetchFn, { ledgerUrl, readAs, token?, expectedSynchronizerId?, ccAdmin?, requirePayer? })` sends:

```http
POST {ledgerUrl}/v2/updates/update-by-id
Content-Type: application/json
Authorization: Bearer <token>        (if the participant requires auth)
```

```json
{
  "updateId": "<settlement.reference>",
  "updateFormat": {
    "includeTransactions": {
      "eventFormat": {
        "filtersByParty": {
          "<readAs party id>": {
            "cumulative": [
              { "identifierFilter": { "WildcardFilter": { "value": { "includeCreatedEventBlob": false } } } },
              { "identifierFilter": { "InterfaceFilter": { "value": {
                  "interfaceId": "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
                  "includeInterfaceView": true, "includeCreatedEventBlob": false } } } }
            ]
          }
        },
        "verbose": true
      },
      "transactionShape": "TRANSACTION_SHAPE_LEDGER_EFFECTS"
    }
  }
}
```

The response is a `JsGetUpdateResponse`: `{ "update": { "Transaction": { "value": { updateId, effectiveAt, offset, synchronizerId, recordTime, events: [...] } } } }`, where each event is `{ "CreatedEvent": {...} }` or `{ "ExercisedEvent": {...} }` for the ledger-effects shape. If no update is visible to `readAs`, the API returns an `UPDATE_NOT_FOUND` error.

What must match:

| Check | Rule | Failure reason |
|---|---|---|
| Update | `value.updateId == settlement.reference` | `reference_mismatch` |
| Synchronizer (optional) | `value.synchronizerId == expectedSynchronizerId` | `synchronizer_mismatch` |
| Payer | `transfer.sender == payer party` | `payer_mismatch` |
| Payee | `transfer.receiver` (or the holding `owner`) `== payee party` | `payee_mismatch` |
| Amount | ledger `Decimal` x 10^10 `== amount` | `amount_mismatch` |
| Asset | `instrumentId.admin` and `instrumentId.id` equal the receipt's asset | `asset_mismatch` |
| Completed | if `exerciseResult.output.tag` is present it must be `TransferInstructionResult_Completed` | `transfer_not_completed` |

Two views are handled, because what a party can see differs:

- **Payer or facilitator view (`source: "transfer_exercise"`).** The payer is the controller of `TransferFactory_Transfer`, so it witnesses that `ExercisedEvent` (`choice: "TransferFactory_Transfer"`, `interfaceId` ending in `Splice.Api.Token.TransferInstructionV1:TransferFactory`). `choiceArgument.transfer` has `sender`, `receiver`, `amount`, `instrumentId`. All four fields are checked.
- **Payee view (`source: "holding_view"`).** The choice has no choice observers, so the receiver is not expected to witness the root exercise. It does see the holding created for it. Through the `Holding` interface filter that `CreatedEvent` carries an interface view `{ owner, instrumentId, amount, lock, meta }`. The check sums the holdings created for the payee in the receipt's instrument and compares the total with `amount`. The payer cannot be confirmed from this view and is reported as `not_visible`. Pass `requirePayer: true` to make that a failure (`payer_not_visible`).

Other reasons: `not_canton_receipt`, `update_not_found`, `ledger_error`, `not_a_transaction`, `no_transfer_visible`. The function never checks signatures, so run Level 1 first. `fetchFn` is injected so callers control TLS, timeouts and auth, and so tests run without a network.

### What each party can prove

| Who | Level 1 | Level 2 |
|---|---|---|
| Payee | yes | payee, amount, asset (payer only if its node also sees the exercise) |
| Payer | yes | payer, payee, amount, asset |
| Auditor or third party, not a stakeholder | yes | no: Canton privacy hides the transaction. It relies on the issuer's signature, or asks a stakeholder to run Level 2 |

This is the honest limit under Canton's privacy model. A receipt does not make a private transaction public.

## 4. Vectors

| File | Level 1 | Level 2 |
|---|---|---|
| `valid-canton-001.json` | `ok` | `ok` (payee view) |
| `valid-canton-002-payer-view.json` | `ok` | `ok` (payer view) |
| `neg-canton-tampered-amount.json` | `bad_signature` | `amount_mismatch` |
| `neg-canton-wrong-party.json` | `ok` (the issuer signed a false payee) | `payee_mismatch` |
| `neg-canton-unknown-kid.json` | `unknown_kid` | none |

Canton vectors carry `ledger: { readAs, request, response }` and `expectLedger`. `request` pins the exact body above; `npm run vectors` replays `response` through a mock fetch and checks both.

## Assumptions and open questions

1. **Network id.** The x402 scheme uses `canton:mainnet` / `canton:testnet` / `canton:devnet`. The CAIP namespace draft (PR #201) proposes `canton:mainnet-global` etc. We follow the x402 scheme, because that is what the facilitator returns and what the payer accepted. If the CAIP draft is merged as is, a mapping (or a receipt version bump) will be needed. We do not map network ids to synchronizer ids; pass `expectedSynchronizerId` (for example `requirements.extra.synchronizerId`) to pin one.
2. **Party encoding in account ids.** Percent-encoding follows the open CAIP draft. The x402 scheme itself uses raw party ids in `payTo`.
3. **JSON encoding of Daml values.** We assume `Decimal` is a string (`"0.1000000000"`) and variants are `{ "tag": ..., "value": ... }` (Daml-LF JSON encoding), with `verbose: true` giving labelled records. Labelled records, `Time` as RFC 3339 strings and `Text` fields confirmed on the 3.6.1 sandbox (section 5); `Decimal` and variants in token-standard events still to confirm.
4. **Payee visibility.** That the receiver does not witness the root `TransferFactory_Transfer` exercise is inferred from the interface (controller `transfer.sender`, no choice observers). The Amulet implementation may expose more to the receiver; the code uses the exercise whenever it is visible.
5. **Holding view amount for Amulet.** We assume the `Holding` view `amount` of a newly created Amulet equals the transferred amount (no holding fee has accrued in the creating transaction).
6. **Atomic units for other CIP-56 instruments.** The scheme defines 1 CC = 10^10 atomic units. We apply the same 10-decimal rule to any CIP-56 instrument, because token-standard amounts are Daml `Decimal`. The exact scheme currently settles Canton Coin only.
7. **Interface id format in filters.** The request uses the package-name reference (`#splice-api-token-holding-v1:...`); the OpenAPI notes that the package-id form is deprecated. Responses use package-id references, so matching is by suffix (confirmed on the 3.6.1 sandbox). A participant that has not uploaded `splice-api-token-holding-v1` rejects the whole request with `PACKAGE_NAMES_NOT_FOUND` (HTTP 404); `checkAgainstLedger` then retries once without the Holding filter, so the answer is about the update, not about the filter. Found on the live sandbox run; before that fix the error was misreported as `update_not_found`.
8. **Update id format.** Validation accepts lowercase hex only. If a participant returns another form, the validator is too strict and should be relaxed. Observed on the 3.6.1 sandbox: `1220` + 64 lowercase hex.

## 5. On-ledger receipt record (M2b)

Daml package [`daml/x402-receipt`](../daml/x402-receipt/daml/X402/Receipt.daml) (Daml SDK 3.6.0, Daml-LF 2), tests in [`daml/x402-receipt-test`](../daml/x402-receipt-test/daml/ReceiptTest.daml).

After settlement, the issuer (the x402 server's party, normally the payee) creates a `ReceiptRecord` in a **separate, follow-up transaction**. The record holds no funds and does not touch the payment; it puts the signed receipt on the ledger, visible only to its stakeholders.

| | |
|---|---|
| signatory | `issuer` |
| observer | `payer` |
| fields | `receiptId`, `payerAccount`, `payeeAccount` (CAIP-10, as signed), `asset` (CAIP-19), `amount` (Text, atomic units), `network`, `settlementUpdateId` (= `settlement.reference`), `settledAt`, `resource`, `paymentRequirementsHash`, `issuerId`, `kid`, `issuedAt`, and the envelope's `canonical`, `signature`, `envelopeHash` byte for byte |
| `ensure` | issuer differs from payer; amount is a decimal integer string without leading zeros; update id is lowercase hex; both hashes are `sha256:` + 64 hex; `receiptId`, `settlementUpdateId` and `amount` appear verbatim in the signed `canonical` text |
| choice `Acknowledge` | controller `payer`; archives the record and creates `AcknowledgedReceipt` (signatories issuer **and** payer): the payer's co-signature that it received the receipt. Moves no funds. |
| `Archive` | issuer only (standard); lets the issuer withdraw an unacknowledged record |

**Why `amount` is Text in atomic units, not `Decimal`.** The receipt is chain-agnostic and the signed value is an atomic-unit integer string. Daml `Decimal` is `Numeric 10` (10 fraction digits, 38 digits total): it cannot hold an 18-decimal EVM amount exactly, and converting would create a second representation of the amount that is not the signed one. Keeping the exact signed string lets anyone compare the field with `canonical` (the template already checks it is contained there) and re-verify the signature. For Canton Coin the conversion is `atomicToDecimal` (1 CC = 10^10).

**Uniqueness of (issuer, receiptId).** Daml 3 / Daml-LF 2 has no contract keys (the 3.6 sandbox offers experimental non-unique keys behind `--nuck`; we do not depend on it), so the ledger does **not** reject a second record with the same receiptId. A Daml Script test pins this behaviour. The issuer dedupes before submitting (the demo script queries its active contracts first and refuses a duplicate); readers treat (issuer, receiptId) as the identity and the oldest record as authoritative.

**What the ledger does not check.** Daml has no ed25519 builtin, so the signature is not verified on ledger; anyone holding the record re-runs Level 1 off ledger from `canonical`, `signature` and the issuer's keyset. The template does not tie the `payer` Party to the `payerAccount` string or `settlementUpdateId` to a real transfer; the issuer-side script checks the first, `checkAgainstLedger` (Level 2) checks the second.

**Tests.** `cd daml && dpm build --all && cd x402-receipt-test && dpm test` runs 6 Daml Script tests: create + payer sees it + outsider does not; only the issuer can create; `ensure` rejects fields that disagree with `canonical`; duplicate receiptId is not rejected by the ledger; payer acknowledges (issuer and outsider cannot); only the issuer can archive. Output: [`docs/runs/m2b-daml-script-tests-2026-10-16.txt`](runs/m2b-daml-script-tests-2026-10-16.txt).

**Sandbox run.** [`scripts/canton-localnet-demo.ts`](../scripts/canton-localnet-demo.ts) (`npm run canton:demo`) runs against a local participant's JSON Ledger API v2: uploads the DAR (`POST /v2/packages`), allocates parties, issues a receipt with the TEST-ONLY key (or takes `ENVELOPE=<file>`), verifies it (Level 1), dedupes, creates the `ReceiptRecord` (`POST /v2/commands/submit-and-wait`), reads it back as payer (`POST /v2/updates/update-by-id`) and as an outsider, re-verifies the copy read from the ledger, has the payer `Acknowledge`, and runs `checkAgainstLedger`. Captured output from a Canton 3.6.1 sandbox: [`docs/runs/m2b-sandbox-run-2026-10-16.json`](runs/m2b-sandbox-run-2026-10-16.json). In that run:

- `ReceiptRecord` created, updateId `1220c6766693f0f1e7734958e2fc2537f59fea4819b624ee9a748a376c8d0c75b00e`; the payer's view shows signatory issuer, observer payer, `canonical` identical to the envelope, and Level 1 verification of the ledger copy returns `ok`;
- the outsider gets `404 UPDATE_NOT_FOUND` ("not found, or not visible") for the same update;
- the payer's `Acknowledge` update `1220c708cb2ab30b7c8caa9082bb8357a985c7684fa3c816de6a9194c100a3e0c61d` creates an `AcknowledgedReceipt` signed by both parties;
- `checkAgainstLedger` on the receipt's (synthetic) settlement reference returns `update_not_found`, and pointed at the real `ReceiptRecord` update returns `no_transfer_visible`.

Limits of that run: a local, in-memory sandbox, so the update ids cannot be looked up by anyone else; no token standard installed, so there is no real payment and the receipt's `settlement.reference` is a synthetic id (labelled `synthetic_settlement: true` in the log); keys are TEST-ONLY.

## Next

A run on LocalNet (Splice) or DevNet with a real Canton Coin transfer through the exact scheme, so that Level 2 confirms payer, payee, amount and instrument from a live node and the published update ids can be checked by the stakeholders; an issuer service that listens to settle responses and records receipts automatically.
