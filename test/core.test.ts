import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalize, fetchKeyset, hashJson, issueReceipt, verifyReceipt } from "../src/index.js";
import { TEST_KID, TEST_SEED, testKeyset } from "./support/test-keys.js";
import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(new URL("../vectors/valid-001.json", import.meta.url), "utf8")).envelope.payload;

test("JCS: key order, escapes, numbers (RFC 8785 samples)", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalize({ "\u20ac": 1, "\r": 2, "\ufb33": 3, "1": 4 }), '{"\\r":2,"1":4,"\u20ac":1,"\ufb33":3}');
  assert.equal(canonicalize([1e21, 0.000001, -0, 4.5]), "[1e+21,0.000001,0,4.5]");
  assert.throws(() => canonicalize(NaN));
});

test("issue then verify round-trip", () => {
  const env = issueReceipt(payload, TEST_SEED, TEST_KID);
  const r = verifyReceipt(env, testKeyset());
  assert.equal(r.ok, true);
  assert.match(env.envelopeHash, /^sha256:[0-9a-f]{64}$/);
});

test("issueReceipt rejects invalid payload and kid mismatch", () => {
  assert.throws(() => issueReceipt({ ...payload, amount: "-1" }, TEST_SEED, TEST_KID));
  assert.throws(() => issueReceipt(payload, TEST_SEED, "other"));
});

test("unknown extra field is schema_invalid; non-object input is schema_invalid", () => {
  const env: any = issueReceipt(payload, TEST_SEED, TEST_KID);
  assert.equal((verifyReceipt({ ...env, extra: 1 }, testKeyset()) as any).reason, "schema_invalid");
  assert.equal((verifyReceipt(null, testKeyset()) as any).reason, "schema_invalid");
});

test("hashJson is key-order independent", () => assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 })));

test("fetchKeyset: well-known path, validation, https rule", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/.well-known/x402-receipt-keys.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(testKeyset())); }
    else if (req.url === "/bad.json") res.end(JSON.stringify({ keys: [{ kid: "x" }] }));
    else { res.statusCode = 404; res.end(); }
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const ks = await fetchKeyset(base);
    assert.equal(ks.keys.length, 2);
    assert.equal(verifyReceipt(issueReceipt(payload, TEST_SEED, TEST_KID), ks).ok, true);
    await assert.rejects(fetchKeyset(base + "/bad.json"), /malformed/);
    await assert.rejects(fetchKeyset(base + "/nope.json"), /404/);
    await assert.rejects(fetchKeyset("http://example.com"), /https/);
  } finally { srv.close(); }
});
