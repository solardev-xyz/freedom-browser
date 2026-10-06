/** Offline original-signature proof recovery over a disposable enrolled account.
 * Synthetic external services; real account, gates, signer, stores and recovery A/C.
 * electron script SOURCE NEW_DIR ENGINE PROVER ARTIFACTS BYTECODES
 *   [Shield|Transact] [transfer|unshield|partial|foreign] [warm|setup|resume] [same-root|advanced-root]
 * foreign: a full-value transfer to account 1 of the same public vector. After
 * recovery, account 1 and an unrelated account 2 are enrolled and scan the output.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const fixtureChecks = require('./fixtures/railgun-native-assertions');
const assert =
  process.argv.at(-1) === 'submission-handoff' ? fixtureChecks.assert : require('assert/strict');
const { createHash, randomUUID } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const OFFSET = 5944700;
const FOREIGN_BLOCK = OFFSET + 50,
  FOREIGN_TRANSACTION = hex(1050),
  FOREIGN_UNSHIELD_RECIPIENT = '0x' + '12'.repeat(20);
const COLD_RECORDS = [
  'railgun-wallet-catalog-v1',
  'railgun-public-catalog-v1',
  'freedom-railgun-host-scan-v1',
  'railgun-private-reservations-v1',
  'railgun-private-capsules-v1',
  'railgun-private-reservations-floor-v1',
  'railgun-private-capsules-floor-v1',
];
let lock,
  phase = 'setup',
  setupHandoff,
  submissionHandoff;
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
  assert.ok(args.length >= 6 && args.length <= 11);
  const [sourceFilename, directory, archive, proverArchive, artifactDirectory, bytecodes] = args;
  const inputCreator = args[6] ?? 'Shield';
  assert.ok(['Shield', 'Transact'].includes(inputCreator));
  const kind = args[7] ?? 'transfer';
  assert.ok(['transfer', 'unshield', 'partial', 'foreign'].includes(kind));
  const foreignTransfer = kind === 'foreign';
  const runMode = args[8] ?? 'warm';
  assert.ok(['warm', 'setup', 'resume'].includes(runMode));
  const resuming = runMode === 'resume';
  const observeClosed = (promise, callback) =>
    process.argv.at(-1) === 'submission-handoff'
      ? fixtureChecks.observeClosed(promise, callback, 'proof-phase.closed')
      : promise.then(callback);
  const forSubmission = args[10] === 'submission-handoff';
  assert.ok(args[10] === undefined || forSubmission);
  assert.ok(!forSubmission || runMode !== 'warm');
  // The cold submission qualifiers do not cover a foreign destination.
  assert.ok(!forSubmission || !foreignTransfer);
  const historyMode = args[9] ?? 'same-root';
  assert.ok(['same-root', 'advanced-root'].includes(historyMode));
  const advanced = historyMode === 'advanced-root';
  assert.ok(!advanced || runMode !== 'warm');
  const handoffFilename = path.join(directory, 'restart-handoff.json');
  const reportFilename = path.join(directory, resuming ? 'resume-report.json' : 'report.json');
  const diagnosticFilename = path.join(
    directory,
    resuming ? 'resume-diagnostic.json' : 'diagnostic.json'
  );
  const transact = inputCreator === 'Transact';
  assert.ok(args.slice(0, 6).every((value) => path.isAbsolute(value)));
  assert.equal(fs.existsSync(directory), resuming);
  let handoff;
  if (resuming) {
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(fs.realpathSync(directory), directory);
    const file = fs.lstatSync(handoffFilename);
    assert.ok(
      file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.size < 2 * 1024 * 1024
    );
    handoff = JSON.parse(fs.readFileSync(handoffFilename, 'utf8'));
    assert.deepEqual(
      Object.keys(handoff).sort(),
      [
        'historyMode',
        'originalCheckpoint',
        'rootTransition',
        'schema',
        'runID',
        'setupPID',
        'inputCreator',
        'kind',
        'sourceSha256',
        'sourceHashes',
        'runtimeHashes',
        'checkpoint',
        'publicIdentity',
        'recordHashes',
        'accountFiles',
        'inventoryHash',
        'setupEvidence',
        'cleanlyDrainedAndProfileReleased',
        ...(forSubmission ? ['submissionBackend', 'metadataSha256'] : []),
      ].sort()
    );
    assert.equal(handoff.schema, 'railgun-proof-recovery-restart-handoff-v1');
    assert.match(handoff.runID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(Number.isSafeInteger(handoff.setupPID) && handoff.setupPID > 0);
    assert.notEqual(handoff.setupPID, process.pid);
    assert.throws(
      () => process.kill(handoff.setupPID, 0),
      (error) => error.code === 'ESRCH',
      'Setup process must have exited before resume'
    );
    assert.equal(handoff.inputCreator, inputCreator);
    assert.equal(handoff.kind, kind);
    assert.equal(handoff.historyMode, historyMode);
    assert.equal(handoff.cleanlyDrainedAndProfileReleased, true);
    assert.deepEqual(Object.keys(handoff.recordHashes).sort(), ['capsule', 'entry', 'signature']);
    for (const digest of Object.values(handoff.recordHashes))
      assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(reportFilename), false);
  }
  const runID = handoff?.runID ?? randomUUID();
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
    if (advanced) {
      const { Interface } = require('ethers');
      const { PRIVATE_EVENTS } = require('../src/main/wallet/railgun-transact-receipt');
      const abi = new Interface(PRIVATE_EVENTS),
        foreign = source.foreignTransfers[0];
      assert.equal(foreign.amount, '700');
      assert.ok(!source.logs.some((log) => log.data.includes(foreign.commitment.slice(2))));
      const event = abi.encodeEventLog(abi.getEvent('Transact'), [
        0,
        3,
        [foreign.commitment],
        [foreign.ciphertext],
      ]);
      const decoded = abi.parseLog(event);
      assert.equal(decoded.args.startPosition, 3n);
      assert.equal(decoded.args.hash[0], foreign.commitment);
      for (const [key, value] of Object.entries(foreign.ciphertext))
        assert.deepEqual(
          Array.isArray(value)
            ? Array.from(decoded.args.ciphertext[0][key])
            : decoded.args.ciphertext[0][key],
          value
        );
      source.logs.push({
        ...source.logs.find((log) => log.blockNumber === 30),
        ...event,
        blockNumber: 40,
        blockHash: hex(41),
        transactionHash: hex(1040),
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
      });
    }
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
  // The foreign output lands at FOREIGN_BLOCK, after the sender's signed history.
  const initialTo = advanced
    ? OFFSET + (transact ? 39 : 29)
    : foreignTransfer
      ? FOREIGN_BLOCK - 1
      : anchor.number;
  const advancedTo = OFFSET + 40;
  if (!resuming) fs.mkdirSync(directory, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  assert.ok(lock);
  const profileLockAcquired = true;
  app.dock?.hide();
  await app.whenReady();
  const inventory = () => {
    const files = [
      __filename,
      ...(forSubmission
        ? ['qualify-railgun-cold-submission.js', 'qualify-railgun-cold-submission-matrix.js'].map(
            (name) => path.join(__dirname, name)
          )
        : []),
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
  const archiveFs = require('original-fs');
  const runtimeHashes = {
    engine: sha(archiveFs.readFileSync(archive)),
    prover: sha(archiveFs.readFileSync(proverArchive)),
    bytecodes: sha(fs.readFileSync(bytecodes)),
    artifacts: Object.fromEntries(
      ['01x01', '01x02'].flatMap((variant) =>
        ['wasm', 'zkey', 'vkey'].map((extension) => {
          const name = variant + '.' + extension;
          return [name, sha(fs.readFileSync(path.join(artifactDirectory, name)))];
        })
      )
    ),
  };
  if (resuming) {
    assert.equal(handoff.sourceSha256, sha(sourceBytes));
    assert.deepEqual(handoff.sourceHashes, sourceHashes);
    assert.deepEqual(handoff.runtimeHashes, runtimeHashes);
  }
  const canonicalHash = (value) => sha(JSON.stringify(value));
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
    storageWrites = [],
    receiverResults = [];
  const jobs = {},
    keys = {},
    keysByAccount = {},
    rpcMethods = {};
  let measuring = false,
    interruptSignature = !resuming,
    interrupted = 0,
    refusedResult = 0;
  let originalCapsule,
    originalSignature,
    originalCheckpoint,
    restoredCheckpoint,
    reservations,
    capsules;
  let capsuleFilename, manifestFilename, authenticatedPublicCheckpoint;
  const walletJournalReads = [];
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
      async get(name) {
        const result = await genuine.get(name);
        if (name === 'railgun-account-enrollment-v1') manifestFilename = filename;
        if (measuring && name === 'railgun-wallet-journal-v1') {
          const authenticated = JSON.parse(result);
          assert.equal(authenticated.pending, null);
          assert.ok(authenticated.checkpoint);
          assert.deepEqual(
            authenticated.checkpoint.target.plan,
            restoredCheckpoint ?? originalCheckpoint
          );
          walletJournalReads.push({
            checkpoint: structuredClone(authenticated.checkpoint),
            afterRecoveryJobExit: childResults.some(
              (child) =>
                child.phase === 'proof-recovery' &&
                child.job === 'railgun-private-recover-job.js' &&
                child.code === 'RAILGUN_PROCESS_CLOSED'
            ),
          });
        }
        return result;
      },
      async update(name, change) {
        let observation, publicCheckpointCandidate;
        await genuine.update(name, (previous) => {
          const next = change(previous);
          let cold;
          if (resuming && phase === 'cold-bootstrap') {
            assert.ok(COLD_RECORDS.includes(name), 'Unexpected cold record update: ' + name);
            assert.equal(
              storageWrites.filter((write) => write.cold?.record === name).length,
              0,
              'Repeated cold record update: ' + name
            );
            assert.notEqual(previous, null, 'Cold bootstrap must not create a record');
            const old = JSON.parse(previous),
              value = JSON.parse(next);
            if (name === 'freedom-railgun-host-scan-v1') {
              assert.equal(value.pending, null);
              assert.ok(value.checkpoint);
              publicCheckpointCandidate = structuredClone(value.checkpoint);
            }
            const mutable =
              name === 'railgun-wallet-catalog-v1' || name === 'railgun-public-catalog-v1'
                ? ['lease', 'sequence']
                : name === 'freedom-railgun-host-scan-v1'
                  ? ['lease', 'sequence', 'generation']
                  : ['railgun-private-reservations-v1', 'railgun-private-capsules-v1'].includes(
                        name
                      )
                    ? ['lease']
                    : [];
            const strip = (record) =>
              Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.includes(key)));
            assert.deepEqual(
              strip(value),
              strip(old),
              'Cold bootstrap changed authenticated content: ' + name
            );
            if (mutable.includes('lease')) assert.notEqual(value.lease, old.lease);
            if (mutable.includes('sequence')) assert.equal(value.sequence, old.sequence + 1);
            if (mutable.includes('generation')) assert.equal(value.generation, old.generation + 1);
            cold = {
              record: name,
              mutableFields: mutable,
              authenticatedContentUnchanged: true,
              ...(Object.hasOwn(old, 'sequence')
                ? { beforeSequence: old.sequence, afterSequence: value.sequence }
                : {}),
            };
          }
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
          if (cold) observation.cold = cold;
          return next;
        });
        if (publicCheckpointCandidate) authenticatedPublicCheckpoint = publicCheckpointCandidate;
        storageWrites.push({ phase, filename, ...observation });
      },
    });
  };
  const trackSession = (start, readOnly) => (options) => {
    counts.storageStarts++;
    if (readOnly) counts.readOnlyStorageStarts++;
    const task = start(options);
    workers.add(task);
    observeClosed(task.closed, (result) => {
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
      assert.deepEqual(
        JSON.parse(options.input).checkpoint,
        restoredCheckpoint ?? originalCheckpoint
      );
    if (
      resuming &&
      [
        'railgun-spend-sign-job.js',
        'railgun-private-operate-job.js',
        'railgun-private-receive-job.js',
        'railgun-note-provenance-job.js',
      ].includes(job)
    ) {
      counts.forbiddenJobs++;
      throw Error('Forbidden resumed admission/signing job');
    }
    if (job === 'railgun-wallet-job.js' && phase === 'advanced-wallet')
      restoredCheckpoint = JSON.parse(options.input).checkpoint;
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
                  if (foreignTransfer) {
                    // Which account's privacy context this key loan serves.
                    const principal =
                      require('../src/main/networks/privacy-context').getPrivacyContext(
                        options.handle
                      ).subject.principal;
                    keysByAccount[principal] ??= {};
                    keysByAccount[principal][message.purpose] =
                      (keysByAccount[principal][message.purpose] || 0) + 1;
                  }
                  if (message.purpose === 'spending-sign') counts.spendingKeys++;
                  if (resuming && message.purpose === 'spending-sign') {
                    counts.forbiddenKeys++;
                    throw Error('Fresh recovery must not admit spending-sign');
                  }
                  if (
                    measuring &&
                    !['wallet-viewing', 'private-recover'].includes(message.purpose)
                  ) {
                    counts.forbiddenKeys++;
                    throw Error('Unexpected proof-recovery credential');
                  }
                }
                if (message.method === 'private-intent') {
                  counts.intentRequests++;
                  assert.equal(resuming, false, 'Fresh recovery must not request an intent');
                }
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
                  // Accepted receiver results only: the marked destination checked
                  // before signing, as main bound it into the authorization digest.
                  if (foreignTransfer && job === 'railgun-private-receive-job.js')
                    receiverResults.push({
                      phase: launchPhase,
                      verified: message.value?.verified,
                      recipient: message.value?.recipient,
                      recipientRelationship: message.value?.recipientRelationship,
                    });
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
    observeClosed(task.closed, (result) => {
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
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
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
  const delta = (before, after) =>
    Object.fromEntries(
      Object.entries(after)
        .map(([name, count]) => [name, count - (before[name] || 0)])
        .filter(([, count]) => count !== 0)
    );
  const plain = (value) => JSON.parse(JSON.stringify(value));
  // Reports and handoffs keep no wallet address, only its relationship.
  const sanitizeReceiver = ({ recipient, ...value }) => ({
    ...value,
    recipientIsForeignDestination: recipient === originalCapsule.selection.recipient,
  });
  // One guarded utility over the published test mnemonic only; see the job.
  async function runForeignFixture(value, owner = enrollment) {
    const parent = getPrivacyContext(owner.getContext('engine'));
    const scope = createPrivacyScope({ profileId: parent.profileId, signal: parent.signal });
    let task, result;
    try {
      task = runtime.startRailgunProcess({
        handle: scope.getContext({ ...parent.subject, operation: 'foreign-recipient-fixture' }),
        filename: require.resolve('./fixtures/railgun-foreign-recipient-job'),
        input: JSON.stringify({ archive, ...value }),
        startupMs: 30000,
        lifetimeMs: 120000,
        broker: {
          signal: scope.signal,
          dispatch: async (wire) => {
            assert.equal(result, undefined);
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 65536);
            const message = JSON.parse(wire);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            result = message.value;
            return JSON.stringify({ id: 1, value: null });
          },
        },
      });
      await task.ready;
      assert.ok(result && !scope.signal.aborted);
      task.close();
      assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(result.mode, value.mode);
      assert.equal(result.guards.attempts, 0);
      assert.ok(result.guards.hooks.length > 0);
      assert.equal(result.guards.canaries, result.guards.hooks.length);
      return result;
    } finally {
      try {
        task?.close();
      } finally {
        await task?.closed;
        scope.close();
      }
    }
  }
  // A genuine second or third enrollment of this profile: identity, public scan
  // to the anchor and a new wallet scan, closed before returning detached data.
  // `use` runs with that account's own owners only, before they close.
  async function scanOtherAccount(accountIndex, use) {
    const accountWallet = require('../src/main/wallet/railgun-account-wallet');
    const other = {};
    try {
      other.identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
        archive,
        accountIndex,
      });
      other.enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity: other.identity, create: true }
        );
      other.publicAccount = await publicApi.openRailgunAccountPublic({
        enrollment: other.enrollment,
        archive,
        create: true,
      });
      for (let from = 0; from <= anchor.number; from += 100000)
        await other.publicAccount.advance({ to: Math.min(from + 99999, anchor.number), anchor });
      const owners = {
        identity: other.identity,
        enrollment: other.enrollment,
        coordinator: other.publicAccount.coordinator,
      };
      other.account = await accountWallet.openRailgunAccountWallet({
        ...owners,
        archive,
        mode: 'new',
      });
      const notes = accountWallet.readRailgunAccountOwnedNotes(other.account, owners);
      const view = {
        descriptor: plain(other.identity.descriptor),
        received: notes.read.received.map((note) => ({ ...note })),
        sent: notes.read.sent.map((note) => ({ ...note })),
        ownedPoi: notes.ownedPoi.map((record) => ({ ...record })),
        trees: plain(notes.trees),
      };
      return use ? { ...view, spend: await use(other, owners, view) } : view;
    } finally {
      try {
        await other.account?.close();
      } finally {
        try {
          await other.publicAccount?.close();
        } finally {
          other.enrollment?.close();
          other.identity?.close();
        }
      }
    }
  }
  const vault = require('../src/main/identity/vault');
  const publicApi = require('../src/main/wallet/railgun-account-public');
  let identity, enrollment, publicAccount, account, txid, staged;
  const started = performance.now();
  try {
    const vaultDirectory = path.join(directory, 'profile', 'identity');
    let publicIdentity, destination, holdId, interruptedResult, faultExits;
    let coldBootstrap,
      originalEntry,
      submissionBackend = handoff?.submissionBackend;
    let rootTransition = null;
    let foreignAccounts, foreignDestination, foreignGate;
    if (!resuming) {
      phase = 'enroll';
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
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          {
            identity,
            create: true,
          }
        );
      phase = 'public-scan';
      publicAccount = await publicApi.openRailgunAccountPublic({
        enrollment,
        archive,
        create: true,
      });
      for (let from = 0; from <= initialTo; from += 100000)
        await publicAccount.advance({ to: Math.min(from + 99999, initialTo), anchor });
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
      if (advanced) assert.equal(selected.id, transact ? '0:2' : '0:1');
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
      if (forSubmission) {
        const identityDirectory = require('../src/main/profile-paths').getIdentityDataDir();
        const relative = path.relative(directory, identityDirectory);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        const metadata = path.join(identityDirectory, 'vault-meta.json');
        assert.equal(fs.existsSync(metadata), false);
        fs.writeFileSync(
          metadata,
          JSON.stringify({
            userKnowsPassword: true,
            addresses: { userWallet: recipient },
            derivedWallets: [
              { index: 0, name: 'Offline public vector', type: 'mnemonic', address: recipient },
            ],
          }) + '\n',
          { flag: 'wx', mode: 0o600 }
        );
        assert.equal(require('../src/main/identity-manager').getWalletRecord(0).address, recipient);
      }
      if (forSubmission)
        submissionBackend = {
          record: Object.fromEntries(
            ['type', 'id', 'hash', 'txid', 'nullifier', 'blindedCommitment', 'blockNumber'].map(
              (key) => [key, selected[key]]
            )
          ),
          submitter: recipient,
          originalRoot: baseline.trees.find((tree) => tree.tree === note.tree).root,
        };
      if (foreignTransfer) {
        phase = 'foreign-accounts';
        foreignAccounts = await runForeignFixture({ mode: 'addresses' });
        const other = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
          archive,
          accountIndex: 1,
        });
        try {
          foreignDestination = plain(other.descriptor);
        } finally {
          other.close();
        }
        // The vault's genuine identities are the published-mnemonic derivations.
        assert.deepEqual(plain(identity.descriptor), foreignAccounts.accounts[0]);
        assert.deepEqual(foreignDestination, foreignAccounts.accounts[1]);
        assert.notEqual(foreignDestination.instanceId, baseline.read.instanceId);
      }
      const request = {
        kind: {
          transfer: 'railgun-private-transfer',
          unshield: 'railgun-token-unshield',
          partial: 'railgun-partial-unshield',
          foreign: 'railgun-private-transfer',
        }[kind],
        noteId: selected.id,
        recipient:
          kind === 'transfer'
            ? baseline.read.instanceId
            : foreignTransfer
              ? foreignDestination.instanceId
              : recipient,
        ...(kind === 'partial' ? { unshieldAmount: (note.amount / 2n).toString() } : {}),
      };
      publicIdentity = publicApi.getRailgunAccountPublicIdentity(owners.coordinator, enrollment);
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
      interruptedResult =
        await require('../src/main/wallet/railgun-private-operation').proveRailgunAccountPrivateOperation(
          options
        );
      assert.equal(
        interruptedResult.status,
        'signed-unfinished',
        JSON.stringify(interruptedResult)
      );
      assert.equal(interrupted, 1);
      assert.equal(refusedResult, 1);
      assert.equal(counts.spendingKeys, 1);
      assert.equal(counts.intentRequests, 1);
      assert.equal(counts.brokerRefusals, 1);
      faultExits = childResults.filter((item) => item.job === 'railgun-private-operate-job.js');
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
      if (foreignTransfer) {
        // The signed capsule names B with the explicit marker; the receiver job
        // verified that destination before the one spending-sign key release.
        assert.deepEqual(originalCapsule.selection, {
          kind: 'railgun-private-transfer',
          tree: note.tree,
          position: note.position,
          recipient: foreignDestination.instanceId,
          recipientRelationship: 'foreign',
        });
        assert.equal(originalCapsule.version, 1);
        assert.equal(originalCapsule.preparation.recipient, foreignDestination.instanceId);
        assert.equal(originalCapsule.preparation.amount, note.amount.toString());
        assert.deepEqual(receiverResults, [
          {
            phase: 'signed-interruption',
            verified: true,
            recipient: foreignDestination.instanceId,
            recipientRelationship: 'foreign',
          },
        ]);
      }
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
      if (foreignTransfer) {
        // The same pre-signing receiver gate on the real signed intent, where
        // only the destination differs. No signing, hold or capsule follows.
        phase = 'foreign-receiver-gate';
        const {
          verifyRailgunPrivateReceiver,
        } = require('../src/main/wallet/railgun-private-receive');
        const intent = originalCapsule.preparation;
        const gate = async (address, accepted) => {
          const startsBefore = jobs['railgun-private-receive-job.js'] || 0,
            keysBefore = keys['private-receive'] || 0;
          const check = verifyRailgunPrivateReceiver({
            identity,
            enrollment,
            archive,
            transaction: intent.transaction,
            expected: intent.expected,
            recipient: address,
            recipientRelationship: 'foreign',
            amount: intent.amount,
          });
          if (accepted) {
            const verified = await check;
            assert.equal(verified.recipientVerified, true);
            assert.equal(verified.recipient, address);
            assert.equal(verified.recipientRelationship, 'foreign');
          } else
            await assert.rejects(
              check,
              (error) => error.code === 'RAILGUN_PRIVATE_RECEIVER_REFUSED'
            );
          return {
            outcome: accepted ? 'verified' : 'refused',
            utilityStarts: (jobs['railgun-private-receive-job.js'] || 0) - startsBefore,
            keyReleases: (keys['private-receive'] || 0) - keysBefore,
          };
        };
        foreignGate = {
          recipient: await gate(foreignDestination.instanceId, true),
          ownKeysOtherEncoding: await gate(foreignAccounts.ownChainAddress, false),
          unrelatedDestination: await gate(foreignAccounts.accounts[2].instanceId, false),
          ownInstanceMarked: await gate(baseline.read.instanceId, false),
        };
        assert.deepEqual(foreignGate, {
          recipient: { outcome: 'verified', utilityStarts: 1, keyReleases: 1 },
          // Refused inside the utility before the viewing key is requested.
          ownKeysOtherEncoding: { outcome: 'refused', utilityStarts: 1, keyReleases: 0 },
          // A destination changed after review fails the sent-output check.
          unrelatedDestination: { outcome: 'refused', utilityStarts: 1, keyReleases: 1 },
          // Main's string policy refuses before any utility starts.
          ownInstanceMarked: { outcome: 'refused', utilityStarts: 0, keyReleases: 0 },
        });
        assert.deepEqual(receiverResults.at(-1), {
          phase: 'foreign-receiver-gate',
          verified: true,
          recipient: foreignDestination.instanceId,
          recipientRelationship: 'foreign',
        });
        assert.equal(receiverResults.length, 2);
        assert.equal(counts.spendingKeys, 1);
        assert.equal(counts.intentRequests, 1);
        assert.equal((await capsules.inspect()).records, 1);
      }
      if (advanced) {
        phase = 'advanced-owner-setup';
        originalEntry = await reservations.withSigningRecovery(async (records, context) => {
          context.assertCurrent();
          assert.equal(records.length, 1);
          assert.equal(records[0].entry.id, interruptedResult.holdId);
          const saved = await capsules.readSignedUnfinished(records[0].receipt);
          assert.deepEqual(saved.capsule, originalCapsule);
          assert.deepEqual(saved.signature, originalSignature);
          return records[0].entry;
        });
        await publicAccount.close();
        publicAccount = await publicApi.openRailgunAccountPublic({ enrollment, archive });
        assert.deepEqual(
          publicApi.getRailgunAccountPublicIdentity(publicAccount.coordinator, enrollment),
          publicIdentity
        );
        owners.coordinator = publicAccount.coordinator;
        phase = 'advanced-public';
        await publicAccount.advance({ to: advancedTo, anchor });
        phase = 'advanced-wallet';
        account = await wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'advance' });
        const current = wallet.readRailgunAccountOwnedNotes(account, owners);
        const currentNote = current.read.received.find((value) => value.id === selected.id);
        const currentPoi = current.ownedPoi.find((value) => value.id === selected.id);
        assert.ok(currentNote && currentPoi);
        for (const key of ['id', 'tree', 'position', 'hash', 'txid', 'amount', 'spentTxid'])
          assert.deepEqual(currentNote[key], note[key]);
        assert.equal(currentNote.spentTxid, false);
        for (const key of ['nullifier', 'type']) assert.equal(currentPoi[key], selected[key]);
        const initialTree = baseline.trees.find((value) => value.tree === note.tree);
        const advancedTree = current.trees.find((value) => value.tree === note.tree);
        assert.equal(initialTree.length, transact ? 3 : 2);
        assert.equal(advancedTree.length, initialTree.length + 1);
        assert.equal(initialTree.root, originalCapsule.preparation.expected.merkleRoot);
        assert.notEqual(advancedTree.root, originalCapsule.preparation.expected.merkleRoot);
        assert.ok(restoredCheckpoint);
        assert.equal(
          restoredCheckpoint.state.trees.find((value) => value.tree === note.tree).root,
          advancedTree.root
        );
        assert.notDeepEqual(restoredCheckpoint, originalCheckpoint);
        rootTransition = {
          initialTreeLength: initialTree.length,
          advancedTreeLength: advancedTree.length,
          currentRootDiffersFromOriginalSignedRoot: true,
          originalInputUnchangedAndUnspent: true,
          maintenanceBeforeShutdown: true,
          addedLeafRecipient: transact ? 'other-wallet' : 'self',
          creatorProvenOrAccepted: false,
        };
        await account.close();
        account = null;
      }
      if (runMode === 'warm') {
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
        destination = publicApi.getRailgunAccountPublicDestination(
          publicAccount.coordinator,
          enrollment
        );
      }
      holdId = interruptedResult.holdId;
    } else {
      phase = 'cold-bootstrap';
      const accountBase = path.join(profile.userDataDir, 'wallet-railgun-accounts');
      const marker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
      assert.deepEqual(snapshot(accountBase), handoff.accountFiles);
      assert.equal(sha(fs.readFileSync(marker)), handoff.inventoryHash);
      if (forSubmission)
        assert.equal(
          sha(fs.readFileSync(path.join(profile.userDataDir, 'identity', 'vault-meta.json'))),
          handoff.metadataSha256
        );
      const beforeBootstrap = evidence();
      await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
      identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
        archive,
      });
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity, create: false }
        );
      publicAccount = await publicApi.openRailgunAccountPublic({
        enrollment,
        archive,
        create: false,
      });
      publicIdentity = publicApi.getRailgunAccountPublicIdentity(
        publicAccount.coordinator,
        enrollment
      );
      assert.deepEqual(publicIdentity, handoff.publicIdentity);
      destination = publicApi.getRailgunAccountPublicDestination(
        publicAccount.coordinator,
        enrollment
      );
      ({ reservations, capsules } = await enrollment.openPrivateRecoveryStores());
      await reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        assert.equal(records.length, 1);
        assert.equal(records[0].entry.state, 'signing');
        const stored = await capsules.readSignedUnfinished(records[0].receipt);
        context.assertCurrent();
        assert.equal(canonicalHash(records[0].entry), handoff.recordHashes.entry);
        assert.equal(canonicalHash(stored.capsule), handoff.recordHashes.capsule);
        assert.equal(canonicalHash(stored.signature), handoff.recordHashes.signature);
        assert.equal(stored.provedTransaction, null);
        holdId = records[0].entry.id;
        originalCapsule = stored.capsule;
        originalSignature = stored.signature;
      });
      originalCheckpoint = handoff.originalCheckpoint;
      assert.ok(authenticatedPublicCheckpoint);
      assert.deepEqual(authenticatedPublicCheckpoint, handoff.checkpoint);
      restoredCheckpoint = authenticatedPublicCheckpoint;
      rootTransition = handoff.rootTransition;
      if (advanced) {
        assert.ok(rootTransition?.currentRootDiffersFromOriginalSignedRoot);
        const tree = restoredCheckpoint.state.trees.find((value) => value.tree === 0);
        assert.notEqual(tree.root, originalCapsule.preparation.expected.merkleRoot);
        assert.equal(tree.length, transact ? 4 : 3);
      } else assert.deepEqual(restoredCheckpoint, originalCheckpoint);
      const bootstrappedFiles = snapshot(accountBase);
      assert.deepEqual(Object.keys(bootstrappedFiles), Object.keys(handoff.accountFiles));
      assert.equal(sha(fs.readFileSync(marker)), handoff.inventoryHash);
      if (forSubmission)
        assert.equal(
          sha(fs.readFileSync(path.join(profile.userDataDir, 'identity', 'vault-meta.json'))),
          handoff.metadataSha256
        );
      const changed = Object.keys(bootstrappedFiles).filter(
        (name) => bootstrappedFiles[name] !== handoff.accountFiles[name]
      );
      const observed = storageWrites.map((write) => path.relative(accountBase, write.filename));
      // SQLite opens are real and source/public stores can authenticate/collect.
      // This fixture requires their bytes unchanged; only observed JSON leases/floors may change.
      assert.deepEqual(
        storageWrites.map((write) => write.cold?.record).sort(),
        [...COLD_RECORDS].sort()
      );
      assert.ok(storageWrites.every((write) => write.cold.authenticatedContentUnchanged));
      assert.equal(new Set(observed).size, 6);
      assert.deepEqual(changed.sort(), [...new Set(observed)].sort());
      const afterBootstrap = evidence();
      const bootstrapJobs = Object.fromEntries(
        Object.entries(afterBootstrap.jobs)
          .map(([job, count]) => [job, count - (beforeBootstrap.jobs[job] || 0)])
          .filter(([, count]) => count !== 0)
      );
      assert.deepEqual(bootstrapJobs, { 'railgun-identity-job.js': 2 });
      assert.equal(afterBootstrap.counts.childStarts - beforeBootstrap.counts.childStarts, 2);
      assert.equal(afterBootstrap.counts.childExits - beforeBootstrap.counts.childExits, 2);
      assert.equal(afterBootstrap.counts.storageStarts - beforeBootstrap.counts.storageStarts, 2);
      assert.equal(
        afterBootstrap.counts.readOnlyStorageStarts - beforeBootstrap.counts.readOnlyStorageStarts,
        0
      );
      assert.ok(
        childResults.every(
          (child) => child.code === 'RAILGUN_PROCESS_CLOSED' && Number.isInteger(child.exitCode)
        )
      );
      assert.equal(
        afterBootstrap.services.transportEntries,
        beforeBootstrap.services.transportEntries
      );
      assert.equal(counts.spendingKeys, 0);
      assert.equal(counts.intentRequests, 0);
      coldBootstrap = {
        before: beforeBootstrap,
        after: afterBootstrap,
        expectedRecordUpdates: [...COLD_RECORDS],
        updates: storageWrites.map(({ cold }) => cold),
        bootstrapJobs,
        changedFileCount: changed.length,
        authenticatedRecordContentPreserved: true,
        persistedCheckpointPreserved: true,
        genuinePublicCheckpointAuthenticatedByColdOpener: true,
        fixedExistingOnlyRecoveryStoresOpenedInBootstrap: true,
        identityDerivationKeys: {
          spendingPublic: keys['spending-public'] || 0,
          viewingIdentity: keys['viewing-identity'] || 0,
        },
        noNewSpendSignatureOrPrivateIntent: true,
        noProtocolServiceOrRpcCalls: true,
      };
      assert.equal(coldBootstrap.identityDerivationKeys.spendingPublic, 1);
      assert.equal(coldBootstrap.identityDerivationKeys.viewingIdentity, 1);
      interruptedResult = { status: 'signed-unfinished' };
      faultExits = [handoff.setupEvidence.observedFaultExit];
    }
    const inspectSigned = async (unfinished) =>
      reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        assert.equal(records.length, 1);
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
    if (originalEntry) assert.deepEqual(before.entry, originalEntry);
    assert.deepEqual(before.stored.capsule, originalCapsule);
    assert.deepEqual(before.stored.signature, originalSignature);
    assert.equal(before.stored.provedTransaction, null);
    assert.equal(before.stored.capsule.version, kind === 'partial' ? 2 : 1);
    if (runMode === 'setup') {
      phase = 'setup-close';
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
      assert.ok(loans.every((key) => key.every((value) => value === 0)));
      await services.close();
      assert.equal(services.report().pendingRequests, 0);
      assert.equal(services.report().transportCreates, services.report().transportCloses);
      assert.deepEqual(inventory(), sourceHashes);
      if (forSubmission) fixtureChecks.assertEmpty();
      setupHandoff = {
        filename: handoffFilename,
        value: {
          schema: 'railgun-proof-recovery-restart-handoff-v1',
          ...(forSubmission
            ? {
                submissionBackend,
                metadataSha256: sha(
                  fs.readFileSync(path.join(profile.userDataDir, 'identity', 'vault-meta.json'))
                ),
              }
            : {}),
          runID,
          setupPID: process.pid,
          inputCreator,
          kind,
          sourceSha256: sha(sourceBytes),
          sourceHashes,
          runtimeHashes,
          historyMode,
          originalCheckpoint,
          rootTransition,
          checkpoint: restoredCheckpoint ?? originalCheckpoint,
          publicIdentity,
          recordHashes: {
            entry: canonicalHash(before.entry),
            capsule: canonicalHash(before.stored.capsule),
            signature: canonicalHash(before.stored.signature),
          },
          accountFiles: snapshot(path.dirname(enrollment.directory)),
          inventoryHash: sha(
            fs.readFileSync(path.join(profile.userDataDir, 'wallet-privacy-inventory.json'))
          ),
          setupEvidence: {
            profileLockAcquired,
            counts,
            jobs,
            keys,
            childResults,
            workerResults,
            brokerResults,
            observedFaultExit: faultExits[0],
            ...(foreignTransfer
              ? { foreignReceivers: receiverResults.map(sanitizeReceiver), foreignGate }
              : {}),
            durableSignedUnfinished: true,
            borrowedKeysWiped: true,
            services: services.report(),
          },
          cleanlyDrainedAndProfileReleased: true,
        },
      };
      return;
    }
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
    if (forSubmission) fixtureChecks.assertEmpty();
    assert.equal(result.status, 'proof-stored', JSON.stringify(result));
    assert.equal(result.submissionEnabled, false);
    const after = await inspectSigned(false);
    assert.ok(walletJournalReads.length > 0);
    assert.ok(walletJournalReads.some((read) => read.afterRecoveryJobExit));
    for (const read of walletJournalReads)
      assert.deepEqual(read.checkpoint, walletJournalReads[0].checkpoint);
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
    if (forSubmission) fixtureChecks.assertEmpty();
    assert.deepEqual(duplicate, { ...result, status: 'proof-present' });
    assert.deepEqual(evidence(), duplicateBefore);
    assert.deepEqual(snapshot(accountBase), duplicateDisk);
    assert.deepEqual(fs.readFileSync(inventoryMarker), inventoryBefore);
    assert.equal(counts.forbiddenJobs + counts.forbiddenKeys + counts.forbiddenRpc, 0);
    assert.ok(loans.every((key) => key instanceof Uint8Array && key.every((value) => value === 0)));
    measuring = false;
    let foreignReceipt;
    if (foreignTransfer) {
      // After measured recovery: the recovered output reaches the synthetic chain
      // and other accounts. Nothing below changes the stored hold or its proof.
      const receiptBefore = evidence();
      phase = 'foreign-creator';
      const capsule = after.stored.capsule;
      const { selection, preparation } = capsule;
      const { Interface } = require('ethers');
      const { TRANSACT_ABI } = require('../src/main/wallet/railgun-private-policy');
      const { PRIVATE_EVENTS } = require('../src/main/wallet/railgun-transact-receipt');
      const { digestRailgunPrivateCapsule } = require('../src/main/wallet/railgun-private-capsule');
      // The recovered transaction already matched the signed intent except for
      // its proof, so this is the reviewed output with the signed ciphertext.
      const [[provedTx]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
        'transact',
        after.stored.provedTransaction.data
      );
      assert.deepEqual([...provedTx.commitments], [preparation.expected.commitment]);
      assert.deepEqual([...provedTx.nullifiers], [preparation.expected.nullifier]);
      const signedCheckpoint = restoredCheckpoint ?? originalCheckpoint;
      assert.ok(signedCheckpoint.to.number < FOREIGN_BLOCK);
      const outputPosition = signedCheckpoint.state.trees.find(
        (value) => value.tree === selection.tree
      ).length;
      const outputId = `${selection.tree}:${outputPosition}`,
        inputId = `${selection.tree}:${selection.position}`;
      const {
        captureRailgunPoiCreator,
      } = require('../src/main/wallet/railgun-poi-creator-capture');
      const captured = await captureRailgunPoiCreator({
        enrollment,
        coordinator: publicAccount.coordinator,
        capsule,
        signal: enrollment.signal,
      });
      let creator;
      try {
        assert.equal(captured.observation.sourceAuthenticated, true);
        creator = plain(captured.observation.creator);
      } finally {
        captured.close();
      }
      assert.equal(creator.type, inputCreator);
      phase = 'foreign-receipt';
      const eventsAbi = new Interface(PRIVATE_EVENTS);
      const ciphertext = provedTx.boundParams.commitmentCiphertext[0];
      const outputEvent = eventsAbi.encodeEventLog(eventsAbi.getEvent('Transact'), [
        selection.tree,
        outputPosition,
        [...provedTx.commitments],
        [
          {
            ciphertext: [...ciphertext.ciphertext],
            blindedSenderViewingKey: ciphertext.blindedSenderViewingKey,
            blindedReceiverViewingKey: ciphertext.blindedReceiverViewingKey,
            annotationData: ciphertext.annotationData,
            memo: ciphertext.memo,
          },
        ],
      ]);
      const receipt = await runForeignFixture({
        mode: 'receipt',
        descriptor: plain(identity.descriptor),
        capsule,
        provedData: after.stored.provedTransaction.data,
        creator,
        outputPosition,
        transactionHash: FOREIGN_TRANSACTION,
        blockNumber: FOREIGN_BLOCK,
        event: outputEvent,
      });
      const [, recipientAccount, unrelatedAccount] = receipt.accounts;
      assert.deepEqual(receipt.accounts[0], plain(identity.descriptor));
      assert.equal(recipientAccount.instanceId, selection.recipient);
      assert.equal(receipt.creatorType, inputCreator);
      assert.match(receipt.poi.npkOut, /^0x[0-9a-f]{64}$/);
      assert.deepEqual(receipt.poi, {
        npkOut: receipt.poi.npkOut,
        npkOutIsRecipientNpk: true,
        valueOutIsFullValue: true,
        outputHashIsReviewedCommitment: true,
        blindedOutputIsRecipientBlindedCommitment: true,
        alteredDestinationRefused: true,
      });
      // The capsule digest, and so the authorization digest, binds both.
      const digest = digestRailgunPrivateCapsule(capsule);
      const unmarked = plain(capsule),
        redirected = plain(capsule);
      delete unmarked.selection.recipientRelationship;
      redirected.selection.recipient = unrelatedAccount.instanceId;
      redirected.preparation.recipient = unrelatedAccount.instanceId;
      assert.notEqual(digestRailgunPrivateCapsule(unmarked), digest);
      assert.notEqual(digestRailgunPrivateCapsule(redirected), digest);
      phase = 'foreign-chain';
      const template = source.logs.find((log) => log.blockNumber === OFFSET + 30);
      const base = {
        ...template,
        blockNumber: FOREIGN_BLOCK,
        blockHash: hex(FOREIGN_BLOCK + 1000),
        transactionHash: FOREIGN_TRANSACTION,
        transactionIndex: 0,
        removed: false,
      };
      services.appendLogs([
        {
          ...base,
          ...eventsAbi.encodeEventLog(eventsAbi.getEvent('Nullified'), [
            selection.tree,
            [preparation.expected.nullifier],
          ]),
          logIndex: 0,
        },
        { ...base, ...outputEvent, logIndex: 1 },
      ]);
      services.observeAccount(1);
      services.observeAccount(2);
      phase = 'foreign-sender-wallet';
      const accountWallet = require('../src/main/wallet/railgun-account-wallet');
      await publicAccount.advance({ to: anchor.number, anchor });
      const senderOwners = { identity, enrollment, coordinator: publicAccount.coordinator };
      account = await accountWallet.openRailgunAccountWallet({
        ...senderOwners,
        archive,
        mode: 'advance',
      });
      const senderView = accountWallet.readRailgunAccountOwnedNotes(account, senderOwners);
      await account.close();
      account = null;
      // A records its own sent output and spent input; it never receives B's note.
      assert.ok(!senderView.read.received.some((value) => value.id === outputId));
      assert.ok(!senderView.ownedPoi.some((value) => value.id === outputId));
      const sentOutput = senderView.read.sent.filter((value) => value.id === outputId);
      assert.equal(sentOutput.length, 1);
      assert.equal(sentOutput[0].amount, BigInt(preparation.amount));
      assert.equal(BigInt(sentOutput[0].hash), BigInt(preparation.expected.commitment));
      const spentInput = senderView.read.received.find((value) => value.id === inputId);
      assert.equal(BigInt(spentInput.spentTxid), BigInt(FOREIGN_TRANSACTION));
      // Each public account holds a source and a public store worker, and one
      // process admits three. A's view is complete, so B and C scan after it closes.
      await publicAccount.close();
      publicAccount = null;
      phase = 'foreign-recipient-wallet';
      const keysBeforeRecipient = plain(keysByAccount);
      // B's own authority only: B's owners, B's descriptor and B's key loans.
      const recipientSpend = async (other, owners, view) => {
        const notePoi = view.ownedPoi.find((value) => value.id === outputId);
        assert.ok(notePoi);
        phase = 'foreign-recipient-prepare';
        const prepared = await accountWallet.prepareRailgunAccountPrivateIntent(
          other.account,
          owners,
          {
            kind: 'railgun-token-unshield',
            noteId: outputId,
            recipient: FOREIGN_UNSHIELD_RECIPIENT,
          }
        );
        assert.deepEqual(prepared.readOnly, { readOnly: true, writeAttempts: 0 });
        const offer = plain(prepared.preparation);
        assert.equal(offer.witnessRetained, false);
        assert.equal(offer.spendingEnabled, false);
        assert.equal(offer.recipient, FOREIGN_UNSHIELD_RECIPIENT);
        assert.equal(offer.amount, preparation.amount);
        assert.equal(offer.expected.kind, 'railgun-token-unshield');
        assert.equal(offer.expected.tree, selection.tree);
        assert.equal(offer.expected.recipient, FOREIGN_UNSHIELD_RECIPIENT);
        // B's nullifier for the received leaf under B's current tree root.
        assert.equal(offer.expected.nullifier, notePoi.nullifier);
        assert.notEqual(offer.expected.nullifier, preparation.expected.nullifier);
        assert.equal(
          offer.expected.merkleRoot,
          view.trees.find((value) => value.tree === selection.tree).root
        );
        // A selector only: the creator collector and POI reconstruction read
        // its selection, prepared intent and note hash, never its path elements.
        const selector = {
          version: 1,
          walletId: view.descriptor.walletId,
          engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
          selection: {
            kind: 'railgun-token-unshield',
            tree: selection.tree,
            position: outputPosition,
            recipient: FOREIGN_UNSHIELD_RECIPIENT,
          },
          preparation: Object.fromEntries(
            ['transaction', 'expected', 'expectedHash', 'recipient', 'amount'].map((key) => [
              key,
              offer[key],
            ])
          ),
          noteHash: notePoi.hash,
          pathElements: Array(16).fill(hex(0)),
        };
        require('../src/main/wallet/railgun-private-capsule').normalizeRailgunPrivateCapsule(
          selector
        );
        phase = 'foreign-recipient-creator';
        const recipientCapture = await captureRailgunPoiCreator({
          enrollment: other.enrollment,
          coordinator: owners.coordinator,
          capsule: selector,
          signal: other.enrollment.signal,
        });
        let observation;
        try {
          observation = plain(recipientCapture.observation);
        } finally {
          recipientCapture.close();
        }
        // B's authenticated source attributes the note to A's Transact at
        // FOREIGN_BLOCK with the real calldata ciphertext: not a Shield.
        assert.equal(observation.sourceAuthenticated, true);
        assert.equal(observation.creatorHashCompared, true);
        assert.equal(observation.spendingEnabled, false);
        assert.deepEqual(observation.creator, {
          type: 'Transact',
          tree: selection.tree,
          position: outputPosition,
          hash: preparation.expected.commitment,
          ciphertext: {
            ciphertext: [...ciphertext.ciphertext],
            blindedSenderViewingKey: ciphertext.blindedSenderViewingKey,
            blindedReceiverViewingKey: ciphertext.blindedReceiverViewingKey,
            annotationData: ciphertext.annotationData,
            memo: ciphertext.memo,
          },
        });
        assert.equal(observation.origin.blockNumber, FOREIGN_BLOCK);
        assert.equal(BigInt(observation.origin.transactionHash), BigInt(FOREIGN_TRANSACTION));
        assert.equal(observation.origin.logIndex, 1);
        assert.equal(observation.origin.startPosition, outputPosition);
        assert.equal(observation.origin.outputOffset, 0);
        phase = 'foreign-recipient-poi';
        const spendInput = {
          mode: 'recipient-spend',
          descriptor: view.descriptor,
          capsule: selector,
          creator: observation.creator,
        };
        const text = JSON.stringify(spendInput);
        for (const value of [
          identity.descriptor.walletId,
          identity.descriptor.instanceId,
          identity.descriptor.masterPublicKey,
          identity.descriptor.viewingPublicKey,
        ])
          assert.ok(!text.includes(value));
        const spent = await runForeignFixture(spendInput, other.enrollment);
        assert.deepEqual(spent.derivedAccountIndexes, [1]);
        assert.equal(spent.valueIn, preparation.amount);
        assert.equal(spent.creatorType, 'Transact');
        for (const key of [
          'receiverSideDecryption',
          'preparedNullifierMatches',
          'noteHashMatches',
          'unshieldCommitmentMatches',
          'alteredCreatorRefused',
        ])
          assert.equal(spent[key], true, key);
        return { inputNpk: spent.inputNpk };
      };
      const recipientView = await scanOtherAccount(1, recipientSpend);
      phase = 'foreign-recipient-checks';
      assert.deepEqual(recipientView.descriptor, recipientAccount);
      // The Transact advanced-root vector already paid account 1 once, at block 40.
      const earlierNotes = transact && advanced ? 1 : 0;
      assert.equal(recipientView.received.length, earlierNotes + 1);
      assert.ok(
        recipientView.received.every(
          (value) => value.id === outputId || value.position < outputPosition
        )
      );
      const receivedNote = recipientView.received.find((value) => value.id === outputId);
      assert.equal(receivedNote.amount, BigInt(preparation.amount));
      assert.equal(BigInt(receivedNote.hash), BigInt(preparation.expected.commitment));
      assert.equal(BigInt(receivedNote.txid), BigInt(FOREIGN_TRANSACTION));
      assert.equal(receivedNote.spentTxid, false);
      assert.deepEqual(recipientView.sent, []);
      assert.equal(recipientView.ownedPoi.length, earlierNotes + 1);
      const receivedPoi = recipientView.ownedPoi.find((value) => value.id === outputId);
      assert.equal(receivedPoi.type, 'Transact');
      assert.equal(receivedPoi.blockNumber, FOREIGN_BLOCK);
      // B's own wallet derives the NPK and blinded commitment A's POI used.
      assert.equal(BigInt(receivedPoi.npk), BigInt(receipt.recipient.npk));
      assert.equal(
        BigInt(receivedPoi.blindedCommitment),
        BigInt(receipt.recipient.blindedCommitment)
      );
      // Independent equality: B's receiver-side POI input NPK and B's wallet NPK
      // against A's sender-side POI output NPK.
      assert.equal(BigInt(recipientView.spend.inputNpk), BigInt(receipt.poi.npkOut));
      assert.equal(BigInt(recipientView.spend.inputNpk), BigInt(receivedPoi.npk));
      const recipientKeys = Object.fromEntries(
        Object.entries(keysByAccount)
          .map(([name, value]) => [name, delta(keysBeforeRecipient[name] || {}, value)])
          .filter(([, value]) => Object.keys(value).length)
      );
      // No key loan for A, or for anyone but B, during B's scan and preparation.
      assert.deepEqual(Object.keys(recipientKeys), ['railgun:1']);
      assert.equal(recipientKeys['railgun:1']['private-prepare'], 1);
      assert.equal(recipientKeys['railgun:1']['spending-sign'], undefined);
      phase = 'foreign-unrelated-wallet';
      const unrelatedView = await scanOtherAccount(2);
      assert.deepEqual(unrelatedView.descriptor, unrelatedAccount);
      assert.deepEqual(
        [unrelatedView.received, unrelatedView.sent, unrelatedView.ownedPoi],
        [[], [], []]
      );
      const receiptAfter = evidence();
      const setupForeign = resuming ? handoff.setupEvidence : null;
      if (setupForeign) assert.ok(setupForeign.foreignGate && setupForeign.foreignReceivers);
      const { npk: _npk, blindedCommitment: _blinded, ...recipientLeaf } = receipt.recipient;
      foreignReceipt = {
        accounts: {
          sender: 0,
          recipient: 1,
          unrelated: 2,
          publicMnemonicDerivationsMatchVaultIdentities: true,
        },
        signedCapsule: {
          version: capsule.version,
          recipientRelationship: selection.recipientRelationship,
          destinationIsRecipientAccount: true,
          markerAndDestinationBoundByCapsuleDigest: true,
        },
        receiverChecksBeforeSigning: setupForeign
          ? setupForeign.foreignReceivers
          : receiverResults.map(sanitizeReceiver),
        receiverGate: setupForeign ? setupForeign.foreignGate : foreignGate,
        output: {
          tree: selection.tree,
          position: outputPosition,
          provedCommitmentIsReviewedCommitment: true,
          syntheticEventAfterSignedCheckpoint: true,
          syntheticEventAppendedAfterMeasuredRecovery: true,
        },
        engineLeafScan: {
          recipient: recipientLeaf,
          sender: receipt.sender,
          unrelated: receipt.unrelated,
        },
        senderPoiReconstruction: {
          ...Object.fromEntries(Object.entries(receipt.poi).filter(([key]) => key !== 'npkOut')),
          creatorType: receipt.creatorType,
          creatorCapturedFromAuthenticatedSource: true,
        },
        senderWallet: {
          advancedToAnchor: true,
          outputReceived: false,
          outputSent: true,
          inputSpentByOutputTransaction: true,
        },
        recipientWallet: {
          enrolledInSameProfile: true,
          outputReceived: true,
          earlierVectorNotes: earlierNotes,
          fullValue: true,
          unspent: true,
          creatorType: receivedPoi.type,
          npkMatchesSenderPoi: true,
          blindedCommitmentMatchesSenderPoi: true,
        },
        recipientCreator: {
          path: 'recipient-account-authenticated-public-source',
          type: 'Transact',
          transactionIsSenderOutputTransaction: true,
          block: 'synthetic-foreign-block',
          ciphertextIsProvedCalldataCiphertext: true,
          sentRecord: false,
        },
        recipientSpend: {
          scope: 'preparation-only',
          kind: 'railgun-token-unshield',
          recipientIsPublicTestAddress: true,
          productionPreparation: true,
          readOnlyNoWrites: true,
          authority: 'recipient-account-only',
          keyLoansByAccount: recipientKeys,
          senderKeyLoans: 0,
          senderDescriptorSupplied: false,
          preparedNullifierIsRecipientNullifier: true,
          preparedRootIsRecipientTreeRoot: true,
          witnessExportedFromUtility: false,
          witnessInputBoundByNullifierRootAndNoteHash: true,
          recipientPoiInputReconstructed: true,
          recipientInputNpkEqualsSenderPoiNpkOut: true,
          recipientInputNpkEqualsRecipientWalletNpk: true,
          selectorPathElementsUnused: true,
          poiEligibility: 'synthetic-not-queried',
          poiListAcceptance: 'synthetic-not-queried',
          txidProvenance: 'not-staged',
          signed: false,
          proved: false,
          submitted: false,
          liveWithdrawalQualified: false,
        },
        unrelatedWallet: { enrolledInSameProfile: true, receivedNotes: 0, sentNotes: 0 },
        jobs: delta(receiptBefore.jobs, receiptAfter.jobs),
        keys: delta(receiptBefore.keys, receiptAfter.keys),
        rpcMethods: delta(receiptBefore.rpcMethods, receiptAfter.rpcMethods),
        reviewCallbacksQualified: false,
        submissionQualified: false,
        poiSubmissionQualified: false,
      };
    }
    phase = 'close';
    await publicAccount?.close();
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
    if (forSubmission) fixtureChecks.assertEmpty();
    const report = {
      schema: 'railgun-proof-recovery-offline-v2',
      ...(forSubmission
        ? { submitterMetadataFixtureWritten: true, productionMetadataOnboardingQualified: false }
        : {}),
      runMode,
      historyMode,
      rootTransition,
      runID,
      resumePID: process.pid,
      ...(resuming ? { setupPID: handoff.setupPID, coldBootstrap } : {}),
      inputCreator,
      kind,
      ...(foreignTransfer ? { foreignRecipient: foreignReceipt } : {}),
      sourceSha256: sha(sourceBytes),
      sourceHashes,
      beforeRecovery,
      afterRecovery,
      interruptedOperation: {
        evidenceProcess: resuming ? 'setup-process' : 'current-process',
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
        publicOwnerReopenedBeforeMeasurement: true,
        noPublicAdvanceDuringRecovery: true,
        recoveryRpcMethods,
        genuineReviewedDestinationBoundByRecoveryHost: true,
        completedWalletJournalCheckpointAuthenticatedAndUnchanged: true,
        authenticatedJournalReads: walletJournalReads.length,
        authenticatedJournalReadAfterRecoveryJobExit: true,
        warmCachedStoreRecovery: !resuming,
        coldExistingOnlyOpenQualified: resuming,
        storesCachedAfterExplicitColdBootstrap: resuming,
        completedPublicCheckpointAndGenerationUnchangedDuringRecovery: true,
        duplicateStatus: duplicate.status,
        duplicateNoJobKeyRpcOrWrite: true,
      },
      actualStoredSignatureRegeneratedProof: true,
      simulatedExternalServiceResponsesAndListTrust: true,
      syntheticExternalChain: true,
      sameProcessRecovery: !resuming,
      freshProcessRestartQualified: resuming,
      cleanRestartOnly: resuming,
      setupProcessObservedAbsentBeforeResume: resuming,
      profileLockAcquired,
      powerLossRecoveryQualified: false,
      originalRootDifferentFromCurrentQualified: advanced,
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
    fs.writeFileSync(reportFilename, JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    if (forSubmission)
      assert.equal(
        sha(fs.readFileSync(path.join(profile.userDataDir, 'identity', 'vault-meta.json'))),
        handoff.metadataSha256
      );
    if (forSubmission)
      submissionHandoff = {
        filename: path.join(directory, 'cold-submission-handoff.json'),
        value: {
          schema: 'railgun-cold-submission-handoff-v1',
          runID,
          setupPID: handoff.setupPID,
          recoveryPID: process.pid,
          inputCreator,
          kind,
          historyMode,
          sourceSha256: sha(sourceBytes),
          sourceHashes,
          runtimeHashes,
          publicIdentity,
          checkpoint: restoredCheckpoint ?? originalCheckpoint,
          originalCheckpoint,
          rootTransition,
          submissionBackend,
          recordHashes: {
            entry: canonicalHash(after.entry),
            stored: canonicalHash(after.stored),
            capsule: canonicalHash(after.stored.capsule),
            signature: canonicalHash(after.stored.signature),
            provedTransaction: canonicalHash(after.stored.provedTransaction),
          },
          transactionDigest: checked.digest,
          accountFiles: snapshot(accountBase),
          inventoryHash: sha(fs.readFileSync(inventoryMarker)),
          recoveryReportSha256: sha(fs.readFileSync(reportFilename)),
          metadataSha256: sha(
            fs.readFileSync(path.join(profile.userDataDir, 'identity', 'vault-meta.json'))
          ),
          cleanlyDrainedAndProfileReleased: true,
        },
      };
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
          if (!setupHandoff && !fs.existsSync(reportFilename))
            fs.writeFileSync(
              diagnosticFilename,
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
    if (setupHandoff) {
      fs.writeFileSync(setupHandoff.filename, JSON.stringify(setupHandoff.value, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          status: 'setup-complete',
          setupPID: process.pid,
          runID: setupHandoff.value.runID,
        })
      );
    }
    if (submissionHandoff)
      fs.writeFileSync(
        submissionHandoff.filename,
        JSON.stringify(submissionHandoff.value, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
    app.exit(0);
  },
  (error) => {
    console.error(
      JSON.stringify({
        phase,
        code: error.code,
        message: error.message,
        stack: error.stack,
        ...(process.argv.at(-1) === 'submission-handoff'
          ? { fixtureViolations: fixtureChecks.report() }
          : {}),
      })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
