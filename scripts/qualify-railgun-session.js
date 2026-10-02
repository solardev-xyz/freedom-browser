/** Offline Node-process qualification. Storage/key stay in this parent. The
 * deliberately uncooperative child receives public viewing material only.
 * This is not Electron packaging, an OS sandbox or a live chain scan.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { fork } = require('child_process');
const { createHash } = require('crypto');
const Database = require('better-sqlite3');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { createRailgunSession } = require('../src/main/wallet/railgun-session');
const expectedInventory = require('./fixtures/railgun-engine/runtime-integrity.json').inventory
  .sha256;
const expectedChecks = [
  'viewing-only-hardware-wallet-without-signing',
  'actual-engine-remote-database-and-fresh-restore',
  'remote-stable-iterator-seek-limit-and-clear',
  'actual-engine-controlled-network-over-host-rpc',
];
const sources = [
  'scripts/qualify-railgun-session.js',
  'scripts/fixtures/railgun-session-child.js',
  'scripts/railgun-fixture-integrity.js',
  'scripts/fixtures/ppv2-egress-tripwire.js',
  'src/main/wallet/railgun-session.js',
  'src/main/wallet/railgun-remote.js',
  'src/main/wallet/railgun-store.js',
  'src/main/networks/railgun-host-provider.js',
  'src/main/networks/privacy-context.js',
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
const sourceSha256 = hashes();
async function run(directory, mode) {
  const scope = createPrivacyScope({
    profileId: 'public-process-fixture',
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
  let child,
    session,
    deadline,
    escalation,
    report,
    outcome,
    rpcSignal,
    lateResolve,
    armed = false,
    lateReplyId,
    stopping = false,
    escalated = false,
    repliesAfterRevocation = 0,
    revoked = false,
    injected = false;
  const originalPrepare = Database.prototype.prepare;
  const delivered = [];
  function terminate() {
    if (stopping) return;
    stopping = true;
    child?.kill('SIGTERM');
    escalation = setTimeout(() => {
      escalated = true;
      child?.kill('SIGKILL');
    }, 250);
  }
  function stop(error) {
    outcome ||= error;
    session?.close();
    terminate();
  }
  function locked() {
    if (mode === 'lock' && armed && lateResolve) scope.close();
  }
  const exited = new Promise((resolve, reject) => {
    session = createRailgunSession({
      handle,
      storage: {
        filename: path.join(directory, 'state.sqlite'),
        key: Buffer.alloc(32, 17),
        binding: 'c'.repeat(64),
        create: mode === 'create',
      },
      createProvider: ({ signal }) => {
        rpcSignal = signal;
        return {
          signal,
          request: async ({ method, params }) => {
            if (method === 'eth_chainId') return '0xaa36a7';
            if (method === 'eth_blockNumber') return '0x123';
            if (method === 'eth_getLogs') return [];
            if (method === 'eth_getBlockByHash') {
              assert.deepEqual(params, ['0x' + '99'.repeat(32), false]);
              const pending = new Promise((done) => {
                lateResolve = done;
              });
              locked();
              return pending;
            }
            throw new Error('Unexpected fixture RPC');
          },
        };
      },
      onClose: () => {
        revoked = true;
        terminate();
      },
    });
    child = fork(path.join(__dirname, 'fixtures/railgun-session-child.js'), [], {
      env: { PATH: process.env.PATH, TMPDIR: directory },
      cwd: directory,
      execArgv: ['--max-old-space-size=256'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    deadline = setTimeout(() => stop(new Error('Process qualification deadline')), 60000);
    child.once('error', () => stop(new Error('Process qualification failed')));
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      const expectedRevocation = revoked;
      session.close();
      scope.close();
      Database.prototype.prepare = originalPrepare;
      lateResolve?.({ number: '0x123', hash: '0x' + '99'.repeat(32) });
      setImmediate(() => {
        try {
          if (outcome) throw outcome;
          assert.ok(expectedRevocation);
          assert.equal(signal, 'SIGKILL');
          assert.equal(code, null);
          assert.equal(escalated, true);
          assert.equal(rpcSignal.aborted, true);
          assert.equal(repliesAfterRevocation, 0);
          assert.ok(report);
          assert.equal(report.mode, mode);
          assert.deepEqual(report.checks, expectedChecks);
          assert.equal(report.inventory, expectedInventory);
          assert.equal(report.hooks, 87);
          assert.equal(report.canaries, 87);
          assert.equal(report.directAttempts, 0);
          assert.equal(report.databaseInChild, false);
          assert.equal(report.spendingKeyDelivered, false);
          assert.equal(report.contractHistoryScanned, false);
          assert.equal(injected, mode === 'fault');
          if (['lock', 'fault'].includes(mode)) {
            assert.ok(lateResolve && Number.isSafeInteger(lateReplyId));
            assert.ok(!delivered.includes(lateReplyId));
          }
          resolve({
            ...report,
            hostStorage: true,
            sharedRpcRevoked: true,
            forcedExitObserved: true,
            termination: signal,
            injectedSqliteFailure: injected,
            lateReplyDelivered: false,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    child.on('message', (message) => {
      if (stopping) return;
      try {
        if (message?.type === 'command') {
          const command = JSON.parse(message.wire);
          if (command.method === 'rpc' && command.args.method === 'eth_getBlockByHash')
            lateReplyId = command.id;
          if (
            mode === 'fault' &&
            command.method === 'batch' &&
            command.args.operations.some(
              (op) => Buffer.from(op.key, 'base64').toString() === 'must-not-commit'
            )
          ) {
            assert.ok(armed && lateResolve);
            assert.equal(rpcSignal.aborted, false);
            Database.prototype.prepare = function (sql) {
              if (sql === 'INSERT INTO records VALUES (?, ?)') {
                injected = true;
                throw new Error('Synthetic database write failure');
              }
              return originalPrepare.call(this, sql);
            };
          }
          session
            .dispatch(message.wire)
            .then((wire) => {
              if (session.signal.aborted || stopping) return;
              if (revoked) repliesAfterRevocation++;
              delivered.push(JSON.parse(wire).id);
              child.send({ type: 'reply', wire });
            })
            .catch(() => {
              if (!(mode === 'fault' && injected) && mode !== 'lock')
                stop(new Error('Host command refused'));
            });
          return;
        }
        if (message?.type === 'armed' && ['lock', 'fault'].includes(mode) && !armed) {
          armed = true;
          report = message.report;
          locked();
          return;
        }
        if (message?.type === 'result' && ['create', 'restore'].includes(mode) && !report) {
          report = message.report;
          session.close();
          return;
        }
        throw new Error('Unexpected child report');
      } catch (error) {
        stop(error);
      }
    });
    child.send({
      type: 'init',
      mode,
      viewingKey: '05'.repeat(32),
      spendingPublicKey: [
        '1700559105542139805112168139351320601853033442476682590258553412078471731431',
        '20772987336827599306927277921643441679141423747083423413320022373456048866305',
      ],
    });
  });
  return exited;
}
async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  const runs = [];
  for (const mode of ['create', 'lock', 'fault', 'restore']) runs.push(await run(directory, mode));
  assert.equal(new Set(runs.map((report) => report.address)).size, 1);
  assert.deepEqual(hashes(), sourceSha256);
  process.stdout.write(
    JSON.stringify(
      {
        sourceSha256,
        publicTestKeysOnly: true,
        actualEngine: true,
        platform: process.platform,
        architecture: process.arch,
        productionEnabled: false,
        runs,
      },
      null,
      2
    ) + '\n'
  );
}
main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
