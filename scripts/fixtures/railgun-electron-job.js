/** Offline fixture loaded by the real Electron utility bootstrap. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { assertRailgunFixture } = require('../railgun-fixture-integrity');
const { createRailgunRemote } = require('../../src/main/wallet/railgun-remote');
const {
  createRailgunHostProvider,
  lockRailgunHttp,
} = require('../../src/main/networks/railgun-host-provider');
let retained;
async function run(input, { request, signal, close, guardReport }) {
  const { mode, viewingKey, spendingPublicKey } = JSON.parse(input);
  assert.deepEqual(Object.keys(process.env), []);
  const guards = guardReport();
  assert.ok(guards.hooks.length >= 88);
  assert.equal(guards.canaries, guards.hooks.length);
  assert.equal(guards.attempts, 0);
  if (mode === 'caught-egress') {
    try {
      require('https').get('https://refused.invalid');
    } catch {
      /* Deliberately caught: host must still revoke. */
    }
    return;
  }
  if (mode === 'wedged') {
    process.on('SIGTERM', () => {});
    setImmediate(() => {
      request(
        JSON.stringify({ id: 1, method: 'rpc', args: { method: 'eth_blockNumber', params: [] } })
      ).catch(() => {});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    });
    return;
  }
  if (mode === 'stall') return new Promise(() => {});
  if (mode === 'disconnect') {
    close();
    return new Promise(() => {});
  }
  if (mode === 'crash') {
    process.exit(7);
    return;
  }
  if (mode === 'bad-message') {
    process.parentPort.postMessage(JSON.stringify({ type: 'ready', authority: 'extra' }));
    return new Promise(() => {});
  }
  if (mode === 'memory') {
    await request(
      JSON.stringify({ id: 1, method: 'rpc', args: { method: 'eth_blockNumber', params: [] } })
    );
    retained = Buffer.alloc(384 * 1024 * 1024, 7);
    return new Promise(() => {});
  }
  assert.ok(['create', 'lock', 'restore', 'quit'].includes(mode));
  const fixture = path.join(__dirname, 'railgun-engine');
  assertRailgunFixture(path.join(fixture, 'node_modules'));
  const r = createRequire(path.join(fixture, 'package.json'));
  const ethers = r('ethers');
  lockRailgunHttp(ethers.FetchRequest);
  const engine = r('@railgun-community/engine');
  const remote = createRailgunRemote({ ...r('abstract-leveldown'), send: request, signal });
  const refuse = async () => {
    throw new Error('Unqualified capability');
  };
  const errors = [];
  const instance = await engine.RailgunEngine.initForWallet(
    'freedomfixture',
    remote.leveldown,
    {
      assertArtifactExists() {
        throw new Error('Unqualified artifact');
      },
      getArtifacts: refuse,
      getArtifactsPOI: refuse,
    },
    refuse,
    refuse,
    refuse,
    refuse,
    {
      log() {},
      error(error) {
        errors.push(error?.name);
      },
    },
    false
  );
  const wallet = new engine.HardwareWallet(
    'public-electron-fixture',
    instance.db,
    {
      privateKey: Buffer.from(viewingKey, 'hex'),
      pubkey: await engine.getPublicViewingKey(Buffer.from(viewingKey, 'hex')),
    },
    spendingPublicKey.map(BigInt),
    undefined,
    instance.prover
  );
  wallet.setConnector({ sign: refuse, requestBatchApproval: refuse });
  if (mode !== 'create') assert.equal(await instance.db.get(['aa'], 'utf8'), wallet.getAddress());
  await instance.db.put(['aa'], wallet.getAddress(), 'utf8');
  await instance.db.level.put('public-guard-report', guardReport(), { valueEncoding: 'json' });
  const values = await Promise.all(
    Array.from({ length: 128 }, () => instance.db.get(['aa'], 'utf8'))
  );
  assert.ok(values.every((value) => value === wallet.getAddress()));
  const provider = createRailgunHostProvider({
    PollingJsonRpcProvider: engine.PollingJsonRpcProvider,
    provider: remote.provider,
    signal: remote.signal,
    chainId: 11155111,
  });
  assert.equal(await provider.getBlockNumber(), 291);
  assert.equal(errors.length, 0);
  assert.ok(
    !Object.keys(require.cache).some(
      (file) => file.includes('better-sqlite3') || file.endsWith('/railgun-store.js')
    )
  );
  assert.equal(signal.aborted, false);
  if (mode === 'lock') {
    setTimeout(
      () =>
        provider
          ._send({
            id: 999,
            jsonrpc: '2.0',
            method: 'eth_getBlockByHash',
            params: ['0x' + '99'.repeat(32), false],
          })
          .catch(() => {}),
      0
    );
  }
  retained = { instance, wallet, provider, remote };
}
module.exports = { run, retained: () => retained };
