// Client: pay (mocked), receive receipt, verify it OFFLINE against a cached keyset.
import { fetchKeyset, hashJson, verifyReceipt, type Keyset } from "../../src/index.js";

export async function run(base: string, keyset?: Keyset) {
  const url = `${base}/weather`;
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const required = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));
  const req = required.accepts[0];

  // MOCK payment authorisation (a real client signs an EIP-3009 / permit authorisation here).
  const payment = { x402Version: 2, accepted: req, payload: { from: "0x857b06519E91e3A54538791bDbb0E22373e36b66", signature: "0xMOCK" } };
  const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payment)).toString("base64") } });
  if (!paid.ok) throw new Error(`payment failed: ${paid.status}`);
  const receipt = JSON.parse(Buffer.from(paid.headers.get("X-402-Receipt")!, "base64url").toString("utf8"));

  // Keyset is fetched once and may be cached/pinned; verification below makes no network calls.
  const ks = keyset ?? (await fetchKeyset(base));
  const result = verifyReceipt(receipt, ks);
  if (!result.ok) throw new Error(`receipt rejected: ${result.reason}`);
  const p = result.payload;
  // Bind the receipt to what THIS client was asked to pay.
  if (p.x402.paymentRequirementsHash !== hashJson(req)) throw new Error("receipt does not match the requirements I accepted");
  if (p.amount !== req.amount || !p.payee.endsWith(req.payTo)) throw new Error("receipt amount/payee mismatch");
  return { body: await paid.json(), receipt, result };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.SERVER ?? "http://localhost:4021";
  run(base).then((r) => console.log("receipt verified offline:", r.result.ok, "| receiptId", r.receipt.payload.receiptId, "| tx", r.receipt.payload.settlement.reference, "| data", JSON.stringify(r.body.data)))
    .catch((e) => { console.error(String(e)); process.exit(1); });
}
