jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock('./logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
// The naming core's driver: none unless a test installs one.
let mockCoreDriver = null;
jest.mock('./core/naming', () => ({ namingDriver: () => mockCoreDriver }));
// Private-ness is decided from the IPC sender; the registry itself needs a
// real BrowserWindow, so stub the one predicate this module uses.
jest.mock('./private/private-windows', () => ({
  isPrivateWebContents: (webContents) => webContents?.isPrivate === true,
}));

const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const logger = require('./logger');
const { UNAVAILABLE } = require('./core/naming-driver');
const { isPrivateLogContext } = require('./private/private-log-context');
const {
  getRpcEndpoints,
  invalidateTezosDomain,
  registerTezosDomainsIpc,
  resolveTezosDomain,
} = require('./tezos-domains-resolver');

function handlerFor(channel) {
  const entry = ipcMain.handle.mock.calls.find(([name]) => name === channel);
  if (!entry) throw new Error(`no handler registered for ${channel}`);
  return entry[1];
}

const loggedText = () =>
  [logger.info, logger.warn, logger.error]
    .flatMap((fn) => fn.mock.calls)
    .map((call) => call.join(' '))
    .join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  mockCoreDriver = null;
  ipcMain.handle.mockClear();
  registerTezosDomainsIpc();
});

describe('Tezos Domains lookups go to the naming core', () => {
  test('lookups and invalidations go to the core', async () => {
    mockCoreDriver = {
      resolveTezos: jest.fn(async () => ({ type: 'ok', from: 'core' })),
      invalidateTezos: jest.fn(async () => undefined),
    };
    expect(await resolveTezosDomain(' Alice.TEZ ')).toEqual({ type: 'ok', from: 'core' });
    await resolveTezosDomain(undefined);
    expect(mockCoreDriver.resolveTezos.mock.calls).toEqual([[' Alice.TEZ '], ['']]);
    invalidateTezosDomain(' Alice.TEZ ');
    invalidateTezosDomain();
    expect(await handlerFor(IPC.TEZOS_DOMAINS_INVALIDATE)({}, { name: 'bob.tez' })).toEqual({
      ok: true,
    });
    expect(mockCoreDriver.invalidateTezos.mock.calls).toEqual([
      [' Alice.TEZ '],
      [undefined],
      ['bob.tez'],
    ]);
  });

  test("the IPC handler returns the core's result, marked private for a private window", async () => {
    mockCoreDriver = {
      resolveTezos: jest.fn(async () => ({ type: 'ok', private: isPrivateLogContext() })),
    };
    const resolve = handlerFor(IPC.TEZOS_DOMAINS_RESOLVE);
    expect(await resolve({ sender: { isPrivate: true } }, { name: 'a.tez' })).toEqual({
      type: 'ok',
      private: true,
    });
    expect(await resolve({ sender: { isPrivate: false } }, { name: 'a.tez' })).toEqual({
      type: 'ok',
      private: false,
    });
  });

  test('without a core, a lookup fails as the driver does when no core serves it', async () => {
    await expect(resolveTezosDomain('alice.tez')).rejects.toThrow(UNAVAILABLE);
    await expect(resolveTezosDomain('not a domain')).rejects.toThrow(UNAVAILABLE);
    // The page gets today's error shape.
    expect(
      await handlerFor(IPC.TEZOS_DOMAINS_RESOLVE)({ sender: {} }, { name: 'alice.tez' })
    ).toEqual({ type: 'error', reason: UNAVAILABLE, system: 'tezos' });
    // Nothing is cached without a core: invalidation is a no-op.
    expect(() => invalidateTezosDomain('alice.tez')).not.toThrow();
    expect(await handlerFor(IPC.TEZOS_DOMAINS_INVALIDATE)({}, {})).toEqual({ ok: true });
  });

  // PRIVATE MODE GUARD (name logging) — mirrors the ENS resolver: the .tez
  // name a private tab asked for must not reach the persistent main.log,
  // which outlives the private window and the app.
  test("a private window's failure keeps the name out of the log, message included", async () => {
    const secret = 'private-secret-site.tez';
    const message = `Tezos configuration changed repeatedly while resolving ${secret}`;
    mockCoreDriver = {
      resolveTezos: jest.fn(async () => {
        throw new Error(message);
      }),
    };
    const handler = handlerFor(IPC.TEZOS_DOMAINS_RESOLVE);
    // The page gets today's shape, the message whole.
    expect(await handler({ sender: { isPrivate: true } }, { name: secret })).toEqual({
      type: 'error',
      reason: message,
      system: 'tezos',
    });
    const logged = loggedText();
    expect(logged).toContain('[tezos-domains] Resolution failed');
    expect(logged).not.toContain('private-secret');

    // A normal window's failure keeps the full line.
    logger.error.mockClear();
    await handler({ sender: { isPrivate: false } }, { name: secret });
    expect(loggedText()).toContain(`Resolution failed for ${secret}: ${message}`);
  });
});

describe('Tezos RPC endpoints', () => {
  const saved = process.env.TEZOS_RPC;
  afterEach(() => {
    if (saved === undefined) delete process.env.TEZOS_RPC;
    else process.env.TEZOS_RPC = saved;
  });

  test('the three public endpoints by default', () => {
    delete process.env.TEZOS_RPC;
    expect(getRpcEndpoints()).toEqual([
      'https://tezos-mainnet.octez.io',
      'https://rpc.tzkt.io/mainnet',
      'https://rpc.tzbeta.net',
    ]);
  });

  test('TEZOS_RPC first, slash-normalized and deduplicated', () => {
    process.env.TEZOS_RPC = ' https://node.example/ ';
    expect(getRpcEndpoints()).toEqual([
      'https://node.example',
      'https://tezos-mainnet.octez.io',
      'https://rpc.tzkt.io/mainnet',
      'https://rpc.tzbeta.net',
    ]);
    process.env.TEZOS_RPC = 'https://rpc.tzbeta.net/';
    expect(getRpcEndpoints()).toEqual([
      'https://rpc.tzbeta.net',
      'https://tezos-mainnet.octez.io',
      'https://rpc.tzkt.io/mainnet',
    ]);
  });

  test('a TEZOS_RPC that is not an HTTP(S) URL is skipped', () => {
    for (const value of ['ftp://node.example', 'not a url']) {
      process.env.TEZOS_RPC = value;
      expect(getRpcEndpoints()).toHaveLength(3);
    }
  });
});
