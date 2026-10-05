/** Offline public-vector three-process campaign. Root runs each phase in a fresh
 * Electron OS process after its predecessor exits. No live fallback exists.
 * Usage: Electron THIS setup|resolve|restore SOURCE DIR ENGINE BYTECODES acknowledged|lost-response
 */
const fs = require('fs'),
  originalFs = require('original-fs'),
  path = require('path');
const { app } = require('electron');
const sticky = require('./fixtures/railgun-native-assertions');
const { assert } = sticky;
const data = require('./fixtures/railgun-public-cold-data');
const handoff = require('./fixtures/railgun-public-cold-handoff');
let lock, releaseLock, diagnostics;
// Failure-only fixture watchdog: force exit is not a successful drain. No
// handoff/report success follows a timeout; root must check every process exit.
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ status: 'refused', stage: 'fixture-timeout', drained: false }));
  app.exit(1);
}, 900000);
function sourceInventory() {
  const root = path.resolve(__dirname, '..'),
    sources = {};
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name))
        sources[path.relative(root, file)] = data.digest(fs.readFileSync(file));
    }
  }
  visit(path.join(root, 'src'));
  visit(path.join(root, 'scripts', 'fixtures'));
  for (const file of [
    __filename,
    path.join(root, 'package.json'),
    path.join(root, 'package-lock.json'),
    path.join(root, 'babel.config.json'),
    path.join(root, 'eslint.config.js'),
    path.join(root, 'jest.config.js'),
  ])
    sources[path.relative(root, file)] = data.digest(fs.readFileSync(file));
  return { root, sources };
}
async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 6);
  const [phase, sourceFile, directory, archive, bytecodes, mode] = args;
  assert.ok(handoff.PHASES.includes(phase));
  assert.ok(['acknowledged', 'lost-response'].includes(mode));
  for (const file of [sourceFile, directory, archive, bytecodes]) assert.ok(path.isAbsolute(file));
  for (const key of Object.keys(process.env))
    if (key.startsWith('FREEDOM_RAILGUN_')) assert.fail('No inherited Railgun mode allowed');
  const { root, sources } = sourceInventory();
  const inputs = Object.fromEntries(
    Object.entries({ source: sourceFile, archive, bytecodes }).map(([name, file]) => [
      name,
      // Hash external archive bytes, not Electron's ASAR virtual directory.
      data.digest(originalFs.readFileSync(file)),
    ])
  );
  let previous, chain;
  if (phase === 'setup') {
    assert.equal(fs.existsSync(directory), false);
    fs.mkdirSync(directory, { mode: 0o700 });
    chain = data.createChain(handoff.read(sourceFile));
  } else
    ({ value: previous, chain } = handoff.load(directory, {
      phase,
      mode,
      inputs,
      sourceHashes: sources,
      pid: process.pid,
      isAlive: handoff.isAlive,
    }));
  const transport = require('./fixtures/railgun-public-cold-chain').install({
    chain,
    bytecodes,
    phase,
    mode,
  });
  const observer = require('./fixtures/railgun-public-cold-observer').install();
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
  });
  const locks = require('../src/main/profile-lock');
  releaseLock = locks.releaseProfileLock;
  lock = locks.acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const session = require('./fixtures/railgun-public-cold-session');
  let state, result, observation, error, transportFinal;
  const began = performance.now();
  try {
    state = await session.open({ directory, archive, phase, transport });
    const run = require('./fixtures/railgun-public-cold-run');
    result = await session.bounded(
      (phase === 'setup' ? run.setup : run.resume)({
        state,
        archive,
        phase,
        chain,
        transport,
        observer,
        mode,
        previous,
      }),
      'phase',
      480000
    );
  } catch (e) {
    error = e;
    sticky.record(e, 'public-cold.phase');
  } finally {
    for (const [label, use] of [
      ['session', () => state?.close()],
      ['synthetic transport', () => transport.close()],
      [
        'resource observations',
        async () => {
          observation = await observer.close();
        },
      ],
    ])
      try {
        await session.bounded(Promise.resolve().then(use), label);
      } catch (e) {
        sticky.record(e, label);
        error ??= e;
      }
    transportFinal = transport.snapshot();
  }
  diagnostics = { phase, counts: transportFinal, resources: observation ?? null };
  if (error) throw error;
  sticky.assertEmpty();
  assert.equal(transportFinal.creates, 1);
  assert.equal(transportFinal.closes, 1);
  assert.equal(state.bootstrapAddresses, 1);
  assert.equal(state.addresses, phase === 'setup' ? 1 : 0);
  assert.equal(transportFinal.sends, phase === 'setup' ? 1 : 0);
  assert.equal(
    transportFinal.controlledLosses,
    phase === 'setup' && mode === 'lost-response' ? 1 : 0
  );
  const ranges = {
    baseline: { from: 0, to: chain.baselineTo, anchor: { number: chain.latest } },
    next: {
      from: chain.baselineTo + 1,
      to: chain.baselineTo + 1,
      anchor: { number: chain.latest },
    },
  };
  const events = new Set(
    chain.logs.filter((l) => l.blockNumber <= chain.baselineTo).map((l) => l.blockNumber)
  ).size;
  const wanted = require('./fixtures/railgun-public-cold-counts').expected(
    phase,
    ranges.baseline,
    ranges.next,
    events
  );
  require('./fixtures/railgun-public-cold-counts').assertCounts(
    { ...transportFinal, ...observation, eoaSigns: state.signs },
    wanted
  );
  assert.deepEqual(sourceInventory().sources, sources);
  for (const file of Object.keys(require.cache)) {
    if (!path.isAbsolute(file)) {
      // Electron's main-process loader inserts these virtual modules. Their
      // bytes belong to the separately pinned runtime, not project files.
      assert.ok(
        ['electron', 'electron/common', 'electron/main'].includes(file),
        'Unexpected virtual runtime module'
      );
      assert.equal(fs.existsSync(path.resolve(root, file)), false);
      const entry = require.cache[file];
      assert.equal(entry.id, 'electron');
      assert.equal(entry.filename, file);
      assert.equal(entry.loaded, true);
      assert.equal(entry.exports, require('electron'));
      continue;
    }
    const rel = path.relative(root, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith('node_modules/'))
      assert.ok(Object.hasOwn(sources, rel), 'Imported source absent from inventory: ' + rel);
  }
  if (phase === 'setup') handoff.write(path.join(directory, 'public-wire.json'), chain);
  else
    assert.equal(
      data.digest(handoff.read(path.join(directory, 'public-wire.json'))),
      previous.chainSha256
    );
  handoff.write(path.join(directory, phase + '-handoff.json'), {
    schema: 'railgun-public-cold-credit-v1',
    phase,
    mode,
    pid: process.pid,
    inputs,
    sourceHashes: sources,
    profileFiles: handoff.profileFiles(path.join(directory, 'profile')),
    chainSha256: data.digest(chain),
    owner: state.owner,
    ...(result.baseline && { baseline: result.baseline }),
    creditSha256: result.creditSha256,
    record: result.record,
  });
  handoff.write(path.join(directory, phase + '-report.json'), {
    schema: 'railgun-public-cold-credit-report-v1',
    phase,
    mode,
    pid: process.pid,
    previousPid: previous?.pid ?? null,
    elapsedMs: Math.ceil(performance.now() - began),
    inputs,
    sourceHashes: sources,
    counts: {
      ...transportFinal,
      ...observation,
      eoaSigns: state.signs,
      bootstrapAddressLookups: state.bootstrapAddresses,
      transactionAddressLookups: state.addresses,
    },
    expected: wanted,
    checks: result.checks,
    limits: {
      syntheticChain: true,
      publicVector: true,
      fixtureMetadataProvisioned: true,
      realProcessRestart: phase !== 'setup',
      consensusFinality: false,
      torOrPhysicalSocketDrain: false,
      poiOrTxidQueries: false,
      spendability: false,
      privateOperation: false,
      ordinaryWalletCredit: phase !== 'setup',
      wholeBrowserProfileByteIdentity: false,
    },
  });
}
main().then(
  () => {
    clearTimeout(watchdog);
    if (lock) releaseLock(lock);
    app.exit(0);
  },
  (error) => {
    clearTimeout(watchdog);
    // No stack/message/ciphertext/owner leaks in failure output.
    console.error(
      JSON.stringify({
        status: 'refused',
        code: /^[A-Z0-9_]{1,80}$/.test(error?.code) ? error.code : null,
        fixtureViolations: sticky.report(),
        assertionLine:
          /railgun-public-(?:cold-(?:chain|data|counts|handoff|observer|run|session)|facade-cold-credit)\.js:(\d+):/.exec(
            error?.stack ?? ''
          )?.[1] ?? null,
        diagnostics,
      })
    );
    if (lock) releaseLock(lock);
    app.exit(1);
  }
);
