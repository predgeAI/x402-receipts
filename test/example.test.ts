import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../examples/x402-express/server.js";
import { run } from "../examples/x402-express/client.js";
import { verifyReceipt } from "../src/index.js";

test("express example: 402 -> pay -> receipt verifies; tampering is caught", async () => {
  let origin = "";
  const app = createApp({ get origin() { return origin; } } as any);
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const r = await run(origin);
    assert.equal(r.result.ok, true);
    assert.equal(r.body.data.city, "Dubai");
    const ks = await (await fetch(origin + "/.well-known/x402-receipt-keys.json")).json();
    const t = structuredClone(r.receipt); t.payload.amount = "1";
    assert.equal((verifyReceipt(t, ks) as any).reason, "envelope_hash_mismatch");
  } finally { srv.close(); }
});
