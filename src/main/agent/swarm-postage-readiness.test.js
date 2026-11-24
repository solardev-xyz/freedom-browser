'use strict';
jest.mock('../swarm/swarm-service', () => ({ getBee: jest.fn(), selectBestBatch: jest.fn() }));
jest.mock('../service-registry', () => ({ getAntApiUrl: () => 'http://localhost:1633' }));
const { SwarmPostageReadiness } = require('./swarm-postage-readiness');
const ID = 'a'.repeat(64);

function fixture() {
  const local = { usable: true, remainingSize: { toBytes: () => 1000 } };
  const global = { start: 0, batchTTL: 3600 };
  const chain = { block: 100 };
  const bee = { stamp: { get: jest.fn(async () => local), getGlobal: jest.fn(async () => global) }, status: { getChainState: jest.fn(async () => chain) } };
  return { local, global, chain, readiness: new SwarmPostageReadiness({ getBee: () => bee }) };
}

test('Ant start=0 requires advancing blocks after a confirmed chain read despite usable=true', async () => {
  const { readiness, chain } = fixture();
  expect(await readiness.inspect(ID, 10)).toEqual({ ready: false, firstConfirmedBlock: 100, blocksRemaining: 10 });
  expect(await readiness.inspect(ID, 10, 100)).toMatchObject({ ready: false });
  chain.block = 110;
  expect(await readiness.inspect(ID, 10, 100)).toMatchObject({ ready: true });
});

test('uses a genuine creation block and refuses expired or insufficient postage', async () => {
  const { readiness, global, local } = fixture();
  global.start = 80;
  expect(await readiness.inspect(ID, 10)).toMatchObject({ ready: true });
  global.batchTTL = 0;
  await expect(readiness.inspect(ID, 10)).rejects.toMatchObject({ permanent: true, code: 'POSTAGE_UNAVAILABLE' });
  global.batchTTL = 3600;
  local.remainingSize.toBytes = () => 1;
  await expect(readiness.inspect(ID, 10)).rejects.toMatchObject({ code: 'POSTAGE_CAPACITY_INSUFFICIENT' });
});

test('retains a just-purchased batch rather than choosing a different batch', async () => {
  const selectBestBatch = jest.fn();
  const readiness = new SwarmPostageReadiness({ selectBestBatch, operationStore: { listRecent: () => [{ service: 'ant', request: { method: 'POST', path: '/stamps/100/20?label=site' }, response: { status: 201, body: JSON.stringify({ batchID: ID }) }, updatedAt: Date.now() }] } });
  expect(await readiness.select('owner', 10)).toBe(ID);
  expect(selectBestBatch).not.toHaveBeenCalled();
});

describe('approval card preview (#741 G)', () => {
  const { estimateChunks } = require('./swarm-postage-readiness');
  function previewFixture(local) {
    const bee = { stamp: { get: jest.fn(async () => local) } };
    const selectBestBatch = jest.fn(async () => ID);
    return { bee, selectBestBatch, readiness: new SwarmPostageReadiness({ getBee: () => bee, selectBestBatch }) };
  }

  test('reports the batch the upload will use, its time left and the estimated share of its prepaid storage', async () => {
    const { readiness, selectBestBatch } = previewFixture({ usable: true, amount: '24000000000',
      duration: { toSeconds: () => 30 * 86_400 }, remainingSize: { toBytes: () => 1_000_000 } });
    const preview = await readiness.preview('owner', 10_000, { files: 2 });
    expect(selectBestBatch).toHaveBeenCalledWith(10_000, expect.objectContaining({ requireCapacity: true }));
    // 3 data chunks + 1 intermediate + 2 manifest chunks.
    expect(preview).toEqual({ status: 'ready', batchId: ID, usable: true, ttlSeconds: 30 * 86_400, estimatedChunks: 6,
      estimatedCostPlur: String(24_000_000_000n * 6n), remainingBytes: 1_000_000, expiry: 'ok' });
  });

  test('warns when the batch is close to expiry, and marks an expired one', async () => {
    for (const [seconds, expiry] of [[6 * 86_400, 'soon'], [3_600, 'critical'], [0, 'expired'], [8 * 86_400, 'ok']]) {
      const { readiness } = previewFixture({ usable: true, amount: '1', duration: { toSeconds: () => seconds } });
      expect(await readiness.preview('owner', 1)).toMatchObject({ ttlSeconds: seconds, expiry });
    }
  });

  test('says when no usable batch exists, never buys one, and omits a cost it cannot compute', async () => {
    const empty = previewFixture({});
    empty.selectBestBatch.mockResolvedValue(null);
    expect(await empty.readiness.preview('owner', 1)).toEqual({ status: 'none' });
    expect(empty.bee.stamp.get).not.toHaveBeenCalled();
    const { readiness } = previewFixture({ usable: false, duration: { toSeconds: () => 86_400 * 10 } });
    const preview = await readiness.preview('owner', 1);
    expect(preview).toMatchObject({ status: 'ready', usable: false });
    expect(preview).not.toHaveProperty('estimatedCostPlur');
  });

  test('chunk estimate grows with encryption (64 references per chunk instead of 128)', () => {
    expect(estimateChunks(0)).toBe(2);
    expect(estimateChunks(4096 * 128)).toBe(128 + 1 + 1);
    expect(estimateChunks(4096 * 128, { encrypted: true })).toBe(128 + 2 + 1 + 1);
    expect(estimateChunks(4096, { files: 5 })).toBe(1 + 5);
  });
});
