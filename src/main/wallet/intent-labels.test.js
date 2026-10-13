const {
  LABELS,
  OBSERVED,
  MAX_DEPTH,
  READ_OPTIONS,
  compactReply,
  isVerifiedEvidence,
  createChainSegment,
  readLabel,
} = require('./intent-labels');
const { fakeFinalityChain, quorum, hex } = require('../../../test/helpers/fake-finality-chain');

const SENDER = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'aa'.repeat(32)}`;
const REPLACEMENT = `0x${'bb'.repeat(32)}`;
const OTHER = `0x${'ee'.repeat(32)}`;

const INTENT = {
  intentId: 'intent-0001',
  chainId: 1,
  sender: SENDER,
  nonce: 7,
  hashes: [{ hash: HASH }],
};

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
const singleton = (result) => quorum(result, { m: 1, k: 1 });

// The sender's nonce is 7 before block 1; `txs` by height.
const chainWith = (txs, options = {}) =>
  fakeFinalityChain({ sender: SENDER, startNonce: 7, txs, ...options });
const ours = (status = 1, hash = HASH) => ({ hash, nonce: 7, status });

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
    expect(isVerifiedEvidence(singleton('0x1'))).toBe(false);
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

describe('labels on the finalized chain', () => {
  test('its own transaction in a block of the finalized chain, status 1: paid', async () => {
    const chain = chainWith({ 90: [ours(1)] });
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toEqual({
      label: LABELS.PAID,
      hash: HASH,
      block: 100,
    });
    for (const [, , , options] of chain.request.mock.calls) expect(options).toEqual(READ_OPTIONS);
    expect(READ_OPTIONS).toEqual({ includeTrust: true, background: true });
  });

  test('status 0: failed', async () => {
    const chain = chainWith({ 90: [ours(0)] });
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.FAILED,
      hash: HASH,
    });
  });

  test('a replacement of its own included: paid, naming the replacement', async () => {
    const chain = chainWith({ 90: [ours(1, REPLACEMENT)] });
    const intent = { ...INTENT, hashes: [{ hash: HASH }, { hash: REPLACEMENT }] };
    await expect(readLabel(intent, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.PAID,
      hash: REPLACEMENT,
    });
  });

  test('the nonce is read at the finalized block by its hash (EIP-1898)', async () => {
    const chain = chainWith({ 90: [ours(1)] });
    await readLabel(INTENT, { request: chain.request });
    const counts = chain.reads().filter(([method]) => method === 'eth_getTransactionCount');
    expect(counts[0][1]).toEqual([SENDER, { blockHash: chain.canonicalHash(100) }]);
    expect(counts.every(([, params]) => typeof params[1]?.blockHash === 'string')).toBe(true);
  });

  test('another transaction of the sender used its nonce in a finalized block: taken, found in that block', async () => {
    // The same payment signed elsewhere, or anything else at nonce 7.
    const chain = chainWith({ 90: [{ hash: OTHER, nonce: 7, status: 1 }] });
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toEqual({
      label: LABELS.TAKEN,
      hash: null,
      block: 100,
    });
    // Positive evidence: the block that used nonce 7, read with its transactions.
    expect(chain.reads()).toContainEqual(['eth_getBlockByHash', [chain.canonicalHash(90), true]]);
  });

  test('not included, and its nonce not used at F: held, absent', async () => {
    const chain = chainWith({ 110: [ours(1)] });
    // Included at 110, above F: the receipt says so.
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.INCLUDED,
    });
    const nothing = chainWith({});
    await expect(readLabel(INTENT, { request: nothing.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.ABSENT,
    });
  });

  test('a reorg: its receipt names a block that is not on the finalized chain, held', async () => {
    const chain = chainWith({});
    chain.defineView('fork', { forkAt: 80, forkTxs: { 90: [ours(1)] }, finalized: 80 });
    chain.route('eth_getTransactionReceipt', 'fork');
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
  });

  test('a node or chain that refuses the block-hash parameter: held', async () => {
    const chain = chainWith({ 90: [ours(1)] });
    chain.reshape('eth_getTransactionCount', () => {
      throw new Error('invalid argument 1: hex string without 0x prefix');
    });
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
    });
  });

  test('no finalized block, or a chain that refuses the tag: held', async () => {
    const none = chainWith({ 90: [ours(1)] }, { finalized: null });
    await expect(readLabel(INTENT, { request: none.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
    const refused = chainWith({ 90: [ours(1)] });
    refused.reshape('eth_getBlockByNumber', () => {
      throw new Error('invalid block tag "finalized"');
    });
    await expect(readLabel(INTENT, { request: refused.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
  });

  test('Myotis and Colibri evidence labels; a quorum of one, Direct and Blockscout never do', async () => {
    for (const wrap of [myotis, colibri]) {
      const chain = chainWith({ 90: [ours(1)] });
      for (const route of [
        'eth_getBlockByNumber',
        'eth_getBlockByNumber:number',
        'eth_getTransactionCount',
        'eth_getTransactionReceipt',
      ]) {
        chain.wrap(route, wrap);
      }
      await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
        label: LABELS.PAID,
      });
    }
    for (const wrap of [singleton, direct, blockscout]) {
      for (const route of [
        'eth_getBlockByNumber',
        'eth_getTransactionCount',
        'eth_getTransactionReceipt',
      ]) {
        const paid = chainWith({ 90: [ours(1)] });
        paid.wrap(route, wrap);
        await expect(readLabel(INTENT, { request: paid.request })).resolves.toMatchObject({
          label: LABELS.HELD,
        });
        const taken = chainWith({ 90: [{ hash: OTHER, nonce: 7 }] });
        taken.wrap(route, wrap);
        await expect(readLabel(INTENT, { request: taken.request })).resolves.toMatchObject({
          label: LABELS.HELD,
        });
      }
      // The block that used the nonce, read on unverified evidence.
      const taken = chainWith({ 90: [{ hash: OTHER, nonce: 7 }] });
      taken.wrap('eth_getBlockByHash', wrap);
      taken.wrap('eth_getBlockByNumber:number', wrap);
      await expect(readLabel(INTENT, { request: taken.request })).resolves.toMatchObject({
        label: LABELS.HELD,
      });
    }
  });
});

// The #712 review: each read is agreed separately, by whichever pair
// answers first. A lying X pairs with honest A for one read and with an
// honest B, lagging or on an unfinalized fork, for another.
describe('reads agreed by different honest views (#712 review)', () => {
  test("split-fork-paid: F from A, the receipt and its block from B's unfinalized fork, never paid", async () => {
    for (const status of [1, 0]) {
      const chain = chainWith({});
      chain.defineView('fork', { forkAt: 80, forkTxs: { 90: [ours(status)] }, finalized: 80 });
      chain.route('eth_getTransactionReceipt', 'fork');
      chain.route('eth_getBlockByNumber:number', 'fork');
      const label = await readLabel(INTENT, { request: chain.request });
      expect(label).toMatchObject({ label: LABELS.HELD });
    }
  });

  test("a fork's receipt while another transaction used the nonce on the finalized chain: never paid", async () => {
    // Finalized: another transaction at nonce 7 (C = 8 > N). B's fork: ours.
    const chain = chainWith({ 85: [{ hash: OTHER, nonce: 7 }] });
    chain.defineView('fork', { forkAt: 80, forkTxs: { 90: [ours(1)] }, finalized: 80 });
    chain.route('eth_getTransactionReceipt', 'fork');
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
    });
  });

  test("split-evidence: F and the nonce from A, a lagging B's null receipt, never taken", async () => {
    const chain = chainWith({ 90: [ours(1)] });
    chain.defineView('lagging', { head: 85, finalized: 80 });
    chain.route('eth_getTransactionReceipt', 'lagging');
    // Its own transaction used the nonce: held until a receipt agrees.
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.INCLUDED,
    });
  });

  test("a lagging pair's older finalized block: labels at that block, on the same chain", async () => {
    const chain = chainWith({ 90: [ours(1)] });
    chain.defineView('lagging', { head: 98, finalized: 95 });
    chain.route('eth_getBlockByNumber', 'lagging');
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toEqual({
      label: LABELS.PAID,
      hash: HASH,
      block: 95,
    });
  });

  test('headers by number from a fork are checked by hash link, and fetched by hash instead', async () => {
    const chain = chainWith({ 90: [ours(1)] });
    chain.defineView('fork', { forkAt: 80, finalized: 80 });
    chain.route('eth_getBlockByNumber:number', 'fork');
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.PAID,
    });
    const byHash = chain.reads().filter(([method]) => method === 'eth_getBlockByHash');
    expect(byHash.length).toBeGreaterThan(0);
    expect(byHash.every(([, params]) => params[0].startsWith('0xc0'))).toBe(true);
  });
});

describe('malformed evidence stays held (#712 review)', () => {
  test('missing-block-hashes: a receipt with no block hash, a block with no hash', async () => {
    const receipt = chainWith({ 90: [ours(1)] });
    receipt.reshape('eth_getTransactionReceipt', (answer) => {
      const { blockHash: _, ...rest } = answer;
      return rest;
    });
    await expect(readLabel(INTENT, { request: receipt.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
    const block = chainWith({ 90: [ours(1)] });
    block.reshape(
      'eth_getBlockByNumber:number',
      (answer) => answer && { ...answer, hash: undefined }
    );
    block.reshape('eth_getBlockByHash', (answer) => answer && { ...answer, hash: undefined });
    await expect(readLabel(INTENT, { request: block.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
  });

  test('undefined-receipt: no result is not a null receipt, so never taken', async () => {
    const chain = chainWith({ 90: [{ hash: OTHER, nonce: 7 }] });
    chain.reshape('eth_getTransactionReceipt', () => undefined);
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
    });
  });

  test('a block of another height than asked, a receipt for another transaction or sender, a bad status', async () => {
    const height = chainWith({ 90: [ours(1)] });
    height.reshape(
      'eth_getBlockByNumber:number',
      (answer) => answer && { ...answer, number: hex(1) }
    );
    height.reshape('eth_getBlockByHash', (answer) => answer && { ...answer, number: hex(1) });
    await expect(readLabel(INTENT, { request: height.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
    for (const bad of [
      { transactionHash: REPLACEMENT },
      { from: '0x2222222222222222222222222222222222222222' },
      { from: undefined },
      { status: '0x2' },
      { status: undefined },
      { blockNumber: 'ninety' },
      { blockHash: '0xcd' },
    ]) {
      const chain = chainWith({ 90: [ours(1)] });
      chain.reshape('eth_getTransactionReceipt', (answer) => answer && { ...answer, ...bad });
      await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
        label: LABELS.HELD,
      });
    }
  });

  test('a finalized nonce that disagrees with an included receipt: held', async () => {
    const chain = chainWith({ 90: [ours(1)] });
    chain.reshape('eth_getTransactionCount', () => hex(7));
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
    });
  });

  test('the block that used the nonce without such a transaction of the sender: held', async () => {
    const chain = chainWith({ 90: [{ hash: OTHER, nonce: 7 }] });
    chain.reshape('eth_getBlockByHash', (answer, params) =>
      params[1] ? { ...answer, transactions: [] } : answer
    );
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
  });
});

describe('the verified chain and its bounds', () => {
  test('kept across intents and passes: a later read walks only the new headers', async () => {
    const chain = chainWith({ 90: [ours(1)], 95: [{ hash: OTHER, nonce: 8 }] }, { head: 200 });
    const segment = createChainSegment();
    await readLabel(INTENT, { request: chain.request, segment });
    const walked = () =>
      chain
        .reads()
        .filter(
          ([method, params]) => method === 'eth_getBlockByNumber' && params[0] !== 'finalized'
        ).length;
    const first = walked();
    expect(first).toBe(10); // 99 down to 90

    // F moves to 130: only 101..129 are new; 90 is already verified.
    chain.views.canonical.finalized = 130;
    await expect(readLabel(INTENT, { request: chain.request, segment })).resolves.toMatchObject({
      label: LABELS.PAID,
      block: 130,
    });
    expect(walked() - first).toBe(29);
  });

  test('taken needs at most 2 × 13 nonce reads to find the block, and one block read', async () => {
    const chain = chainWith({ 1000: [{ hash: OTHER, nonce: 7 }] }, { head: 9000, finalized: 8900 });
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.TAKEN,
    });
    const counts = chain.reads().filter(([method]) => method === 'eth_getTransactionCount').length;
    expect(counts).toBeLessThanOrEqual(1 + 2 * 13);
    expect(
      chain.reads().filter(([method]) => method === 'eth_getBlockByHash' && method).length
    ).toBeLessThanOrEqual(1);
  });

  test(`deeper than ${MAX_DEPTH} blocks below F: held, recorded as unverifiable`, async () => {
    const used = chainWith({ 10: [{ hash: OTHER, nonce: 7 }] }, { head: 9300, finalized: 9250 });
    await expect(readLabel(INTENT, { request: used.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNVERIFIABLE,
    });
    const receipt = chainWith({ 10: [ours(1)] }, { head: 9300, finalized: 9250 });
    await expect(readLabel(INTENT, { request: receipt.request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNVERIFIABLE,
    });
    // It looked no deeper than the bound.
    const deepest = Math.min(
      ...receipt
        .reads()
        .filter(
          ([method, params]) => method === 'eth_getBlockByNumber' && params[0] !== 'finalized'
        )
        .map(([, params]) => Number(BigInt(params[0])))
    );
    expect(deepest).toBeGreaterThanOrEqual(9250 - Number(MAX_DEPTH));
  });

  test('read failures: held', async () => {
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

// #712 review, round 2, and the window rules of freedom-core #71.
describe('what a walk keeps, and the retained window', () => {
  test('replies are compacted to what a label uses', () => {
    const block = {
      number: '0x5a',
      hash: `0x${'cd'.repeat(32)}`,
      parentHash: `0x${'ce'.repeat(32)}`,
      transactions: [{ hash: OTHER, from: SENDER, nonce: '0x7', input: '0x' + 'ab'.repeat(5000) }],
      logsBloom: '0x' + '00'.repeat(256),
    };
    const wrap = (result) => quorum(result);
    expect(compactReply('eth_getBlockByNumber', ['0x5a', false], wrap(block)).result).toEqual({
      number: '0x5a',
      hash: block.hash,
      parentHash: block.parentHash,
    });
    expect(compactReply('eth_getBlockByHash', [block.hash, true], wrap(block)).result).toEqual({
      number: '0x5a',
      hash: block.hash,
      parentHash: block.parentHash,
      transactions: [{ hash: OTHER, from: SENDER, nonce: '0x7' }],
    });
    // Trust and source stay; other reads are untouched.
    expect(compactReply('eth_getBlockByNumber', ['0x5a', false], wrap(block)).trust).toEqual(
      wrap(block).trust
    );
    const receipt = wrap({ transactionHash: HASH });
    expect(compactReply('eth_getTransactionReceipt', [HASH], receipt)).toBe(receipt);
    expect(compactReply('eth_getBlockByNumber', ['0x5a', false], wrap(null)).result).toBeNull();
  });

  test('a block with more transactions than the bound is malformed evidence: held', async () => {
    const chain = chainWith({ 90: [{ hash: OTHER, nonce: 7 }] });
    chain.reshape('eth_getBlockByHash', (answer, params) =>
      params[1] ? { ...answer, transactions: Array(65537).fill(answer.transactions[0]) } : answer
    );
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
  });

  test('an F within the window that does not link to the verified chain conflicts: held, the chain kept', async () => {
    const chain = chainWith({ 90: [ours(1)] }, { head: 200 });
    const segment = createChainSegment();
    await readLabel(INTENT, { request: chain.request, segment });
    // A later finalized block on another chain (it forks below the old F).
    chain.defineView('other', { forkAt: 95, finalized: 130, head: 140, fork: 2 });
    chain.route('eth_getBlockByNumber', 'other');
    chain.route('eth_getBlockByNumber:number', 'other');
    chain.route('eth_getTransactionCount', 'other');
    await expect(readLabel(INTENT, { request: chain.request, segment })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNKNOWN,
    });
    expect(segment.top).toBe(100n);
    expect(segment.headers.get(100n).hash).toBe(chain.canonicalHash(100));
  });

  test('an F older than the retained window, and evidence below the window: held, unverifiable', async () => {
    const chain = chainWith({ 805: [ours(1)] }, { head: 9100, finalized: 9000 });
    const segment = createChainSegment();
    await readLabel(INTENT, { request: chain.request, segment }); // anchors at 9000
    expect(segment.top).toBe(9000n);

    // A lagging pair's F, 10 below the top: its receipt at 805 is within
    // 8192 of that F, but below the window kept under the top.
    chain.defineView('lagging', { head: 8995, finalized: 8990 });
    chain.route('eth_getBlockByNumber', 'lagging');
    await expect(readLabel(INTENT, { request: chain.request, segment })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNVERIFIABLE,
    });

    // An F older than the window altogether.
    chain.defineView('stale', { head: 600, finalized: 500 });
    chain.route('eth_getBlockByNumber', 'stale');
    await expect(readLabel(INTENT, { request: chain.request, segment })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNVERIFIABLE,
    });
  });

  test('a walk that fails partway keeps what it verified, and the next one goes on from there', async () => {
    const chain = chainWith({ 300: [ours(1)] }, { head: 1100, finalized: 1000 });
    let failBelow = 600;
    const request = jest.fn(async (chainId, method, params, options) => {
      const height = method.startsWith('eth_getBlockBy') && params[0] !== 'finalized';
      if (height && method === 'eth_getBlockByNumber' && Number(BigInt(params[0])) < failBelow) {
        throw new Error('timeout');
      }
      if (height && method === 'eth_getBlockByHash') {
        const at = chain.views.canonical.blocks.get(params[0]);
        if (at && Number(BigInt(at.number)) < failBelow) throw new Error('timeout');
      }
      return chain.request(chainId, method, params, options);
    });
    const segment = createChainSegment();
    await expect(readLabel(INTENT, { request, segment })).resolves.toMatchObject({
      label: LABELS.HELD,
    });
    expect(segment.bottom).toBe(600n);

    failBelow = 0;
    request.mockClear();
    await expect(readLabel(INTENT, { request, segment })).resolves.toMatchObject({
      label: LABELS.PAID,
    });
    const walked = request.mock.calls
      .filter(
        ([, method, params]) => method === 'eth_getBlockByNumber' && params[0] !== 'finalized'
      )
      .map(([, , params]) => Number(BigInt(params[0])));
    expect(Math.max(...walked)).toBe(599);
  });
});
