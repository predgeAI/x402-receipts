// Canton profile for x402 receipts (M2a). See docs/canton-profile.md for sources and assumptions.
//
// Upstream references this module is written against:
// - x402 `exact` scheme on Canton: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md
// - CAIP namespace draft for Canton (open PR): https://github.com/ChainAgnostic/namespaces/pull/201
// - JSON Ledger API v2 OpenAPI (POST /v2/updates/update-by-id):
//   https://github.com/digital-asset/canton/blob/main/community/ledger/ledger-json-api/src/test/resources/json-api-docs/openapi.yaml
// - CIP-56 token standard Daml interfaces (Transfer, Holding):
//   https://github.com/hyperledger-labs/splice/tree/main/token-standard
import { hashJson } from "./canonical.js";
import { isTimestamp, validatePayload } from "./schema.js";
import type { ReceiptEnvelope, ReceiptPayload } from "./types.js";

/** Network ids used by the x402 exact-Canton scheme. Other `canton:<ref>` ids are accepted by the format check. */
export const CANTON_X402_NETWORKS = ["canton:mainnet", "canton:testnet", "canton:devnet"] as const;
/** On-ledger token-standard amounts are Daml `Decimal` (Numeric 10); the exact-Canton scheme uses 1 CC = 1e10 atomic units. */
export const CANTON_DECIMALS = 10;
export const HOLDING_INTERFACE = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
const HOLDING_SUFFIX = ":Splice.Api.Token.HoldingV1:Holding";
const TRANSFER_FACTORY_SUFFIX = ":Splice.Api.Token.TransferInstructionV1:TransferFactory";
const TRANSFER_CHOICE = "TransferFactory_Transfer";

export interface InstrumentId { admin: string; id: string }

// ---------------------------------------------------------------------------
// Formats

const NETWORK_RE = /^canton:[-_a-zA-Z0-9]{1,32}$/;
// Party id = "<hint>::<namespace>". Hint: Daml-LF party chars, no "::", <= 185 chars (Canton UniqueIdentifier).
// Namespace: 68 lowercase hex chars (observed form "1220" + SHA-256; Canton allocates String68 for it).
const HINT_RE = /^[A-Za-z0-9:_\- ]{1,185}$/;
const NAMESPACE_RE = /^[0-9a-f]{68}$/;
// Update ids observed in the scheme and on ledger are lowercase hex ("1220..."). We accept 8-255 lowercase hex chars.
const UPDATE_ID_RE = /^[0-9a-f]{8,255}$/;

export const isCantonNetwork = (s: unknown): s is string => typeof s === "string" && NETWORK_RE.test(s);
export const isUpdateId = (s: unknown): s is string => typeof s === "string" && UPDATE_ID_RE.test(s);

export function parsePartyId(s: unknown): { hint: string; namespace: string } | null {
  if (typeof s !== "string" || s.length > 255) return null;
  const i = s.lastIndexOf("::");
  if (i <= 0) return null;
  const hint = s.slice(0, i), namespace = s.slice(i + 2);
  if (!HINT_RE.test(hint) || hint.includes("::") || hint.endsWith(":") || !NAMESPACE_RE.test(namespace)) return null;
  return { hint, namespace };
}
export const isPartyId = (s: unknown): s is string => parsePartyId(s) !== null;

const enc = (s: string) => encodeURIComponent(s);

/** CAIP-10 style account id. The party id is percent-encoded (":" -> "%3A") as in the CAIP namespace draft (PR #201). */
export function cantonAccountId(network: string, party: string): string {
  if (!isCantonNetwork(network)) throw new Error(`not a Canton network id: ${network}`);
  if (!isPartyId(party)) throw new Error(`not a Canton party id: ${party}`);
  return `${network}:${enc(party)}`;
}

/** Parses "canton:<ref>:<party>" where <party> is percent-encoded or raw ("alice::1220..."). */
export function parseCantonAccountId(s: unknown): { network: string; party: string } | null {
  if (typeof s !== "string") return null;
  const m = /^(canton:[-_a-zA-Z0-9]{1,32}):(.+)$/.exec(s);
  if (!m) return null;
  let party: string;
  try { party = decodeURIComponent(m[2]); } catch { return null; }
  return isPartyId(party) ? { network: m[1], party } : null;
}

/** CAIP-19 asset id for a CIP-56 instrument: "<network>/cip-56:<enc(admin)>.<enc(id)>" (CAIP namespace draft, PR #201). */
export function cantonAssetId(network: string, instrument: InstrumentId): string {
  if (!isCantonNetwork(network)) throw new Error(`not a Canton network id: ${network}`);
  if (!isPartyId(instrument?.admin)) throw new Error("instrumentId.admin is not a party id");
  if (typeof instrument.id !== "string" || !instrument.id) throw new Error("instrumentId.id missing");
  return `${network}/cip-56:${enc(instrument.admin)}.${enc(instrument.id)}`;
}

export type ParsedCantonAsset =
  | { network: string; kind: "cip-56"; instrumentId: InstrumentId }
  | { network: string; kind: "slip44"; coinType: string };

/** Accepts the cip-56 form and the draft's SLIP-44 form for Canton Coin ("<network>/slip44:6767"). */
export function parseCantonAssetId(s: unknown): ParsedCantonAsset | null {
  if (typeof s !== "string") return null;
  const m = /^(canton:[-_a-zA-Z0-9]{1,32})\/(cip-56|slip44):([-.%a-zA-Z0-9]{1,256})$/.exec(s);
  if (!m) return null;
  if (m[2] === "slip44") return /^[0-9]+$/.test(m[3]) ? { network: m[1], kind: "slip44", coinType: m[3] } : null;
  // the encoded admin party contains no "." (party hints cannot contain "."), so the first "." separates admin from id
  const dot = m[3].indexOf(".");
  if (dot <= 0) return null;
  try {
    const admin = decodeURIComponent(m[3].slice(0, dot)), id = decodeURIComponent(m[3].slice(dot + 1));
    return isPartyId(admin) && id ? { network: m[1], kind: "cip-56", instrumentId: { admin, id } } : null;
  } catch { return null; }
}

/** Daml Decimal string ("0.1000000000") -> atomic integer string ("1000000000"). Throws on >10 fraction digits or sign. */
export function decimalToAtomic(d: string, decimals = CANTON_DECIMALS): string {
  const m = /^([0-9]+)(?:\.([0-9]*))?$/.exec(String(d));
  if (!m) throw new Error(`not an unsigned decimal: ${d}`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) throw new Error(`more than ${decimals} fraction digits: ${d}`);
  const s = (m[1] + frac.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  return s;
}
/** Atomic integer string -> Daml Decimal string with exactly `decimals` fraction digits. */
export function atomicToDecimal(a: string, decimals = CANTON_DECIMALS): string {
  if (!/^(0|[1-9][0-9]*)$/.test(a)) throw new Error(`not an atomic amount: ${a}`);
  const p = a.padStart(decimals + 1, "0");
  return `${p.slice(0, -decimals)}.${p.slice(-decimals)}`;
}

/** Canton-profile checks on top of the generic schema (returns errors; empty = valid). */
export function validateCantonPayload(p: unknown): string[] {
  const errs = validatePayload(p);
  if (errs.length) return errs;
  const r = p as ReceiptPayload;
  const net = r.settlement.network;
  if (!isCantonNetwork(net)) return ["settlement.network is not canton:<ref>"];
  const payer = parseCantonAccountId(r.payer), payee = parseCantonAccountId(r.payee), asset = parseCantonAssetId(r.asset);
  if (!payer) errs.push("payer is not a Canton account id");
  else if (payer.network !== net) errs.push("payer network differs from settlement.network");
  if (!payee) errs.push("payee is not a Canton account id");
  else if (payee.network !== net) errs.push("payee network differs from settlement.network");
  if (!asset) errs.push("asset is not a Canton asset id");
  else if (asset.network !== net) errs.push("asset network differs from settlement.network");
  if (!isUpdateId(r.settlement.reference)) errs.push("settlement.reference is not an update id (lowercase hex)");
  return errs;
}

// ---------------------------------------------------------------------------
// Building a receipt payload from an exact-Canton settlement

/** `PaymentRequirements` of the x402 exact scheme on Canton (fields as in scheme_exact_canton.md). */
export interface ExactCantonRequirements {
  scheme: "exact";
  network: string;
  /** atomic units, 1 CC = 1e10 */
  amount: string;
  asset: string; // "CC"
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: "transfer-factory";
    feePayer: string;
    synchronizerId: string;
    instrumentId: InstrumentId;
    executeBeforeSeconds: number;
    memo?: string;
  };
}

/** Facilitator `SettlementResponse` of the exact-Canton scheme. `transaction` is the ledger updateId. Unsigned. */
export interface ExactCantonSettleResponse {
  success: boolean;
  payer?: string;
  transaction: string;
  network?: string;
  errorReason?: string;
}

export interface BuildCantonReceiptInput {
  requirements: ExactCantonRequirements;
  settle: ExactCantonSettleResponse;
  resource: string;
  receiptId: string;
  issuer: { id: string; kid: string };
  /** Ledger recordTime if the issuer has read it, otherwise the time the settle response arrived. RFC 3339 UTC. */
  settledAt: string;
  issuedAt: string;
}

/** Turns a successful exact-Canton settlement into a receipt payload (not yet signed; pass it to issueReceipt). */
export function buildCantonReceiptPayload(i: BuildCantonReceiptInput): ReceiptPayload {
  const { requirements: req, settle } = i;
  if (!settle?.success) throw new Error(`settlement not successful: ${settle?.errorReason ?? "unknown"}`);
  if (req?.scheme !== "exact") throw new Error("requirements.scheme must be \"exact\"");
  if (!isCantonNetwork(req.network)) throw new Error("requirements.network is not a Canton network id");
  if (settle.network !== undefined && settle.network !== req.network) throw new Error("settle.network differs from requirements.network");
  if (req.extra?.assetTransferMethod !== "transfer-factory") throw new Error("extra.assetTransferMethod must be \"transfer-factory\"");
  if (!isPartyId(settle.payer)) throw new Error("settle.payer missing or not a party id");
  if (!isUpdateId(settle.transaction)) throw new Error("settle.transaction is not an update id");
  if (!/^(0|[1-9][0-9]*)$/.test(req.amount)) throw new Error("requirements.amount must be an atomic integer string");
  if (!isTimestamp(i.settledAt) || !isTimestamp(i.issuedAt)) throw new Error("settledAt / issuedAt must be RFC 3339 UTC");
  const payload: ReceiptPayload = {
    version: "1",
    receiptId: i.receiptId,
    payer: cantonAccountId(req.network, settle.payer),
    payee: cantonAccountId(req.network, req.payTo),
    asset: cantonAssetId(req.network, req.extra.instrumentId),
    amount: req.amount,
    settlement: { network: req.network, reference: settle.transaction, settledAt: i.settledAt },
    x402: { resource: i.resource, paymentRequirementsHash: hashJson(req) },
    issuer: { id: i.issuer.id, kid: i.issuer.kid },
    issuedAt: i.issuedAt,
  };
  const errs = validateCantonPayload(payload);
  if (errs.length) throw new Error("invalid Canton receipt payload: " + errs.join("; "));
  return payload;
}

// ---------------------------------------------------------------------------
// Level 2: cross-check against the verifier's own participant (JSON Ledger API v2)

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface LedgerCheckOptions {
  /** Base URL of the participant's JSON Ledger API, e.g. "http://localhost:7575". */
  ledgerUrl: string;
  /** Party hosted on that participant whose view is queried (normally the payee or the payer). */
  readAs: string;
  /** Bearer token for the JSON API, if the participant requires auth. */
  token?: string;
  /** If set, transaction.synchronizerId must equal it. */
  expectedSynchronizerId?: string;
  /** Required to check a slip44 (Canton Coin) asset id: the DSO party that administers Amulet on this network. */
  ccAdmin?: string;
  /** Fail when the payer cannot be confirmed from this party's view (default false: reported as "not_visible"). */
  requirePayer?: boolean;
}

export type LedgerCheckReason =
  | "ok" | "not_canton_receipt" | "update_not_found" | "ledger_error" | "not_a_transaction"
  | "reference_mismatch" | "synchronizer_mismatch" | "no_transfer_visible" | "transfer_not_completed"
  | "payer_mismatch" | "payee_mismatch" | "amount_mismatch" | "asset_mismatch" | "payer_not_visible";

export type FieldCheck = "match" | "mismatch" | "not_visible";

export interface LedgerCheckResult {
  ok: boolean;
  reason: LedgerCheckReason;
  detail?: string;
  checks: { payer: FieldCheck; payee: FieldCheck; amount: FieldCheck; asset: FieldCheck };
  /** Where the facts came from: the TransferFactory_Transfer exercise (payer/facilitator view) or created holdings (payee view). */
  source?: "transfer_exercise" | "holding_view";
  recordTime?: string;
  synchronizerId?: string;
}

/**
 * Exact request body sent to POST /v2/updates/update-by-id. With `includeHoldingView` false the CIP-56
 * Holding interface filter is left out; checkAgainstLedger retries that way when the participant does
 * not know the token-standard package (PACKAGE_NAMES_NOT_FOUND, observed on a plain Canton 3.6 sandbox).
 */
export function updateByIdRequest(updateId: string, readAs: string, includeHoldingView = true) {
  const holding = { identifierFilter: { InterfaceFilter: { value: { interfaceId: HOLDING_INTERFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } } };
  return {
    updateId,
    updateFormat: {
      includeTransactions: {
        eventFormat: {
          filtersByParty: {
            [readAs]: {
              cumulative: [
                { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
                ...(includeHoldingView ? [holding] : []),
              ],
            },
          },
          verbose: true,
        },
        transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
      },
    },
  };
}

const NONE: LedgerCheckResult["checks"] = { payer: "not_visible", payee: "not_visible", amount: "not_visible", asset: "not_visible" };
const fail = (reason: LedgerCheckReason, detail?: string, extra: Partial<LedgerCheckResult> = {}): LedgerCheckResult =>
  ({ ok: false, reason, detail, checks: { ...NONE }, ...extra });
const obj = (v: unknown): Record<string, any> | undefined => (typeof v === "object" && v !== null ? (v as any) : undefined);

function instrumentMatches(asset: ParsedCantonAsset, inst: unknown, ccAdmin?: string): boolean {
  const i = obj(inst);
  if (!i || typeof i.admin !== "string" || typeof i.id !== "string") return false;
  if (asset.kind === "cip-56") return i.admin === asset.instrumentId.admin && i.id === asset.instrumentId.id;
  // slip44:6767 is Canton Coin per the CAIP draft; on ledger that is instrument id "Amulet" administered by the DSO party.
  return asset.coinType === "6767" && i.id === "Amulet" && ccAdmin !== undefined && i.admin === ccAdmin;
}

function sameAtomic(ledgerDecimal: unknown, atomic: string): boolean {
  try { return typeof ledgerDecimal === "string" && decimalToAtomic(ledgerDecimal) === atomic; } catch { return false; }
}

/**
 * Level 2 check: fetch `settlement.reference` from the verifier's own participant and compare
 * payer, payee, amount and asset with the receipt. Run verifyReceipt (Level 1) first; this
 * function does not check signatures. `fetchFn` is injected so it can be mocked and so callers
 * control TLS, timeouts and auth.
 */
export async function checkAgainstLedger(
  receipt: ReceiptPayload | ReceiptEnvelope, fetchFn: FetchFn, opts: LedgerCheckOptions,
): Promise<LedgerCheckResult> {
  const p: ReceiptPayload = "payload" in receipt && "signature" in receipt ? receipt.payload : (receipt as ReceiptPayload);
  const errs = validateCantonPayload(p);
  if (errs.length) return fail("not_canton_receipt", errs[0]);
  if (!isPartyId(opts.readAs)) return fail("not_canton_receipt", "opts.readAs is not a party id");
  const payer = parseCantonAccountId(p.payer)!.party, payee = parseCantonAccountId(p.payee)!.party;
  const asset = parseCantonAssetId(p.asset)!;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: any;
  let res: Awaited<ReturnType<FetchFn>>;
  const url = opts.ledgerUrl.replace(/\/$/, "") + "/v2/updates/update-by-id";
  try {
    res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(updateByIdRequest(p.settlement.reference, opts.readAs)) });
    body = await res.json().catch(() => undefined);
    // A participant without the token-standard packages rejects the Holding interface filter with
    // PACKAGE_NAMES_NOT_FOUND (HTTP 404). That says nothing about the update: retry without the filter.
    if (!res.ok && obj(body)?.code === "PACKAGE_NAMES_NOT_FOUND") {
      res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(updateByIdRequest(p.settlement.reference, opts.readAs, false)) });
      body = await res.json().catch(() => undefined);
    }
  } catch (e) {
    return fail("ledger_error", (e as Error).message);
  }
  if (!res.ok) {
    const code = obj(body)?.code;
    if (res.status === 404 || code === "UPDATE_NOT_FOUND") return fail("update_not_found", code ?? `HTTP ${res.status}`);
    return fail("ledger_error", code ?? `HTTP ${res.status}`);
  }
  const tx = obj(obj(obj(body)?.update)?.Transaction)?.value;
  if (!tx) return fail("not_a_transaction");
  const meta = { recordTime: tx.recordTime, synchronizerId: tx.synchronizerId };
  if (tx.updateId !== p.settlement.reference) return fail("reference_mismatch", tx.updateId, meta);
  if (opts.expectedSynchronizerId && tx.synchronizerId !== opts.expectedSynchronizerId)
    return fail("synchronizer_mismatch", tx.synchronizerId, meta);
  const events: any[] = Array.isArray(tx.events) ? tx.events : [];

  // Path A: the TransferFactory_Transfer exercise is visible (payer, facilitator, DSO views).
  const ex = events.map((e) => obj(e)?.ExercisedEvent).find((e) =>
    e && e.choice === TRANSFER_CHOICE && (e.interfaceId === undefined || String(e.interfaceId).endsWith(TRANSFER_FACTORY_SUFFIX)));
  if (ex) {
    const t = obj(obj(ex.choiceArgument)?.transfer);
    if (!t) return fail("no_transfer_visible", "exercise without transfer argument", meta);
    const tag = obj(obj(ex.exerciseResult)?.output)?.tag;
    if (tag !== undefined && tag !== "TransferInstructionResult_Completed") return fail("transfer_not_completed", String(tag), meta);
    const checks: LedgerCheckResult["checks"] = {
      payer: t.sender === payer ? "match" : "mismatch",
      payee: t.receiver === payee ? "match" : "mismatch",
      amount: sameAtomic(t.amount, p.amount) ? "match" : "mismatch",
      asset: instrumentMatches(asset, t.instrumentId, opts.ccAdmin) ? "match" : "mismatch",
    };
    return verdict(checks, "transfer_exercise", meta, opts);
  }

  // Path B: payee view. The receiver is not a witness of the root exercise (no choice observers on
  // TransferFactory_Transfer), but it is a stakeholder of the holding created for it. Sum the holdings
  // created for the payee in the receipt's instrument.
  const views = events.map((e) => obj(e)?.CreatedEvent).filter(Boolean).flatMap((c: any) =>
    (Array.isArray(c.interfaceViews) ? c.interfaceViews : [])
      .filter((v: any) => String(v?.interfaceId ?? "").endsWith(HOLDING_SUFFIX) && obj(v?.viewValue))
      .map((v: any) => v.viewValue));
  if (!views.length) return fail("no_transfer_visible", "no transfer exercise and no holding views for readAs", meta);
  const mine = views.filter((v: any) => v.owner === payee);
  if (!mine.length) return verdict({ payer: "not_visible", payee: "mismatch", amount: "not_visible", asset: "not_visible" }, "holding_view", meta, opts);
  const inInstrument = mine.filter((v: any) => instrumentMatches(asset, v.instrumentId, opts.ccAdmin));
  let total = 0n;
  for (const v of inInstrument) {
    try { total += BigInt(decimalToAtomic(v.amount)); } catch { return fail("ledger_error", "unparseable holding amount", meta); }
  }
  return verdict({
    payer: "not_visible",
    payee: "match",
    amount: inInstrument.length && total.toString() === p.amount ? "match" : "mismatch",
    asset: inInstrument.length ? "match" : "mismatch",
  }, "holding_view", meta, opts);
}

function verdict(checks: LedgerCheckResult["checks"], source: LedgerCheckResult["source"],
  meta: Pick<LedgerCheckResult, "recordTime" | "synchronizerId">, opts: LedgerCheckOptions): LedgerCheckResult {
  const order: Array<[keyof typeof checks, LedgerCheckReason]> =
    [["payee", "payee_mismatch"], ["payer", "payer_mismatch"], ["asset", "asset_mismatch"], ["amount", "amount_mismatch"]];
  for (const [k, reason] of order) if (checks[k] === "mismatch") return { ok: false, reason, checks, source, ...meta };
  if (checks.payer === "not_visible" && opts.requirePayer) return { ok: false, reason: "payer_not_visible", checks, source, ...meta };
  return { ok: true, reason: "ok", checks, source, ...meta };
}
