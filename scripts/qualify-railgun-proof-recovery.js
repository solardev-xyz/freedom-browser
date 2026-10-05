/** Offline original-signature proof recovery over a disposable enrolled account.
 * Synthetic external services; real account, gates, signer, stores and recovery A/C.
 * electron script SOURCE NEW_DIR ENGINE PROVER ARTIFACTS BYTECODES
 *   [Shield|Transact] [transfer|unshield|partial]
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
function snapshot(directory) {
  const entries = {};
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const filename = path.join(current, name),
        stat = fs.lstatSync(filename);
      assert.equal(stat.isSymbolicLink(), false);
      const relative = path.relative(directory, filename);
      if (stat.isDirectory()) {
        entries[relative + '/'] = 'directory';
        visit(filename);
      } else {
        assert.ok(stat.isFile());
        entries[relative] = sha(fs.readFileSync(filename));
      }
    }
  };
  visit(directory);
  return entries;
}
async function bounded(work, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Fixture wait exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length >= 6 && args.length <= 8);
  const [sourceFilename, directory, archive, proverArchive, artifactDirectory, bytecodes] = args;
  const inputCreator = args[6] ?? 'Shield';
  assert.ok(['Shield', 'Transact'].includes(inputCreator));
  const kind = args[7] ?? 'transfer';
  assert.ok(['transfer', 'unshield', 'partial'].includes(kind));
  const transact = inputCreator === 'Transact';
  assert.ok(args.slice(0, 6).every((value) => path.isAbsolute(value)));
  assert.equal(fs.existsSync(directory), false);
  const sourceBytes = fs.readFileSync(sourceFilename);
  // This one published public-vector source is allowed. Never accept a real
  // wallet export just because its JSON claims to be a disposable fixture.
  assert.equal(
    sha(sourceBytes),
    'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41'
  );
  let source = JSON.parse(sourceBytes);
  assert.equal(source.publicVaultVector, true);
  if (transact) {
    const derived = require('./fixtures/railgun-transact-staging-source').derive(source);
    source = derived.source;
    derived.row.blockNumber += OFFSET;
    derived.row.timestamp += OFFSET;
    derived.row.graphID = hex(derived.row.blockNumber) + derived.row.graphID.slice(66);
    source.txidRows = [derived.row];
  }
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
      ...['profile-lock.js', 'profile-resolver.js', 'settings-store.js', 'tor-manager.js'].map(
        (name) => path.join(__dirname, '../src/main', name)
      ),
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
  const sessions = require('../src/main/wallet/railgun-session-worker');
  const storage = require('../src/main/wallet/privacy-storage');
  const originals = {
    start: runtime.startRailgunProcess,
    session: sessions.startRailgunSessionWorker,
    readOnlySession: sessions.startRailgunReadOnlySessionWorker,
    storage: storage.createPrivacyStorage,
  };
  const children = new Set(),
    workers = new Set(),
    loans = [];
  const childResults = [],
    workerResults = [],
    brokerResults = [],
    storageWrites = [];
  const jobs = {},
    keys = {},
    rpcMethods = {};
  let measuring = false,
    interruptSignature = true,
    interrupted = 0,
    refusedResult = 0;
  let originalCapsule, originalSignature, originalCheckpoint, reservations, capsules;
  let capsuleFilename, manifestFilename;
  const counts = {
    childStarts: 0,
    childExits: 0,
    storageStarts: 0,
    storageExits: 0,
    readOnlyStorageStarts: 0,
    forbiddenJobs: 0,
    forbiddenKeys: 0,
    forbiddenRpc: 0,
    intentRequests: 0,
    spendingKeys: 0,
    brokerRefusals: 0,
  };
  storage.createPrivacyStorage = (options) => {
    const genuine = originals.storage(options);
    const filename = storage.getPrivacyStoragePath(options.handle, options.directory);
    return Object.freeze({
      ...genuine,
      async update(name, change) {
        let observation;
        await genuine.update(name, (previous) => {
          const next = change(previous);
          if (name === 'railgun-private-capsules-v1') {
            capsuleFilename = filename;
            observation = {
              kind: 'capsule',
              before: previous === null ? null : JSON.parse(previous).sequence,
              after: JSON.parse(next).sequence,
            };
          } else {
            observation = { kind: 'other' };
          }
          if (name === 'railgun-account-enrollment-v1') manifestFilename = filename;
          return next;
        });
        storageWrites.push({ phase, filename, ...observation });
      },
    });
  };
  const trackSession = (start, readOnly) => (options) => {
    counts.storageStarts++;
    if (readOnly) counts.readOnlyStorageStarts++;
    const task = start(options);
    workers.add(task);
    task.closed.then((result) => {
      workers.delete(task);
      counts.storageExits++;
      workerResults.push({ phase, readOnly, ...result });
    });
    return task;
  };
  sessions.startRailgunSessionWorker = trackSession(originals.session, false);
  sessions.startRailgunReadOnlySessionWorker = trackSession(originals.readOnlySession, true);
  runtime.startRailgunProcess = (options) => {
    const job = path.basename(options.filename),
      launchPhase = phase;
    counts.childStarts++;
    jobs[job] = (jobs[job] || 0) + 1;
    if (
      measuring &&
      ![
        'railgun-public-job.js',
        'railgun-wallet-job.js',
        'railgun-private-recover-job.js',
        'railgun-private-verify-job.js',
      ].includes(job)
    ) {
      counts.forbiddenJobs++;
      throw Error('Unexpected proof-recovery utility');
    }
    if (job === 'railgun-private-operate-job.js')
      originalCheckpoint = JSON.parse(options.input).checkpoint;
    if (measuring && ['railgun-wallet-job.js', 'railgun-private-recover-job.js'].includes(job))
      assert.deepEqual(JSON.parse(options.input).checkpoint, originalCheckpoint);
    const broker = options.broker;
    const task = originals.start({
      ...options,
      ...(broker
        ? {
            broker: {
              ...broker,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                if (message.method === 'key') {
                  keys[message.purpose] = (keys[message.purpose] || 0) + 1;
                  if (message.purpose === 'spending-sign') counts.spendingKeys++;
                  if (
                    measuring &&
                    !['wallet-viewing', 'private-recover'].includes(message.purpose)
                  ) {
                    counts.forbiddenKeys++;
                    throw Error('Unexpected proof-recovery credential');
                  }
                }
                if (message.method === 'private-intent') counts.intentRequests++;
                if (
                  job === 'railgun-private-operate-job.js' &&
                  message.method === 'result' &&
                  message.value?.privateOperation?.status === 'refused'
                )
                  refusedResult++;
                let reply;
                try {
                  reply = await broker.dispatch(wire);
                } catch (error) {
                  counts.brokerRefusals++;
                  brokerResults.push({
                    job,
                    phase: launchPhase,
                    method: message.method,
                    code: error.code ?? 'BROKER_REFUSED',
                  });
                  throw error;
                }
                if (message.method === 'key') {
                  assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
                  loans.push(reply);
                  if (message.purpose === 'spending-sign') {
                    assert.equal((await reservations.inspect()).signing, 1);
                    const before = await capsules.inspect();
                    assert.equal(before.records, 1);
                    assert.equal(before.signatures, 0);
                    assert.equal(before.proofs, 0);
                  }
                }
                if (message.method === 'result') {
                  const guards = message.value?.guards;
                  if (guards) {
                    assert.equal(guards.attempts, 0);
                    assert.ok(guards.hooks.length > 0);
                    assert.equal(guards.canaries, guards.hooks.length);
                    brokerResults.push({
                      job,
                      phase: launchPhase,
                      method: 'result',
                      guardAttempts: guards.attempts,
                      guardHooks: guards.hooks.length,
                      guardCanaries: guards.canaries,
                    });
                  }
                }
                if (
                  interruptSignature &&
                  job === 'railgun-private-operate-job.js' &&
                  message.method === 'private-intent'
                ) {
                  const response = JSON.parse(reply);
                  assert.equal(response.value.status, 'signed');
                  const saved = await capsules.inspect();
                  assert.equal(saved.signatures, 1);
                  assert.equal(saved.proofs, 0);
                  originalCapsule = message.value.capsule;
                  originalSignature = response.value.signature;
                  interruptSignature = false;
                  interrupted++;
                  // Original main callback saved B's real signature. A sees refusal;
                  // the genuine host detects its result mismatch and drains that child.
                  return JSON.stringify({ id: message.id, value: { status: 'refused' } });
                }
                return reply;
              },
            },
          }
        : {}),
    });
    children.add(task);
    task.closed.then((result) => {
      children.delete(task);
      counts.childExits++;
      childResults.push({ job, phase: launchPhase, ...result });
    });
    return task;
  };
  const services = require('./fixtures/railgun-partial-controller-services').install({
    bytecodes,
    artifactDirectory,
    source,
    anchor,
  });
  const transport = require('../src/main/networks/wallet-tor-transport');
  const fixtureTransport = transport.createWalletTorTransport;
  const { getPrivacyContext } = require('../src/main/networks/privacy-context');
  transport.createWalletTorTransport = (...options) => {
    const client = fixtureTransport(...options);
    return {
      ...client,
      async request(handle, url, request) {
        const subject = getPrivacyContext(handle).subject,
          wire = JSON.parse(request.body);
        const method = subject.role + ':' + (wire.method ?? 'GraphQL');
        rpcMethods[method] = (rpcMethods[method] || 0) + 1;
        if (
          measuring &&
          (subject.role !== 'protocol-rpc' ||
            subject.operation !== null ||
            !['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs'].includes(wire.method))
        ) {
          counts.forbiddenRpc++;
          throw Error('Unexpected proof-recovery RPC');
        }
        return client.request(handle, url, request);
      },
    };
  };
  const evidence = () => ({
    counts: { ...counts },
    jobs: { ...jobs },
    keys: { ...keys },
    rpcMethods: { ...rpcMethods },
    services: services.report(),
    writes: storageWrites.length,
  });
  const vault = require('../src/main/identity/vault');
  const publicApi = require('../src/main/wallet/railgun-account-public');
  let identity, enrollment, publicAccount, account, txid, staged;
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
    publicAccount = await publicApi.openRailgunAccountPublic({ enrollment, archive, create: true });
    for (let from = 0; from <= anchor.number; from += 100000)
      await publicAccount.advance({ to: Math.min(from + 99999, anchor.number), anchor });
    const wallet = require('../src/main/wallet/railgun-account-wallet');
    const owners = { identity, enrollment, coordinator: publicAccount.coordinator };
    if (transact) {
      phase = 'txid-checkpoint';
      const state = await services.initializeTxid({ archive, enrollment });
      txid = await require('../src/main/wallet/railgun-account-txid').openRailgunAccountTxid({
        enrollment,
        coordinator: owners.coordinator,
        archive,
        create: true,
      });
      await txid.advance();
      assert.deepEqual((await txid.inspect()).checkpoint.state, state);
      await txid.close();
      txid = null;
    }
    phase = 'wallet-scan';
    account = await wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'new' });
    const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
    const selected = baseline.ownedPoi.find(
      (record) =>
        record.type === inputCreator &&
        baseline.read.received.some(
          (note) => note.id === record.id && note.spentTxid === false && note.amount > 1n
        )
    );
    assert.ok(selected);
    const note = baseline.read.received.find((note) => note.id === selected.id);
    reservations = await enrollment.openReservations();
    capsules = await enrollment.openPrivateCapsules();
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
    const request = {
      kind: {
        transfer: 'railgun-private-transfer',
        unshield: 'railgun-token-unshield',
        partial: 'railgun-partial-unshield',
      }[kind],
      noteId: selected.id,
      recipient: kind === 'transfer' ? baseline.read.instanceId : recipient,
      ...(kind === 'partial' ? { unshieldAmount: (note.amount / 2n).toString() } : {}),
    };
    const publicIdentity = publicApi.getRailgunAccountPublicIdentity(
      owners.coordinator,
      enrollment
    );
    const options = { account, owners, archive, proverArchive, artifactDirectory, request };
    if (transact) {
      phase = 'transact-staging';
      staged =
        await require('../src/main/wallet/railgun-transact-staging').stageRailgunTransactInput({
          account,
          owners,
          request,
          archive,
          signal: enrollment.signal,
        });
      assert.equal(staged.status, 'staged');
      account = options.account = staged.account;
      options.stagingReceipt = staged.receipt;
    }
    phase = 'signed-interruption';
    const interruptedResult =
      await require('../src/main/wallet/railgun-private-operation').proveRailgunAccountPrivateOperation(
        options
      );
    assert.equal(interruptedResult.status, 'signed-unfinished', JSON.stringify(interruptedResult));
    assert.equal(interrupted, 1);
    assert.equal(refusedResult, 1);
    assert.equal(counts.spendingKeys, 1);
    assert.equal(counts.intentRequests, 1);
    assert.equal(counts.brokerRefusals, 1);
    const faultExits = childResults.filter((item) => item.job === 'railgun-private-operate-job.js');
    assert.equal(faultExits.length, 1);
    assert.equal(faultExits[0].code, 'RAILGUN_SESSION_REVOKED');
    assert.ok(
      brokerResults.some(
        (value) =>
          value.job === 'railgun-private-operate-job.js' &&
          value.method === 'result' &&
          value.code === 'RAILGUN_WALLET_BROKER_REFUSED'
      )
    );
    assert.equal(Number.isInteger(faultExits[0].exitCode), true);
    assert.deepEqual(services.report().verificationKeyQueries, [[1, kind === 'partial' ? 2 : 1]]);
    assert.deepEqual(services.report().verificationKeyVariants, [
      kind === 'partial' ? '01x02' : '01x01',
    ]);
    await account.close();
    account = null;
    staged?.close();
    staged = null;
    require('../src/main/wallet/railgun-identity').assertRailgunIdentity(identity);
    const availablePhase =
      require('../src/main/wallet/railgun-account-phase').claimRailgunAccountPhase(
        enrollment,
        'recovery'
      );
    try {
      availablePhase.assertCurrent();
    } finally {
      availablePhase.release();
    }
    phase = 'recovery-owner-setup';
    // The detected A protocol refusal revokes its coordinator. Reopen only its
    // existing public generation; no advance, source repair or wallet repair.
    const setupBefore = services.report();
    await publicAccount.close();
    publicAccount = await publicApi.openRailgunAccountPublic({ enrollment, archive });
    assert.deepEqual(
      publicApi.getRailgunAccountPublicIdentity(publicAccount.coordinator, enrollment),
      publicIdentity
    );
    assert.equal(services.report().publicScanRequests, setupBefore.publicScanRequests);
    assert.deepEqual(services.report().publicServiceMethods, setupBefore.publicServiceMethods);
    const destination = publicApi.getRailgunAccountPublicDestination(
      publicAccount.coordinator,
      enrollment
    );
    const holdId = interruptedResult.holdId;
    const inspectSigned = async (unfinished) =>
      reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        const matches = records.filter((value) => value.entry.id === holdId);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].entry.state, 'signing');
        const stored = await capsules[unfinished ? 'readSignedUnfinished' : 'readSigned'](
          matches[0].receipt
        );
        context.assertCurrent();
        return { entry: matches[0].entry, stored };
      });
    const before = await inspectSigned(true);
    assert.deepEqual(before.stored.capsule, originalCapsule);
    assert.deepEqual(before.stored.signature, originalSignature);
    assert.equal(before.stored.provedTransaction, null);
    assert.equal(before.stored.capsule.version, kind === 'partial' ? 2 : 1);
    assert.ok(capsuleFilename && manifestFilename);
    const accountBase = path.dirname(enrollment.directory);
    const inventoryMarker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
    const inventoryBefore = fs.readFileSync(inventoryMarker);
    const diskBefore = snapshot(accountBase),
      beforeRecovery = evidence();
    const recoveryWrites = storageWrites.length;
    const childOffset = childResults.length,
      workerOffset = workerResults.length;
    measuring = true;
    phase = 'proof-recovery';
    const {
      resumeRailgunAccountPrivateProof: resume,
    } = require('../src/main/wallet/railgun-private-proof-recovery');
    const resumeOptions = {
      identity,
      enrollment,
      coordinator: publicAccount.coordinator,
      destination,
      archive,
      proverArchive,
      artifactDirectory,
      holdId,
    };
    const result = await resume(resumeOptions);
    assert.equal(result.status, 'proof-stored', JSON.stringify(result));
    assert.equal(result.submissionEnabled, false);
    const after = await inspectSigned(false);
    assert.deepEqual(after.entry, before.entry);
    assert.deepEqual(after.stored, {
      ...before.stored,
      provedTransaction: after.stored.provedTransaction,
    });
    const checked =
      require('../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
        before.stored.capsule.preparation.transaction,
        after.stored.provedTransaction,
        before.stored.capsule.preparation.expected
      );
    assert.equal(result.transactionDigest, checked.digest);
    const afterRecovery = evidence(),
      diskAfter = snapshot(accountBase);
    assert.deepEqual(fs.readFileSync(inventoryMarker), inventoryBefore);
    assert.deepEqual(Object.keys(diskAfter), Object.keys(diskBefore));
    const changedFiles = Object.keys(diskBefore).filter(
      (name) => diskBefore[name] !== diskAfter[name]
    );
    assert.deepEqual(
      changedFiles.sort(),
      [capsuleFilename, manifestFilename]
        .map((filename) => path.relative(accountBase, filename))
        .sort()
    );
    const mutations = storageWrites.slice(recoveryWrites);
    assert.ok(
      mutations.every((write) => [capsuleFilename, manifestFilename].includes(write.filename))
    );
    const capsuleWrites = mutations.filter((write) => write.kind === 'capsule');
    assert.equal(capsuleWrites.length, 1);
    assert.equal(capsuleWrites[0].after, capsuleWrites[0].before + 1);
    assert.equal(afterRecovery.counts.spendingKeys, beforeRecovery.counts.spendingKeys);
    assert.equal(afterRecovery.counts.intentRequests, beforeRecovery.counts.intentRequests);
    for (const name of [
      'poiRequests',
      'selectedNullifierQueries',
      'deploymentRequests',
      'eoaRequests',
      'publicServiceRequests',
      'signatureChecks',
    ])
      assert.equal(afterRecovery.services[name], beforeRecovery.services[name], name);
    assert.deepEqual(
      afterRecovery.services.privatePreflightMethods,
      beforeRecovery.services.privatePreflightMethods
    );
    assert.deepEqual(
      afterRecovery.services.publicServiceMethods,
      beforeRecovery.services.publicServiceMethods
    );
    const recoveryRpcMethods = Object.fromEntries(
      Object.entries(afterRecovery.rpcMethods)
        .map(([method, count]) => [method, count - (beforeRecovery.rpcMethods[method] || 0)])
        .filter(([, count]) => count !== 0)
    );
    assert.ok(recoveryRpcMethods['protocol-rpc:eth_getBlockByNumber'] > 0);
    assert.ok(recoveryRpcMethods['protocol-rpc:eth_getLogs'] > 0);
    assert.ok(
      Object.keys(recoveryRpcMethods).every((method) =>
        [
          'protocol-rpc:eth_getBlockByNumber',
          'protocol-rpc:eth_getLogs',
          'protocol-rpc:eth_chainId',
        ].includes(method)
      )
    );
    // A freshly reopened public owner may require its normal chain handshake.
    // Count it inside recovery rather than warming the RPC before measurement.
    assert.ok((recoveryRpcMethods['protocol-rpc:eth_chainId'] || 0) <= 1);
    const recoveryChildren = childResults.slice(childOffset);
    for (const job of [
      'railgun-wallet-job.js',
      'railgun-private-recover-job.js',
      'railgun-private-verify-job.js',
    ])
      assert.equal(
        brokerResults.filter(
          (item) => item.phase === 'proof-recovery' && item.job === job && item.guardHooks > 0
        ).length,
        1,
        job
      );
    for (const job of [
      'railgun-wallet-job.js',
      'railgun-private-recover-job.js',
      'railgun-private-verify-job.js',
    ])
      assert.equal(recoveryChildren.filter((child) => child.job === job).length, 1, job);
    assert.ok(
      recoveryChildren.every(
        (child) => child.code === 'RAILGUN_PROCESS_CLOSED' && Number.isInteger(child.exitCode)
      )
    );
    assert.equal(
      (afterRecovery.keys['wallet-viewing'] || 0) - (beforeRecovery.keys['wallet-viewing'] || 0),
      1
    );
    assert.equal(
      (afterRecovery.keys['private-recover'] || 0) - (beforeRecovery.keys['private-recover'] || 0),
      1
    );
    const recoveryWorkers = workerResults.slice(workerOffset);
    assert.equal(recoveryWorkers.length, 1);
    assert.equal(recoveryWorkers[0].readOnly, true);
    assert.equal(recoveryWorkers[0].exitCode, 0);
    assert.equal(afterRecovery.counts.storageStarts - beforeRecovery.counts.storageStarts, 1);
    assert.equal(
      afterRecovery.counts.readOnlyStorageStarts - beforeRecovery.counts.readOnlyStorageStarts,
      1
    );
    phase = 'duplicate';
    const duplicateBefore = evidence(),
      duplicateDisk = snapshot(accountBase);
    const duplicate = await resume(resumeOptions);
    assert.deepEqual(duplicate, { ...result, status: 'proof-present' });
    assert.deepEqual(evidence(), duplicateBefore);
    assert.deepEqual(snapshot(accountBase), duplicateDisk);
    assert.deepEqual(fs.readFileSync(inventoryMarker), inventoryBefore);
    assert.equal(counts.forbiddenJobs + counts.forbiddenKeys + counts.forbiddenRpc, 0);
    assert.ok(loans.every((key) => key instanceof Uint8Array && key.every((value) => value === 0)));
    measuring = false;
    phase = 'close';
    await publicAccount.close();
    publicAccount = null;
    enrollment.close();
    identity.close();
    vault.lockVault();
    await bounded(Promise.all([...children].map((child) => child.closed)));
    await bounded(Promise.all([...workers].map((worker) => worker.closed)));
    assert.equal(children.size, 0);
    assert.equal(workers.size, 0);
    assert.equal(counts.childStarts, counts.childExits);
    assert.equal(counts.storageStarts, counts.storageExits);
    assert.ok(workerResults.every((worker) => worker.exitCode === 0));
    await services.close();
    assert.equal(services.report().pendingRequests, 0);
    assert.equal(services.report().transportCreates, services.report().transportCloses);
    assert.equal(services.report().unexpectedTransportFailures, 0);
    assert.deepEqual(inventory(), sourceHashes, 'Source changed during qualification');
    const report = {
      schema: 'railgun-proof-recovery-offline-v1',
      inputCreator,
      kind,
      sourceSha256: sha(sourceBytes),
      sourceHashes,
      beforeRecovery,
      afterRecovery,
      interruptedOperation: {
        status: interruptedResult.status,
        durableSignature: true,
        proofAbsent: true,
        reservationSigning: true,
        brokerReplySubstitutedAfterDurableSignature: true,
        naturalCrashQualified: false,
        refusedResultDetected: true,
        identityCurrentAfterObservedRefusal: true,
        genuineRecoveryPhaseClaimedAndReleasedBeforeRecovery: true,
        observedExit: faultExits[0],
      },
      recovery: {
        status: result.status,
        submissionEnabled: false,
        originalCapsuleUnchanged: true,
        originalSignatureUnchanged: true,
        originalCiphertextUnchanged: true,
        reservationUnchanged: true,
        proofSlotWrittenExactlyOnce: true,
        capsuleSequenceIncrements: 1,
        walletJournalCoverageInventoryAndDirectoryNamesUnchanged: true,
        changedFileClasses: ['capsule', 'manifest-floor'],
        realFreshIndependentVerification: true,
        viewingOnlyJobs: 2,
        newSignatures: 0,
        privateServiceCalls: 0,
        eoaCalls: 0,
        publicOwnerReopenedWithoutAdvanceBeforeMeasurement: true,
        recoveryRpcMethods,
        genuineReviewedDestinationBoundByRecoveryHost: true,
        warmCachedStoreRecovery: true,
        coldExistingOnlyOpenQualified: false,
        originalPublicCheckpointAndGenerationUnchanged: true,
        duplicateStatus: duplicate.status,
        duplicateNoJobKeyRpcOrWrite: true,
      },
      actualStoredSignatureRegeneratedProof: true,
      simulatedExternalServiceResponsesAndListTrust: true,
      syntheticExternalChain: true,
      sameProcessRecovery: true,
      freshProcessRestartQualified: false,
      originalRootDifferentFromCurrentQualified: false,
      fundedOrLiveQualified: false,
      realTorQualified: false,
      noAuthorityApiReplaced: true,
      storageUpdatesObservedWithoutReplacementValues: true,
      counts,
      jobs,
      keys,
      brokerResults,
      childResults,
      workerResults,
      services: services.report(),
      elapsedMs: Math.round(performance.now() - started),
    };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ status: 'qualified', elapsedMs: report.elapsedMs }));
  } finally {
    measuring = false;
    try {
      await account?.close();
    } finally {
      staged?.close();
      try {
        await txid?.close();
      } finally {
        try {
          await publicAccount?.close();
        } finally {
          enrollment?.close();
          identity?.close();
          vault.lockVault();
          for (const child of children) child.close();
          for (const worker of workers) worker.close();
          await bounded(Promise.all([...children].map((child) => child.closed)));
          await bounded(Promise.all([...workers].map((worker) => worker.closed)));
          await services.close();
          if (!fs.existsSync(path.join(directory, 'report.json')))
            fs.writeFileSync(
              path.join(directory, 'diagnostic.json'),
              JSON.stringify(
                {
                  phase,
                  counts,
                  jobs,
                  keys,
                  brokerResults,
                  childResults,
                  workerResults,
                  services: services.report(),
                },
                null,
                2
              ) + '\n',
              { flag: 'wx', mode: 0o600 }
            );
          runtime.startRailgunProcess = originals.start;
          sessions.startRailgunSessionWorker = originals.session;
          sessions.startRailgunReadOnlySessionWorker = originals.readOnlySession;
          storage.createPrivacyStorage = originals.storage;
        }
      }
    }
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
