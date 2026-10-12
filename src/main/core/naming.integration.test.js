/**
 * Main's naming pieces against the real freedom-cored binary: the
 * configuration, the executors (over a scripted hop) and the resolvers'
 * driver. Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/core
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoreClient } = require('./core-client');
const { NamingConfig } = require('./naming-config');
const { registerNamingShell } = require('./naming-shell');
const { registerNamingVerified } = require('./naming-verified');
const { NamingDriver } = require('./naming-driver');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({ netGatewayFetch: jest.fn() }));

const binary = process.env.FREEDOM_CORED_PATH;
// A real core resolves on real timers.
jest.setTimeout(20_000);
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };

const RPC = ['https://a.rpc.example', 'https://b.rpc.example', 'https://c.rpc.example'];
let endpoints = RPC;

function sources() {
  return {
    ens: {
      getEffectiveRpcEndpoints: () => endpoints,
      getDirectRpcCandidate: () => ({ url: null }),
      resolutionPolicy: () => ({ order: ['quorum'] }),
    },
    tezos: { getRpcEndpoints: () => ['https://t1.tez.example'] },
    registry: { getNetwork: () => ({ quorum: { k: 3, m: 2 } }), getEndpoints: () => [] },
    myotis: { isEnabled: () => false, isReady: () => false },
  };
}

describeIfBinary('naming with the real freedom-cored', () => {
  let root;
  let client;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-naming-'));
    endpoints = RPC;
  });
  afterEach(async () => {
    await client?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A core whose every HTTP exchange `hop` answers. */
  async function start(hop) {
    client = new CoreClient({
      spawn,
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
        '--lock-dir',
        path.join(root, 'locks'),
        '--parent-pid',
        String(process.pid),
      ],
      log: quietLog,
      shellVersion: 'jest',
    });
    const config = new NamingConfig({ client, sources: sources(), log: quietLog });
    registerNamingShell(client, config, { hop });
    registerNamingVerified(client, config, { adapters: {} });
    const driver = new NamingDriver({ client, config, normalize: (n) => n.toLowerCase() });
    await client.start();
    expect(await config.whenReady()).toBe(true);
    return { config, driver };
  }

  const failing = jest.fn(async () => ({
    status: 500,
    headers: {},
    body: Buffer.from('{"error":"down"}'),
  }));

  test("a lookup every endpoint fails throws the core's message, as today's resolvers throw", async () => {
    const { driver } = await start(failing);
    const err = await driver.resolveContent('vitalik.eth').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // Today's message when no endpoint can read the head.
    expect(err.message).toBe('Single-provider anchor fetch failed: could not read the head');
    // Only configured endpoints were dialled, by URL.
    for (const [url] of failing.mock.calls) {
      expect(RPC.some((base) => url.startsWith(base))).toBe(true);
    }
  });

  test("a Tezos lookup's result comes back in today's shape", async () => {
    const { driver } = await start(failing);
    expect(await driver.resolveTezos('alice.tez')).toEqual({
      type: 'error',
      reason: 'all Tezos RPC providers failed',
      system: 'tezos',
    });
  });

  test('a reset alone restarts the attempt inside the core', async () => {
    let held = null;
    const hop = jest.fn((url, init) => {
      if (!held) {
        return new Promise((resolve, reject) => {
          held = resolve;
          init.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      return failing(url, init);
    });
    const { config, driver } = await start(hop);
    const sent = jest.spyOn(client, 'requestTo');
    const lookup = driver.resolveContent('nick.eth').catch((e) => e);
    while (!held) await new Promise(setImmediate);
    const { ens, lifecycle } = config.generations;
    await config.configure({ reset: true });
    // The held exchange fails now: the attempt ends, crossed, and the core
    // restarts it rather than waiting out the quorum's timeout.
    held(await failing());
    // Today's invalidateCachedProvider: a new lifecycle, the same snapshot.
    expect(config.generations.ens).toBe(ens);
    expect(config.generations.lifecycle).toBeGreaterThan(lifecycle);
    expect((await lookup).message).not.toMatch(/configuration changed/);
    expect(
      sent.mock.calls.filter(([, method]) => method === 'naming.resolve_content')
    ).toHaveLength(1);
  });

  test('a configuration change ends the session, and main sends the lookup again', async () => {
    let held = null;
    const hop = jest.fn((url, init) => {
      // The first exchange waits for the change.
      if (!held) {
        return new Promise((resolve, reject) => {
          held = { resolve, reject };
          init.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      return failing(url, init);
    });
    const { config, driver } = await start(hop);
    const sent = jest.spyOn(client, 'requestTo');
    const lookup = driver.resolveContent('nick.eth').catch((e) => e);
    while (!held) await new Promise(setImmediate);
    const before = config.generations.ens;
    endpoints = [...RPC.slice(1), 'https://d.rpc.example'];
    await config.configure({ reset: true });
    expect(config.generations.ens).toBeGreaterThan(before);
    const err = await lookup;
    // Sent again with the attempt it used, it ran to today's failure, not to
    // the core's "configuration changed".
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/configuration changed/);
    const lookups = sent.mock.calls.filter(([, method]) => method === 'naming.resolve_content');
    expect(lookups.map(([, , params]) => params.attempts_used)).toEqual([undefined, 1]);
    expect(lookups[1][2].deadline_ms).toBeGreaterThan(100_000);
  });

  test('an invalidation reaches the core and answers whether it evicted', async () => {
    const { driver } = await start(failing);
    expect(await driver.invalidateContent('vitalik.eth')).toBe(false);
    await expect(driver.invalidateTezos('alice.tez')).resolves.toBeUndefined();
  });
});
