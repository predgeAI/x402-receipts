import type { ReceiptPayload } from "./types.js";

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
// CAIP-10 account part widened to allow ':' and '_' so ledger party ids (e.g. Canton "alice::1220ab..") fit.
const CAIP10 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%:_a-zA-Z0-9]{1,256}$/;
const CAIP19 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%:_a-zA-Z0-9]{1,256}(\/[-.%a-zA-Z0-9]{1,78})?$/;
const AMOUNT = /^(0|[1-9][0-9]*)$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const REQ_HASH = /^sha256:[0-9a-f]{64}$/;
export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

export function isTimestamp(s: unknown): s is string {
  return typeof s === "string" && TS.test(s) && !Number.isNaN(Date.parse(s));
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function exactKeys(o: Record<string, unknown>, keys: string[], path: string, errs: string[]) {
  for (const k of keys) if (!(k in o)) errs.push(`${path}.${k} missing`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${path}.${k} unexpected`);
}

const str = (v: unknown, max = 2048) => typeof v === "string" && v.length > 0 && v.length <= max;

/** Returns a list of schema errors (empty when valid). Unknown fields are rejected. */
export function validatePayload(p: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(p)) return ["payload not an object"];
  exactKeys(p, ["version", "receiptId", "payer", "payee", "asset", "amount", "settlement", "x402", "issuer", "issuedAt"], "payload", errs);
  if (p.version !== "1") errs.push("payload.version must be \"1\"");
  if (!str(p.receiptId, 128)) errs.push("payload.receiptId invalid");
  if (typeof p.payer !== "string" || !CAIP10.test(p.payer)) errs.push("payload.payer not CAIP-10");
  if (typeof p.payee !== "string" || !CAIP10.test(p.payee)) errs.push("payload.payee not CAIP-10");
  if (typeof p.asset !== "string" || !CAIP19.test(p.asset)) errs.push("payload.asset not CAIP-19");
  if (typeof p.amount !== "string" || !AMOUNT.test(p.amount)) errs.push("payload.amount must be a base-10 integer string");
  if (!isTimestamp(p.issuedAt)) errs.push("payload.issuedAt invalid");
  if (!isObj(p.settlement)) errs.push("payload.settlement not an object");
  else {
    exactKeys(p.settlement, ["network", "reference", "settledAt"], "payload.settlement", errs);
    if (typeof p.settlement.network !== "string" || !CAIP2.test(p.settlement.network)) errs.push("payload.settlement.network not CAIP-2");
    if (!str(p.settlement.reference, 512)) errs.push("payload.settlement.reference invalid");
    if (!isTimestamp(p.settlement.settledAt)) errs.push("payload.settlement.settledAt invalid");
  }
  if (!isObj(p.x402)) errs.push("payload.x402 not an object");
  else {
    exactKeys(p.x402, ["resource", "paymentRequirementsHash"], "payload.x402", errs);
    if (!str(p.x402.resource)) errs.push("payload.x402.resource invalid");
    if (typeof p.x402.paymentRequirementsHash !== "string" || !REQ_HASH.test(p.x402.paymentRequirementsHash)) errs.push("payload.x402.paymentRequirementsHash invalid");
  }
  if (!isObj(p.issuer)) errs.push("payload.issuer not an object");
  else {
    exactKeys(p.issuer, ["id", "kid"], "payload.issuer", errs);
    if (!str(p.issuer.id, 512)) errs.push("payload.issuer.id invalid");
    if (!str(p.issuer.kid, 128)) errs.push("payload.issuer.kid invalid");
  }
  return errs;
}

export function validateEnvelopeShape(e: unknown): string[] {
  if (!isObj(e)) return ["envelope not an object"];
  const errs: string[] = [];
  exactKeys(e, ["payload", "canonical", "signature", "kid", "alg", "envelopeHash"], "envelope", errs);
  if (typeof e.canonical !== "string") errs.push("envelope.canonical not a string");
  if (typeof e.signature !== "string" || !SIG_RE.test(e.signature)) errs.push("envelope.signature must be base64url of 64 bytes");
  if (!str(e.kid, 128)) errs.push("envelope.kid invalid");
  if (e.alg !== "ed25519") errs.push("envelope.alg must be \"ed25519\"");
  if (typeof e.envelopeHash !== "string" || !REQ_HASH.test(e.envelopeHash)) errs.push("envelope.envelopeHash invalid");
  errs.push(...validatePayload(e.payload));
  if (isObj(e.payload) && isObj(e.payload.issuer) && e.payload.issuer.kid !== e.kid) errs.push("payload.issuer.kid must equal envelope.kid");
  return errs;
}

export type { ReceiptPayload };
