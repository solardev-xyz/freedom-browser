/** Offline internal partial withdrawal over genuinely scanned, disposable
 * enrolled accounts. Service/RPC responses and list signing trust are fixtures;
 * account, POI/preflight hosts, reservations, signer and A/B/C are production.
 * electron script SOURCE NEW_DIRECTORY ENGINE PROVER ARTIFACTS BYTECODES
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const OFFSET = 5944700;
let lock,
  phase = 'setup';
async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 6);
  const [sourceFilename, directory, archive, proverArchive, artifactDirectory, bytecodes] = args;
  assert.ok(args.every((value) => path.isAbsolute(value)));
  assert.equal(fs.existsSync(directory), false);
  const sourceBytes = fs.readFileSync(sourceFilename);
  // This one published public-vector source is allowed. Never accept a real
  // wallet export just because its JSON claims to be a disposable fixture.
  assert.equal(
    sha(sourceBytes),
    'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41'
  );
  const source = JSON.parse(sourceBytes);
  assert.equal(source.publicVaultVector, true);
  for (const log of source.logs) {
    log.blockNumber += OFFSET;
    log.blockHash = hex(log.blockNumber + 1000);
  }
  const anchor = { number: OFFSET + 100, hash: hex(OFFSET + 1100) };
  fs.mkdirSync(directory, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const inventory = () => {
    const files = [
      __filename,
      ...fs
        .readdirSync(path.join(__dirname, 'fixtures'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => path.join(__dirname, 'fixtures', name)),
      ...['wallet', 'networks', 'identity'].flatMap((name) => {
        const base = path.join(__dirname, '../src/main', name);
        return fs
          .readdirSync(base)
          .filter((name) => /\.(js|json)$/.test(name))
          .map((name) => path.join(base, name));
      }),
    ];
    return Object.fromEntries(
      files
        .sort()
        .map((file) => [
          path.relative(path.join(__dirname, '..'), file),
          sha(fs.readFileSync(file)),
        ])
    );
  };
  const sourceHashes = inventory();
  const runtime = require('../src/main/wallet/railgun-process');
  const originalStart = runtime.startRailgunProcess;
  const trace = [];
  const children = new Set(),
    childResults = [],
    loans = [];
  let spendingKeys = 0,
    receiveKeys = 0,
    corruptReceiver = false;
  let reservations, capsules;
  runtime.startRailgunProcess = (options) => {
    const broker = options.broker;
    const traced = path.basename(options.filename) === 'railgun-private-operate-job.js';
    if (traced && broker)
      broker.signal.addEventListener(
        'abort',
        () => {
          trace.push({
            event: 'operate-broker-abort',
            at: Math.round(performance.now()),
            frames: new Error().stack.split('\n').slice(1, 12),
          });
        },
        { once: true }
      );
    const task = originalStart({
      ...options,
      ...(broker
        ? {
            broker: {
              ...broker,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                if (traced && message.method === 'private-intent')
                  trace.push({ event: 'intent-enter', at: Math.round(performance.now()) });
                const reply = await broker.dispatch(wire);
                if (traced && message.method === 'private-intent')
                  trace.push({
                    event: 'intent-replied',
                    at: Math.round(performance.now()),
                    status: JSON.parse(reply).value.status,
                  });
                if (message.method === 'key' && message.purpose === 'spending-sign') {
                  spendingKeys++;
                  assert.equal((await reservations.inspect()).signing, 1);
                  const stored = await capsules.inspect();
                  assert.equal(stored.records, 1);
                  assert.equal(stored.signatures, 0);
                  assert.equal(stored.proofs, 0);
                  loans.push(reply);
                }
                if (message.method === 'key' && message.purpose === 'private-receive') {
                  receiveKeys++;
                  loans.push(reply);
                  if (corruptReceiver) reply[0] ^= 1;
                }
                return reply;
              },
            },
          }
        : {}),
    });
    children.add(task);
    task.closed.then((value) => {
      children.delete(task);
      childResults.push({ job: path.basename(options.filename), ...value });
    });
    return task;
  };
  const services = require('./fixtures/railgun-partial-controller-services').install({
    bytecodes,
    artifactDirectory,
    source,
    anchor,
  });
  const vault = require('../src/main/identity/vault');
  let identity, enrollment, publicAccount, account, completion;
  const started = performance.now();
  try {
    phase = 'enroll';
    const vaultDirectory = path.join(directory, 'profile', 'identity');
    await vault.importVault(
      vaultDirectory,
      'public-fixture-password-not-a-user-credential',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive,
    });
    enrollment =
      await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment({
        identity,
        create: true,
      });
    phase = 'public-scan';
    publicAccount =
      await require('../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
        enrollment,
        archive,
        create: true,
      });
    for (let from = 0; from <= anchor.number; from += 100000)
      await publicAccount.advance({ to: Math.min(from + 99999, anchor.number), anchor });
    const wallet = require('../src/main/wallet/railgun-account-wallet');
    const owners = { identity, enrollment, coordinator: publicAccount.coordinator };
    phase = 'wallet-scan';
    account = await wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'new' });
    const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
    const selected = baseline.ownedPoi.find(
      (record) =>
        record.type === 'Shield' &&
        baseline.read.received.some(
          (note) => note.id === record.id && note.spentTxid === false && note.amount > 1n
        )
    );
    assert.ok(selected);
    const note = baseline.read.received.find((note) => note.id === selected.id);
    assert.ok(selected.blockNumber >= OFFSET);
    reservations = await enrollment.openReservations();
    capsules = await enrollment.openPrivateCapsules();
    const empty = {
      reservations: await reservations.inspect(),
      capsules: await capsules.inspect(),
    };
    const recipient = (
      await require('../src/main/wallet/signers').getSigner(0).getAddress()
    ).toLowerCase();
    await services.setSelected({
      archive,
      enrollment,
      record: selected,
      submitter: recipient,
      merkleRoot: baseline.trees.find((tree) => tree.tree === note.tree).root,
    });
    const options = {
      account,
      owners,
      archive,
      proverArchive,
      artifactDirectory,
      request: {
        kind: 'railgun-partial-unshield',
        noteId: selected.id,
        recipient,
        unshieldAmount: (note.amount / 2n).toString(),
      },
    };
    const {
      proveRailgunAccountPrivateOperation: prove,
      claimRailgunPrivateCompletion: claim,
    } = require('../src/main/wallet/railgun-private-operation');
    const refusals = [];
    for (const [mode, expectedStage] of [
      ['receive-credential-mismatch', 'receiver'],
      ['bad-membership', 'poi'],
      ['wrong-verifier', 'preflight'],
    ]) {
      phase = mode;
      corruptReceiver = mode === 'receive-credential-mismatch';
      services.setMode(corruptReceiver ? 'healthy' : mode);
      const before = services.report();
      const result = await prove(options);
      assert.equal(result.status, 'refused', JSON.stringify(result));
      assert.equal(result.stage, expectedStage);
      assert.equal(spendingKeys, 0);
      const after = services.report();
      assert.equal(after.unexpectedTransportFailures, before.unexpectedTransportFailures);
      assert.equal(after.selectedNullifierQueries, before.selectedNullifierQueries);
      if (corruptReceiver) assert.equal(after.poiRequests, before.poiRequests);
      if (mode === 'wrong-verifier')
        assert.deepEqual(after.verificationKeyQueries.slice(before.verificationKeyQueries.length), [
          [1, 2],
        ]);
      for (const name of ['rootHistory', 'unshieldFee', 'getVerificationKey', 'nullifiers'])
        assert.equal(
          after.privatePreflightMethods[name] - before.privatePreflightMethods[name],
          mode === 'wrong-verifier' && name !== 'nullifiers' ? 1 : 0
        );
      assert.deepEqual(
        { reservations: await reservations.inspect(), capsules: await capsules.inspect() },
        empty
      );
      refusals.push({ mode, stage: result.stage, before, after, spendingKeys });
    }
    corruptReceiver = false;
    services.setMode('healthy');
    phase = 'prove';
    const beforeHealthy = services.report();
    const result = await prove(options);
    assert.equal(result.status, 'proved', JSON.stringify(result));
    assert.equal(result.submissionEnabled, false);
    completion = result.completion;
    assert.equal(spendingKeys, 1);
    assert.equal(receiveKeys, 4);
    assert.equal(
      services.report().selectedNullifierQueries,
      beforeHealthy.selectedNullifierQueries + 1
    );
    assert.deepEqual(
      services.report().verificationKeyQueries.slice(beforeHealthy.verificationKeyQueries.length),
      [[1, 2]]
    );
    assert.deepEqual(
      services.report().privateCallOrder.slice(beforeHealthy.privateCallOrder.length),
      ['rootHistory', 'unshieldFee', 'getVerificationKey:1:2', 'nullifiers']
    );
    for (const name of ['rootHistory', 'unshieldFee', 'getVerificationKey', 'nullifiers'])
      assert.equal(
        services.report().privatePreflightMethods[name] -
          beforeHealthy.privatePreflightMethods[name],
        1
      );
    assert.ok(loans.every((key) => key instanceof Uint8Array && key.every((v) => v === 0)));
    const stored = await capsules.get(result.holdId);
    assert.equal(stored.capsule.version, 2);
    assert.equal(stored.capsule.selection.kind, options.request.kind);
    assert.ok(stored.signature && stored.provedTransaction);
    require('../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
      stored.capsule.preparation.transaction,
      stored.provedTransaction,
      stored.capsule.preparation.expected
    );
    const beforeDuplicate = services.report();
    assert.deepEqual(await prove(options), { status: 'refused', stage: 'local' });
    assert.equal(spendingKeys, 1);
    assert.deepEqual(services.report(), beforeDuplicate);
    await account.close();
    account = null;
    const claimed = claim(completion.receipt, identity, enrollment);
    assert.deepEqual(claimed.assertCurrent().stored, stored);
    assert.throws(() => claim(completion.receipt, identity, enrollment));
    claimed.close();
    completion.close();
    completion = null;
    await reservations.withSigningRecovery(async (records, context) => {
      context.assertCurrent();
      const recovered = records.find(({ entry }) => entry.id === result.holdId);
      assert.equal(recovered.entry.state, 'signing');
      assert.deepEqual(await capsules.readSigned(recovered.receipt), stored);
    });
    phase = 'close';
    await publicAccount.close();
    publicAccount = null;
    enrollment.close();
    identity.close();
    vault.lockVault();
    await Promise.all([...children].map((child) => child.closed));
    assert.equal(children.size, 0);
    const jobEvidence = {};
    for (const [job, count] of [
      ['railgun-private-receive-job.js', 4],
      ['railgun-spend-sign-job.js', 1],
      ['railgun-private-operate-job.js', 4],
      ['railgun-private-verify-job.js', 1],
    ]) {
      const jobs = childResults.filter((value) => value.job === job);
      assert.equal(jobs.length, count, job);
      if (job !== 'railgun-private-receive-job.js')
        assert.ok(
          jobs.every((value) => value.code === 'RAILGUN_PROCESS_CLOSED'),
          job
        );
      else assert.equal(jobs.filter((value) => value.code === 'RAILGUN_PROCESS_CLOSED').length, 3);
      jobEvidence[job] = jobs.map(({ code }) => code);
    }
    phase = 'reopen';
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive,
    });
    enrollment =
      await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment({
        identity,
        create: false,
      });
    reservations = await enrollment.openReservations();
    capsules = await enrollment.openPrivateCapsules();
    const beforeRecovery = services.report();
    await reservations.withSigningRecovery(async (records, context) => {
      context.assertCurrent();
      const recovered = records.find(({ entry }) => entry.id === result.holdId);
      assert.equal(recovered.entry.state, 'signing');
      assert.deepEqual(await capsules.readSigned(recovered.receipt), stored);
    });
    assert.equal(spendingKeys, 1);
    assert.deepEqual(services.report(), beforeRecovery);
    enrollment.close();
    identity.close();
    vault.lockVault();
    await Promise.all([...children].map((child) => child.closed));
    assert.equal(children.size, 0);
    assert.deepEqual(inventory(), sourceHashes, 'Source changed during qualification');
    await services.close();
    const serviceEvidence = services.report();
    assert.equal(serviceEvidence.pendingRequests, 0);
    assert.equal(serviceEvidence.transportCreates, serviceEvidence.transportCloses);
    assert.equal(serviceEvidence.unexpectedTransportFailures, 0);
    assert.equal(serviceEvidence.poiPathJobs, 1);
    assert.equal(serviceEvidence.poiPathExits, 1);
    const report = {
      schema: 'railgun-partial-controller-offline-v1',
      sourceSha256: sha(sourceBytes),
      sourceHashes,
      inputCreator: 'Shield',
      internalController: true,
      realAccountPoiAndPrivatePreflightHosts: true,
      syntheticChainAndServiceResponses: true,
      fixtureServiceSigningKey: true,
      liveDeploymentVerifierQualified: false,
      liveSpendQualified: false,
      facadeEnabled: false,
      partialSubmissionEnabled: false,
      signedCapsuleVersion: stored.capsule.version,
      realSpendProofAndFreshVerification: true,
      durableSigningObservedBeforeKeyDelivery: true,
      processLauncherInstrumented: true,
      corruptionControl: 'receive-credential-mismatch',
      duplicateRefusedBeforeServices: true,
      storedProofReadableUnderRecovery: true,
      enrollmentReopenedFromEncryptedStorage: true,
      newProcessRestartQualified: false,
      spendingKeys,
      receiveKeys,
      borrowedKeysWiped: true,
      refusals,
      services: serviceEvidence,
      childResults,
      jobEvidence,
      elapsedMs: Math.round(performance.now() - started),
    };
    await services.close();
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ status: 'qualified', elapsedMs: report.elapsedMs }));
  } finally {
    completion?.close();
    await account?.close();
    await publicAccount?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    for (const child of children) child.close();
    await Promise.all([...children].map((child) => child.closed));
    await services.close();
    if (!fs.existsSync(path.join(directory, 'report.json')))
      fs.writeFileSync(
        path.join(directory, 'diagnostic.json'),
        JSON.stringify(
          {
            phase,
            spendingKeys,
            receiveKeys,
            childResults,
            services: services.report(),
            trace,
          },
          null,
          2
        ) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
    runtime.startRailgunProcess = originalStart;
  }
}
main().then(
  () => {
    releaseProfileLock(lock);
    app.exit(0);
  },
  (error) => {
    console.error(
      JSON.stringify({ phase, code: error.code, message: error.message, stack: error.stack })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
