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

// Colibri alone, with a prover: every lookup is a verified operation.
const sources = {
  ens: {
    getEffectiveRpcEndpoints: () => ['https://a.rpc.example'],
    getDirectRpcCandidate: () => ({ url: null }),
    resolutionPolicy: () => ({ order: ['colibri'] }),
  },
  tezos: { getRpcEndpoints: () => [] },
  registry: {
    getNetwork: () => ({ zkProof: true }),
    getEndpoints: (_chain, role) => (role === 'prover' ? ['https://prover.example'] : []),
  },
  myotis: { isEnabled: () => false, isReady: () => false },
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

  test('revert data without a byte form is a failure the core takes, not one that ends it', async () => {
    const thrown = [];
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
    const config = new NamingConfig({ client, sources, log: quietLog });
    registerNamingShell(client, config, {
      hop: async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }),
    });
    registerNamingVerified(client, config, {
      adapters: {
        colibriResolve: async () => {
          // As ethers leaves a node's error: the data under info.error.
          throw Object.assign(new Error('backend unavailable'), {
            info: { error: { code: -32000, data: thrown.shift() } },
          });
        },
        callResolver: () => () => {},
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
