import { readdirSync, readFileSync } from "node:fs";
import { verifyReceipt } from "../src/verify.js";

export function runVectors(dir = new URL("../vectors/", import.meta.url).pathname) {
  const keyset = JSON.parse(readFileSync(dir + "keyset.json", "utf8"));
  const files = readdirSync(dir).filter((f) => /^(valid|neg)-.*\.json$/.test(f)).sort();
  return files.map((f) => {
    const v = JSON.parse(readFileSync(dir + f, "utf8"));
    const r = verifyReceipt(v.envelope, keyset);
    return { file: f, expected: v.expect, got: { ok: r.ok, reason: r.reason }, pass: r.ok === v.expect.ok && r.reason === v.expect.reason };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = runVectors();
  for (const r of res) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.file}  -> ${r.got.reason}`);
  const failed = res.filter((r) => !r.pass).length;
  console.log(`${res.length - failed}/${res.length} vectors passed`);
  process.exit(failed ? 1 : 0);
}
