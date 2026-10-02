/** Real engine and host scan coordinator against archived public RPC responses.
 * No network, wallet keys or transactions. This is not live source qualification.
 */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict'),
  { createHash } = require('crypto');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function main() {
  const [captureDir, headerDir, directory, previousDirectory] = process.argv.slice(2);
  for (const value of [captureDir, headerDir, directory, previousDirectory])
    assert.ok(path.isAbsolute(value));
  assert.ok(!fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  assert.ok(path.isAbsolute(previousDirectory));
  for (const name of fs.readdirSync(previousDirectory)) {
    if (name === 'engine.sqlite' || name === 'source.sqlite' || /^[0-9a-f]{64}\.json$/.test(name))
      fs.copyFileSync(
        path.join(previousDirectory, name),
        path.join(directory, name),
        fs.constants.COPYFILE_EXCL
      );
  }
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const capture = readRailgunLogCapture(captureDir),
    logs = [...capture.logs()];
  const bytes = fs.readFileSync(path.join(headerDir, 'headers.jsonl')),
    { report: headerReport } = require('./verify-railgun-sepolia-history').readHeaderEvidence(
      headerDir,
      capture
    );
  assert.equal(sha(bytes), headerReport.headerFileSha256);
  assert.equal(headerReport.logSetSha256, capture.logSetSha256);
  const headers = new Map(
    bytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((text) => {
        const value = JSON.parse(text);
        return [value.number, value];
      })
  );
  const ranges = [];
  for (const page of capture.report.pages) {
    const blocks = [
      ...new Set(
        logs
          .filter((log) => log.blockNumber >= page.from && log.blockNumber <= page.to)
          .map((log) => log.blockNumber)
      ),
    ];
    if (blocks.length <= 512) ranges.push({ from: page.from, to: page.to });
    else {
      const split = blocks
        .map((number, index) => ({ number, index }))
        .filter(
          ({ number, index }) =>
            index > 0 && index <= 512 && blocks.length - index <= 512 && headers.has(number - 1)
        )
        .sort(
          (a, b) => Math.abs(a.index - blocks.length / 2) - Math.abs(b.index - blocks.length / 2)
        )[0]?.number;
      assert.ok(split);
      ranges.push({ from: page.from, to: split - 1 }, { from: split, to: page.to });
    }
  }
  for (const range of ranges) {
    const values = logs.filter(
      (log) => log.blockNumber >= range.from && log.blockNumber <= range.to
    );
    assert.ok(new Set(values.map((log) => log.blockNumber)).size <= 512);
    assert.ok(
      values.length <= 4096 && Buffer.byteLength(JSON.stringify(values)) <= 4 * 1024 * 1024
    );
    for (const number of [range.from, range.to, ...(range.from ? [range.from - 1] : [])])
      assert.ok(headers.has(number));
  }
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
  const privateRpc = require('../src/main/networks/private-rpc');
  let requests = 0,
    provider = 'archived-source-a.invalid';
  privateRpc.createPrivateRpc = (handle, _role, { signal }) => {
    const lifetime = AbortSignal.any([getPrivacyContext(handle).signal, signal]);
    const active = () => {
      getPrivacyContext(handle);
      assert.equal(lifetime.aborted, false);
    };
    return {
      signal: lifetime,
      trust: { queried: [provider] },
      release: () => {},
      assertActive: active,
      request: async (method, params, validate) => {
        if (process.env.RAILGUN_REPLAY_DIAGNOSTIC)
          console.log('archived-rpc', method, JSON.stringify(params));
        active();
        requests++;
        let result;
        if (method === 'eth_getLogs') {
          const [filter] = params;
          assert.equal(filter.address, capture.report.proxy);
          result = logs
            .filter(
              (log) =>
                log.blockNumber >= Number(BigInt(filter.fromBlock)) &&
                log.blockNumber <= Number(BigInt(filter.toBlock))
            )
            .map((log) => ({
              ...log,
              removed: false,
              blockNumber: '0x' + log.blockNumber.toString(16),
              transactionIndex: '0x' + log.transactionIndex.toString(16),
              logIndex: '0x' + log.logIndex.toString(16),
            }));
        } else {
          assert.equal(method, 'eth_getBlockByNumber');
          assert.equal(params[1], false);
          const number =
            params[0] === 'finalized' ? capture.report.anchor.number : Number(BigInt(params[0]));
          const found = headers.get(number);
          assert.ok(found, 'Missing archived header ' + number);
          result = { ...found, number: '0x' + number.toString(16) };
        }
        assert.equal(validate(result), true);
        return { result };
      },
    };
  };
  const { createRailgunSourceLedger } = require('../src/main/wallet/railgun-source-ledger');
  const { createRailgunScanSource } = require('../src/main/wallet/railgun-scan-source');
  const { startRailgunSessionWorker } = require('../src/main/wallet/railgun-session-worker');
  const { createRailgunScanCoordinator } = require('../src/main/wallet/railgun-scan-coordinator');
  const qualified = require('../docs/qualification/railgun-sepolia-history-2026-10-02.json');
  assert.deepEqual(qualified.anchor, capture.report.anchor);
  assert.equal(qualified.logSetSha256, capture.logSetSha256);
  const qualifiedThrough = qualified.anchor.number;
  let jobs;
  const subject = {
    kind: 'private-account',
    principal: 'fixture',
    chainId: 11155111,
    protocol: 'railgun',
    deployment: 'archived-sepolia',
  };
  let scope,
    ledger,
    source,
    session,
    coordinator,
    crashPhase = null;
  const applications = [];
  async function open(create) {
    scope = createPrivacyScope({
      profileId: 'coordinated-public-history',
      signal: new AbortController().signal,
    });
    const rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' }),
      engineHandle = scope.getContext({ ...subject, role: 'engine' });
    jobs = require('./railgun-coordinated-electron').createJobs(engineHandle, qualifiedThrough);
    ledger = await createRailgunSourceLedger({
      handle: rpcHandle,
      filename: path.join(directory, 'source.sqlite'),
      key: Buffer.alloc(32, 61),
      binding: 'a'.repeat(64),
      create,
    });
    source = createRailgunScanSource({
      handle: rpcHandle,
      ledger,
      projectRange: async (...args) => {
        try {
          return await jobs.project(...args);
        } catch (error) {
          console.error('public planner diagnostic', error.stack);
          throw error;
        }
      },
    });
    session = startRailgunSessionWorker({
      handle: engineHandle,
      storage: {
        format: 'paged-v2',
        filename: path.join(directory, 'engine.sqlite'),
        key: Buffer.alloc(32, 62),
        binding: 'b'.repeat(64),
        create,
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw Error('Engine RPC forbidden');
        },
      }),
      onClose: () => {},
    });
    await session.ready;
    coordinator = await createRailgunScanCoordinator({
      handle: engineHandle,
      storeSession: session,
      source,
      journalStorage: { directory, key: Buffer.alloc(32, 63), binding: 'c'.repeat(64) },
      applyRange: async (input, capability) => {
        try {
          applications.push({
            to: input.plan.to.number,
            ...(await jobs.apply({ ...input, crashPhase }, capability)),
          });
        } catch (error) {
          applications.push({
            to: input.plan.to.number,
            interrupted: true,
            phase: error.phase,
            exitSignal: error.exitSignal,
          });
          throw error;
        }
      },
    });
  }
  async function close() {
    coordinator?.close();
    source?.close();
    ledger?.close();
    session?.close();
    scope?.close();
    await Promise.all([ledger?.closed, session?.closed]);
  }
  const sources = [
    'scripts/qualify-railgun-wallet-snapshot.js',
    'scripts/railgun-wallet-snapshot-electron.js',
    'scripts/fixtures/railgun-wallet-snapshot-job.js',
    'src/main/wallet/railgun-wallet-storage.js',
    'src/main/wallet/railgun-wallet-scan.js',
    'src/main/wallet/railgun-wallet-records.js',
    'scripts/railgun-coordinated-electron.js',
    'scripts/fixtures/railgun-coordinated-electron-job.js',
    'src/main/wallet/railgun-event-projector.js',
    'src/main/wallet/railgun-scan-coordinator.js',
    'src/main/wallet/railgun-scan-source.js',
    'src/main/wallet/railgun-source-ledger.js',
    'src/main/wallet/railgun-scan-journal.js',
    'src/main/wallet/railgun-session-worker.js',
    'src/main/wallet/railgun-public-records.js',
    'scripts/railgun-log-capture-data.js',
    'scripts/verify-railgun-sepolia-history.js',
    'scripts/railgun-fixture-integrity.js',
    'src/main/wallet/railgun-session.js',
    'src/main/wallet/railgun-session-worker-entry.js',
    'src/main/wallet/railgun-paged-store.js',
    'src/main/wallet/railgun-frontier.js',
    'src/main/wallet/railgun-remote.js',
    'src/main/wallet/railgun-tree-transactions.js',
    'src/main/wallet/privacy-storage.js',
    'src/main/networks/privacy-context.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'docs/qualification/railgun-sepolia-history-2026-10-02.json',
  ];
  const hashes = () =>
    Object.fromEntries(
      sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
    );
  const sourceSha256 = hashes(),
    runs = [];
  const walletId = sha(
    Buffer.from(require('./fixtures/railgun-wallet-snapshot-job').shared, 'hex')
  );
  let walletSession;
  try {
    await open(false);
    assert.equal((await coordinator.recover()).to.number, capture.report.anchor.number);
    for (const restore of [false, true]) {
      const handle = scope.getContext({ ...subject, role: 'engine' });
      walletSession = startRailgunSessionWorker({
        handle,
        storage: {
          format: 'paged-v2',
          filename: path.join(directory, 'wallet.sqlite'),
          key: Buffer.alloc(32, 64),
          binding: 'd'.repeat(64),
          create: !restore,
        },
        createProvider: ({ signal }) => ({
          signal,
          request: async () => {
            throw Error('No wallet RPC');
          },
        }),
        onClose: () => {},
      });
      await walletSession.ready;
      const started = performance.now(),
        beforeRequests = requests;
      const result = await coordinator.withPublicSnapshot((snapshot) =>
        require('./railgun-wallet-snapshot-electron').runWalletSnapshot({
          handle,
          snapshot,
          walletSession,
          walletId,
          restore,
        })
      );
      assert.equal(
        coordinator.assertSnapshot(result.evidence).to.number,
        capture.report.anchor.number
      );
      assert.equal(result.value.scannedLeaves, 10194);
      assert.equal(result.value.received.length, 0);
      assert.equal(result.value.sent.length, 0);
      assert.equal(result.value.spendableGranted, false);
      runs.push({
        restore,
        elapsedMs: Math.round(performance.now() - started),
        sourceHeaderRequests: requests - beforeRequests,
        ...result.value,
      });
      console.log(
        JSON.stringify({
          restore,
          elapsedMs: runs.at(-1).elapsedMs,
          scannedLeaves: result.value.scannedLeaves,
        })
      );
      walletSession.close();
      await walletSession.closed;
    }
    assert.equal(applications.length, 0);
    assert.deepEqual(hashes(), sourceSha256);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          archivedPublicHistory: true,
          liveAcquisition: false,
          publicViewingVector: true,
          walletCoverageGranted: false,
          spendableGranted: false,
          submissions: 0,
          anchor: capture.report.anchor,
          logSetSha256: capture.logSetSha256,
          requests,
          runs,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    walletSession?.close();
    if (walletSession) await walletSession.closed;
    await close();
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
