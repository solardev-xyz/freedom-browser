/** Real vault/engine identity and durable enrollment; public disposable keys only. */
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
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(output, 'profile') },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const vault = require('../src/main/identity/vault'),
    { openRailgunIdentity } = require('../src/main/wallet/railgun-identity'),
    { openRailgunAccountEnrollment } = require('../src/main/wallet/railgun-account-enrollment'),
    { openRailgunAccountStore } = require('../src/main/wallet/railgun-account-store');
  const sources = [
    'scripts/qualify-railgun-enrollment.js',
    'src/main/wallet/railgun-account-enrollment.js',
    'src/main/wallet/railgun-account-store.js',
    'src/main/wallet/railgun-source-ledger.js',
    'src/main/wallet/railgun-scan-journal.js',
    'src/main/wallet/railgun-public-records.js',
    'src/main/wallet/privacy-profile-guard.js',
    'src/main/wallet/privacy-storage.js',
    'src/main/wallet/railgun-wallet-catalog.js',
    'src/main/wallet/railgun-identity.js',
    'src/main/wallet/railgun-identity-job.js',
    'src/main/wallet/railgun-engine-runtime.js',
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/identity/privacy-keys.js',
    'src/main/identity/railgun-key-derivation.js',
    'src/main/wallet/privacy-session.js',
    'src/main/networks/privacy-context.js',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/railgun-session-worker.js',
    'src/main/wallet/railgun-session-worker-entry.js',
    'src/main/wallet/railgun-session.js',
    'src/main/wallet/railgun-paged-store.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      sources.map((p) => [
        p,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', p)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes();
  const password = 'public-fixture-password-not-a-user-credential',
    phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    vaultDirectory = path.join(profile.userDataDir, 'identity');
  let identity, enrollment, worker;
  const storeIds = {};
  let sourceReference;
  async function store(kind, create, generationId) {
    const opened = await openRailgunAccountStore({
      enrollment,
      kind,
      create,
      generationId,
      expectedStoreId: create ? undefined : storeIds[kind],
    });
    worker = opened.session;
    try {
      const observed = await worker.inspectStoreIdentity();
      worker.assertFresh(observed);
      assert.equal(observed.instanceId, opened.storeId);
      if (create) storeIds[kind] = opened.storeId;
      else assert.equal(opened.storeId, storeIds[kind]);
      if (kind === 'source') {
        assert.equal(opened.ledger.identity(), opened.storeId);
        assert.throws(() => worker.claimDispatch());
        if (create) opened.ledger.assertEmpty();
        else assert.throws(() => opened.ledger.assertEmpty());
        const reference = await opened.ledger.stage(
          {
            from: 0,
            to: { number: 10, hash: '0x' + '1'.repeat(64) },
            previousHash: '0x' + '0'.repeat(64),
            providersSha256: 'b'.repeat(64),
            logs: { count: 0, sha256: createHash('sha256').update('').digest('hex') },
          },
          []
        );
        if (create) sourceReference = reference;
        else assert.deepEqual(reference, sourceReference);
        assert.deepEqual(
          await opened.ledger.visit(reference, () => {
            throw Error('no logs');
          }),
          { count: 0, bytes: 0 }
        );
      }
      assert.ok(
        !fs
          .readdirSync(path.dirname(opened.filename))
          .some((name) => name.startsWith(kind + '.init-'))
      );
    } finally {
      worker.close();
      await worker.closed;
      worker = null;
    }
  }
  try {
    await vault.importVault(vaultDirectory, password, phrase);
    await vault.unlockVault(vaultDirectory, password, 0);
    identity = await openRailgunIdentity({ archive });
    enrollment = await openRailgunAccountEnrollment({ identity, create: true });
    const descriptor = identity.descriptor,
      directory = enrollment.directory,
      candidate = await enrollment.catalog.begin('2'.repeat(64));
    let borrowed;
    for (const create of [true, false]) {
      await enrollment.withPublicKeys(async (keys) => {
        borrowed = Object.values(keys);
        await store('source', create);
        await store('public', create);
      });
      assert.ok(borrowed.every((k) => k.every((v) => v === 0)));
      await enrollment.withGenerationKeys(candidate.id, async (keys) => {
        borrowed = Object.values(keys);
        await store('wallet', create, candidate.id);
      });
      assert.ok(borrowed.every((k) => k.every((v) => v === 0)));
      if (create) {
        enrollment.close();
        identity.close();
        vault.lockVault();
        await vault.unlockVault(vaultDirectory, password, 0);
        identity = await openRailgunIdentity({ archive });
        assert.deepEqual(identity.descriptor, descriptor);
        enrollment = await openRailgunAccountEnrollment({ identity });
        assert.equal(enrollment.directory, directory);
        assert.equal((await enrollment.catalog.resume()).id, candidate.id);
      }
    }
    await assert.rejects(
      enrollment.withPublicKeys(async (keys) => {
        borrowed = Object.values(keys);
        vault.lockVault();
        assert.ok(borrowed.every((k) => k.every((v) => v === 0)));
      })
    );
    assert.equal(enrollment.signal.aborted, true);
    await vault.unlockVault(vaultDirectory, password, 0);
    identity = await openRailgunIdentity({ archive });
    const filename = path.join(candidate.directory, 'wallet.sqlite');
    fs.renameSync(filename, filename + '.preserved');
    await assert.rejects(openRailgunAccountEnrollment({ identity }), {
      code: 'PRIVATE_PROFILE_STORE_MISSING',
    });
    await assert.rejects(openRailgunAccountEnrollment({ identity, create: true }), {
      code: 'PRIVATE_PROFILE_STORE_MISSING',
    });
    assert.equal(fs.existsSync(filename), false);
    assert.deepEqual(hashes(), sourceSha256);
    const inventory = JSON.parse(
      fs.readFileSync(path.join(profile.userDataDir, 'wallet-privacy-inventory.json'))
    );
    assert.equal(inventory.state.files.length, 5);
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          publicVaultFixture: true,
          hostStoreComposition: true,
          stagedInitialization: true,
          sourceLedgerMetadataInitializedBeforePublication: true,
          sourceLedgerExclusiveDispatch: true,
          syntheticEmptySourceRangeRestored: true,
          automaticInventoryRegistration: true,
          identityMatchesAfterUnlock: true,
          encryptedEnrollmentAndCatalog: true,
          registeredFiles: inventory.state.files.length,
          realPagedStoresCreatedAndReopened: Object.keys(storeIds),
          distinctStoreIds: new Set(Object.values(storeIds)).size === 3,
          borrowedKeysWipedAfterUseAndLock: true,
          missingEnrolledStoreRefused: true,
          scansPerformed: false,
          spendabilityGranted: false,
          submissions: 0,
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );
  } finally {
    worker?.close();
    if (worker) await worker.closed;
    enrollment?.close();
    identity?.close();
    vault.lockVault();
  }
}
main().then(
  () => {
    releaseProfileLock(lock);
    app.exit(0);
  },
  (error) => {
    console.error(error.stack);
    releaseProfileLock(lock);
    app.exit(1);
  }
);
