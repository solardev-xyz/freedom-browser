/** Actual Electron main + utility processes. No product profile or live RPC. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { createRailgunStore } = require('../src/main/wallet/railgun-store');
const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
const sources = [
  'scripts/qualify-railgun-electron.js',
  'scripts/fixtures/railgun-electron-job.js',
  'scripts/railgun-fixture-integrity.js',
  'src/main/wallet/railgun-process.js',
  'src/main/wallet/railgun-process-entry.js',
  'src/main/wallet/railgun-process-guards.js',
  'src/main/wallet/railgun-session.js',
  'src/main/wallet/railgun-frontier.js',
  'src/main/wallet/railgun-remote.js',
  'src/main/wallet/railgun-store.js',
  'src/main/networks/railgun-host-provider.js',
  'src/main/networks/privacy-context.js',
  'scripts/fixtures/railgun-engine/runtime-integrity.json',
  'scripts/fixtures/railgun-engine/package-lock.json',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [
      file,
      createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', file)))
        .digest('hex'),
    ])
  );
async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const sourceSha256 = hashes(),
    runs = [];
  for (const mode of [
    'create',
    'lock',
    'restore',
    'quit',
    'stall',
    'crash',
    'bad-message',
    'memory',
    'disconnect',
    'missing-entry',
    'before-spawn',
    'caught-egress',
    'wedged',
  ]) {
    const scope = createPrivacyScope({
      profileId: 'public-electron-fixture',
      signal: new AbortController().signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'fixture0',
      protocol: 'railgun',
      deployment: 'offline',
      chainId: 11155111,
      role: 'engine',
    });
    let rpcSignal,
      lateResolve,
      rpcStarted,
      memoryBaseline = 0;
    const started = new Promise((resolve) => {
      rpcStarted = resolve;
    });
    const actualEngine = ['create', 'lock', 'restore', 'quit'].includes(mode);
    const options = {
      handle,
      filename:
        mode === 'missing-entry'
          ? path.join(directory, 'absent-entry.js')
          : require.resolve('./fixtures/railgun-electron-job'),
      input: JSON.stringify({
        mode,
        viewingKey: '05'.repeat(32),
        spendingPublicKey: [
          '1700559105542139805112168139351320601853033442476682590258553412078471731431',
          '20772987336827599306927277921643441679141423747083423413320022373456048866305',
        ],
      }),
      storage: {
        filename: path.join(directory, actualEngine ? 'engine.sqlite' : mode + '.sqlite'),
        key: Buffer.alloc(32, 23),
        binding: 'd'.repeat(64),
        create: !['lock', 'restore', 'quit'].includes(mode),
      },
      createProvider: ({ signal }) => {
        rpcSignal = signal;
        return {
          signal,
          request: async ({ method }) => {
            if (method === 'eth_chainId') return '0xaa36a7';
            if (method === 'eth_blockNumber') {
              if (mode === 'wedged') rpcStarted();
              if (mode === 'memory') {
                for (let i = 0; i < 100 && task.getStatus().peakRssBytes === 0; i++)
                  await new Promise((resolve) => setTimeout(resolve, 25));
                memoryBaseline = task.getStatus().peakRssBytes;
                assert.ok(memoryBaseline > 0 && memoryBaseline < 256 * 1024 * 1024);
              }
              return '0x123';
            }
            if (method === 'eth_getBlockByHash' && mode === 'lock') {
              const result = new Promise((resolve) => {
                lateResolve = resolve;
              });
              rpcStarted();
              return result;
            }
            throw new Error('Unexpected fixture RPC');
          },
        };
      },
      startupMs: mode === 'stall' ? 1000 : 30000,
      lifetimeMs: 60000,
      rssMb: mode === 'memory' ? 256 : 768,
    };
    const task = startRailgunProcess(options);
    try {
      if (mode === 'before-spawn') scope.close();
      if (actualEngine || mode === 'wedged') {
        await task.ready;
        if (mode === 'wedged') {
          await started;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (mode === 'lock') {
          await started;
          scope.close();
          lateResolve('late');
        } else if (mode === 'quit') app.emit('before-quit');
        else task.close();
        if (mode === 'wedged')
          assert.throws(
            () => startRailgunProcess(options),
            (error) => error.code === 'RAILGUN_PROCESS_BUSY'
          );
      } else await assert.rejects(task.ready);
      const result = await task.closed;
      fs.writeFileSync(
        path.join(directory, mode + '-observed.json'),
        JSON.stringify({ ...result, memoryBaseline }, null, 2) + '\n'
      );
      assert.equal(task.signal.aborted, true);
      assert.equal(rpcSignal.aborted, true);
      if (actualEngine) assert.ok(result.peakRssBytes > 0);
      const expected = {
        create: 'RAILGUN_PROCESS_CLOSED',
        restore: 'RAILGUN_PROCESS_CLOSED',
        quit: 'RAILGUN_PROCESS_CLOSED',
        lock: 'PRIVACY_CONTEXT_REVOKED',
        stall: 'RAILGUN_PROCESS_STARTUP_TIMEOUT',
        crash: 'RAILGUN_PROCESS_EXITED',
        'bad-message': 'RAILGUN_PROCESS_FAILED',
        memory: 'RAILGUN_PROCESS_MEMORY_LIMIT',
        disconnect: 'RAILGUN_PROCESS_CHANNEL_CLOSED',
        'missing-entry': 'RAILGUN_PROCESS_FAILED',
        'before-spawn': 'PRIVACY_CONTEXT_REVOKED',
        'caught-egress': 'RAILGUN_PROCESS_EGRESS_REFUSED',
        wedged: 'RAILGUN_PROCESS_CLOSED',
      }[mode];
      // A crashed child disconnects its channel too; either event may win.
      if (mode === 'crash')
        assert.ok(
          ['RAILGUN_PROCESS_EXITED', 'RAILGUN_PROCESS_CHANNEL_CLOSED'].includes(result.code)
        );
      else assert.equal(result.code, expected);
      if (mode === 'memory')
        assert.ok(memoryBaseline > 0 && result.peakRssBytes > 256 * 1024 * 1024);
      if (mode === 'wedged') {
        assert.equal(result.escalated, true);
        const retry = startRailgunProcess({
          ...options,
          storage: { ...options.storage, create: false },
        });
        retry.close();
        await retry.closed;
      }
      let guards;
      if (actualEngine) {
        const inspection = createPrivacyScope({
          profileId: 'public-electron-fixture',
          signal: new AbortController().signal,
        });
        const storageHandle = inspection.getContext({
          kind: 'private-account',
          principal: 'fixture0',
          protocol: 'railgun',
          deployment: 'offline',
          chainId: 11155111,
          role: 'storage',
        });
        const store = createRailgunStore({
          ...options.storage,
          handle: storageHandle,
          create: false,
          onFatal: () => inspection.close(),
        });
        try {
          guards = JSON.parse(store.get(Buffer.from('public-guard-report')).toString());
        } finally {
          store.close();
          inspection.close();
        }
        assert.ok(guards.hooks.length >= 88);
        assert.equal(guards.canaries, guards.hooks.length);
        assert.equal(guards.attempts, 0);
      }
      runs.push({ mode, actualEngine, passed: true, ...result, memoryBaseline, guards });
    } finally {
      task.close();
      await task.closed;
      scope.close();
    }
  }
  assert.deepEqual(hashes(), sourceSha256);
  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    sourceSha256,
    runs,
    noLiveRpc: true,
    publicTestKeysOnly: true,
    productEnabled: false,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => app.exit(0));
}
main().catch((error) => process.stderr.write(error.stack + '\n', () => app.exit(1)));
