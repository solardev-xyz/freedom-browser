const { EventEmitter } = require('events');
const { runChild } = require('./myotis-child');

function setup(abi = 26) {
  const host = new EventEmitter();
  host.connected = true;
  host.send = jest.fn();
  host.exit = jest.fn();
  const addon = {
    init: jest.fn(() => abi), create: jest.fn(() => 7), start: jest.fn(() => true), stop: jest.fn(),
    statusJson: jest.fn(() => JSON.stringify({ snapPeers: 2 })), drainLogs: jest.fn(),
    ensRecordJson: jest.fn(), requestAccountJson: jest.fn(), estimateGasJson: jest.fn(),
    acceptStaleAnchor: jest.fn(() => true),
    createWithCheckpoint: jest.fn(() => 8),
    feeEstimateJson: jest.fn(), sendRawTransactionJson: jest.fn(),
    ethCallJson: jest.fn(async () => '{"resultHex":"0x1234"}'),
  };
  const load = jest.fn(() => addon);
  runChild(host, load);
  const generation = 'current';
  const send = (message) => host.emit('message', { generation, ...message });
  const start = () => send({ type: 'start', addonPath: '/addon.node', network: 'mainnet', dataDir: '/profile/mainnet' });
  return { host, addon, load, send, start };
}

test('loads and starts native code only after explicit owned start; enforces ABI', () => {
  const ctx = setup(21);
  expect(ctx.load).not.toHaveBeenCalled();
  ctx.start();
  expect(ctx.addon.create).not.toHaveBeenCalled();
  expect(ctx.host.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'started', ok: false }));
  expect(ctx.host.exit).toHaveBeenCalled();
});

test('runs status and bounded native work in child, refusing surplus native operations', async () => {
  const ctx = setup(); ctx.start();
  const resolvers = [];
  ctx.addon.ethCallJson.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
  for (let id = 1; id <= 3; id++) ctx.send({ type: 'request', id, op: 'call', args: [] });
  expect(ctx.addon.ethCallJson).toHaveBeenCalledTimes(1);
  expect(ctx.host.send).toHaveBeenCalledWith(expect.objectContaining({ id: 3, ok: false }));
  ctx.send({ type: 'request', id: 4, op: 'status', args: [] });
  expect(ctx.addon.statusJson).toHaveBeenCalledWith(7);
  expect(ctx.addon.drainLogs).toHaveBeenCalledWith(200);
  resolvers.forEach((resolve) => resolve('{"resultHex":"0x12"}'));
  await Promise.resolve();
});

test('rejects stale generations and stops admission before synchronous native stop', async () => {
  const ctx = setup(); ctx.start();
  ctx.send({ generation: 'old', type: 'request', id: 1, op: 'call', args: [] });
  expect(ctx.addon.ethCallJson).not.toHaveBeenCalled();
  ctx.addon.stop.mockImplementation(() => ctx.send({ type: 'request', id: 2, op: 'call', args: [] }));
  ctx.send({ type: 'stop' });
  expect(ctx.addon.ethCallJson).not.toHaveBeenCalled();
  expect(ctx.addon.stop).toHaveBeenCalledWith(7);
  expect(ctx.host.exit).toHaveBeenCalledWith(0);
});


test.each(['load', 'abi', 'create', 'start'])('reports only the bounded %s startup failure class', (failure) => {
  const ctx = setup();
  const operation = { load: ctx.load, abi: ctx.addon.init, create: ctx.addon.create, start: ctx.addon.start }[failure];
  operation.mockImplementation(() => { throw new Error('secret request payload'); });
  ctx.start();
  expect(ctx.host.send).toHaveBeenCalledWith({ generation: 'current', type: 'started', ok: false, failure });
  expect(JSON.stringify(ctx.host.send.mock.calls)).not.toContain('secret');
});


test('does not expose the stale-anchor risk bypass', async () => {
  const ctx = setup(); ctx.start();
  ctx.addon.statusJson.mockReturnValue('{"beaconState":"STALE_ANCHOR"}');
  ctx.send({ type: 'request', id: 1, op: 'accept-stale-anchor', args: [] });
  expect(ctx.addon.acceptStaleAnchor).not.toHaveBeenCalled();
  expect(ctx.host.send).toHaveBeenCalledWith(expect.objectContaining({ id: 1, ok: false }));
});

test('imports only a chain-bound checkpoint through the explicit native capability', () => {
  const ctx = setup();
  const checkpoint = { chainId: 100, network: 'gnosis', root: '0x' + 'ab'.repeat(32), slot: 30000000 };
  ctx.send({ type: 'start', addonPath: '/addon.node', network: 'gnosis', dataDir: '/owned', checkpoint });
  expect(ctx.addon.create).not.toHaveBeenCalled();
  expect(ctx.addon.createWithCheckpoint).toHaveBeenCalledWith('gnosis', '/owned', checkpoint.root, checkpoint.slot);
  expect(ctx.host.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true, checkpointSupported: true }));
});

test.each([
  { chainId: 1 }, { network: 'mainnet' }, { root: '0x' + '00'.repeat(32) }, { slot: 1.5 }, { slot: Number.MAX_SAFE_INTEGER + 1 },
])('refuses malformed or wrong-chain checkpoint before native creation: %s', (change) => {
  const ctx = setup();
  const checkpoint = { chainId: 100, network: 'gnosis', root: '0x' + 'ab'.repeat(32), slot: 30000000, ...change };
  ctx.send({ type: 'start', addonPath: '/addon.node', network: 'gnosis', dataDir: '/owned', checkpoint });
  expect(ctx.addon.create).not.toHaveBeenCalled();
  expect(ctx.addon.createWithCheckpoint).not.toHaveBeenCalled();
  expect(ctx.host.send).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: 'configuration' }));
});

test('refuses an unsupported addon instead of falling back to its embedded checkpoint', () => {
  const ctx = setup(); delete ctx.addon.createWithCheckpoint;
  ctx.send({ type: 'start', addonPath: '/addon.node', network: 'mainnet', dataDir: '/owned',
    checkpoint: { chainId: 1, network: 'mainnet', root: '0x' + 'ab'.repeat(32), slot: 15000000 } });
  expect(ctx.addon.create).not.toHaveBeenCalled();
  expect(ctx.host.send).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: 'checkpoint-unsupported' }));
});


test.each([undefined, null, NaN, '7', 7.5, {}])('refuses a non-integer native handle instead of starting it: %s', (handle) => {
  const ctx = setup();
  ctx.addon.create.mockReturnValue(handle);
  ctx.start();
  expect(ctx.addon.start).not.toHaveBeenCalled();
  expect(ctx.addon.stop).not.toHaveBeenCalled();
  expect(ctx.host.send).toHaveBeenCalledWith({ generation: 'current', type: 'started', ok: false, failure: 'create' });
});

test.each([false, true])('reports native ANCHOR_MISMATCH without starting or falling back (checkpoint=%s)', (withCheckpoint) => {
  const ctx = setup();
  ctx.addon.create.mockReturnValue(-3);
  ctx.addon.createWithCheckpoint.mockReturnValue(-3);
  const checkpoint = withCheckpoint ? { chainId: 1, network: 'mainnet', root: '0x' + 'ab'.repeat(32), slot: 15000000 } : null;
  ctx.send({ type: 'start', addonPath: '/addon.node', network: 'mainnet', dataDir: '/owned', checkpoint });
  expect(ctx.addon.start).not.toHaveBeenCalled();
  expect(ctx.host.send).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: 'anchor-mismatch' }));
  if (withCheckpoint) expect(ctx.addon.create).not.toHaveBeenCalled();
});
