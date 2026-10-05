/** Transparent, sticky utility/worker/key observations for this fixed public lane. */
const path = require('path');
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
function install() {
  for (const name of [
    'railgun-process',
    'railgun-session-worker',
    'railgun-identity',
    'railgun-wallet-run',
    'railgun-account-wallet',
    'railgun-shield-receive',
  ])
    assert.equal(!!require.cache[require.resolve('../../src/main/wallet/' + name)], false);
  const session = require('../../src/main/wallet/railgun-session-worker');
  const saved = [],
    tasks = [],
    loans = [],
    jobs = {},
    keyPurposes = {},
    childResults = [],
    workerResults = [],
    workerKinds = {};
  const track = (promise) => {
    promise.catch((error) => sticky.record(error, 'public-cold.child.closed'));
    tasks.push(promise);
  };
  let workers = 0,
    viewing = 0,
    guards = 0,
    active = true;
  for (const name of ['startRailgunSessionWorker', 'startRailgunReadOnlySessionWorker']) {
    const original = session[name];
    saved.push(() => {
      session[name] = original;
    });
    session[name] = (options) => {
      assert.equal(active, true);
      // Classify only bounded store purpose/lifecycle; never report a path or ID.
      const storage = options.storage;
      assert.equal(storage?.format, 'paged-v2');
      assert.equal(typeof storage.filename, 'string');
      assert.equal(typeof storage.create, 'boolean');
      const basename = path.basename(storage.filename);
      const match = /^(source|public|wallet)(?:\.init-[0-9a-f]{32})?\.sqlite$/.exec(basename);
      assert.ok(match, 'Unexpected public cold store worker');
      const initializing = basename.includes('.init-');
      assert.equal(storage.create, initializing);
      const readOnly = name === 'startRailgunReadOnlySessionWorker';
      assert.ok(!readOnly || (!initializing && match[1] === 'wallet'));
      const kind = match[1] + '.' + (initializing ? 'initialize' : readOnly ? 'readOnly' : 'open');
      workers++;
      workerKinds[kind] = (workerKinds[kind] ?? 0) + 1;
      const task = original(options);
      track(
        task.closed.then((result) => {
          workerResults.push({ kind, exitCode: result.exitCode });
          assert.equal(result.exitCode, 0);
        })
      );
      return task;
    };
  }
  const runtime = require('../../src/main/wallet/railgun-process'),
    start = runtime.startRailgunProcess;
  saved.push(() => {
    runtime.startRailgunProcess = start;
  });
  runtime.startRailgunProcess = (options) => {
    assert.equal(active, true);
    const name = path.basename(options.filename, '.js'),
      input = JSON.parse(options.input);
    assert.ok(
      [
        'railgun-identity-job',
        'railgun-public-job',
        'railgun-wallet-job',
        'railgun-shield-job',
        'railgun-shield-receive-job',
      ].includes(name),
      'Unexpected public cold utility'
    );
    const key = name === 'railgun-public-job' ? name + ':' + input.mode : name;
    jobs[key] = (jobs[key] ?? 0) + 1;
    if (name === 'railgun-wallet-job') {
      assert.equal(input.privateIntent, undefined);
      assert.equal(input.privateOperation, undefined);
      assert.equal(input.privateRecovery, undefined);
    }
    const original = options.broker;
    let reported = false;
    const task = start({
      ...options,
      broker: {
        ...original,
        async dispatch(wire) {
          const message = JSON.parse(wire);
          if (message.method === 'key') {
            keyPurposes[message.purpose] = (keyPurposes[message.purpose] ?? 0) + 1;
            assert.ok(
              ['wallet-viewing', 'shield-receive', 'spending-public', 'viewing-identity'].includes(
                message.purpose
              )
            );
          }
          const guard = message.guards ?? message.value?.guards;
          if (guard) {
            assert.equal(reported, false);
            reported = true;
            guards++;
            assert.equal(guard.attempts, 0);
            assert.ok(Array.isArray(guard.hooks) && guard.hooks.length > 0);
            assert.equal(guard.canaries, guard.hooks.length);
            assert.equal(new Set(guard.hooks).size, guard.hooks.length);
          }
          const result = await original.dispatch(wire);
          if (message.method === 'key') {
            assert.ok(result instanceof Uint8Array && result.length === 32);
            loans.push(result);
          }
          return result;
        },
      },
    });
    track(
      task.closed.then((result) => {
        childResults.push({
          job: key,
          code: result.code,
          exitCode: result.exitCode,
          escalated: result.escalated,
          peerDisconnected: result.peerDisconnected,
        });
        assert.equal(result.code, 'RAILGUN_PROCESS_CLOSED');
        assert.ok(Number.isInteger(result.exitCode));
        assert.equal(result.escalated, false);
        assert.equal(result.peerDisconnected, false);
        assert.equal(reported, true);
      })
    );
    return task;
  };
  const identity = require('../../src/main/wallet/railgun-identity'),
    originalViewing = identity.withRailgunViewingCredential;
  saved.push(() => {
    identity.withRailgunViewingCredential = originalViewing;
  });
  identity.withRailgunViewingCredential = (value, use) =>
    originalViewing(value, (credential) => {
      viewing++;
      assert.ok(credential.viewingKey instanceof Uint8Array && credential.viewingKey.length === 32);
      loans.push(credential.viewingKey);
      return use(credential);
    });
  // Error observers are attached immediately, even when a host masks refusal.
  const snapshot = () => ({
    jobs: { ...jobs },
    keyPurposes: { ...keyPurposes },
    workers,
    workerKinds: { ...workerKinds },
    viewing,
    guards,
  });
  return {
    snapshot,
    async close() {
      active = false;
      for (const restore of saved.reverse()) restore();
      const results = await Promise.allSettled(tasks);
      for (const result of results)
        if (result.status === 'rejected') sticky.record(result.reason, 'public-cold.child.closed');
      assert.ok(loans.length > 0);
      assert.ok(loans.every((key) => key.every((byte) => byte === 0)));
      sticky.assertEmpty();
      return { ...snapshot(), childResults, workerResults, credentialBuffersWiped: true };
    },
  };
}
module.exports = { install };
