const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const {
  assertRailgunRelaySignal,
  normalizeRailgunRelayRequest,
  parseRailgunRelayDraft,
  normalizeRailgunRelayReconstruction,
  bindRailgunRelayDraft,
} = require('./railgun-relay-wallet-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const pins = require('./railgun-shield-pins.json');
function inputs() {
  const { draft, request } = createRailgunRelayUnsignedData();
  const normalized = normalizeRailgunRelayDraftCapsule(draft);
  const note = {
    id: '0:7',
    hash: draft.noteHash,
    txid: '0x' + 'ab'.repeat(32),
    spentTxid: false,
    amount: 700n,
    asset: { __type: 'erc20', contract: pins.wrappedNative },
  };
  return {
    draft,
    request,
    normalized,
    owner: {
      walletId: draft.walletId,
      read: { instanceId: request.context.self.address, received: [note] },
      ownedPoi: [{ ...note, nullifier: draft.intent.expected.nullifier }],
      trees: [{ tree: 0, root: draft.intent.expected.merkleRoot }],
    },
  };
}
test('native live signals accepted; aborted, proxy, subclass and shadows refused without callbacks', () => {
  const controller = new AbortController();
  expect(() => assertRailgunRelaySignal(controller.signal)).not.toThrow();
  controller.abort();
  expect(() => assertRailgunRelaySignal(controller.signal)).toThrow();
  const callback = jest.fn(() => false);
  for (const key of ['aborted', 'reason']) {
    const signal = new AbortController().signal;
    Object.defineProperty(signal, key, { get: callback });
    expect(() => assertRailgunRelaySignal(signal)).toThrow();
  }
  const proxy = new Proxy(new AbortController().signal, { getPrototypeOf: callback });
  expect(() => assertRailgunRelaySignal(proxy)).toThrow();
  const signal = new AbortController().signal;
  Object.setPrototypeOf(signal, Object.create(AbortSignal.prototype));
  expect(() => assertRailgunRelaySignal(signal)).toThrow();
  expect(callback).not.toHaveBeenCalled();
});
test('detaches exact request and canonical serialized draft without granting authority', () => {
  const { draft, request } = inputs();
  const detached = normalizeRailgunRelayRequest(request, draft.walletId);
  request.selection.position = 8;
  request.context.gas.gasEstimate = '999';
  expect(detached.selection.position).toBe(7);
  expect(detached.context.gas.gasEstimate).toBe('84');
  expect(Object.isFrozen(detached.context.gas)).toBe(true);
  const normalized = parseRailgunRelayDraft(JSON.stringify(draft), draft.walletId);
  expect(normalized.reviewedPreparation).toBe(false);
  expect(normalized.signingEnabled).toBe(false);
  for (const text of [JSON.stringify(draft, null, 2), ' '.repeat(65537), '{}'])
    expect(() => parseRailgunRelayDraft(text, draft.walletId)).toThrow();
  expect(() => parseRailgunRelayDraft(JSON.stringify(draft), '99'.repeat(32))).toThrow();
});
test('only exact reconstruction diagnostics join the original normalized draft', () => {
  const { normalized } = inputs();
  const result = {
    draftDigest: normalized.digest,
    expectedHash: normalized.data.intent.expectedHash,
    recoveredOutputs: 2,
  };
  expect(normalizeRailgunRelayReconstruction(result, normalized)).toEqual(result);
  for (const change of [
    { draftDigest: '99'.repeat(32) },
    { expectedHash: '0x' + '00'.repeat(32) },
    { recoveredOutputs: 1 },
    { signature: 'extra' },
  ])
    expect(() =>
      normalizeRailgunRelayReconstruction({ ...result, ...change }, normalized)
    ).toThrow();
});
test('draft joins main-owned original input, instance, checkpoint and fee context', () => {
  const { draft, request, owner, normalized } = inputs();
  expect(bindRailgunRelayDraft(draft, request, owner)).toEqual(normalized);
});
test.each([
  ['missing note', (x) => (x.owner.read.received = [])],
  ['duplicate note', (x) => x.owner.read.received.push(x.owner.read.received[0])],
  ['spent note', (x) => (x.owner.read.received[0].spentTxid = 'spent')],
  ['different amount', (x) => (x.owner.read.received[0].amount = 701n)],
  ['different token', (x) => (x.owner.read.received[0].asset.contract = '0x' + 'ab'.repeat(20))],
  ['wrong input hash', (x) => (x.owner.read.received[0].hash = '0x' + '99'.repeat(32))],
  ['different instance', (x) => (x.owner.read.instanceId = x.request.context.peer.address)],
  ['missing ownership', (x) => (x.owner.ownedPoi = [])],
  ['wrong nullifier', (x) => (x.owner.ownedPoi[0].nullifier = '0x' + '00'.repeat(32))],
  ['different transaction', (x) => (x.owner.ownedPoi[0].txid = '0x' + '00'.repeat(32))],
  ['missing checkpoint tree', (x) => (x.owner.trees = [])],
  ['different checkpoint root', (x) => (x.owner.trees[0].root = '0x' + '00'.repeat(32))],
  ['different selection', (x) => (x.request.selection.position = 8)],
  ['different fee cap', (x) => (x.request.context.feeCap = '101')],
  ['different engine', (x) => (x.draft.engineSha256 = '99'.repeat(32))],
])('refuses %s', (_name, change) => {
  const x = inputs();
  change(x);
  expect(() => bindRailgunRelayDraft(x.draft, x.request, x.owner)).toThrow();
});
