import { readdirSync, readFileSync } from "node:fs";
import { verifyReceipt } from "../src/verify.js";
import { checkAgainstLedger } from "../src/canton.js";

export function runVectors(dir = new URL("../vectors/", import.meta.url).pathname) {
  const keyset = JSON.parse(readFileSync(dir + "keyset.json", "utf8"));
  const files = readdirSync(dir).filter((f) => /^(valid|neg)-.*\.json$/.test(f)).sort();
  return files.map((f) => {
    const v = JSON.parse(readFileSync(dir + f, "utf8"));
    const r = verifyReceipt(v.envelope, keyset);
    return { file: f, expected: v.expect, got: { ok: r.ok, reason: r.reason }, pass: r.ok === v.expect.ok && r.reason === v.expect.reason };
  });
}

/** Level 2 vectors: replay the canned ledger response through checkAgainstLedger with a mock fetch. */
export async function runLedgerVectors(dir = new URL("../vectors/", import.meta.url).pathname) {
  const files = readdirSync(dir).filter((f) => /^(valid|neg)-.*\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const v = JSON.parse(readFileSync(dir + f, "utf8"));
    if (!v.ledger) continue;
    let sent: unknown;
    const fetchFn = async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => v.ledger.response };
    };
    const r = await checkAgainstLedger(v.envelope, fetchFn as any, { ledgerUrl: "http://participant.invalid", readAs: v.ledger.readAs });
    const requestOk = JSON.stringify(sent) === JSON.stringify(v.ledger.request);
    out.push({ file: f, expected: v.expectLedger, got: { ok: r.ok, reason: r.reason }, requestOk,
      pass: requestOk && r.ok === v.expectLedger.ok && r.reason === v.expectLedger.reason });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = runVectors();
  for (const r of res) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.file}  -> ${r.got.reason}`);
  const led = await runLedgerVectors();
  for (const r of led) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.file}  [ledger] -> ${r.got.reason}${r.requestOk ? "" : " (request body differs)"}`);
  const failed = res.filter((r) => !r.pass).length + led.filter((r) => !r.pass).length;
  console.log(`${res.length + led.length - failed}/${res.length + led.length} vector checks passed (${res.length} offline, ${led.length} ledger)`);
  process.exit(failed ? 1 : 0);
}
