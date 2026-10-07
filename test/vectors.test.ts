import { test } from "node:test";
import assert from "node:assert/strict";
import { runVectors } from "../scripts/run-vectors.js";

const results = runVectors();
test("vector set covers every reason code", () => {
  const reasons = new Set(results.map((r) => r.expected.reason));
  for (const r of ["ok", "bad_signature", "canonical_mismatch", "envelope_hash_mismatch", "unknown_kid", "key_not_valid_at_issuedAt", "schema_invalid"])
    assert.ok(reasons.has(r), r);
  assert.ok(results.length >= 9);
});
for (const r of results) test(`vector ${r.file}`, () => assert.deepEqual(r.got, r.expected));
