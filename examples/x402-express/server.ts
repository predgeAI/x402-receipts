// Minimal x402 v2 resource server with a MOCKED facilitator that issues signed receipts.
// Uses the TEST-ONLY seed unless X402_RECEIPT_SEED_HEX is set. Do not use test keys in production.
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { hashJson, issueReceipt, keysetEntry, WELL_KNOWN_PATH } from "../../src/index.js";
import { TEST_KID, TEST_SEED } from "../../test/support/test-keys.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

export function createApp(opts: { origin: string; seed?: Uint8Array } = { origin: "http://localhost:4021" }) {
  const seed = opts.seed ?? (process.env.X402_RECEIPT_SEED_HEX ? Uint8Array.from(Buffer.from(process.env.X402_RECEIPT_SEED_HEX, "hex")) : TEST_SEED);
  const kid = TEST_KID;
  const app = express();

  app.get(WELL_KNOWN_PATH, (_req, res) => res.json({ keys: [keysetEntry(seed, kid, "2026-01-01T00:00:00Z", null)] }));

  app.get("/weather", (req, res) => {
    const resourceUrl = `${opts.origin}/weather`;
    const requirements = { scheme: "exact", network: NETWORK, amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
    const sigHeader = req.header("PAYMENT-SIGNATURE");
    if (!sigHeader) {
      const required = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: resourceUrl, description: "Current weather", mimeType: "application/json" }, accepts: [requirements] };
      res.status(402).set("PAYMENT-REQUIRED", b64(required)).json(required);
      return;
    }
    // MOCK settlement: a real server would call a facilitator /verify and /settle here.
    let payment: any;
    try { payment = JSON.parse(Buffer.from(sigHeader, "base64").toString("utf8")); } catch { res.status(400).json({ error: "bad payment header" }); return; }
    if (payment?.x402Version !== 2 || typeof payment?.payload?.from !== "string") { res.status(400).json({ error: "bad payment payload" }); return; }
    const txHash = "0x" + randomBytes(32).toString("hex");
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const receipt = issueReceipt({
      version: "1", receiptId: randomUUID(),
      payer: `${NETWORK}:${payment.payload.from}`, payee: `${NETWORK}:${PAY_TO}`,
      asset: `${NETWORK}/erc20:${USDC}`, amount: requirements.amount,
      settlement: { network: NETWORK, reference: txHash, settledAt: now },
      x402: { resource: resourceUrl, paymentRequirementsHash: hashJson(requirements) },
      issuer: { id: opts.origin, kid }, issuedAt: now,
    }, seed, kid);
    res.set("PAYMENT-RESPONSE", b64({ success: true, transaction: txHash, network: NETWORK, payer: payment.payload.from }));
    res.set("X-402-Receipt", Buffer.from(JSON.stringify(receipt)).toString("base64url"));
    res.json({ data: { city: "Dubai", tempC: 34 }, receipt });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4021);
  createApp({ origin: `http://localhost:${port}` }).listen(port, () => console.log(`x402 example server on http://localhost:${port}/weather (mock settlement, test keys)`));
}
