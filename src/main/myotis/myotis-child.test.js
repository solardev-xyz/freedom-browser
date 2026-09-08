const { EventEmitter } = require('events');
const { runChild } = require('./myotis-child');

function setup(abi = 22) {
  const host = new EventEmitter();
  host.connected = true;
  host.send = jest.fn();
  host.exit = jest.fn();
  const addon = {
    init: jest.fn(() => abi), create: jest.fn(() => 7), start: jest.fn(() => true), stop: jest.fn(),
    statusJson: jest.fn(() => JSON.stringify({ snapPeers: 2 })), drainLogs: jest.fn(),
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
  expect(ctx.addon.ethCallJson).toHaveBeenCalledTimes(2);
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
