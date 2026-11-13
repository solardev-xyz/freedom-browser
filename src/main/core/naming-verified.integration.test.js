/**
 * shell.verified against the real freedom-cored binary. Skipped unless
 * FREEDOM_CORED_PATH points at a build, e.g.
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

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({ netGatewayFetch: jest.fn() }));

const binary = process.env.FREEDOM_CORED_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };

// Myotis alone, enabled and ready: every lookup is a verified operation.
// (Colibri runs none, #1076.)
const sources = {
  ens: {
    getEffectiveRpcEndpoints: () => ['https://a.rpc.example'],
    getDirectRpcCandidate: () => ({ url: null }),
    resolutionPolicy: () => ({ order: ['myotis'] }),
  },
  tezos: { getRpcEndpoints: () => [] },
  registry: {
    getNetwork: () => ({ zkProof: true }),
    getEndpoints: () => [],
  },
  myotis: { isEnabled: () => true, isReady: () => true },
};

describeIfBinary('shell.verified with the real freedom-cored', () => {
  let root;
  let client;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-verified-'));
  });
  afterEach(async () => {
    await client?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function newClient() {
    return new CoreClient({
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
      grantRoot: root,
    });
  }

  // freedom-core #286 (main's #1076): from 0.12.0 the core has no Colibri
  // naming operation, so an order that names Colibri, with a prover for it,
  // skips it: main is asked no Colibri operation, and Myotis, next in the
  // order, answers with its own label.
  test('an order naming Colibri first asks main no Colibri operation: the next method answers', async () => {
    client = newClient();
    const asked = [];
    const handle = client.handle.bind(client);
    client.handle = (method, fn, ...rest) =>
      handle(
        method,
        method === 'shell.verified'
          ? (params, context) => {
              asked.push(params);
              return fn(params, context);
            }
          : fn,
        ...rest
      );
    const config = new NamingConfig({
      client,
      sources: {
        ...sources,
        ens: { ...sources.ens, resolutionPolicy: () => ({ order: ['colibri', 'myotis'] }) },
        registry: {
          getNetwork: () => ({ zkProof: true }),
          getEndpoints: (_chain, role) => (role === 'prover' ? ['https://prover.example'] : []),
        },
      },
      log: quietLog,
    });
    registerNamingShell(client, config, {
      hop: async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }),
    });
    const myotisRecord = jest.fn(async () => ({
      verified: true,
      blockNumber: 21_000_000,
      status: 'ok',
      dataHex: '0x',
    }));
    registerNamingVerified(client, config, { adapters: { myotisRecord } });
    await client.start();
    const gen = await config.whenServing();
    const reply = await client
      .requestTo(gen, 'naming.resolve_content', { name: 'vitalik.eth', private: false })
      .catch((e) => e);
    expect(reply.result).toMatchObject({
      type: 'not_found',
      reason: 'EMPTY_CONTENTHASH',
      trust: { level: 'verified', method: 'myotis' },
    });
    expect(asked.filter((params) => 'colibri' in params)).toEqual([]);
    expect(myotisRecord).toHaveBeenCalled();
  });

  test('revert data without a byte form is a failure the core takes, not one that ends it', async () => {
    const thrown = [];
    client = newClient();
    const config = new NamingConfig({ client, sources, log: quietLog });
    registerNamingShell(client, config, {
      hop: async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }),
    });
    registerNamingVerified(client, config, {
      adapters: {
        myotisRecord: async () => {
          // As ethers leaves a node's error: the data under info.error.
          throw Object.assign(new Error('backend unavailable'), {
            info: { error: { code: -32000, data: thrown.shift() } },
          });
        },
      },
    });
    await client.start();
    const gen = await config.whenServing();
    expect(gen).not.toBeNull();
    for (const data of ['0x123', '0X12']) {
      thrown.push(data);
      const err = await client
        .requestTo(gen, 'naming.resolve_content', { name: 'vitalik.eth', private: false })
        .catch((e) => e);
      expect(err.code).toBe('resolution_failed');
      expect(client.serves(gen)).toBe(true);
    }
  });
});
