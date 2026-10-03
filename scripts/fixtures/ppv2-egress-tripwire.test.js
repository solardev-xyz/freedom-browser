const { installPPv2EgressTripwire } = require('./ppv2-egress-tripwire');

test('counts swallowed direct attempts and restores exact original API descriptors', () => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const originalConnect = require('net').Socket.prototype.connect;
  const originalWorker = require('worker_threads').Worker;
  const originalSpawn = require('child_process').spawn;
  const electronNet = { request: jest.fn(), fetch: jest.fn() };
  const sessionPrototype = { fetch: jest.fn(), resolveHost: jest.fn(), resolveProxy: jest.fn() };
  const session = Object.create(sessionPrototype);
  const guard = installPPv2EgressTripwire(electronNet, session);
  try {
    guard.assertClean();
    expect(guard.report().refusedCanaries).toEqual(guard.report().hooks);
    const calls = [
      () => globalThis.fetch('https://unused.invalid'),
      () => require('https').request('https://unused.invalid'),
      () => new (require('net').Socket)().connect(9, 'unused.invalid'),
      () => require('dns').lookup('unused.invalid'),
      () => new (require('dns').promises.Resolver)().resolve4('unused.invalid'),
      () => electronNet.fetch('https://unused.invalid'),
      () => session.fetch('https://unused.invalid'),
      () => session.resolveHost('unused.invalid'),
      () => session.resolveProxy('https://unused.invalid'),
      () => new (require('worker_threads').Worker)('unused.js'),
      () => require('child_process').spawn('unused'),
    ];
    for (const call of calls) expect(call).toThrow('direct egress refused');
    expect(guard.report().attempts).toHaveLength(calls.length);
    expect(() => guard.assertClean()).toThrow('Unexpected direct network attempts');
  } finally {
    guard.restore();
    guard.restore();
  }
  expect(Object.getOwnPropertyDescriptor(globalThis, 'fetch')).toEqual(originalFetch);
  expect(require('net').Socket.prototype.connect).toBe(originalConnect);
  expect(require('worker_threads').Worker).toBe(originalWorker);
  expect(require('child_process').spawn).toBe(originalSpawn);
  expect(jest.isMockFunction(sessionPrototype.resolveProxy)).toBe(true);
  expect(Object.hasOwn(session, 'resolveProxy')).toBe(false);
  expect(jest.isMockFunction(electronNet.fetch)).toBe(true);
  expect(electronNet.fetch).not.toHaveBeenCalled();
});

test('clean run records installed hooks and no network attempts', () => {
  const guard = installPPv2EgressTripwire();
  try {
    expect(guard.report().hooks).toContain('dns.promises.Resolver.resolve4');
    expect(guard.report().hooks).toContain('net.Socket.connect');
    expect(guard.report().attempts).toEqual([]);
    guard.assertClean();
  } finally {
    guard.restore();
  }
});
