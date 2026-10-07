/** Qualification-only route observation. This never starts or authorizes work. */
const assert = require('assert/strict');
const path = require('path');
const wallet = path.resolve(__dirname, '../../src/main/wallet');
const jobs = Object.freeze({
  'spending-public': 'railgun-identity-job.js',
  'viewing-identity': 'railgun-identity-job.js',
  'spending-sign': 'railgun-spend-sign-job.js',
  'wallet-viewing': 'railgun-wallet-job.js',
  'private-prepare': 'railgun-private-prepare-job.js',
  'private-operate': 'railgun-private-operate-job.js',
  'private-recover': 'railgun-private-recover-job.js',
  'private-receive': 'railgun-private-receive-job.js',
  'private-verify': 'railgun-private-verify-job.js',
});

function observeRailgunJob(options) {
  assert.ok(options && typeof options === 'object');
  if (Object.hasOwn(options, 'executionJob')) {
    assert.equal(Object.hasOwn(options, 'filename'), false);
    assert.equal(Object.hasOwn(options, 'binaryKey'), false);
    const job = options.executionJob;
    assert.ok(typeof job === 'string' && Object.hasOwn(jobs, job));
    // Resolve the installed inventory, without importing a job or initializing
    // host bindings. The production supervisor independently admits this enum.
    const filename =
      require('@freedom/railgun-kohaku-adapter/host/execution').getRailgunExecutionJob(job);
    assert.ok(path.isAbsolute(filename));
    assert.equal(path.basename(filename), jobs[job]);
    if (job === 'spending-public' || job === 'viewing-identity')
      assert.equal(JSON.parse(options.input).purpose, job);
    return Object.freeze({ route: 'kernel', executionJob: job, filename, name: jobs[job] });
  }
  assert.ok(typeof options.filename === 'string' && path.isAbsolute(options.filename));
  const name = path.basename(options.filename);
  // A legacy call must not be counted as an extracted kernel job, even when
  // a fixture supplies a same-named file outside the original wallet directory.
  assert.equal(Object.values(jobs).includes(name), false);
  return Object.freeze({ route: 'legacy', executionJob: null, filename: options.filename, name });
}

function isRailgunWalletJob(options, name) {
  assert.match(name, /^railgun-[a-z-]+-job\.js$/);
  const observation = observeRailgunJob(options);
  return observation.route === 'kernel'
    ? observation.name === name
    : observation.filename === path.join(wallet, name);
}

/** Main-process target identity only. This neither inspects child module caches
 * nor changes a task, broker, bootstrap, or host binding. */
function createRailgunJobEvidence() {
  const fs = require('fs');
  const { createHash } = require('crypto');
  const root = path.resolve(__dirname, '../..');
  const relativeRoot = 'node_modules/@freedom/railgun-kohaku-adapter';
  const packageRoot = path.join(root, relativeRoot);
  assert.equal(fs.realpathSync(packageRoot), packageRoot);
  const entry = path.join(packageRoot, 'host-execution.cjs');
  assert.equal(require.resolve('@freedom/railgun-kohaku-adapter/host/execution'), entry);
  const pin = (filename) => {
    assert.ok(filename.startsWith(root + path.sep));
    assert.equal(fs.realpathSync(filename), filename);
    assert.ok(fs.lstatSync(filename).isFile());
    const bytes = fs.readFileSync(filename);
    return Object.freeze({
      path: path.relative(root, filename),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  const bootstrapPins = [
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-kernel-entry.js',
    'src/main/wallet/railgun-process-entry.js',
    ...[
      'package.json',
      'host-execution.cjs',
      'host-bootstrap.cjs',
      'src/execution/job-locations.js',
      'src/execution/host-bindings.js',
      'src/execution/railgun-process-guards.js',
    ].map((name) => relativeRoot + '/' + name),
  ]
    .sort()
    .map((name) => pin(path.join(root, name)));
  const targets = new Map();
  return Object.freeze({
    observe(options) {
      const observed = observeRailgunJob(options);
      if (observed.route === 'kernel')
        assert.equal(observed.filename, path.join(packageRoot, 'src/execution', observed.name));
      else
        assert.ok(
          observed.filename.startsWith(path.join(root, 'src/main/wallet') + path.sep) ||
            observed.filename.startsWith(path.join(root, 'scripts/fixtures') + path.sep)
        );
      const target = Object.freeze({
        route: observed.route,
        executionJob: observed.executionJob,
        ...pin(observed.filename),
      });
      const key = observed.executionJob ?? target.path;
      if (targets.has(key)) assert.deepEqual(targets.get(key), target);
      targets.set(key, target);
      return target;
    },
    report() {
      for (const original of [...bootstrapPins, ...targets.values()])
        assert.deepEqual(pin(path.join(root, original.path)), {
          path: original.path,
          bytes: original.bytes,
          sha256: original.sha256,
        });
      const mainPackageCache = [];
      for (const [key, value] of Object.entries(require.cache)) {
        const candidate = (filename) =>
          typeof filename === 'string' &&
          (filename.startsWith(packageRoot + path.sep) ||
            filename.includes('/@freedom/railgun-kohaku-adapter/'));
        if (!candidate(key) && !candidate(value.filename)) continue;
        assert.equal(key, value.filename);
        assert.ok(key.startsWith(packageRoot + path.sep));
        // Jobs and archive runtimes belong in the utility, never the main cache.
        assert.ok(!/\/railgun-[^/]+-job\.js$/.test(key));
        assert.ok(!/\/railgun-(engine|prover)-runtime\.js$/.test(key));
        assert.notEqual(key, path.join(packageRoot, 'host-bootstrap.cjs'));
        mainPackageCache.push(pin(key));
      }
      assert.ok(
        mainPackageCache.some(({ path: name }) => name === relativeRoot + '/host-execution.cjs')
      );
      return {
        scope: 'main-observed-installed-job-targets',
        utilityModuleCacheObserved: false,
        historicalExecutionCoverage: false,
        packageRoot: relativeRoot,
        bootstrapPins,
        targets: [...targets.values()].sort((a, b) =>
          (a.executionJob ?? a.path).localeCompare(b.executionJob ?? b.path)
        ),
        mainPackageCache: mainPackageCache.sort((a, b) => a.path.localeCompare(b.path)),
      };
    },
  });
}

module.exports = { observeRailgunJob, isRailgunWalletJob, createRailgunJobEvidence };
