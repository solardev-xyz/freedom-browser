const { readRailgunRecoveryFinality: read } = require('./railgun-recovery-finality');
const B = '0x' + 'b'.repeat(64),
  C = '0x' + 'c'.repeat(64),
  D = '0x' + 'd'.repeat(64);
let network, blocks, finalized, record, current;
beforeEach(() => {
  blocks = {
    '0x10': { number: '0x10', hash: B },
    '0x11': { number: '0x11', hash: C },
    '0x12': { number: '0x12', hash: D },
  };
  finalized = { ...blocks['0x11'] };
  record = { observation: { blockNumber: 16, blockHash: B } };
  current = jest.fn();
  network = {
    request: jest.fn(async (_chain, method, params) => ({
      result:
        method === 'eth_blockNumber'
          ? '0x12'
          : params[0] === 'finalized'
            ? finalized
            : blocks[params[0]],
    })),
  };
});
test('binds tagged finality to a numbered header and a fresh head', async () => {
  expect(await read(network, record, current)).toEqual({ number: 17, hash: C });
  expect(network.request.mock.calls.map((v) => v[1])).toEqual([
    'eth_getBlockByNumber',
    'eth_blockNumber',
    'eth_getBlockByNumber',
    'eth_getBlockByNumber',
  ]);
});
test('advancement requires the previously reviewed anchor to remain canonical', async () => {
  const previous = await read(network, record, current);
  finalized = { ...blocks['0x12'] };
  expect(await read(network, record, current, previous)).toEqual({ number: 18, hash: D });
  blocks['0x11'].hash = D;
  await expect(read(network, record, current, previous)).rejects.toThrow();
});
test.each(['ahead', 'regressed', 'same-height-reorg', 'noncanonical', 'inclusion-mismatch'])(
  'refuses %s finality evidence',
  async (mode) => {
    const previous = { number: 17, hash: C };
    if (mode === 'ahead') finalized = { number: '0x100', hash: D };
    if (mode === 'regressed') finalized = { ...blocks['0x10'] };
    if (mode === 'same-height-reorg') {
      finalized.hash = D;
      blocks['0x11'].hash = D;
    }
    if (mode === 'noncanonical') blocks['0x11'].hash = D;
    if (mode === 'inclusion-mismatch') {
      record.observation.blockNumber = 17;
    }
    await expect(read(network, record, current, previous)).rejects.toThrow();
  }
);
test('a moving finalized tag during acquisition refuses the spliced snapshot', async () => {
  const original = network.request.getMockImplementation();
  let tags = 0;
  network.request.mockImplementation(async (...args) => {
    if (args[2][0] === 'finalized' && ++tags === 2) finalized = { ...blocks['0x12'] };
    return original(...args);
  });
  await expect(read(network, record, current)).rejects.toThrow();
});
test('revocation after any awaited read prevents further requests', async () => {
  let valid = true;
  current.mockImplementation(() => {
    if (!valid) throw Error('revoked');
  });
  const original = network.request.getMockImplementation();
  network.request.mockImplementation(async (...args) => {
    const result = await original(...args);
    valid = false;
    return result;
  });
  await expect(read(network, record, current)).rejects.toThrow();
  expect(network.request).toHaveBeenCalledTimes(1);
});
