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
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
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
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
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
    await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
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

// freedom-core design 0005, "State history" (#94): nodes serve state for
// a window W of recent blocks, so the search for the block that used a
// nonce starts from a bracket, and Colibri answers deeper where it proves
// the reads. Here W is 128 blocks below each view's head, as geth keeps.
describe('state history (#94)', () => {
  const W = 128;
  // Another transaction of the sender at nonce 7, at `at`.
  const takenAt = (at, options = {}) =>
    chainWith({ [at]: [{ hash: OTHER, nonce: 7 }] }, { stateWindow: W, ...options });
  const countHeights = (chain) =>
    chain
      .reads()
      .filter(([method]) => method === 'eth_getTransactionCount')
      .map(([, params]) => chain.views.canonical.heights.get(params[1].blockHash));
  const fullBlockReads = (chain) =>
    chain
      .reads()
      .filter(
        ([method, params]) =>
          (method === 'eth_getBlockByHash' || method === 'eth_getBlockByNumber') &&
          params[1] === true
      );
  const bracketAt = (chain, height) => ({ number: height, hash: chain.canonicalHash(height) });

  describe('the bracket', () => {
    test('a read that finds the nonce unused at F takes the bracket there; later reads move it up, never down', async () => {
      const chain = chainWith({}, { head: 200, finalized: 100 });
      const segment = createChainSegment();
      const first = await readLabel(INTENT, { request: chain.request, segment });
      expect(first).toMatchObject({
        label: LABELS.HELD,
        observed: OBSERVED.ABSENT,
        nonceAtF: { block: 100, hash: chain.canonicalHash(100), count: 7, used: false },
        bracket: bracketAt(chain, 100),
      });

      chain.views.canonical.finalized = 130;
      const moved = await readLabel(INTENT, {
        request: chain.request,
        segment,
        bracket: first.bracket,
      });
      expect(moved.bracket).toEqual(bracketAt(chain, 130));

      // A lagging pair's older F: the nonce is unused there too, and the
      // bracket stays where it was.
      chain.defineView('lagging', { head: 125, finalized: 120 });
      chain.route('eth_getBlockByNumber', 'lagging');
      const lagged = await readLabel(INTENT, {
        request: chain.request,
        segment,
        bracket: moved.bracket,
      });
      expect(lagged).toMatchObject({ nonceAtF: { block: 120, used: false } });
      expect(lagged.bracket).toEqual(bracketAt(chain, 130));
    });

    test('a finalized nonce that disagrees with its receipt moves nothing', async () => {
      const chain = chainWith({ 90: [ours(1)] });
      chain.reshape('eth_getTransactionCount', () => hex(7));
      const bracket = bracketAt(chain, 80);
      await expect(readLabel(INTENT, { request: chain.request, bracket })).resolves.toMatchObject({
        label: LABELS.HELD,
        observed: OBSERVED.UNKNOWN,
        bracket,
      });
    });

    test('a nonce used at F leaves the bracket where it was', async () => {
      const chain = chainWith({ 90: [ours(1)] });
      const bracket = bracketAt(chain, 80);
      await expect(readLabel(INTENT, { request: chain.request, bracket })).resolves.toMatchObject({
        label: LABELS.PAID,
        nonceAtF: { block: 100, count: 8, used: true },
        bracket,
      });
    });

    test("once the nonce is used, the search runs above the bracket, within the endpoints' window, and labels the intent", async () => {
      // F is 100 below the head: a probe deeper than 28 blocks below F is
      // outside every endpoint's window. The nonce was used 20 below F.
      const chain = takenAt(80, { head: 200, finalized: 100 });
      await expect(
        readLabel(INTENT, { request: chain.request, bracket: bracketAt(chain, 79) })
      ).resolves.toMatchObject({ label: LABELS.TAKEN, block: 100, bracket: bracketAt(chain, 79) });
      // Every probe above the bracket, all within the window.
      expect(Math.min(...countHeights(chain))).toBeGreaterThan(79);
      expect(Math.min(...countHeights(chain))).toBeGreaterThanOrEqual(200 - W);
      // The one block read with its transactions: the one that used it.
      expect(fullBlockReads(chain)).toEqual([
        ['eth_getBlockByHash', [chain.canonicalHash(80), true]],
      ]);

      // Paid and failed, from its own receipt, with the nonce at F in reach.
      for (const [status, label] of [
        [1, LABELS.PAID],
        [0, LABELS.FAILED],
      ]) {
        const own = chainWith({ 80: [ours(status)] }, { head: 200, stateWindow: W });
        await expect(
          readLabel(INTENT, { request: own.request, bracket: bracketAt(own, 79) })
        ).resolves.toMatchObject({ label, hash: HASH });
      }
    });

    test('without a bracket the same search probes past the window: missing state, held', async () => {
      const chain = takenAt(80, { head: 200, finalized: 100 });
      await expect(readLabel(INTENT, { request: chain.request })).resolves.toMatchObject({
        label: LABELS.HELD,
        observed: OBSERVED.UNKNOWN,
        reason: expect.stringContaining('missing trie node'),
        nonceAtF: { block: 100, used: true },
        bracket: null,
      });
    });

    test('probes beyond the window leave the intent held, also the nonce at F itself, and keep the bracket', async () => {
      // F is 150 below the head: even its own nonce is out of reach.
      const chain = takenAt(80, { head: 250, finalized: 100 });
      const bracket = bracketAt(chain, 79);
      await expect(readLabel(INTENT, { request: chain.request, bracket })).resolves.toMatchObject({
        label: LABELS.HELD,
        observed: OBSERVED.UNKNOWN,
        nonceAtF: null,
        bracket,
      });
    });

    test("a bracket that doesn't verify is dropped, and the search falls back to the window", async () => {
      const wide = (at, options) =>
        chainWith({ [at]: [{ hash: OTHER, nonce: 7 }] }, { head: 9100, ...options });
      const dropped = { label: LABELS.TAKEN, bracket: null };

      // Its hash isn't the verified header's at its height.
      const forked = wide(80);
      await expect(
        readLabel(INTENT, {
          request: forked.request,
          bracket: { number: 79, hash: forked.forkHash(79) },
        })
      ).resolves.toMatchObject(dropped);

      // It isn't an ancestor of F: at F, or above it.
      for (const height of [100, 105]) {
        const above = wide(80);
        await expect(
          readLabel(INTENT, { request: above.request, bracket: bracketAt(above, height) })
        ).resolves.toMatchObject(dropped);
      }

      // Deeper below F than any probe may go (F − 8194).
      const deep = wide(8990, { finalized: 9000 });
      await expect(
        readLabel(INTENT, { request: deep.request, bracket: bracketAt(deep, 9000 - 8194) })
      ).resolves.toMatchObject(dropped);

      // A malformed one is no bracket.
      const malformed = wide(80);
      await expect(
        readLabel(INTENT, { request: malformed.request, bracket: { number: -1, hash: 'x' } })
      ).resolves.toMatchObject(dropped);
    });

    test('a bracket whose check fails to read is kept for the next pass', async () => {
      const chain = takenAt(80, { head: 200, finalized: 100 });
      const bracket = bracketAt(chain, 79);
      const request = jest.fn(async (chainId, method, params, options) => {
        if (method.startsWith('eth_getBlockBy') && params[0] !== 'finalized') {
          throw new Error('timeout');
        }
        return chain.request(chainId, method, params, options);
      });
      await expect(readLabel(INTENT, { request, bracket })).resolves.toMatchObject({
        label: LABELS.HELD,
        observed: OBSERVED.UNKNOWN,
        bracket,
      });
    });
  });

  describe('Colibri, where it proves the reads', () => {
    // The core's read order, scripted: Colibri first where the chain has a
    // prover, Colibri is in the order and up, and it proves the method (at
    // any depth its prover reaches); then the quorum, within its
    // endpoints' window; then `direct`, one endpoint's answer, if given.
    function routed(chain, { proves = null, direct: directAnswer = null } = {}) {
      const request = jest.fn(async (chainId, method, params, options) => {
        if (proves?.has(method)) {
          request.sources.push('colibri');
          return colibri(chain.prove(method, params));
        }
        try {
          return await chain.request(chainId, method, params, options);
        } catch (err) {
          if (directAnswer) return directAnswer(method, params);
          throw err;
        }
      });
      request.sources = [];
      return request;
    }
    const STATE_READS = new Set(['eth_getTransactionCount', 'eth_getBlockByHash']);

    test("with a prover, and Colibri proving the reads, the search reaches a block beyond the endpoints' window", async () => {
      // Used 2,000 blocks below F, with no bracket.
      const chain = takenAt(1000, { head: 3100, finalized: 3000 });
      const request = routed(chain, { proves: STATE_READS });
      await expect(readLabel(INTENT, { request })).resolves.toMatchObject({
        label: LABELS.TAKEN,
        block: 3000,
      });
      expect(request.sources).toContain('colibri');
      // The probes went deeper than any endpoint's window.
      const probed = request.mock.calls
        .filter(([, method]) => method === 'eth_getTransactionCount')
        .map(([, , params]) => chain.views.canonical.heights.get(params[1].blockHash));
      expect(Math.min(...probed)).toBeLessThan(3100 - W);
    });

    test("with no prover, Colibri out of the order or failing, or a read it doesn't prove, the read falls to the quorum, within the window", async () => {
      // No Colibri at all (no prover, out of the order, or failing: the
      // router goes on to the quorum), or Colibri proving only the block
      // read, not the nonce.
      for (const proves of [null, new Set(['eth_getBlockByHash'])]) {
        const deep = takenAt(1000, { head: 3100, finalized: 3000 });
        await expect(
          readLabel(INTENT, { request: routed(deep, { proves }) })
        ).resolves.toMatchObject({
          label: LABELS.HELD,
          observed: OBSERVED.UNKNOWN,
          nonceAtF: { used: true },
        });
        // Within the window, the quorum's answers label it.
        const shallow = takenAt(2995, { head: 3100, finalized: 3000 });
        await expect(
          readLabel(INTENT, { request: routed(shallow, { proves }) })
        ).resolves.toMatchObject({ label: LABELS.TAKEN });
      }
    });

    test('a Direct answer, or a quorum of one, never counts as evidence, at any depth', async () => {
      // An archive endpoint answers past the window, alone.
      for (const wrap of [direct, singleton]) {
        const chain = takenAt(1000, { head: 3100, finalized: 3000 });
        const request = routed(chain, {
          direct: (method, params) => wrap(chain.prove(method, params)),
        });
        await expect(readLabel(INTENT, { request })).resolves.toMatchObject({
          label: LABELS.HELD,
          observed: OBSERVED.UNKNOWN,
          reason: expect.stringContaining('no verified evidence'),
        });
      }
    });
  });

  test('no block scan: at most one block with its transactions per intent, the one its probes located', async () => {
    for (const bracket of [null, 2900]) {
      const chain = takenAt(2950, { head: 3100, finalized: 3000, stateWindow: Infinity });
      await expect(
        readLabel(INTENT, {
          request: chain.request,
          bracket: bracket === null ? null : bracketAt(chain, bracket),
        })
      ).resolves.toMatchObject({ label: LABELS.TAKEN });
      expect(fullBlockReads(chain)).toEqual([
        ['eth_getBlockByHash', [chain.canonicalHash(2950), true]],
      ]);
    }
  });

  test(`the bound: evidence ${MAX_DEPTH} blocks below F settles the intent; ${MAX_DEPTH + 1n} below, it stays held`, async () => {
    const F = 9000;
    const edge = F - Number(MAX_DEPTH);
    const options = { head: 9100, finalized: F };
    // Its own receipt.
    await expect(
      readLabel(INTENT, { request: chainWith({ [edge]: [ours(1)] }, options).request })
    ).resolves.toMatchObject({ label: LABELS.PAID });
    await expect(
      readLabel(INTENT, { request: chainWith({ [edge - 1]: [ours(1)] }, options).request })
    ).resolves.toMatchObject({ label: LABELS.HELD, observed: OBSERVED.UNVERIFIABLE });
    // Another transaction at its nonce, found by the search from F...
    const taken = (at) => chainWith({ [at]: [{ hash: OTHER, nonce: 7 }] }, options);
    await expect(readLabel(INTENT, { request: taken(edge).request })).resolves.toMatchObject({
      label: LABELS.TAKEN,
    });
    await expect(readLabel(INTENT, { request: taken(edge - 1).request })).resolves.toMatchObject({
      label: LABELS.HELD,
      observed: OBSERVED.UNVERIFIABLE,
    });
    // ...or from a bracket just below it.
    const bracketed = taken(edge);
    await expect(
      readLabel(INTENT, {
        request: bracketed.request,
        bracket: bracketAt(bracketed, edge - 1),
      })
    ).resolves.toMatchObject({ label: LABELS.TAKEN, bracket: bracketAt(bracketed, edge - 1) });
    // It never looked at a header below the bound.
    const deepest = Math.min(
      ...bracketed
        .reads()
        .filter(
          ([method, params]) => method === 'eth_getBlockByNumber' && params[0] !== 'finalized'
        )
        .map(([, params]) => Number(BigInt(params[0])))
    );
    expect(deepest).toBe(edge);
  });
});
