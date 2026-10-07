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

module.exports = { observeRailgunJob, isRailgunWalletJob };
