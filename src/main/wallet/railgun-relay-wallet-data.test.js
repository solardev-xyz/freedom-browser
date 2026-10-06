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
function prePoiFixture() {
  const f =
    require('../../../scripts/fixtures/railgun-relay-main-proof-data').createRailgunRelayMainProofData();
  return {
    walletId: f.record.walletId,
    input: { draftText: JSON.stringify(f.record.draft), history: f.record.history },
    result: {
      binding: f.record.prePoiBinding,
      historyDigest: f.proof.historyDigest,
      draftDigest: f.proof.draftDigest,
      expectedHash: f.proof.expectedHash,
    },
  };
}
test('pre-POI input/result are detached exact values, not authority', () => {
  const f = prePoiFixture(),
    d = require('./railgun-relay-wallet-data');
  const input = d.normalizeRailgunRelayPrePoiInput(f.input, f.walletId),
    result = d.normalizeRailgunRelayPrePoiResult(f.result, input, f.walletId);
  expect(input).toEqual(f.input);
  expect(result).toEqual(f.result);
  expect(input.history).not.toBe(f.input.history);
  expect(result.binding).not.toBe(f.result.binding);
  expect(Object.isFrozen(input.history)).toBe(true);
  expect(Object.isFrozen(result.binding)).toBe(true);
});
test.each([
  'input-extra',
  'input-accessor',
  'input-proxy',
  'noncanonical',
  'wallet',
  'history',
  'binding',
  'list',
  'history-digest',
  'draft-digest',
  'expected',
  'result-extra',
  'result-accessor',
  'result-proxy',
])('pre-POI boundary refuses %s', (mode) => {
  const f = prePoiFixture(),
    d = require('./railgun-relay-wallet-data');
  let reads = 0;
  if (mode === 'input-extra') f.input.verified = true;
  if (mode === 'input-accessor')
    Object.defineProperty(f.input, 'draftText', {
      enumerable: true,
      get() {
        reads++;
        return '{}';
      },
    });
  if (mode === 'input-proxy')
    f.input = new Proxy(f.input, {
      get() {
        reads++;
        throw Error('trap');
      },
    });
  if (mode === 'noncanonical') f.input.draftText = ' ' + f.input.draftText;
  if (mode === 'wallet') f.walletId = 'ff'.repeat(32);
  if (mode === 'history') f.input.history.draftDigest = 'ff'.repeat(32);
  if (mode === 'binding') f.result.binding.draftDigest = 'ff'.repeat(32);
  if (mode === 'list') f.result.binding.listWitness.root = '0'.repeat(63) + '9';
  if (mode === 'history-digest') f.result.historyDigest = 'ff'.repeat(32);
  if (mode === 'draft-digest') f.result.draftDigest = 'ff'.repeat(32);
  if (mode === 'expected') f.result.expectedHash = '0x' + '0'.repeat(63) + '9';
  if (mode === 'result-extra') f.result.witness = {};
  if (mode === 'result-accessor')
    Object.defineProperty(f.result, 'binding', {
      enumerable: true,
      get() {
        reads++;
        return {};
      },
    });
  if (mode === 'result-proxy')
    f.result = new Proxy(f.result, {
      get() {
        reads++;
        throw Error('trap');
      },
    });
  expect(() => d.normalizeRailgunRelayPrePoiResult(f.result, f.input, f.walletId)).toThrow();
  expect(reads).toBe(0);
});
