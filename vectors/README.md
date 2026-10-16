# Test vectors

TEST-ONLY keys (seeds are public strings in test/support/test-keys.ts). Regenerate with `npm run vectors:gen`; run with `npm run vectors`.

Each file: `{ description, expect: { ok, reason }, envelope }`. Verify against `keyset.json`.

Canton vectors (`*-canton-*`) may also carry `ledger: { readAs, request, response }` and `expectLedger: { ok, reason }`: `request` is the exact body `checkAgainstLedger` must POST to `/v2/updates/update-by-id`, `response` is a hand-built JSON Ledger API v2 response (not captured from a node). Parties and update ids are fabricated test values. See docs/canton-profile.md.
