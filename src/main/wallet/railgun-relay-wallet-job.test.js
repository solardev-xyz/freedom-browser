const mockWallet = jest.fn(),
  mockPrepare = jest.fn(),
  mockReconstruct = jest.fn();
jest.mock('./railgun-wallet-job', () => ({ withWallet: (...args) => mockWallet(...args) }));
jest.mock('./railgun-relay-witness', () => ({
  prepareRailgunRelayDraft: (...args) => mockPrepare(...args),
}));
jest.mock('./railgun-relay-reconstruct', () => ({
  reconstructRailgunRelayDraft: (...args) => mockReconstruct(...args),
}));
const { run } = require('./railgun-relay-wallet-job');
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
function input(constructing = true) {
  const { draft, request } = createRailgunRelayUnsignedData();
  return {
    archive: '/public-engine.asar',
    descriptor: {},
    checkpoint: {},
    walletId: draft.walletId,
    restore: true,
    prefixes: [],
    ...(constructing ? { relayRequest: request } : { relayDraftText: JSON.stringify(draft) }),
  };
}
beforeEach(() => jest.resetAllMocks());
test.each([true, false])(
  'fixed viewing-only job selects exactly one implementation (%s)',
  async (constructing) => {
    const value = input(constructing),
      restored = { wallet: {}, scan: {}, signal: new AbortController().signal },
      output = { public: 'diagnostic' };
    mockPrepare.mockResolvedValue(output);
    mockReconstruct.mockResolvedValue(output);
    mockWallet.mockImplementation(async (text, context, purpose, callback) => {
      expect(JSON.parse(text)).toEqual(value);
      expect(context).toEqual({ host: true });
      expect(purpose).toBe(constructing ? 'relay-prepare' : 'relay-reconstruct');
      return callback(restored);
    });
    expect(await run(JSON.stringify(value), { host: true })).toEqual(
      constructing ? { relayDraft: output } : { relayReconstruction: output }
    );
    expect(constructing ? mockPrepare : mockReconstruct).toHaveBeenCalledWith({
      ...restored,
      ...(constructing ? { request: value.relayRequest } : { draftText: value.relayDraftText }),
    });
    expect(constructing ? mockReconstruct : mockPrepare).not.toHaveBeenCalled();
  }
);
test.each([
  ['writable scan', (v) => (v.restore = false)],
  ['missing mode', (v) => delete v.relayRequest],
  ['dual mode', (v) => (v.relayDraftText = input(false).relayDraftText)],
  ['private intent', (v) => (v.privateIntent = {})],
  ['private operation', (v) => (v.privateOperation = {})],
  ['private recovery', (v) => (v.privateRecovery = {})],
  ['extra authority', (v) => (v.proverArchive = '/prover.asar')],
  ['invalid request', (v) => (v.relayRequest.selection.position = -1)],
  ['different wallet', (v) => (v.walletId = '99'.repeat(32))],
  [
    'malformed serialized draft',
    (v) => {
      delete v.relayRequest;
      v.relayDraftText = '{}';
    },
  ],
])('refuses %s before restoring or borrowing a key', async (_name, change) => {
  const value = input();
  change(value);
  await expect(run(JSON.stringify(value), {})).rejects.toThrow();
  expect(mockWallet).not.toHaveBeenCalled();
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockReconstruct).not.toHaveBeenCalled();
});
test.each([true, false])('utility failure cannot produce success (%s)', async (constructing) => {
  mockWallet.mockImplementation((_text, _context, _purpose, callback) => callback({}));
  (constructing ? mockPrepare : mockReconstruct).mockRejectedValue(Error('refused'));
  await expect(run(JSON.stringify(input(constructing)), {})).rejects.toThrow('refused');
});
