/** Real engine and host scan coordinator against archived public RPC responses.
 * No network, wallet keys or transactions. This is not live source qualification.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict'),
  { createHash } = require('crypto');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function main() {
  const [captureDir, headerDir, directory] = process.argv.slice(2);
  for (const value of [captureDir, headerDir, directory]) assert.ok(path.isAbsolute(value));
  assert.ok(!fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
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
  const jobs = require('./railgun-coordinated-child');
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
  const applications = [],
    observations = [];
  async function open(create) {
    scope = createPrivacyScope({
      profileId: 'coordinated-public-history',
      signal: new AbortController().signal,
    });
    const rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' }),
      engineHandle = scope.getContext({ ...subject, role: 'engine' });
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
    'scripts/qualify-railgun-coordinated-replay.js',
    'scripts/railgun-coordinated-child.js',
    'scripts/fixtures/railgun-coordinated-job.js',
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
  ];
  const sourceSha256 = Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
  try {
    await open(true);
    for (const range of ranges) {
      const started = performance.now();
      // This nonempty historical range contains all three public event categories.
      const interrupt = range.from === 7000000;
      if (interrupt) crashPhase = 'nullifiers';
      try {
        await coordinator.advance({ to: range.to, anchor: capture.report.anchor });
        assert.equal(interrupt, false, 'Expected engine interruption');
      } catch (error) {
        if (!interrupt) throw error;
        assert.equal(applications.at(-1).phase, 'nullifiers');
        assert.equal(applications.at(-1).exitSignal, 'SIGKILL');
        assert.throws(() => coordinator.inspect());
        await close();
        crashPhase = null;
        provider = 'archived-source-b.invalid';
        await open(false);
        const recovered = await coordinator.recover();
        assert.equal(recovered.to.number, range.to);
      }
      const state = await session.inspectPublicState();
      const row = {
        ...range,
        elapsedMs: Math.round(performance.now() - started),
        state,
        interruptedAndRecovered: interrupt,
      };
      observations.push(row);
      fs.writeFileSync(
        path.join(directory, 'progress.json'),
        JSON.stringify({ ranges: observations.length, last: row }, null, 2) + '\n',
        { mode: 0o600 }
      );
      console.log(
        JSON.stringify({
          range: observations.length,
          to: range.to,
          elapsedMs: row.elapsedMs,
          leaves: state.commitments.count,
          nullifiers: state.nullifiers.count,
          unshields: state.unshields.count,
          recovered: interrupt,
        })
      );
    }
    const complete = await session.inspectPublicState();
    const expected = require('../docs/qualification/railgun-public-state-2026-10-02.json').runs.at(
      -1
    ).publicState;
    assert.deepEqual({ ...complete, storeId: expected.storeId }, expected);
    await close();
    await open(false);
    await coordinator.recover();
    const cold = await session.inspectPublicState();
    assert.deepEqual(cold, complete);
    const report = {
      observedAt: new Date().toISOString(),
      sourceSha256,
      captureReportSha256: capture.reportSha256,
      logSetSha256: capture.logSetSha256,
      headerFileSha256: headerReport.headerFileSha256,
      controlledArchivedRpc: true,
      liveRpc: false,
      engine: 'authenticated9.6.0-guarded-node-child',
      requests,
      applications,
      observations,
      cold,
      submissions: 0,
      walletScanned: false,
      receiptCompletenessProven: false,
      electronCoordinatorQualified: false,
    };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } finally {
    await close();
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
