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
