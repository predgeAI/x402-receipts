import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atomicToDecimal, buildCantonReceiptPayload, cantonAccountId, cantonAssetId, checkAgainstLedger, decimalToAtomic,
  issueReceipt, type FetchFn, parseCantonAccountId, parseCantonAssetId, parsePartyId, updateByIdRequest, validateCantonPayload, verifyReceipt,
} from "../src/index.js";
import * as C from "./support/canton-fixtures.js";
import { TEST_KID, TEST_SEED, testKeyset } from "./support/test-keys.js";

const build = (over: Partial<Parameters<typeof buildCantonReceiptPayload>[0]> = {}) => buildCantonReceiptPayload({
  requirements: C.requirements, settle: C.settle, resource: "https://api.example.com/v1/weather", receiptId: "r-1",
  issuer: { id: "https://api.example.com", kid: TEST_KID }, settledAt: C.RECORD_TIME, issuedAt: "2026-10-16T09:00:04Z", ...over,
});
const LEDGER = "http://localhost:7575/";
const _globalFetchFits: FetchFn = fetch; // the platform fetch can be passed directly
void _globalFetchFits;

test("party id parsing", () => {
  assert.deepEqual(parsePartyId(C.PAYEE)?.hint, "test-merchant");
  assert.equal(parsePartyId("alice::1220abc"), null); // namespace too short
  assert.equal(parsePartyId("alice"), null);
  assert.equal(parsePartyId("::1220" + "a".repeat(64)), null);
  assert.equal(parsePartyId("al.ice::1220" + "a".repeat(64)), null);
  assert.equal(parsePartyId("a:b::1220" + "a".repeat(64))?.hint, "a:b");
});

test("account and asset ids round-trip; raw '::' accepted on input", () => {
  const acc = cantonAccountId(C.NETWORK, C.PAYER);
  assert.match(acc, /^canton:devnet:test-agent%3A%3A1220[0-9a-f]{64}$/);
  assert.deepEqual(parseCantonAccountId(acc), { network: C.NETWORK, party: C.PAYER });
  assert.deepEqual(parseCantonAccountId(`${C.NETWORK}:${C.PAYER}`), { network: C.NETWORK, party: C.PAYER });
  const asset = cantonAssetId(C.NETWORK, { admin: C.DSO, id: "Amulet" });
  assert.deepEqual(parseCantonAssetId(asset), { network: C.NETWORK, kind: "cip-56", instrumentId: { admin: C.DSO, id: "Amulet" } });
  assert.deepEqual(parseCantonAssetId("canton:mainnet/slip44:6767"), { network: "canton:mainnet", kind: "slip44", coinType: "6767" });
  assert.equal(parseCantonAssetId("eip155:1/erc20:0xabc"), null);
  assert.throws(() => cantonAccountId("eip155:1", C.PAYER));
});

test("decimal <-> atomic (10 places)", () => {
  assert.equal(decimalToAtomic("0.1000000000"), "1000000000");
  assert.equal(decimalToAtomic("12"), "120000000000");
  assert.equal(decimalToAtomic("0.0"), "0");
  assert.equal(atomicToDecimal("1000000000"), "0.1000000000");
  assert.equal(atomicToDecimal("0"), "0.0000000000");
  assert.throws(() => decimalToAtomic("0.00000000001"));
  assert.throws(() => decimalToAtomic("-1"));
});

test("buildCantonReceiptPayload maps the exact-Canton settle response; signed receipt verifies offline", () => {
  const p = build();
  assert.equal(p.settlement.reference, C.UPDATE_ID);
  assert.equal(p.settlement.network, "canton:devnet");
  assert.equal(parseCantonAccountId(p.payer)?.party, C.PAYER);
  assert.equal(parseCantonAccountId(p.payee)?.party, C.PAYEE);
  assert.deepEqual(validateCantonPayload(p), []);
  assert.equal(verifyReceipt(issueReceipt(p, TEST_SEED, TEST_KID), testKeyset()).ok, true);
});

test("buildCantonReceiptPayload rejects failed or inconsistent settlements", () => {
  assert.throws(() => build({ settle: { success: false, transaction: "", errorReason: "invalid_exact_canton_amount_mismatch" } }), /amount_mismatch/);
  assert.throws(() => build({ settle: { ...C.settle, network: "canton:mainnet" } }), /differs/);
  assert.throws(() => build({ settle: { ...C.settle, payer: undefined } }), /payer/);
  assert.throws(() => build({ settle: { ...C.settle, transaction: "not-hex" } }), /update id/);
});

test("validateCantonPayload rejects mixed networks", () => {
  const p = build();
  assert.ok(validateCantonPayload({ ...p, payee: `canton:mainnet:${encodeURIComponent(C.PAYEE)}` }).some((e) => /payee network/.test(e)));
  assert.ok(validateCantonPayload({ ...p, settlement: { ...p.settlement, reference: "0xABC" } }).length > 0);
});

test("checkAgainstLedger sends the documented request and passes on the payee view", async () => {
  const { fetchFn, calls } = C.mockLedger(C.payeeView());
  const r = await checkAgainstLedger(issueReceipt(build(), TEST_SEED, TEST_KID), fetchFn, { ledgerUrl: LEDGER, readAs: C.PAYEE, token: "t0k" });
  assert.equal(r.ok, true);
  assert.equal(r.source, "holding_view");
  assert.deepEqual(r.checks, { payer: "not_visible", payee: "match", amount: "match", asset: "match" });
  assert.equal(r.recordTime, C.RECORD_TIME);
  assert.equal(calls[0].url, "http://localhost:7575/v2/updates/update-by-id");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer t0k");
  assert.deepEqual(JSON.parse(calls[0].init.body), updateByIdRequest(C.UPDATE_ID, C.PAYEE));
});

test("checkAgainstLedger: payer view confirms all four fields", async () => {
  const r = await checkAgainstLedger(build(), C.mockLedger(C.payerView()).fetchFn, { ledgerUrl: LEDGER, readAs: C.PAYER });
  assert.deepEqual([r.ok, r.source, r.checks.payer], [true, "transfer_exercise", "match"]);
});

test("checkAgainstLedger detects mismatches", async () => {
  const run = (resp: unknown, p = build(), extra = {}) =>
    checkAgainstLedger(p, C.mockLedger(resp).fetchFn, { ledgerUrl: LEDGER, readAs: C.PAYEE, ...extra });
  assert.equal((await run(C.payeeView({ amount: "999" }))).reason, "amount_mismatch");
  assert.equal((await run(C.payeeView({ owner: C.OTHER }))).reason, "payee_mismatch");
  assert.equal((await run(C.payerView({ receiver: C.OTHER }))).reason, "payee_mismatch");
  assert.equal((await run(C.payerView({ tag: "TransferInstructionResult_Pending" }))).reason, "transfer_not_completed");
  const otherAsset = { ...build(), asset: cantonAssetId(C.NETWORK, { admin: C.DSO, id: "USDCx" }) };
  assert.equal((await run(C.payerView(), otherAsset)).reason, "asset_mismatch");
  assert.equal((await run(C.payeeView(), build(), { requirePayer: true })).reason, "payer_not_visible");
  assert.equal((await run(C.payeeView(), build(), { expectedSynchronizerId: "global-domain::1220" + "0".repeat(64) })).reason, "synchronizer_mismatch");
  const slip = { ...build(), asset: "canton:devnet/slip44:6767" };
  assert.equal((await run(C.payeeView(), slip)).reason, "asset_mismatch"); // no ccAdmin given: cannot confirm
  assert.equal((await run(C.payeeView(), slip, { ccAdmin: C.DSO })).reason, "ok");
});

test("checkAgainstLedger: not found, errors, non-Canton receipts", async () => {
  const opts = { ledgerUrl: LEDGER, readAs: C.PAYEE };
  assert.equal((await checkAgainstLedger(build(), C.mockLedger({ code: "UPDATE_NOT_FOUND", cause: "x" }, 404).fetchFn, opts)).reason, "update_not_found");
  assert.equal((await checkAgainstLedger(build(), C.mockLedger({ code: "PERMISSION_DENIED" }, 403).fetchFn, opts)).reason, "ledger_error");
  assert.equal((await checkAgainstLedger(build(), async () => { throw new Error("ECONNREFUSED"); }, opts)).reason, "ledger_error");
  assert.equal((await checkAgainstLedger(build(), C.mockLedger({ update: { OffsetCheckpoint: {} } }).fetchFn, opts)).reason, "not_a_transaction");
  const wrongId = C.payeeView(); wrongId.update.Transaction.value.updateId = "1220" + "f".repeat(64);
  assert.equal((await checkAgainstLedger(build(), C.mockLedger(wrongId).fetchFn, opts)).reason, "reference_mismatch");
  const evm = (await import("../vectors/valid-001.json", { with: { type: "json" } })).default.envelope;
  assert.equal((await checkAgainstLedger(evm as any, C.mockLedger({}).fetchFn, opts)).reason, "not_canton_receipt");
});

test("checkAgainstLedger retries without the Holding filter on PACKAGE_NAMES_NOT_FOUND (seen on a real 3.6 sandbox)", async () => {
  const replies: Array<[number, unknown]> = [
    [404, { code: "PACKAGE_NAMES_NOT_FOUND", cause: "The following package names do not match upgradable packages uploaded on this participant: [splice-api-token-holding-v1]." }],
    [404, { code: "UPDATE_NOT_FOUND", cause: "Update not found, or not visible." }],
  ];
  const calls: string[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    calls.push(init.body);
    const [status, body] = replies.shift()!;
    return { ok: status < 300, status, json: async () => body };
  };
  const r = await checkAgainstLedger(build(), fetchFn, { ledgerUrl: LEDGER, readAs: C.PAYEE });
  assert.equal(r.reason, "update_not_found");
  assert.equal(r.detail, "UPDATE_NOT_FOUND");
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0]), updateByIdRequest(C.UPDATE_ID, C.PAYEE));
  assert.deepEqual(JSON.parse(calls[1]), updateByIdRequest(C.UPDATE_ID, C.PAYEE, false));
  // a payee view without interface views (no token standard) is not a confirmed transfer
  const r2 = await checkAgainstLedger(build(), C.mockLedger({ update: { Transaction: { value: { updateId: C.UPDATE_ID, events: [] } } } }).fetchFn, { ledgerUrl: LEDGER, readAs: C.PAYEE });
  assert.equal(r2.reason, "no_transfer_visible");
});
