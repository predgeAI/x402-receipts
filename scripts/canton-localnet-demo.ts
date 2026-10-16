// M2b demo: record a signed x402 receipt on a local Canton participant via the JSON Ledger API v2.
//
//   cd daml && dpm build --all && dpm sandbox --json-api-port 7575      # terminal 1
//   npm run canton:demo                                                  # terminal 2
//
// Env: LEDGER_URL (default http://localhost:7575), LEDGER_TOKEN (optional bearer), LEDGER_USER
// (default participant_admin), DAR (default daml/x402-receipt/.daml/dist/x402-receipt-0.1.0.dar),
// ENVELOPE (optional path to an existing signed envelope JSON; its payer/payee parties must be hosted
// on this participant), OUT (optional path to write the captured run log).
//
// Without ENVELOPE the script issues a fresh receipt with the TEST-ONLY key for parties it allocates.
// A plain sandbox has no CIP-56 token, so there is no real payment: the receipt's settlement.reference
// is a synthetic update id, and the Level 2 check is expected to report update_not_found.
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildCantonReceiptPayload, checkAgainstLedger, issueReceipt, parseCantonAccountId, verifyReceipt,
  type ExactCantonRequirements, type FetchFn, type ReceiptEnvelope,
} from "../src/index.js";
import { TEST_KID, TEST_SEED, testKeyset } from "../test/support/test-keys.js";

const LEDGER = (process.env.LEDGER_URL ?? "http://localhost:7575").replace(/\/$/, "");
const USER = process.env.LEDGER_USER ?? "participant_admin";
const DAR = process.env.DAR ?? new URL("../daml/x402-receipt/.daml/dist/x402-receipt-0.1.0.dar", import.meta.url).pathname;
const TEMPLATE = "#x402-receipt:X402.Receipt:ReceiptRecord";
const ACK_TEMPLATE = "#x402-receipt:X402.Receipt:AcknowledgedReceipt";
const log: Array<Record<string, unknown>> = [];
const step = (name: string, data: Record<string, unknown>) => { log.push({ step: name, ...data }); console.log(`\n## ${name}\n` + JSON.stringify(data, null, 2)); };

function headers(ct = "application/json"): Record<string, string> {
  const h: Record<string, string> = { "content-type": ct };
  if (process.env.LEDGER_TOKEN) h.authorization = `Bearer ${process.env.LEDGER_TOKEN}`;
  return h;
}
async function api(method: string, path: string, body?: unknown, raw?: Buffer): Promise<{ status: number; body: any }> {
  const res = await fetch(LEDGER + path, {
    method, headers: headers(raw ? "application/octet-stream" : "application/json"),
    body: raw ? new Blob([new Uint8Array(raw)]) : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}
function must<T extends { status: number; body: any }>(r: T, what: string): T {
  if (r.status < 200 || r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

async function allocate(hint: string): Promise<string> {
  const r = must(await api("POST", "/v2/parties", { partyIdHint: hint, identityProviderId: "" }), `allocate ${hint}`);
  return r.body.partyDetails.party;
}

const wildcard = (party: string) => ({
  filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } },
  verbose: true,
});
async function updateById(updateId: string, party: string) {
  return api("POST", "/v2/updates/update-by-id", {
    updateId,
    updateFormat: { includeTransactions: { eventFormat: wildcard(party), transactionShape: "TRANSACTION_SHAPE_ACS_DELTA" } },
  });
}
async function activeReceipts(party: string): Promise<any[]> {
  const end = must(await api("GET", "/v2/state/ledger-end"), "ledger-end").body.offset;
  const r = must(await api("POST", "/v2/state/active-contracts", {
    activeAtOffset: end,
    eventFormat: {
      filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: TEMPLATE, includeCreatedEventBlob: false } } } }] } },
      verbose: true,
    },
  }), "active-contracts");
  return (Array.isArray(r.body) ? r.body : []).map((e: any) => e?.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean);
}
async function submit(actAs: string, command: unknown) {
  return api("POST", "/v2/commands/submit-and-wait", { commands: [command], commandId: randomUUID(), userId: USER, actAs: [actAs], readAs: [] });
}

/** The on-ledger record for an envelope. Parties come from the signed CAIP-10 accounts. */
function recordArgs(env: ReceiptEnvelope, issuer: string) {
  const p = env.payload;
  return {
    issuer, payer: parseCantonAccountId(p.payer)!.party,
    receiptId: p.receiptId, payerAccount: p.payer, payeeAccount: p.payee, asset: p.asset, amount: p.amount,
    network: p.settlement.network, settlementUpdateId: p.settlement.reference, settledAt: p.settlement.settledAt,
    resource: p.x402.resource, paymentRequirementsHash: p.x402.paymentRequirementsHash,
    issuerId: p.issuer.id, kid: env.kid, issuedAt: p.issuedAt,
    canonical: env.canonical, signature: env.signature, envelopeHash: env.envelopeHash,
  };
}

async function main() {
  const version = must(await api("GET", "/v2/version"), "version").body.version;
  step("participant", { ledgerUrl: LEDGER, version });

  const dar = readFileSync(DAR);
  const up = await api("POST", "/v2/packages", undefined, dar);
  step("upload_dar", { dar: DAR.split("/").slice(-1)[0], sha256: createHash("sha256").update(dar).digest("hex"), status: up.status });
  must(up, "upload dar");

  const sfx = Date.now().toString(36);
  const merchant = await allocate(`test-merchant-${sfx}`);
  const agent = await allocate(`test-agent-${sfx}`);
  const registry = await allocate(`test-registry-${sfx}`);
  const outsider = await allocate(`outsider-${sfx}`);
  step("parties", { merchant, agent, registry, outsider });

  // 1. Signed envelope: existing file, or a fresh one with the TEST-ONLY key.
  let env: ReceiptEnvelope;
  if (process.env.ENVELOPE) {
    const j = JSON.parse(readFileSync(process.env.ENVELOPE, "utf8"));
    env = j.envelope ?? j;
  } else {
    const network = "canton:sandbox";
    const requirements: ExactCantonRequirements = {
      scheme: "exact", network, amount: "1000000000", asset: "TestToken", payTo: merchant, maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "transfer-factory", feePayer: merchant, synchronizerId: "sandbox", instrumentId: { admin: registry, id: "TestToken" }, executeBeforeSeconds: 60 },
    };
    // No token on a plain sandbox, so no real payment: a synthetic, clearly labelled update id.
    const syntheticSettlement = "1220" + createHash("sha256").update(`x402-receipts synthetic settlement ${sfx}`).digest("hex");
    const now = new Date().toISOString();
    const payload = buildCantonReceiptPayload({
      requirements, settle: { success: true, payer: agent, transaction: syntheticSettlement, network },
      resource: "https://api.example.com/v1/weather", receiptId: randomUUID(),
      issuer: { id: "https://api.example.com", kid: TEST_KID }, settledAt: now, issuedAt: now,
    });
    env = issueReceipt(payload, TEST_SEED, TEST_KID);
  }
  const l1 = verifyReceipt(env, testKeyset());
  step("level1_offline_verify", { receiptId: env.payload.receiptId, envelopeHash: env.envelopeHash, settlementReference: env.payload.settlement.reference, synthetic_settlement: !process.env.ENVELOPE, result: l1.reason });
  if (!l1.ok) throw new Error("envelope does not verify: " + l1.reason);
  const payer = parseCantonAccountId(env.payload.payer)?.party;
  if (payer !== agent && !process.env.ENVELOPE) throw new Error("payer party mismatch");

  // 2. Dedupe on (issuer, receiptId): Daml 3 has no contract keys, so the issuer checks its ACS first.
  const existing = (await activeReceipts(merchant)).filter((c) => c.createArgument?.receiptId === env.payload.receiptId);
  step("dedupe_check_before_create", { activeWithSameReceiptId: existing.length });
  if (existing.length) throw new Error("receipt already recorded");

  // 3. Create the ReceiptRecord as the issuer.
  const created = must(await submit(merchant, { CreateCommand: { templateId: TEMPLATE, createArguments: recordArgs(env, merchant) } }), "create ReceiptRecord");
  step("create_receipt_record", { request: "POST /v2/commands/submit-and-wait (CreateCommand X402.Receipt:ReceiptRecord, actAs issuer)", response: created.body });
  const recordUpdateId: string = created.body.updateId;

  // 4. Visibility: the payer sees the record, an outsider does not.
  const asPayer = must(await updateById(recordUpdateId, agent), "update-by-id payer");
  const ev = (asPayer.body?.update?.Transaction?.value?.events ?? []).map((e: any) => e.CreatedEvent).find(Boolean);
  step("payer_view", {
    status: asPayer.status, recordTime: asPayer.body?.update?.Transaction?.value?.recordTime,
    templateId: ev?.templateId, contractId: ev?.contractId, signatories: ev?.signatories, observers: ev?.observers,
    receiptId: ev?.createArgument?.receiptId, envelopeHash: ev?.createArgument?.envelopeHash,
    canonicalMatchesEnvelope: ev?.createArgument?.canonical === env.canonical,
  });
  const asOutsider = await updateById(recordUpdateId, outsider);
  step("outsider_view", { status: asOutsider.status, code: asOutsider.body?.code ?? null, cause: asOutsider.body?.cause ?? null });

  // 5. Re-verify the receipt read back from the ledger (Level 1, from the payer's copy).
  const a = ev.createArgument;
  const fromLedger: ReceiptEnvelope = { payload: JSON.parse(a.canonical), canonical: a.canonical, signature: a.signature, kid: a.kid, alg: "ed25519", envelopeHash: a.envelopeHash };
  step("level1_verify_from_ledger_copy", { result: verifyReceipt(fromLedger, testKeyset()).reason });

  // 6. Duplicate attempt is refused by the issuer-side check.
  const dup = (await activeReceipts(merchant)).filter((c) => c.createArgument?.receiptId === env.payload.receiptId);
  step("duplicate_attempt", { activeWithSameReceiptId: dup.length, action: dup.length ? "refused by issuer-side dedupe, not submitted" : "would submit" });

  // 7. Payer acknowledges: record replaced by an AcknowledgedReceipt signed by both.
  const ack = must(await submit(agent, { ExerciseCommand: { templateId: TEMPLATE, contractId: ev.contractId, choice: "Acknowledge", choiceArgument: {} } }), "Acknowledge");
  const ackView = must(await updateById(ack.body.updateId, merchant), "update-by-id ack");
  const ackEv = (ackView.body?.update?.Transaction?.value?.events ?? []).map((e: any) => e.CreatedEvent).find((c: any) => c && String(c.templateId).endsWith(":X402.Receipt:AcknowledgedReceipt"));
  step("payer_acknowledge", { response: ack.body, acknowledgedContractId: ackEv?.contractId, signatories: ackEv?.signatories, templateIdUsed: ACK_TEMPLATE });

  // 8. Level 2 (checkAgainstLedger) against this real participant.
  const realFetch: FetchFn = async (url, init) => fetch(url, init) as any;
  const l2 = await checkAgainstLedger(env, realFetch, { ledgerUrl: LEDGER, readAs: merchant, token: process.env.LEDGER_TOKEN });
  step("level2_checkAgainstLedger_settlement_reference", { note: "settlement.reference is synthetic on a plain sandbox (no CIP-56 token), so update_not_found is the expected, correct answer", result: l2 });
  const l2b = await checkAgainstLedger({ ...env.payload, settlement: { ...env.payload.settlement, reference: recordUpdateId } }, realFetch, { ledgerUrl: LEDGER, readAs: merchant, token: process.env.LEDGER_TOKEN });
  step("level2_checkAgainstLedger_on_a_real_non_transfer_update", { note: "points the check at the real ReceiptRecord update: it exists but contains no token transfer", updateId: recordUpdateId, result: l2b });

  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ capturedAt: new Date().toISOString(), steps: log }, null, 2) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
