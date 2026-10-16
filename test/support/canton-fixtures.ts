// TEST-ONLY Canton fixtures. Party namespaces and update ids are fabricated from public labels
// (sha256 of a string), not real MainNet/DevNet parties. The ledger responses are hand-built in the
// shape of the JSON Ledger API v2 OpenAPI (JsGetUpdateResponse); they were not captured from a node.
import { createHash } from "node:crypto";
import { atomicToDecimal, type ExactCantonRequirements, type ExactCantonSettleResponse } from "../../src/canton.js";

const h = (label: string) => createHash("sha256").update(`x402-receipts TEST-ONLY canton: ${label}`).digest("hex");
export const party = (hint: string) => `${hint}::1220${h("party " + hint)}`;

export const NETWORK = "canton:devnet";
export const PAYER = party("test-agent");
export const PAYEE = party("test-merchant");
export const OTHER = party("someone-else");
export const FACILITATOR = party("test-facilitator");
export const DSO = party("DSO");
export const SYNCHRONIZER = `global-domain::1220${h("synchronizer")}`;
export const UPDATE_ID = "1220" + h("update 001");
export const AMOUNT = "1000000000"; // 0.1 CC
export const RECORD_TIME = "2026-10-16T09:00:03.120Z";

export const requirements: ExactCantonRequirements = {
  scheme: "exact",
  network: NETWORK,
  amount: AMOUNT,
  asset: "CC",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: {
    assetTransferMethod: "transfer-factory",
    feePayer: FACILITATOR,
    synchronizerId: SYNCHRONIZER,
    instrumentId: { admin: DSO, id: "Amulet" },
    executeBeforeSeconds: 120,
  },
};

export const settle: ExactCantonSettleResponse = { success: true, payer: PAYER, transaction: UPDATE_ID, network: NETWORK };

const PKG = "0".repeat(60) + "abcd"; // fake package id
const tx = (events: unknown[]) => ({
  update: {
    Transaction: {
      value: {
        updateId: UPDATE_ID,
        effectiveAt: "2026-10-16T09:00:02.950Z",
        events,
        offset: 4242,
        synchronizerId: SYNCHRONIZER,
        recordTime: RECORD_TIME,
      },
    },
  },
});

/** View of the payee: no root exercise, one Amulet holding created for it (Holding interface view). */
export function payeeView(opts: { owner?: string; amount?: string } = {}) {
  return tx([
    {
      CreatedEvent: {
        offset: 4242, nodeId: 7, contractId: "00" + h("holding"), templateId: `${PKG}:Splice.Amulet:Amulet`,
        createArgument: { dso: DSO, owner: opts.owner ?? PAYEE, amount: { initialAmount: atomicToDecimal(opts.amount ?? AMOUNT) } },
        interfaceViews: [{
          interfaceId: `${PKG}:Splice.Api.Token.HoldingV1:Holding`,
          viewStatus: { code: 0, message: "" },
          viewValue: { owner: opts.owner ?? PAYEE, instrumentId: { admin: DSO, id: "Amulet" }, amount: atomicToDecimal(opts.amount ?? AMOUNT), lock: null, meta: { values: {} } },
        }],
        witnessParties: [opts.owner ?? PAYEE], signatories: [DSO, opts.owner ?? PAYEE], observers: [],
        createdAt: "2026-10-16T09:00:02.950Z", packageName: "splice-amulet", acsDelta: true,
      },
    },
  ]);
}

/** View of the payer: the TransferFactory_Transfer exercise with its Transfer argument. */
export function payerView(opts: { receiver?: string; amount?: string; tag?: string } = {}) {
  return tx([
    {
      ExercisedEvent: {
        offset: 4242, nodeId: 0, contractId: "00" + h("amulet-rules"), templateId: `${PKG}:Splice.AmuletRules:AmuletRules`,
        interfaceId: `${PKG}:Splice.Api.Token.TransferInstructionV1:TransferFactory`,
        choice: "TransferFactory_Transfer",
        choiceArgument: {
          expectedAdmin: DSO,
          transfer: {
            sender: PAYER, receiver: opts.receiver ?? PAYEE, amount: atomicToDecimal(opts.amount ?? AMOUNT),
            instrumentId: { admin: DSO, id: "Amulet" }, requestedAt: "2026-10-16T09:00:00Z", executeBefore: "2026-10-16T09:02:00Z",
            inputHoldingCids: ["00" + h("input")], meta: { values: {} },
          },
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
        actingParties: [PAYER], consuming: false, witnessParties: [PAYER], lastDescendantNodeId: 9,
        exerciseResult: { output: { tag: opts.tag ?? "TransferInstructionResult_Completed", value: { receiverHoldingCids: ["00" + h("holding")] } }, senderChangeCids: [], meta: { values: {} } },
        packageName: "splice-amulet", acsDelta: false,
      },
    },
  ]);
}

/** Mock fetch that serves one canned JSON API response and records requests. */
export function mockLedger(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => response };
  };
  return { fetchFn, calls };
}
