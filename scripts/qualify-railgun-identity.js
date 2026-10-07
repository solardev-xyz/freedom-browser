/** Real vault + guarded packaged identity, using an explicitly public test seed.
 * Fresh disposable profile only; never opens a user's existing funded vault.
 */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
let lock;
async function main() {
  const [archive, output] = process.argv.slice(2);
  assert.ok(path.isAbsolute(archive) && path.isAbsolute(output) && !fs.existsSync(output));
  fs.mkdirSync(output, { mode: 0o700 });
  const profileDirectory = path.join(output, 'profile');
  const { initializeProfile } = require('../src/main/profile-resolver');
  const profile = initializeProfile(app, { env: { FREEDOM_TEST_USER_DATA: profileDirectory } });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const vault = require('../src/main/identity/vault'),
    vaultDirectory = path.join(profileDirectory, 'identity');
  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const password = 'public-fixture-password-not-a-user-credential';
  let lockOnSpendingKey = false,
    withheldKey,
    cancelledProcessClosed = false;
  const processModule = require('../src/main/wallet/railgun-process'),
    startProcess = processModule.startRailgunProcess;
  processModule.startRailgunProcess = (options) => {
    const original = options.broker;
    const task = startProcess({
      ...options,
      broker: {
        ...original,
        async dispatch(wire) {
          const message = JSON.parse(wire),
            reply = await original.dispatch(wire);
          if (
            lockOnSpendingKey &&
            message.method === 'key' &&
            message.purpose === 'spending-public'
          ) {
            lockOnSpendingKey = false;
            withheldKey = reply;
            vault.lockVault();
          }
          return reply;
        },
      },
    });
    task.closed.then((result) => {
      if (withheldKey && result.code === 'PRIVACY_CONTEXT_REVOKED') cancelledProcessClosed = true;
    });
    return task;
  };
  const {
    openRailgunIdentity,
    assertRailgunIdentity,
    withRailgunViewingCredential,
  } = require('../src/main/wallet/railgun-identity');
  const files = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-identity.js',
    'scripts/build-railgun-engine.js',
    'src/main/wallet/railgun-identity.js',
    'src/main/wallet/railgun-identity-job.js',
    'src/main/wallet/railgun-engine-runtime.js',
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/identity/privacy-keys.js',
    'src/main/identity/railgun-key-derivation.js',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/privacy-session.js',
    'src/main/networks/privacy-context.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      files.map((f) => [
        f,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', f)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes(),
    runs = [];
  let identity;
  try {
    await vault.importVault(vaultDirectory, password, phrase);
    await vault.unlockVault(vaultDirectory, password, 0);
    for (const accountIndex of [0, 1]) {
      const start = performance.now();
      identity = await openRailgunIdentity({ archive, accountIndex });
      const descriptor = assertRailgunIdentity(identity);
      assert.equal(Object.isFrozen(descriptor), true);
      assert.throws(() => assertRailgunIdentity({ ...identity }));
      await assert.rejects(openRailgunIdentity({ archive, accountIndex }));
      let retained;
      await withRailgunViewingCredential(identity, ({ viewingKey, spendingPublicKey }) => {
        retained = viewingKey;
        assert.equal(viewingKey.length, 32);
        assert.ok(viewingKey.some((v) => v !== 0));
        assert.deepEqual(spendingPublicKey, descriptor.spendingPublicKey);
      });
      assert.ok(retained.every((v) => v === 0));
      runs.push({
        accountIndex,
        descriptor,
        elapsedMs: Math.round(performance.now() - start),
        duplicateRefused: true,
        clonedIdentityRefused: true,
        viewingBufferWiped: true,
      });
      identity.close();
      assert.throws(() => assertRailgunIdentity(identity));
    }
    assert.notEqual(runs[0].descriptor.instanceId, runs[1].descriptor.instanceId);
    lockOnSpendingKey = true;
    await assert.rejects(openRailgunIdentity({ archive, accountIndex: 2 }));
    assert.equal(cancelledProcessClosed, true);
    assert.ok(withheldKey instanceof Uint8Array && withheldKey.every((v) => v === 0));
    await vault.unlockVault(vaultDirectory, password, 0);
    identity = await openRailgunIdentity({ archive, accountIndex: 2 });
    identity.close();
    vault.lockVault();
    await vault.unlockVault(vaultDirectory, password, 0);
    identity = await openRailgunIdentity({ archive, accountIndex: 0 });
    assert.deepEqual(assertRailgunIdentity(identity), runs[0].descriptor);
    let retained;
    await assert.rejects(
      withRailgunViewingCredential(identity, async ({ viewingKey }) => {
        retained = viewingKey;
        vault.lockVault();
        assert.ok(viewingKey.every((v) => v === 0));
      })
    );
    assert.ok(retained.every((v) => v === 0));
    assert.throws(() => assertRailgunIdentity(identity));
    await assert.rejects(openRailgunIdentity({ archive }));
    assert.deepEqual(hashes(), sourceSha256);
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          publicTestMnemonic: true,
          runtime: require('../src/main/wallet/railgun-engine-manifest.json'),
          runs,
          lockRevocation: true,
          spendingKeyTransferCancelled: true,
          cancelledProcessClosed: true,
          cancelledKeyWiped: true,
          cancelledAccountReopened: true,
          reopenIdentityMatches: true,
          submissions: 0,
          spendingCapabilityGranted: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(
      JSON.stringify({ identities: runs.length, lockRevocation: true, reopenIdentityMatches: true })
    );
  } finally {
    identity?.close();
    vault.lockVault();
  }
}
main().then(
  () => {
    if (lock) releaseProfileLock(lock);
    app.exit(0);
  },
  (error) => {
    console.error(error.stack);
    if (lock) releaseProfileLock(lock);
    app.exit(1);
  }
);
