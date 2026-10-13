const {
  LABELS,
  OBSERVED,
  READ_OPTIONS,
  isVerifiedEvidence,
  readLabel,
} = require('./intent-labels');

const SENDER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'aa'.repeat(32)}`;
const REPLACEMENT = `0x${'bb'.repeat(32)}`;
const BLOCK_HASH = `0x${'cc'.repeat(32)}`;
const hex = (n) => `0x${n.toString(16)}`;

const INTENT = {
  intentId: 'intent-0001',
  chainId: 1,
  sender: SENDER,
  nonce: 7,
  hashes: [{ hash: HASH }],
};

// A read's reply as chain-data returns it with trust.
const quorum = (result, { m = 2, k = 3, achieved = true } = {}) => ({
  result,
  source: 'quorum',
  verified: true,
  trust: { level: 'verified', method: 'quorum', block: null, quorum: { k, m, achieved } },
});
const myotis = (result) => ({
  result,
  source: 'myotis',
  verified: true,
  trust: {
    level: 'verified',
    method: 'myotis',
    finality: 'optimistic',
    quorum: { k: 1, m: 1, achieved: true },
  },
});
const colibri = (result) => ({
  result,
  source: 'colibri',
  verified: true,
  trust: { level: 'verified', method: 'colibri', quorum: { k: 1, m: 1, achieved: true } },
});
// A quorum that fell back to Direct: one endpoint's answer.
const direct = (result) => ({
  result,
  source: 'direct',
  verified: false,
  trust: { level: 'unverified', method: 'direct', quorum: { k: 3, m: 2, achieved: false } },
});
const blockscout = (result) => ({
  result,
  source: 'blockscout',
  verified: true,
  trust: { level: 'verified', method: 'blockscout', quorum: { k: 2, m: 2, achieved: true } },
});

const receipt = (overrides = {}) => ({
  transactionHash: HASH,
  from: SENDER,
  blockNumber: hex(90),
  blockHash: BLOCK_HASH,
  status: '0x1',
  ...overrides,
});

/**
 * A chain as the reads see it: the finalized block, the sender's
 * finalized count, receipts by hash and blocks by number, each wrapped by
 * `source` (quorum unless a test says otherwise). Records every call.
 */
function chain({
  finalized = 100,
  count = 7,
  receipts = {},
  blocks = { [hex(90)]: { number: hex(90), hash: BLOCK_HASH } },
  source = {},
} = {}) {
  const calls = [];
  const request = jest.fn(async (chainId, method, params, options) => {
    calls.push({ method, params, options });
    const wrap = source[method] ?? quorum;
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
      if (finalized instanceof Error) throw finalized;
      return wrap(
        finalized === null ? null : { number: hex(finalized), hash: `0x${'ff'.repeat(32)}` }
      );
    }
    if (method === 'eth_getTransactionCount') return wrap(hex(count));
    if (method === 'eth_getTransactionReceipt') return wrap(receipts[params[0]] ?? null);
    if (method === 'eth_getBlockByNumber')
      return (source.block ?? quorum)(blocks[params[0]] ?? null);
    throw new Error(`unexpected ${method}`);
  });
  return { request, calls };
}

describe('what counts as evidence', () => {
  test('Myotis, Colibri, and a quorum agreed among at least two endpoints', () => {
    expect(isVerifiedEvidence(myotis('0x1'))).toBe(true);
    expect(isVerifiedEvidence(colibri('0x1'))).toBe(true);
    expect(isVerifiedEvidence(quorum('0x1', { m: 2 }))).toBe(true);
    expect(isVerifiedEvidence(quorum('0x1', { m: 3 }))).toBe(true);
  });

  test('not Direct, Blockscout, a quorum of one, an unachieved quorum, or a label that disagrees with its source', () => {
    expect(isVerifiedEvidence(direct('0x1'))).toBe(false);
    expect(isVerifiedEvidence(blockscout('0x1'))).toBe(false);
    expect(isVerifiedEvidence(quorum('0x1', { m: 1, k: 1 }))).toBe(false);
    expect(isVerifiedEvidence(quorum('0x1', { achieved: false }))).toBe(false);
    expect(isVerifiedEvidence({ ...quorum('0x1'), source: 'direct' })).toBe(false);
    expect(
      isVerifiedEvidence({
        ...myotis('0x1'),
        trust: { ...myotis('0x1').trust, level: 'unverified' },
      })
    ).toBe(false);
    expect(isVerifiedEvidence({ result: '0x1', source: 'quorum', verified: true })).toBe(false);
    expect(isVerifiedEvidence(null)).toBe(false);
  });
});

describe('labels at the finalized block', () => {
  test('included at or below the finalized block, in its canonical block, status 1: paid', async () => {
    const { request, calls } = chain({ receipts: { [HASH]: receipt() } });
    await expect(readLabel(INTENT, { request })).resolves.toEqual({
      label: LABELS.PAID,
      hash: HASH,
      block: 100,
    });
    // Every read asks for trust, with no routing context.
    for (const { options } of calls) expect(options).toEqual(READ_OPTIONS);
    expect(READ_OPTIONS).toEqual({ includeTrust: true, background: true });
  });

  test('status 0: failed', async () => {
    const { request } = chain({ receipts: { [HASH]: receipt({ status: '0x0' }) } });
    await expect(readLabel(INTENT, { request })).resolves.toEqual({
      label: LABELS.FAILED,
      hash: HASH,
      block: 100,
    });
  });

  test('a replacement of its own included: paid, naming the replacement', async () => {
    const intent = { ...INTENT, hashes: [{ hash: HASH }, { hash: REPLACEMENT }] };
    const { request } = chain({
      receipts: { [REPLACEMENT]: receipt({ transactionHash: REPLACEMENT }) },
    });
    await expect(readLabel(intent, { request })).resolves.toEqual({
      label: LABELS.PAID,
      hash: REPLACEMENT,
      block: 100,
    });
  });

  test('the same payment replaced from elsewhere: the nonce passed, none of its own included, taken', async () => {
    const { request } = chain({ count: 8 });
    await expect(readLabel(INTENT, { request })).resolves.toEqual({
      label: LABELS.TAKEN,
      hash: null,
      block: 100,
    });
  });

  test('none included and the nonce not passed: held, seen absent', async () => {
    const { request } = chain({ count: 7 });
    await expect(readLabel(INTENT, { request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.ABSENT,
    });
  });

  test('a receipt above the finalized block (it lags finality): held, seen included', async () => {
    const { request } = chain({
      finalized: 89,
      count: 8,
      receipts: { [HASH]: receipt({ blockNumber: hex(90) }) },
    });
    await expect(readLabel(INTENT, { request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.INCLUDED,
    });
  });

  test('a reorg before finality: the block at that height has another hash, held', async () => {
    const { request } = chain({
      count: 8,
      receipts: { [HASH]: receipt() },
      blocks: { [hex(90)]: { number: hex(90), hash: `0x${'dd'.repeat(32)}` } },
    });
    await expect(readLabel(INTENT, { request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
    });
  });

  test('inconsistent receipts (the quorum fell to Direct): held, not taken', async () => {
    // Direct says no receipt and the nonce has passed: unverified, it
    // proves nothing.
    const { request } = chain({ count: 8, source: { eth_getTransactionReceipt: direct } });
    await expect(readLabel(INTENT, { request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
    });
    // Nor does a Direct receipt make it paid.
    const paid = chain({
      receipts: { [HASH]: receipt() },
      source: { eth_getTransactionReceipt: direct },
    });
    await expect(readLabel(INTENT, { request: paid.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
  });

  test('a quorum of one counts as Direct: held', async () => {
    const singleton = (result) => quorum(result, { m: 1, k: 1 });
    for (const method of [
      'eth_getBlockByNumber',
      'eth_getTransactionCount',
      'eth_getTransactionReceipt',
    ]) {
      const { request } = chain({
        count: 8,
        receipts: { [HASH]: receipt() },
        source: { [method]: singleton },
      });
      await expect(readLabel(INTENT, { request })).resolves.toMatchObject({ label: LABELS.HELD });
    }
    const block = chain({ receipts: { [HASH]: receipt() }, source: { block: singleton } });
    await expect(readLabel(INTENT, { request: block.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
  });

  test('Myotis and Colibri evidence labels', async () => {
    for (const wrap of [myotis, colibri]) {
      const source = {
        eth_getBlockByNumber: wrap,
        eth_getTransactionCount: wrap,
        eth_getTransactionReceipt: wrap,
        block: wrap,
      };
      const { request } = chain({ receipts: { [HASH]: receipt() }, source });
      await expect(readLabel(INTENT, { request })).resolves.toMatchObject({ label: LABELS.PAID });
    }
  });

  test('no finalized block, or a chain that refuses the tag: held', async () => {
    for (const finalized of [null, new Error('invalid block tag "finalized"')]) {
      const { request, calls } = chain({ finalized, count: 8 });
      await expect(readLabel(INTENT, { request })).resolves.toMatchObject({
        label: LABELS.HELD,
        observed: OBSERVED.UNKNOWN,
      });
      expect(calls).toHaveLength(1);
    }
  });

  test('the finalized nonce is read before any receipt', async () => {
    const intent = { ...INTENT, hashes: [{ hash: HASH }, { hash: REPLACEMENT }] };
    const { request, calls } = chain({ count: 8 });
    await readLabel(intent, { request });
    expect(calls.map(({ method, params }) => [method, params[0]])).toEqual([
      ['eth_getBlockByNumber', 'finalized'],
      ['eth_getTransactionCount', SENDER],
      ['eth_getTransactionReceipt', HASH],
      ['eth_getTransactionReceipt', REPLACEMENT],
    ]);
    expect(calls[1].params).toEqual([SENDER, 'finalized']);
  });

  test("a receipt for another transaction, or another sender's: held", async () => {
    for (const bad of [{ transactionHash: REPLACEMENT }, { from: OTHER }, { from: undefined }]) {
      const { request } = chain({ count: 8, receipts: { [HASH]: receipt(bad) } });
      await expect(readLabel(INTENT, { request })).resolves.toMatchObject({ label: LABELS.HELD });
    }
  });

  test('malformed answers and failed reads: held', async () => {
    for (const receiptOverrides of [
      { blockNumber: 'ninety' },
      { status: undefined },
      { status: '0x2' },
    ]) {
      const { request } = chain({ count: 8, receipts: { [HASH]: receipt(receiptOverrides) } });
      await expect(readLabel(INTENT, { request })).resolves.toMatchObject({ label: LABELS.HELD });
    }
    const failing = jest.fn(async () => {
      throw new Error('Chain data is unavailable');
    });
    await expect(readLabel(INTENT, { request: failing })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
      reason: expect.stringContaining('Chain data is unavailable'),
    });
  });
});
