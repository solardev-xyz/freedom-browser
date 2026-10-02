const { scanRailgunWallet } = require('./railgun-wallet-scan');
let input;
beforeEach(() => {
  input = {
    signal: new AbortController().signal,
    checkpoint: { state: { trees: [] } },
    tree: { getTreeLength: jest.fn(), getRoot: jest.fn(), getCommitmentRange: jest.fn() },
    wallet: {
      loadUTXOMerkletree: jest.fn(async () => {}),
      scanLeaves: jest.fn(async () => {}),
      TXOs: jest.fn(async () => []),
      getSentCommitments: jest.fn(async () => []),
    },
    runtime: { TransactNote: { getNullifier: jest.fn() } },
  };
});
test('a revoked window never starts SDK reads or writes', async () => {
  input.signal = AbortSignal.abort();
  await expect(scanRailgunWallet(input)).rejects.toThrow('cancelled');
  expect(input.wallet.loadUTXOMerkletree).not.toHaveBeenCalled();
});
test.each(['loadUTXOMerkletree', 'TXOs', 'getSentCommitments'])(
  'refuses replacement of the source-only resolver during %s',
  async (method) => {
    input.wallet[method].mockImplementation(async () => {
      input.wallet.tokenDataGetter = {};
      return [];
    });
    await expect(scanRailgunWallet(input)).rejects.toThrow();
  }
);
test.each(['length', 'root', 'missing-leaf', 'wrong-position', 'unsupported-type'])(
  'refuses %s before a wallet scan can publish anything',
  async (mode) => {
    input.checkpoint.state.trees = [{ tree: 0, length: 1, root: '0x' + '1'.repeat(64) }];
    input.tree.getTreeLength.mockResolvedValue(mode === 'length' ? 2 : 1);
    input.tree.getRoot.mockResolvedValue((mode === 'root' ? '2' : '1').repeat(64));
    input.tree.getCommitmentRange.mockResolvedValue(
      mode === 'missing-leaf'
        ? []
        : [
            {
              utxoTree: 0,
              utxoIndex: mode === 'wrong-position' ? 1 : 0,
              commitmentType: 'Unsupported',
            },
          ]
    );
    await expect(scanRailgunWallet(input)).rejects.toThrow();
    expect(input.wallet.scanLeaves).not.toHaveBeenCalled();
    expect(input.wallet.TXOs).not.toHaveBeenCalled();
  }
);
test('an empty completed public history produces no spendable grant or invented notes', async () => {
  expect(await scanRailgunWallet(input)).toEqual({
    scannedLeaves: 0,
    expectedReceived: [],
    expectedSent: [],
    quarantine: [],
    unrecoverableSent: [],
    received: [],
    sent: [],
    spendableGranted: false,
  });
});
