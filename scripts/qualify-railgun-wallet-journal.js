const { isRailgunWalletJob } = require('./fixtures/railgun-job-observer');
/** Durable wallet checkpoint and interrupted recovery over synthetic public history. */
const { app } = require('electron');
const nativeAssertions = require('./fixtures/railgun-native-assertions');
const fs = require('fs'),
  path = require('path'),
  assert = nativeAssertions.assert,
  { createHash } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const { getPrivacyStoragePath } = require('../src/main/wallet/privacy-storage');
let qualificationLock;
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function main() {
  // An isolated cooperative campaign cannot share the legacy same-main reopen loop.
  const refusalFlag = process.env.FREEDOM_RAILGUN_RELAY_REFUSAL;
  if (refusalFlag !== undefined) {
    const fixture = require('./fixtures/railgun-relay-refusal-native');
    const config = fixture.select(refusalFlag, process.argv.slice(2), process.env);
    await fixture.execute(config);
    return;
  }
  const [sourceFilename, directory, accountArchive, composition, proverArchive, artifactDirectory] =
    process.argv.slice(2);
  assert.ok(process.argv.slice(2).length <= 6);
  assert.ok(
    (proverArchive === undefined && artifactDirectory === undefined) ||
      (composition === 'enrolled' &&
        path.isAbsolute(proverArchive) &&
        path.isAbsolute(artifactDirectory))
  );
  assert.ok(composition === undefined || (composition === 'enrolled' && accountArchive));
  assert.ok(accountArchive === undefined || path.isAbsolute(accountArchive));
  assert.ok(
    path.isAbsolute(sourceFilename) && path.isAbsolute(directory) && !fs.existsSync(directory)
  );
  const exactReviewFlag = process.env.FREEDOM_RAILGUN_EXACT_RELAY_REVIEW;
  assert.ok([undefined, 'accept', 'held-close'].includes(exactReviewFlag));
  if (exactReviewFlag) {
    assert.equal(composition, 'enrolled');
    assert.ok(accountArchive);
    assert.equal(proverArchive, undefined);
    assert.equal(artifactDirectory, undefined);
    for (const name of Object.keys(process.env).filter(
      (name) => name.startsWith('FREEDOM_RAILGUN_') && name !== 'FREEDOM_RAILGUN_EXACT_RELAY_REVIEW'
    ))
      assert.equal(process.env[name], undefined);
  }
  const relayPreparationFlag = process.env.FREEDOM_RAILGUN_UNSIGNED_RELAY_PREPARATION;
  assert.ok(relayPreparationFlag === undefined || relayPreparationFlag === '1');
  if (relayPreparationFlag) {
    assert.equal(composition, 'enrolled');
    assert.ok(accountArchive);
    assert.equal(proverArchive, undefined);
    assert.equal(artifactDirectory, undefined);
    for (const name of Object.keys(process.env).filter(
      (name) =>
        name.startsWith('FREEDOM_RAILGUN_') && name !== 'FREEDOM_RAILGUN_UNSIGNED_RELAY_PREPARATION'
    ))
      assert.equal(process.env[name], undefined);
  }
  const localReviewFlag = process.env.FREEDOM_RAILGUN_LOCAL_RELAY_REVIEW;
  assert.ok(localReviewFlag === undefined || localReviewFlag === '1');
  if (localReviewFlag) {
    assert.equal(composition, 'enrolled');
    assert.equal(proverArchive, undefined);
    assert.equal(artifactDirectory, undefined);
    for (const name of Object.keys(process.env).filter(
      (name) => name.startsWith('FREEDOM_RAILGUN_') && name !== 'FREEDOM_RAILGUN_LOCAL_RELAY_REVIEW'
    ))
      assert.equal(process.env[name], undefined);
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  if (accountArchive) {
    const profile = require('../src/main/profile-resolver').initializeProfile(app, {
      env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
    });
    qualificationLock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  } else app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const snapshotFlag = process.env.FREEDOM_RAILGUN_KOHAKU_SNAPSHOT;
  assert.ok(snapshotFlag === undefined || snapshotFlag === '1');
  if (snapshotFlag) {
    assert.equal(composition, 'enrolled');
    assert.equal(proverArchive, undefined);
    assert.equal(artifactDirectory, undefined);
    for (const name of [
      'FREEDOM_RAILGUN_KOHAKU',
      'FREEDOM_RAILGUN_PRIVATE_OPERATION',
      'FREEDOM_RAILGUN_PRIVATE_SUBMISSION',
      'FREEDOM_RAILGUN_TRANSACT_STAGING',
      'FREEDOM_RAILGUN_TRANSACT_CONTROLLER',
      'FREEDOM_RAILGUN_SIMULATE_LOST_ACK',
    ])
      assert.equal(process.env[name], undefined);
  }
  const snapshotProbe = snapshotFlag
    ? require('./fixtures/railgun-kohaku-snapshot-native').install()
    : null;
  let snapshotAdapterQualification;
  const localReviewProbe = localReviewFlag
    ? require('./fixtures/railgun-relay-review-native').install()
    : null;
  let localRelayReviewQualification;
  const relayPreparationProbe = relayPreparationFlag
    ? require('./fixtures/railgun-relay-preparation-native').install()
    : null;
  let unsignedRelayPreparationQualification;
  const exactReviewProbe = exactReviewFlag
    ? require('./fixtures/railgun-relay-exact-review-native').install()
    : null;
  let exactRelayReviewQualification;
  const kohakuMode = process.env.FREEDOM_RAILGUN_KOHAKU;
  const privateAdapterMode = process.env.FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER === '1';
  const privateAdapterDenied = process.env.FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER_DENY === '1';
  for (const name of [
    'FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER',
    'FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER_DENY',
  ])
    assert.ok([undefined, '1'].includes(process.env[name]));
  if (privateAdapterMode) {
    assert.ok(['shield-transfer', 'transact-unshield'].includes(kohakuMode));
    assert.equal(snapshotFlag, undefined);
  } else assert.equal(privateAdapterDenied, false);
  const publicAdapterFlag = process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_ADAPTER;
  assert.ok(publicAdapterFlag === undefined || publicAdapterFlag === '1');
  const publicAdapterMode = publicAdapterFlag === '1';
  const publicShield = kohakuMode === 'public-shield';
  if (publicAdapterMode) {
    assert.equal(publicShield, true);
    assert.equal(snapshotFlag, undefined);
    assert.equal(privateAdapterMode, false);
  }
  if (publicShield) {
    assert.equal(composition, 'enrolled');
    assert.equal(proverArchive, undefined);
    assert.equal(artifactDirectory, undefined);
    assert.ok(path.isAbsolute(process.env.FREEDOM_RAILGUN_SHIELD_BYTECODES));
    assert.ok(
      ['acknowledged', 'lost-response', 'review-cancelled'].includes(
        process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE
      )
    );
    assert.equal(process.env.FREEDOM_RAILGUN_KOHAKU_LOST_ACK, undefined);
    assert.equal(process.env.FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW, undefined);
  } else {
    assert.equal(process.env.FREEDOM_RAILGUN_SHIELD_BYTECODES, undefined);
    assert.equal(process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE, undefined);
  }
  if (kohakuMode) {
    assert.ok(composition === 'enrolled' && (publicShield || proverArchive));
    for (const name of [
      'FREEDOM_RAILGUN_PRIVATE_OPERATION',
      'FREEDOM_RAILGUN_PRIVATE_SUBMISSION',
      'FREEDOM_RAILGUN_TRANSACT_STAGING',
      'FREEDOM_RAILGUN_TRANSACT_CONTROLLER',
      'FREEDOM_RAILGUN_SIMULATE_LOST_ACK',
    ])
      assert.equal(process.env[name], undefined);
  } else {
    assert.equal(process.env.FREEDOM_RAILGUN_KOHAKU_LOST_ACK, undefined);
    assert.equal(process.env.FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW, undefined);
  }
  const kohaku = kohakuMode
    ? publicShield
      ? publicAdapterMode
        ? require('./fixtures/railgun-kohaku-public-integration').install(
            process.env.FREEDOM_RAILGUN_SHIELD_BYTECODES,
            process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE,
            { publicAdapter: true }
          )
        : require('./fixtures/railgun-kohaku-public-integration').install(
            process.env.FREEDOM_RAILGUN_SHIELD_BYTECODES,
            process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE
          )
      : require('./fixtures/railgun-kohaku-integration').install(kohakuMode)
    : null;
  let kohakuQualification;
  let accountIdentity, accountParent, accountProfileId, enrollment;
  const vault = accountArchive ? require('../src/main/identity/vault') : null;
  let lockOnViewingKey = false,
    privateViewingKeys = 0,
    privateReceiveKeys = 0,
    corruptPrivateReceiveKey = false,
    failReadOnlyRestore = false,
    failWalletBatch = false,
    failPublicCommit = false,
    failPublication = false,
    cancelledViewingKey,
    cancelledViewingClosed,
    cancelledViewingMessages = 0,
    cancelledViewingProcessClosed = false,
    cancelledViewingProcess = null;
  const stagingQualification = process.env.FREEDOM_RAILGUN_TRANSACT_STAGING === '1';
  const transactControllerKind = process.env.FREEDOM_RAILGUN_TRANSACT_CONTROLLER;
  if (transactControllerKind) {
    assert.ok(
      stagingQualification &&
        ['railgun-private-transfer', 'railgun-token-unshield'].includes(transactControllerKind)
    );
    assert.equal(process.env.FREEDOM_RAILGUN_PRIVATE_OPERATION, undefined);
    assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_PRIVATE_SUBMISSION));
  }
  if (process.env.FREEDOM_RAILGUN_PRIVATE_SUBMISSION !== undefined) {
    assert.equal(process.env.FREEDOM_RAILGUN_PRIVATE_SUBMISSION, '1');
    assert.ok(
      transactControllerKind ||
        ['railgun-private-transfer', 'railgun-token-unshield'].includes(
          process.env.FREEDOM_RAILGUN_PRIVATE_OPERATION
        )
    );
  }
  if (process.env.FREEDOM_RAILGUN_SIMULATE_LOST_ACK !== undefined) {
    assert.equal(process.env.FREEDOM_RAILGUN_SIMULATE_LOST_ACK, '1');
    assert.equal(process.env.FREEDOM_RAILGUN_PRIVATE_SUBMISSION, '1');
  }
  if (stagingQualification) assert.ok(composition === 'enrolled' && proverArchive);
  let stagingGuard = false,
    retainedTransactController;
  const forbiddenStaging = { signerLaunches: 0, spendingKeys: 0, transports: 0, rpc: 0 };
  const transport = require('../src/main/networks/wallet-tor-transport');
  const originalTransport = transport.createWalletTorTransport;
  transport.createWalletTorTransport = (...args) => {
    snapshotProbe?.count('transportFactories');
    localReviewProbe?.count('transportFactories');
    relayPreparationProbe?.count('transportFactories');
    exactReviewProbe?.count('transportFactories');
    if (stagingGuard) {
      forbiddenStaging.transports++;
      throw Error('External transport forbidden during synthetic staging');
    }
    return originalTransport(...args);
  };
  const privateOperationJobs = [];
  let spendingReplyObserver = null,
    productionPrivateOperation = null;
  const contractResources = kohaku
    ? require('./fixtures/railgun-kohaku-contract-observer').installResourceMeter()
    : (snapshotProbe?.resources ??
      localReviewProbe?.resources ??
      relayPreparationProbe?.resources ??
      exactReviewProbe?.resources ??
      null);
  const readContracts = [];
  let restoreContractRuntime;
  const walletRestores = [],
    applications = [];
  if (composition) {
    const catalogModule = require('../src/main/wallet/railgun-wallet-catalog'),
      original = catalogModule.createRailgunWalletCatalog;
    catalogModule.createRailgunWalletCatalog = async (options) => {
      const catalog = await original(options);
      return Object.freeze({
        ...catalog,
        async publish(...args) {
          if (failPublication) {
            failPublication = false;
            throw Error('Injected publication interruption');
          }
          return catalog.publish(...args);
        },
      });
    };
  }
  if (accountArchive) {
    const runtime = require('../src/main/wallet/railgun-process'),
      originalStart = runtime.startRailgunProcess;
    runtime.startRailgunProcess = (options) => {
      if (stagingGuard && isRailgunWalletJob(options, 'railgun-spend-sign-job.js')) {
        forbiddenStaging.signerLaunches++;
        assert.ok(
          transactControllerKind && forbiddenStaging.signerLaunches === 1,
          'Signer forbidden during synthetic staging'
        );
      }
      if (isRailgunWalletJob(options, 'railgun-wallet-job.js'))
        walletRestores.push(JSON.parse(options.input).restore);
      if (!options.broker) return originalStart(options);
      const original = options.broker;
      let cancelledThisTask = false,
        messages = 0;
      const task = originalStart({
        ...options,
        broker: {
          ...original,
          async dispatch(wire) {
            messages++;
            snapshotProbe?.count('brokerMessages');
            localReviewProbe?.count('brokerMessages');
            relayPreparationProbe?.count('brokerMessages');
            exactReviewProbe?.count('brokerMessages');
            const message = JSON.parse(wire);
            if (message.method === 'key') snapshotProbe?.count('railgunKeyRequests');
            if (message.method === 'key') localReviewProbe?.count('railgunKeyRequests');
            if (message.method === 'key') relayPreparationProbe?.count('railgunKeyRequests');
            if (message.method === 'key') exactReviewProbe?.count('railgunKeyRequests');
            if (stagingGuard && message.method === 'key' && message.purpose === 'spending-sign') {
              forbiddenStaging.spendingKeys++;
              assert.ok(
                transactControllerKind && forbiddenStaging.spendingKeys === 1,
                'Spending key forbidden during synthetic staging'
              );
            }
            if (message.method === 'key' && message.purpose === 'private-prepare')
              privateViewingKeys++;
            if (message.method === 'key' && message.purpose === 'private-receive')
              privateReceiveKeys++;
            if (
              failReadOnlyRestore &&
              isRailgunWalletJob(options, 'railgun-wallet-job.js') &&
              JSON.parse(options.input).restore === true &&
              message.method === 'key'
            ) {
              failReadOnlyRestore = false;
              throw Error('Injected read-only restore interruption');
            }
            const reply = await original.dispatch(wire);
            if (message.method === 'key') snapshotProbe?.count('railgunKeyReplies');
            if (message.method === 'key') localReviewProbe?.count('railgunKeyReplies');
            if (message.method === 'key') relayPreparationProbe?.count('railgunKeyReplies');
            if (message.method === 'key') exactReviewProbe?.count('railgunKeyReplies');
            if (
              message.method === 'key' &&
              message.purpose === 'spending-sign' &&
              spendingReplyObserver
            )
              await spendingReplyObserver(reply);
            if (
              corruptPrivateReceiveKey &&
              message.method === 'key' &&
              message.purpose === 'private-receive'
            ) {
              corruptPrivateReceiveKey = false;
              reply[0] ^= 1;
            }
            if (
              lockOnViewingKey &&
              message.method === 'key' &&
              message.purpose === 'wallet-viewing'
            ) {
              lockOnViewingKey = false;
              cancelledViewingKey = reply;
              cancelledThisTask = true;
              cancelledViewingClosed = task.closed;
              vault.lockVault();
            }
            if (
              failPublicCommit &&
              isRailgunWalletJob(options, 'railgun-public-job.js') &&
              message.method === 'txCommit'
            ) {
              failPublicCommit = false;
              throw Error('Injected acknowledged public commit interruption');
            }
            if (
              failWalletBatch &&
              message.channel === 'wallet' &&
              JSON.parse(message.wire).method === 'batch'
            ) {
              failWalletBatch = false;
              throw Error('Injected wallet write interruption');
            }
            return reply;
          },
        },
      });
      task.closed.then((result) => {
        if (isRailgunWalletJob(options, 'railgun-private-operate-job.js'))
          privateOperationJobs.push(result);
        if (cancelledThisTask) {
          cancelledViewingMessages = messages;
          cancelledViewingProcess = result;
          cancelledViewingProcessClosed = [
            'PRIVACY_CONTEXT_REVOKED',
            'RAILGUN_SESSION_REVOKED',
          ].includes(result.code);
        }
      });
      return task;
    };
    if (contractResources) {
      const observed = runtime.startRailgunProcess;
      restoreContractRuntime = () => {
        assert.equal(runtime.startRailgunProcess, observed);
        runtime.startRailgunProcess = originalStart;
      };
    }
  }
  if (composition) {
    const publicModule = require('../src/main/wallet/railgun-public-run'),
      originalJobs = publicModule.createRailgunPublicJobs;
    publicModule.createRailgunPublicJobs = (options) => {
      const jobs = originalJobs(options);
      return Object.freeze({
        ...jobs,
        async apply(input, capability) {
          try {
            const result = await jobs.apply(input, capability);
            applications.push({ to: input.plan.to.number, ...result });
            return result;
          } catch (error) {
            applications.push({
              to: input.plan.to.number,
              interrupted: true,
              closed: error.closed,
            });
            throw error;
          }
        },
      });
    };
  }
  if (accountArchive) {
    const vaultDirectory = path.join(directory, 'profile', 'identity');
    await vault.importVault(
      vaultDirectory,
      'public-fixture-password-not-a-user-credential',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    accountIdentity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive: accountArchive,
    });
    if (composition)
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity: accountIdentity, create: true }
        );
    accountParent = require('../src/main/wallet/privacy-session').openPrivacySession();
  }
  const originalSourceBytes = fs.readFileSync(sourceFilename);
  let sourceBytes = originalSourceBytes,
    stagingRow;
  if (stagingQualification || kohaku?.inputType === 'Transact') {
    const derived = require('./fixtures/railgun-transact-staging-source').derive(
      JSON.parse(originalSourceBytes)
    );
    stagingRow = derived.row;
    sourceBytes = Buffer.from(JSON.stringify(derived.source) + '\n');
    fs.writeFileSync(path.join(directory, 'derived-synthetic-source.json'), sourceBytes, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const { logs, foreignTransfers } = JSON.parse(sourceBytes);
  const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
  const capture = {
    logSetSha256: sha(sourceBytes),
    report: {
      proxy: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
      anchor: { number: 100, hash: hash(101) },
    },
  };
  const headers = new Map(
    Array.from({ length: 101 }, (_, n) => [
      n,
      { number: n, hash: hash(n + 1), parentHash: hash(n) },
    ])
  );
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
  const privateRpc = require('../src/main/networks/private-rpc');
  let requests = 0,
    provider = 'archived-source-a.invalid';
  const archivedRpc = (handle, _role, { signal }) => {
    snapshotProbe?.count('rpcFactories');
    localReviewProbe?.count('rpcFactories');
    relayPreparationProbe?.count('rpcFactories');
    exactReviewProbe?.count('rpcFactories');
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
        snapshotProbe?.count('rpcRequests');
        localReviewProbe?.count('rpcRequests');
        relayPreparationProbe?.count('rpcRequests');
        exactReviewProbe?.count('rpcRequests');
        relayPreparationProbe?.rpc(method, params);
        exactReviewProbe?.rpc(method, params);
        if (stagingGuard && !['eth_getLogs', 'eth_getBlockByNumber'].includes(method)) {
          forbiddenStaging.rpc++;
          throw Error('Private RPC forbidden during synthetic staging');
        }
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
  if (kohaku) kohaku.configureArchive(archivedRpc);
  else privateRpc.createPrivateRpc = archivedRpc;
  const { createRailgunSourceLedger } = require('../src/main/wallet/railgun-source-ledger');
  const { createRailgunScanSource } = require('../src/main/wallet/railgun-scan-source');
  const { startRailgunSessionWorker } = require('../src/main/wallet/railgun-session-worker');
  const { createRailgunScanCoordinator } = require('../src/main/wallet/railgun-scan-coordinator');
  const qualifiedThrough = 0;
  let jobs;
  const subject = {
    kind: 'private-account',
    principal: accountArchive ? 'railgun:0' : 'fixture',
    chainId: 11155111,
    protocol: 'railgun',
    deployment: accountArchive ? 'sepolia' : 'archived-sepolia',
  };
  if (accountArchive)
    accountProfileId = getPrivacyContext(
      accountParent.getContext({ ...subject, role: 'engine' })
    ).profileId;
  let scope,
    ledger,
    source,
    session,
    coordinator,
    publicAccount,
    crashPhase = null;
  const advancePublic = (range) =>
    publicAccount ? publicAccount.advance(range) : coordinator.advance(range);
  async function open(create, mode) {
    scope = createPrivacyScope({
      profileId: accountProfileId ?? 'coordinated-public-history',
      signal: accountParent?.signal ?? new AbortController().signal,
    });
    const rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' }),
      engineHandle = scope.getContext({ ...subject, role: 'engine' });
    if (enrollment) {
      publicAccount =
        await require('../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
          enrollment,
          archive: accountArchive,
          create,
          ...(mode ? { mode } : {}),
        });
      coordinator = publicAccount.coordinator;
    } else {
      jobs = require('./railgun-coordinated-electron').createJobs(engineHandle, qualifiedThrough);
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
            console.error('public apply diagnostic', error.stack);
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
    catalog =
      enrollment?.catalog ??
      (await createRailgunWalletCatalog({
        handle: scope.getContext({
          ...subject,
          role: 'storage',
          operation: 'railgun-wallet-catalog-v1:' + walletId,
        }),
        directory,
        key: Buffer.alloc(32, 66),
        binding: 'f'.repeat(64),
        walletId,
        create,
      }));
    if (enrollment) return;
    if (create) generation = await catalog.begin(policy);
    else if ((await catalog.inspect()).pending) generation = await catalog.resume();
    else generation = null;
    walletDirectory = generation?.directory ?? catalog.activeFor(policy).directory;
  }
  async function close() {
    const cleanup = async (label, run) => {
      try {
        await run();
      } catch (error) {
        nativeAssertions.record(error, 'wallet-journal.' + label);
      }
    };
    // Preserve dependent-before-dependency order on healthy barriers. Rejection
    // is sticky but must not prevent stopping the remaining owned resources.
    await cleanup('publicAccount.close', () => publicAccount?.close());
    if (!enrollment) await cleanup('catalog.close', () => catalog?.close());
    await cleanup('coordinator.close', () => coordinator?.close());
    await cleanup('source.close', () => source?.close());
    await cleanup('ledger.close', () => ledger?.close());
    await cleanup('session.close', () => session?.close());
    // Scope revocation is the final stop, before barriers that may need it.
    await cleanup('scope.close', () => scope?.close());
    await Promise.all([
      cleanup('ledger.closed', () => ledger?.closed),
      cleanup('session.closed', () => session?.closed),
    ]);
  }
  const sources = [
    'src/shared/endpoint-sources.json',
    'scripts/fixtures/railgun-native-assertions.js',
    'scripts/fixtures/railgun-kohaku-contract-pin.json',
    'scripts/fixtures/railgun-kohaku-contract-oracle.js',
    'scripts/fixtures/railgun-kohaku-contract-oracle.test.js',
    'scripts/fixtures/railgun-kohaku-contract-conformance.js',
    'scripts/fixtures/railgun-kohaku-contract-conformance.test.js',
    'scripts/fixtures/railgun-kohaku-contract-observer.js',
    'scripts/fixtures/railgun-kohaku-contract-observer.test.js',
    'src/main/wallet/railgun-account-public.js',
    'src/main/wallet/railgun-public-catalog.js',
    'src/main/wallet/railgun-store-owners.js',
    'src/main/wallet/railgun-public-job.js',
    'src/main/wallet/railgun-public-run.js',
    'src/main/wallet/railgun-public-policy.js',
    'scripts/qualify-railgun-wallet-journal.js',
    ...(kohaku
      ? [
          publicShield
            ? 'scripts/fixtures/railgun-kohaku-public-integration.js'
            : 'scripts/fixtures/railgun-kohaku-integration.js',
          'src/main/wallet/railgun-kohaku-plugin.js',
          'src/main/wallet/railgun-kohaku-read-dispatch.js',
          'src/main/wallet/railgun-kohaku-operation-dispatch.js',
          'src/main/wallet/railgun-kohaku-broadcaster.js',
        ]
      : []),
    ...(privateAdapterMode
      ? [
          'src/main/wallet/railgun-kohaku-private-host.js',
          'src/main/wallet/railgun-kohaku-private-host.test.js',
          'src/main/wallet/railgun-kohaku-private-adapter.js',
          'src/main/wallet/railgun-kohaku-private-adapter.test.js',
          'scripts/fixtures/railgun-kohaku-private-contract.d.ts',
          'scripts/fixtures/railgun-kohaku-private-conformance.js',
          'scripts/fixtures/railgun-kohaku-private-native.js',
          'scripts/fixtures/railgun-kohaku-private-native.test.js',
        ]
      : []),
    ...(publicAdapterMode
      ? [
          'src/main/wallet/railgun-kohaku-public-host.js',
          'src/main/wallet/railgun-kohaku-public-host.test.js',
          'src/main/wallet/railgun-kohaku-public-adapter.js',
          'src/main/wallet/railgun-kohaku-public-adapter.test.js',
          'scripts/fixtures/railgun-kohaku-public-contract.d.ts',
          'scripts/fixtures/railgun-kohaku-public-conformance.js',
          'scripts/fixtures/railgun-kohaku-public-integration.test.js',
          'scripts/qualify-railgun-wallet-journal.test.js',
        ]
      : []),
    ...(relayPreparationProbe || exactReviewProbe
      ? [
          'scripts/fixtures/railgun-relay-preparation-native.js',
          'scripts/fixtures/railgun-relay-preparation-native.test.js',
          'scripts/fixtures/railgun-public-cold-data.js',
          'scripts/fixtures/railgun-relay-quote-native-vectors.js',
          'scripts/fixtures/railgun-kohaku-snapshot-native.js',
          'scripts/fixtures/railgun-kohaku-snapshot-native.test.js',
          'scripts/fixtures/railgun-kohaku-contract-observer.js',
          'scripts/fixtures/railgun-kohaku-contract-observer.test.js',
          'scripts/fixtures/railgun-kohaku-contract-oracle.js',
          'src/main/wallet/railgun-relay-quote-data.js',
          'src/main/wallet/railgun-relay-quote-verify.js',
          'src/main/wallet/railgun-relay-quote-job.js',
          'src/main/wallet/railgun-relay-intent.js',
          'src/main/wallet/railgun-relay-capsule.js',
          'src/main/wallet/railgun-relay-wallet-data.js',
          'src/main/wallet/railgun-relay-wallet-job.js',
          'src/main/wallet/railgun-relay-witness.js',
          'src/main/wallet/railgun-relay-reconstruct.js',
          'src/main/wallet/railgun-relay-intent.test.js',
          'src/main/wallet/railgun-relay-witness.test.js',
          'src/main/wallet/railgun-relay-wallet-data.test.js',
          'src/main/wallet/railgun-relay-wallet-job.test.js',
          'scripts/qualify-railgun-wallet-journal.test.js',
        ]
      : []),
    ...(exactReviewProbe
      ? [
          'scripts/fixtures/railgun-relay-exact-review-native.js',
          'scripts/fixtures/railgun-relay-exact-review-native.test.js',
          'src/main/wallet/railgun-account-wallet.js',
          'src/main/wallet/railgun-account-wallet.test.js',
          'src/main/wallet/railgun-relay-review-summary.js',
          'src/main/wallet/railgun-relay-review-summary.test.js',
          'src/main/wallet/railgun-wallet-policy.js',
          'src/main/wallet/railgun-wallet-policy.test.js',
        ]
      : []),
    ...(localReviewProbe
      ? [
          'scripts/fixtures/railgun-relay-review-native.js',
          'scripts/fixtures/railgun-relay-review-native.test.js',
          'scripts/fixtures/railgun-relay-quote-native-vectors.js',
          'scripts/fixtures/railgun-kohaku-snapshot-native.js',
          'scripts/fixtures/railgun-kohaku-snapshot-native.test.js',
          'scripts/fixtures/railgun-public-cold-data.js',
          'src/main/wallet/railgun-relay-review.js',
          'src/main/wallet/railgun-relay-review.test.js',
          'src/main/wallet/railgun-relay-quote-verify.js',
          'src/main/wallet/railgun-relay-quote-verify.test.js',
          'src/main/wallet/railgun-relay-quote-data.js',
          'src/main/wallet/railgun-relay-quote-data.test.js',
          'src/main/wallet/railgun-relay-quote-job.js',
          'src/main/wallet/railgun-relay-quote-job.test.js',
          'scripts/qualify-railgun-wallet-journal.test.js',
        ]
      : []),
    ...(snapshotProbe
      ? [
          'scripts/fixtures/railgun-kohaku-snapshot-native.js',
          'scripts/fixtures/railgun-kohaku-snapshot-native.test.js',
          'scripts/fixtures/railgun-kohaku-snapshot-conformance.js',
          'scripts/fixtures/railgun-kohaku-snapshot-contract.d.ts',
          'scripts/fixtures/railgun-public-cold-data.js',
          'src/main/wallet/railgun-shield-policy.js',
          'src/main/wallet/railgun-shield-receipt.js',
          'src/main/wallet/railgun-kohaku-snapshot-host.js',
          'src/main/wallet/railgun-kohaku-snapshot-host.test.js',
          'src/main/wallet/railgun-kohaku-snapshot-plugin.js',
          'src/main/wallet/railgun-kohaku-snapshot-plugin.test.js',
          'src/main/wallet/railgun-kohaku-read-dispatch.js',
        ]
      : []),
    ...(publicShield
      ? [
          'src/main/wallet/railgun-kohaku-public-submitter.js',
          'src/main/identity-manager.js',
          'src/main/profile-paths.js',
          'src/main/swarm/ant-cache.js',
          ...Object.keys(
            require('../docs/qualification/railgun-shield-prerequisites-2026-10-04.json')
              .sourceSha256
          ),
        ]
      : []),
    'src/main/wallet/railgun-account-wallet.js',
    'src/main/wallet/railgun-private-creator.js',
    'src/main/wallet/railgun-wallet-policy.js',
    'src/main/wallet/railgun-account-store.js',
    'src/main/wallet/railgun-account-enrollment.js',
    'src/main/wallet/railgun-account-fence.js',
    'src/main/wallet/railgun-account-phase.js',
    'src/main/wallet/railgun-private-reservations.js',
    'src/main/wallet/railgun-private-witness.js',
    'scripts/fixtures/railgun-enrolled-operation.js',
    'scripts/fixtures/railgun-enrolled-signing.js',
    'scripts/fixtures/railgun-enrolled-submission.js',
    'src/main/wallet/railgun-private-submission.js',
    'src/main/wallet/railgun-recovered-review-budget.json',
    'src/main/wallet/private-transaction-intent.js',
    'src/main/wallet/private-submission-journal.js',
    'src/main/wallet/private-submission-reconciler.js',
    'src/main/wallet/privacy-journal-retention.js',
    'src/main/wallet/railgun-transact-intent.js',
    'src/main/wallet/railgun-transact-receipt.js',
    'src/main/wallet/railgun-transact-resolution.js',
    'src/main/wallet/railgun-transact-recovery.js',
    'src/main/wallet/railgun-recovery-finality.js',
    'src/main/wallet/transaction-service.js',
    'src/main/wallet/transaction-submission-coordinator.js',
    'src/main/wallet/ordinary-submission-policy.js',
    'src/main/networks/private-rpc.js',
    'src/main/wallet/railgun-private-operation.js',
    'src/main/wallet/railgun-account-poi.js',
    'src/main/wallet/railgun-private-preflight.js',
    'src/main/wallet/private-transaction-network.js',
    'src/main/wallet/signers.js',
    'src/main/wallet/vault-access.js',
    'scripts/fixtures/railgun-capsule-data.js',
    'src/main/wallet/railgun-private-capsule-store.js',
    'src/main/wallet/railgun-private-capsule.js',
    'src/main/wallet/railgun-private-reconstruct.js',
    'src/main/wallet/railgun-private-operate-job.js',
    'src/main/wallet/railgun-private-prover.js',
    'src/main/wallet/railgun-prover-runtime.js',
    'src/main/wallet/railgun-prover-manifest.json',
    'src/main/wallet/railgun-artifacts.js',
    'src/main/wallet/privacy-artifacts.js',
    'src/main/wallet/railgun-spend-sign-job.js',
    'src/main/wallet/railgun-private-verify-job.js',
    'src/main/wallet/railgun-private-proof.js',
    'src/main/wallet/railgun-private-prepare-job.js',
    'src/main/wallet/railgun-private-preparation.js',
    'src/main/wallet/railgun-private-destination.js',
    'src/main/wallet/railgun-private-intent.js',
    'src/main/wallet/railgun-private-policy.js',
    'src/main/wallet/railgun-private-receive.js',
    'src/main/wallet/railgun-private-receive-job.js',
    'src/main/wallet/railgun-private-results.js',
    'src/main/wallet/railgun-private-signature.js',
    'src/main/wallet/railgun-shield-pins.json',
    'src/main/wallet/privacy-profile-guard.js',
    'src/main/wallet/railgun-identity.js',
    'src/main/wallet/railgun-identity-job.js',
    'src/main/wallet/railgun-wallet-job.js',
    'src/main/wallet/railgun-wallet-run.js',
    'src/main/wallet/railgun-engine-runtime.js',
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/identity/privacy-keys.js',
    'src/main/identity/railgun-key-derivation.js',
    'src/main/wallet/privacy-session.js',
    'src/main/wallet/railgun-wallet-catalog.js',
    'src/main/wallet/railgun-wallet-coverage.js',
    'src/main/wallet/railgun-wallet-coverage-store.js',
    'src/main/wallet/railgun-wallet-journal.js',
    'src/main/wallet/railgun-wallet-runner.js',
    'src/main/wallet/railgun-wallet-read.js',
    'src/main/wallet/railgun-kohaku-read.js',
    'src/main/wallet/railgun-kohaku-read-data.js',
    'src/main/wallet/railgun-wallet-state.js',
    'scripts/fixtures/railgun-wallet-source.js',
    'scripts/railgun-wallet-snapshot-electron.js',
    'scripts/fixtures/railgun-wallet-snapshot-job.js',
    'src/main/wallet/railgun-wallet-storage.js',
    'src/main/wallet/railgun-wallet-scan.js',
    'src/main/wallet/railgun-wallet-records.js',
    'src/main/wallet/railgun-owned-poi-records.js',
    'scripts/railgun-coordinated-electron.js',
    'scripts/fixtures/railgun-coordinated-electron-job.js',
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
    'scripts/fixtures/railgun-engine/runtime-integrity.json',
    'src/main/wallet/railgun-session.js',
    'src/main/wallet/railgun-session-worker-entry.js',
    'src/main/wallet/railgun-paged-store.js',
    'src/main/wallet/railgun-frontier.js',
    'src/main/wallet/railgun-remote.js',
    'src/main/wallet/railgun-tree-transactions.js',
    'src/main/wallet/privacy-storage.js',
    'src/main/networks/privacy-context.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'docs/qualification/railgun-sepolia-history-2026-10-02.json',
  ];
  for (const file of [
    'scripts/fixtures/railgun-transact-staging-source.js',
    'scripts/fixtures/railgun-transact-staging-row.js',
    'scripts/fixtures/railgun-enrolled-transact-staging.js',
    ...[
      'railgun-transact-staging',
      'railgun-transact-provenance',
      'railgun-account-txid',
      'railgun-note-provenance',
      'railgun-note-provenance-job',
      ...require('../src/main/wallet/railgun-txid-policy').SOURCES,
    ].map((name) => 'src/main/wallet/' + name + '.js'),
    // The railgun-kohaku-* modules above re-export this installed package.
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
  ])
    if (!sources.includes(file)) sources.push(file);
  const hashes = () =>
    Object.fromEntries(
      sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
    );
  const sourceSha256 = hashes(),
    runs = [];
  const walletId =
    accountIdentity?.descriptor.walletId ??
    sha(Buffer.from(require('./fixtures/railgun-wallet-snapshot-job').shared, 'hex'));
  if (accountIdentity) {
    const vector = JSON.parse(sourceBytes);
    assert.equal(vector.publicVaultVector, true);
    assert.equal(vector.walletId, walletId);
    assert.equal(vector.instanceId, accountIdentity.descriptor.instanceId);
  }
  const { createRailgunWalletRunner } = require('../src/main/wallet/railgun-wallet-runner');
  const {
    createRailgunWalletCoverageStore,
  } = require('../src/main/wallet/railgun-wallet-coverage-store');
  const { createRailgunWalletJournal } = require('../src/main/wallet/railgun-wallet-journal');
  let policy = enrollment
    ? require('../src/main/wallet/railgun-wallet-policy').getRailgunWalletPolicy(accountArchive)
    : sha('wallet-policy-fixture-v1\0' + JSON.stringify(sourceSha256));
  const runner = accountIdentity
    ? require('../src/main/wallet/railgun-wallet-runner').createRailgunAccountRunner({
        identity: accountIdentity,
        archive: accountArchive,
        policy,
      })
    : createRailgunWalletRunner({
        runJob: require('./railgun-wallet-snapshot-electron').runWalletSnapshot,
        inventory: require('./fixtures/railgun-engine/runtime-integrity.json').inventory.sha256,
        policy,
      });
  const { createRailgunWalletCatalog } = require('../src/main/wallet/railgun-wallet-catalog');
  let walletSession, walletJournal, catalog, generation, walletDirectory;
  const retainedDirectories = [];
  const legacyHashes = new Map();
  const capsuleData = require('./fixtures/railgun-capsule-data');
  const reservationCapsule = capsuleData.capsule(walletId);
  const reservationInput = Object.freeze(capsuleData.facts(reservationCapsule));

  let initialReservationStore, initialReservationReceipt;
  try {
    if (enrollment) {
      const { openRailgunAccountStore } = require('../src/main/wallet/railgun-account-store');
      const sourceStore = await openRailgunAccountStore({
        enrollment,
        kind: 'source',
        create: true,
      });
      let legacyPublic, legacySource, legacyCoordinator;
      try {
        legacyPublic = await openRailgunAccountStore({ enrollment, kind: 'public', create: true });
        const engineHandle = enrollment.getContext('engine');
        const legacyJobs = require('../src/main/wallet/railgun-public-run').createRailgunPublicJobs(
          {
            handle: engineHandle,
            archive: accountArchive,
          }
        );
        legacySource = createRailgunScanSource({
          handle: enrollment.getContext('protocol-rpc'),
          ledger: sourceStore.ledger,
          projectRange: legacyJobs.project,
        });
        legacyCoordinator = await enrollment.withPublicKeys((keys) =>
          createRailgunScanCoordinator({
            handle: engineHandle,
            storeSession: legacyPublic.session,
            source: legacySource,
            journalStorage: {
              directory: enrollment.directory,
              key: keys['scan-journal'],
              binding: enrollment.binding,
              policy: 'e'.repeat(64),
              create: true,
              profileGuard: enrollment.profileGuard,
            },
            applyRange: legacyJobs.apply,
          })
        );
        await legacyCoordinator.advance({ to: 10, anchor: capture.report.anchor });
      } finally {
        legacyCoordinator?.close();
        legacySource?.close();
        sourceStore.ledger.close();
        legacyPublic?.session.close();
        await Promise.all([sourceStore.session.closed, legacyPublic?.session.closed]);
      }
      for (const name of fs
        .readdirSync(enrollment.directory)
        .filter((name) => name.endsWith('.sqlite') || name.endsWith('.json')))
        legacyHashes.set(name, sha(fs.readFileSync(path.join(enrollment.directory, name))));
      const marker = path.join(directory, 'profile', 'wallet-privacy-inventory.json');
      const markerBefore = fs.readFileSync(marker);
      const height = await enrollment.withPublicKeys((keys) =>
        require('../src/main/wallet/railgun-scan-journal').readRailgunScanUpgradeHeight({
          handle: enrollment.getContext('storage', 'railgun-scan-v1'),
          directory: enrollment.directory,
          key: keys['scan-journal'],
          binding: enrollment.binding,
          profileGuard: enrollment.profileGuard,
        })
      );
      assert.equal(height, 10);
      assert.deepEqual(fs.readFileSync(marker), markerBefore);
    }
    await open(true);
    if (enrollment) {
      initialReservationStore = await enrollment.openReservations();
      initialReservationReceipt = await initialReservationStore.reserve(reservationInput);
      assert.deepEqual(
        (await initialReservationStore.assertReceipt(initialReservationReceipt)).facts,
        reservationInput
      );
    }
    let previousEvidence;
    for (const stage of [10, 20, 30]) {
      if (enrollment && stage === 30) {
        failPublicCommit = true;
        await assert.rejects(advancePublic({ to: stage, anchor: capture.report.anchor }));
        assert.equal(failPublicCommit, false);
        assert.equal(applications.at(-1).interrupted, true);
        await close();
        enrollment.close();
        enrollment =
          await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
            { identity: accountIdentity }
          );
        await assert.rejects(initialReservationStore.assertReceipt(initialReservationReceipt));
        const reservations = await enrollment.openReservations();
        assert.deepEqual(await reservations.inspect(), {
          held: 1,
          signing: 0,
          abandoned: 0,
          legacy: 0,
        });
        await assert.rejects(reservations.reserve(reservationInput), {
          code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
        });
        await open(false);
        const recovered = await coordinator.recover();
        assert.equal(recovered.to.number, stage);
        runs.push({
          attempt: 'interrupted-public-apply',
          acknowledgedCommitInterrupted: true,
          recoveredThrough: recovered.to.number,
        });
      } else if (stage !== 20 || accountIdentity)
        await advancePublic({ to: stage, anchor: capture.report.anchor });
      if (enrollment) {
        policy = require('../src/main/wallet/railgun-account-wallet').getRailgunAccountWalletPolicy(
          { archive: accountArchive, enrollment, coordinator }
        );
        if (stage === 10) await catalog.begin(policy);
      }
      if (previousEvidence) assert.throws(() => coordinator.assertSnapshot(previousEvidence));
      for (const attempt of accountIdentity
        ? stage === 30
          ? ['scan', 'restore', 'rebuild', 'rebuild-restore']
          : ['scan', 'restore']
        : stage === 10
          ? [
              'interrupt',
              'incomplete-restore',
              'coverage-crash',
              'restore-pending',
              'restore',
              'stale-public',
            ]
          : stage === 20
            ? ['scan', 'host-first', 'restore']
            : ['scan', 'restore', 'rebuild', 'rebuild-restore']) {
        const restore = [
          'restore',
          'incomplete-restore',
          'restore-pending',
          'host-first',
          'rebuild-restore',
        ].includes(attempt);
        if (enrollment) {
          if (attempt === 'rebuild') retainedDirectories.push(walletDirectory);
          const mode = restore
            ? 'active'
            : attempt === 'rebuild'
              ? 'new'
              : stage === 10
                ? 'pending'
                : 'advance';
          const started = performance.now();
          const opened =
            await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
              identity: accountIdentity,
              enrollment,
              archive: accountArchive,
              coordinator,
              policy,
              mode,
            });
          try {
            if (kohaku)
              readContracts.push(
                await require('./fixtures/railgun-kohaku-contract-conformance').qualifyOwnedView({
                  instance: opened.view,
                  account: opened,
                  owners: { identity: accountIdentity, enrollment, coordinator },
                  measure: () =>
                    structuredClone({
                      requests,
                      transport: kohaku.measureActivity(),
                      applications: applications.length,
                      walletRestores: walletRestores.length,
                      privateViewingKeys,
                      privateReceiveKeys,
                      resources: contractResources.snapshot(),
                    }),
                })
              );
            const balances = await opened.view.balance(),
              notes = await opened.view.notes(),
              status = await opened.view.status();
            const amount = balances.reduce((sum, item) => sum + item.amount, 0n);
            assert.equal(amount, stage === 10 ? 3000n : stage === 20 ? 2000n : 2700n);
            assert.equal(notes.length, stage === 10 ? 2 : stage === 20 ? 1 : 2);
            assert.equal((await opened.view.notes(undefined, true)).length, stage === 30 ? 3 : 2);
            assert.equal(await opened.view.instanceId(), accountIdentity.descriptor.instanceId);
            assert.equal(status.status, 'wallet-scanned-unverified');
            assert.equal(status.spendableGranted, false);
            assert.ok(balances.every((b) => b.tag === 'unverified'));
            assert.equal(opened.view.prepareTransfer, undefined);
            walletDirectory = catalog.activeFor(policy).directory;
            assert.ok(
              retainedDirectories.every((dir) => fs.existsSync(path.join(dir, 'wallet.sqlite')))
            );
            if (snapshotProbe && stage === 30 && attempt === 'restore') {
              assert.equal(snapshotAdapterQualification, undefined);
              snapshotAdapterQualification =
                await require('./fixtures/railgun-kohaku-snapshot-native').qualify({
                  account: opened,
                  owners: { identity: accountIdentity, enrollment, coordinator },
                  signal: opened.signal,
                  profile: path.join(directory, 'profile'),
                  walletDirectory,
                  measure: () =>
                    snapshotProbe.measure({
                      applications: applications.length,
                      walletRestores: walletRestores.length,
                    }),
                });
            }
            if (localReviewProbe && stage === 30 && attempt === 'restore') {
              assert.equal(localRelayReviewQualification, undefined);
              localRelayReviewQualification =
                await require('./fixtures/railgun-relay-review-native').qualify({
                  account: opened,
                  owners: { identity: accountIdentity, enrollment, coordinator },
                  archive: accountArchive,
                  signal: opened.signal,
                  profile: path.join(directory, 'profile'),
                  walletDirectory,
                  measure: () =>
                    localReviewProbe.measure({
                      applications: applications.length,
                      walletRestores: walletRestores.length,
                    }),
                  jobs: localReviewProbe.jobs,
                });
            }
            const accountWindows = [];
            const privatePreparations = [];
            const privateOperations = [];
            if (attempt === 'restore') {
              const {
                readRailgunAccountOwnedNotes,
                restoreRailgunAccountWallet,
              } = require('../src/main/wallet/railgun-account-wallet');
              const owners = { identity: accountIdentity, enrollment, coordinator };
              for (let i = 0; i < 2; i++) {
                const previousView = opened.view;
                const before = readRailgunAccountOwnedNotes(opened, owners);
                const restoring = restoreRailgunAccountWallet(opened, owners);
                assert.throws(() => readRailgunAccountOwnedNotes(opened, owners));
                const nextView = await restoring;
                assert.equal(nextView, opened.view);
                assert.notEqual(nextView, previousView);
                await assert.rejects(previousView.balance());
                const after = readRailgunAccountOwnedNotes(opened, owners);
                assert.equal(after.checkpointHash, before.checkpointHash);
                assert.notEqual(after.read.received[0], before.read.received[0]);
                assert.deepEqual(after.ownedPoi, before.ownedPoi);
                assert.equal(
                  (await nextView.balance()).reduce((sum, b) => sum + b.amount, 0n),
                  amount
                );
                accountWindows.push({
                  currentViewReplaced: true,
                  busyOwnedReadRefused: true,
                  oldViewRefused: true,
                  checkpointUnchanged: true,
                  ownedProjectionUnchanged: true,
                  freshOwnedNoteObjects: true,
                  balanceUnchanged: true,
                });
              }
              const beforePreparation = readRailgunAccountOwnedNotes(opened, owners);
              const selected = beforePreparation.read.received
                .filter((v) => v.spentTxid === false)
                .at(-1);
              if (
                selected.asset.contract ===
                require('../src/main/wallet/railgun-shield-pins.json').wrappedNative
              ) {
                for (const kind of ['railgun-private-transfer', 'railgun-token-unshield']) {
                  const previousView = opened.view,
                    keysBefore = privateViewingKeys,
                    started = performance.now();
                  const prepared =
                    await require('../src/main/wallet/railgun-account-wallet').prepareRailgunAccountPrivateIntent(
                      opened,
                      owners,
                      {
                        kind,
                        noteId: selected.id,
                        recipient:
                          kind === 'railgun-private-transfer'
                            ? accountIdentity.descriptor.instanceId
                            : '0x' + '12'.repeat(20),
                      }
                    );
                  assert.equal(prepared.view, opened.view);
                  await assert.rejects(previousView.balance());
                  assert.equal(prepared.preparation.spendingEnabled, false);
                  assert.equal(prepared.preparation.witnessRetained, false);
                  assert.deepEqual(prepared.readOnly, { readOnly: true, writeAttempts: 0 });
                  assert.equal(prepared.preparation.amount, selected.amount.toString());
                  assert.equal(privateViewingKeys - keysBefore, 1);
                  assert.deepEqual(
                    readRailgunAccountOwnedNotes(opened, owners).ownedPoi,
                    beforePreparation.ownedPoi
                  );
                  let receiver;
                  if (kind === 'railgun-private-transfer') {
                    const p = prepared.preparation,
                      keyCount = privateReceiveKeys;
                    const verify =
                      require('../src/main/wallet/railgun-private-receive').verifyRailgunPrivateReceiver;
                    const args = {
                      identity: accountIdentity,
                      enrollment,
                      archive: accountArchive,
                      transaction: p.transaction,
                      expected: p.expected,
                      recipient: p.recipient,
                      amount: p.amount,
                    };
                    const checked = await verify(args);
                    assert.equal(checked.recipientVerified, true);
                    assert.equal(checked.transactionDigest, p.transactionDigest);
                    assert.equal(checked.spendingEnabled, false);
                    assert.equal(checked.inputOwnershipVerified, false);
                    await assert.rejects(
                      verify({ ...args, amount: (BigInt(p.amount) + 1n).toString() }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    const { Interface, AbiCoder, keccak256 } = require('ethers');
                    const {
                      TRANSACT_ABI,
                      BOUND_PARAMS,
                    } = require('../src/main/wallet/railgun-private-policy');
                    const abi = new Interface([TRANSACT_ABI]);
                    const bad = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    bad[4][6][0][0][1] =
                      '0x' + (BigInt(bad[4][6][0][0][1]) ^ 1n).toString(16).padStart(64, '0');
                    const boundHash =
                      BigInt(
                        keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bad[4]]))
                      ) %
                      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[bad]]),
                        },
                        expected: {
                          ...p.expected,
                          boundParamsHash: '0x' + boundHash.toString(16).padStart(64, '0'),
                        },
                      }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    const changedCommitment = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    changedCommitment[3][0] =
                      '0x' + (BigInt(changedCommitment[3][0]) ^ 1n).toString(16).padStart(64, '0');
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[changedCommitment]]),
                        },
                        expected: { ...p.expected, commitment: changedCommitment[3][0] },
                      }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    corruptPrivateReceiveKey = true;
                    await assert.rejects(verify(args), {
                      code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED',
                    });
                    assert.equal(corruptPrivateReceiveKey, false);
                    const foreign = foreignTransfers?.find((v) => v.amount === p.amount);
                    assert.ok(foreign);
                    const foreignTx = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    foreignTx[3][0] = foreign.commitment;
                    foreignTx[4][6] = [foreign.ciphertext];
                    const foreignHash =
                      BigInt(
                        keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [foreignTx[4]]))
                      ) %
                      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[foreignTx]]),
                        },
                        expected: {
                          ...p.expected,
                          commitment: foreign.commitment,
                          boundParamsHash: '0x' + foreignHash.toString(16).padStart(64, '0'),
                        },
                      }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    assert.equal(privateReceiveKeys - keyCount, 6);
                    const keyCountBeforePolicyRefusal = privateReceiveKeys;
                    const nonzero = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    nonzero[0][0][0] = 1n;
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[nonzero]]),
                        },
                      })
                    );
                    await assert.rejects(
                      verify({
                        ...args,
                        expected: { ...p.expected, kind: 'railgun-token-unshield' },
                      })
                    );
                    assert.equal(privateReceiveKeys, keyCountBeforePolicyRefusal);
                    receiver = {
                      recipientVerified: true,
                      wrongAmountRefused: true,
                      changedCiphertextRefused: true,
                      changedCommitmentRefused: true,
                      wrongViewingKeyRefused: true,
                      foreignRecipientRefused: true,
                      nonzeroProofRefusedBeforeKey: true,
                      wrongKindRefusedBeforeKey: true,
                      viewingKeyTransfersIncludingNegatives: 6,
                      inputOwnershipVerified: false,
                      spendingEnabled: false,
                    };
                  } else {
                    const p = prepared.preparation,
                      keyCount = privateReceiveKeys;
                    await assert.rejects(
                      require('../src/main/wallet/railgun-private-receive').verifyRailgunPrivateReceiver(
                        {
                          identity: accountIdentity,
                          enrollment,
                          archive: accountArchive,
                          transaction: p.transaction,
                          expected: p.expected,
                          recipient: accountIdentity.descriptor.instanceId,
                          amount: p.amount,
                        }
                      )
                    );
                    assert.equal(privateReceiveKeys, keyCount);
                    receiver = { validUnshieldRefusedBeforeKey: true, viewingKeyTransfers: 0 };
                  }
                  if (proverArchive && stage === 10) {
                    privateOperations.push(
                      ...(await require('./fixtures/railgun-enrolled-operation').qualify({
                        account: opened,
                        owners,
                        archive: accountArchive,
                        proverArchive,
                        artifactDirectory,
                        request: {
                          kind,
                          noteId: selected.id,
                          recipient:
                            kind === 'railgun-private-transfer'
                              ? accountIdentity.descriptor.instanceId
                              : '0x' + '12'.repeat(20),
                        },
                      }))
                    );
                  }
                  privatePreparations.push({
                    kind,
                    elapsedMs: Math.round(performance.now() - started),
                    currentViewReplaced: true,
                    oldViewRefused: true,
                    ownedProjectionUnchanged: true,
                    fullInputAmount: true,
                    viewingKeyTransfers: 1,
                    spendingEnabled: false,
                    witnessRetained: false,
                    writeAttempts: 0,
                    ...(receiver ? { receiver } : {}),
                  });
                }
              }
            }
            let transactStaging;
            if (stagingQualification && stage === 30 && attempt === 'restore') {
              stagingGuard = true;
              try {
                transactStaging =
                  await require('./fixtures/railgun-enrolled-transact-staging').qualify({
                    account: opened,
                    owners: { identity: accountIdentity, enrollment, coordinator },
                    archive: accountArchive,
                    proverArchive,
                    artifactDirectory,
                    row: stagingRow,
                    controllerKind: transactControllerKind,
                    observeKeys: (observer) => {
                      spendingReplyObserver = observer;
                    },
                  });
                if (transactControllerKind) {
                  const reservations = await enrollment.openReservations();
                  const capsules = await enrollment.openPrivateCapsules();
                  await reservations.withSigningRecovery(async (records) => {
                    assert.equal(records.length, 1);
                    const entry = records[0].entry;
                    const stored = await capsules.get(entry.id);
                    assert.ok(stored.signature && stored.provedTransaction);
                    retainedTransactController = {
                      id: entry.id,
                      digest: sha(JSON.stringify({ entry, stored })),
                    };
                  });
                }
              } finally {
                stagingGuard = false;
              }
              assert.deepEqual(forbiddenStaging, {
                signerLaunches: transactControllerKind ? 1 : 0,
                spendingKeys: transactControllerKind ? 1 : 0,
                transports: 0,
                rpc: 0,
              });
              transactStaging[transactControllerKind ? 'guardedAttempts' : 'forbiddenAttempts'] = {
                ...forbiddenStaging,
              };
            }
            if (relayPreparationProbe && stage === 30 && attempt === 'restore') {
              assert.equal(unsignedRelayPreparationQualification, undefined);
              unsignedRelayPreparationQualification =
                await require('./fixtures/railgun-relay-preparation-native').qualify({
                  account: opened,
                  owners: { identity: accountIdentity, enrollment, coordinator },
                  archive: accountArchive,
                  signal: opened.signal,
                  profile: path.join(directory, 'profile'),
                  walletDirectory,
                  measure: () =>
                    relayPreparationProbe.measure({
                      applications: applications.length,
                      walletRestores: walletRestores.length,
                    }),
                  jobs: relayPreparationProbe.jobs,
                  rpc: relayPreparationProbe.rpcSnapshot,
                });
            }
            if (exactReviewProbe && stage === 30 && attempt === 'restore') {
              assert.equal(exactRelayReviewQualification, undefined);
              exactRelayReviewQualification =
                await require('./fixtures/railgun-relay-exact-review-native').qualify({
                  scenario: exactReviewFlag,
                  storage: exactReviewProbe.storage,
                  account: opened,
                  owners: { identity: accountIdentity, enrollment, coordinator },
                  archive: accountArchive,
                  profile: path.join(directory, 'profile'),
                  walletDirectory,
                  measure: () =>
                    exactReviewProbe.measure({
                      applications: applications.length,
                      walletRestores: walletRestores.length,
                    }),
                  jobs: exactReviewProbe.jobs,
                  rpc: exactReviewProbe.rpcSnapshot,
                });
            }
            runs.push({
              ...(transactStaging ? { transactStaging } : {}),
              stage,
              attempt,
              mode,
              elapsedMs: performance.now() - started,
              observedAmount: amount.toString(),
              unspentNotes: notes.length,
              instanceMatches: true,
              spendableGranted: false,
              accountWindows,
              privatePreparations,
              privateOperations,
            });
          } finally {
            await opened.close();
          }
          await assert.rejects(opened.view.balance());
          await assert.rejects(opened.view.notes());
          await assert.rejects(opened.view.instanceId());
          runs.at(-1).closedReadsRefused = true;
          console.log(JSON.stringify(runs.at(-1)));
          continue;
        }
        if (attempt === 'rebuild') {
          retainedDirectories.push(walletDirectory);
          generation = await catalog.begin(policy);
          walletDirectory = generation.directory;
        }
        const handle = scope.getContext({ ...subject, role: 'engine' });
        walletSession = startRailgunSessionWorker({
          handle,
          storage: {
            format: 'paged-v2',
            filename: path.join(walletDirectory, 'wallet.sqlite'),
            key: Buffer.alloc(32, 64),
            binding: 'd'.repeat(64),
            create:
              (stage === 10 && attempt === (accountIdentity ? 'scan' : 'interrupt')) ||
              attempt === 'rebuild',
          },
          createProvider: ({ signal }) => ({
            signal,
            request: async () => {
              throw Error('No wallet RPC');
            },
          }),
          onClose: () => {},
        });
        await walletSession.ready;
        if (!generation) {
          const identity = await walletSession.inspectStoreIdentity();
          walletSession.assertFresh(identity);
          assert.equal(identity.instanceId, catalog.activeFor(policy).storeId);
        }
        const coverageStore = createRailgunWalletCoverageStore({
          session: walletSession,
          walletId,
          policy,
          assertScan: runner.assertScan,
        });
        walletJournal = await createRailgunWalletJournal({
          handle: scope.getContext({
            ...subject,
            role: 'storage',
            operation: 'railgun-wallet-v1:' + walletId,
          }),
          directory: walletDirectory,
          key: Buffer.alloc(32, 65),
          binding: 'e'.repeat(64),
          walletId,
          policy,
          storeSession: walletSession,
          coverageStore,
          coordinator,
          assertScan: runner.assertScan,
          create:
            (stage === 10 && attempt === (accountIdentity ? 'scan' : 'interrupt')) ||
            attempt === 'rebuild',
        });
        const started = performance.now(),
          beforeRequests = requests;
        let failure, pending;
        const running = coordinator.withPublicSnapshot(async (snapshot) => {
          if (!restore || attempt === 'restore-pending')
            pending = await walletJournal.prepare(snapshot.checkpoint);
          return runner
            .run({
              handle,
              snapshot,
              walletSession,
              coverageStore,
              walletId,
              restore,
              interruptAfterWalletBatches: attempt === 'interrupt' ? 1 : 0,
            })
            .catch((error) => {
              failure = { closed: error.closed, walletBatches: error.walletBatches };
              throw error;
            });
        });
        if (attempt === 'interrupt' || attempt === 'incomplete-restore') {
          await assert.rejects(running);
          assert.ok(failure?.closed);
          if (attempt === 'interrupt') assert.equal(failure.walletBatches, 1);
          assert.throws(() => coordinator.inspect());
          runs.push({ stage, attempt, refused: true, ...failure });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          await close();
          await open(false);
          assert.equal((await coordinator.recover()).to.number, stage);
          continue;
        }
        let checked = await running;
        if (attempt === 'host-first') {
          await coverageStore.read();
          await assert.rejects(coverageStore.read(checked.value.receipt));
          assert.throws(() => walletJournal.assertReady());
          runs.push({ stage, attempt, refused: true });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          continue;
        }
        const coverage = restore
          ? await coverageStore.read(checked.value.receipt)
          : await coverageStore.write(
              coordinator.assertSnapshot(checked.evidence),
              checked.value.coverage,
              checked.value.receipt
            );
        const state = await walletSession.inspectWalletState();
        let evidence = {
          snapshot: checked.evidence,
          coverage,
          state,
          receipt: checked.value.receipt,
        };
        if (attempt === 'coverage-crash') {
          assert.ok((await walletJournal.readState()).pending);
          assert.throws(() => walletJournal.assertReady());
          runs.push({ stage, attempt, closedBeforeJournalCommit: true });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          continue;
        }
        if (attempt === 'stale-public') {
          await advancePublic({ to: 20, anchor: capture.report.anchor });
          await assert.rejects(walletJournal.complete(pending, evidence));
          assert.throws(() => walletJournal.assertReady());
          runs.push({ stage, attempt, refused: true, publicAdvancedTo: 20 });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          continue;
        }
        if (stage === 20 && !restore) {
          const renewed = await coordinator.withPublicSnapshot(async () => null);
          assert.throws(() => coordinator.assertSnapshot(checked.evidence));
          evidence.snapshot = renewed.evidence;
        }
        if (restore && attempt !== 'restore-pending') await walletJournal.revalidate(evidence);
        else await walletJournal.complete(pending, evidence);
        assert.equal(walletJournal.assertReady().status, 'wallet-scanned-unverified');
        assert.equal(walletJournal.assertReady().spendableGranted, false);
        if (generation) {
          await catalog.publish(generation, walletJournal);
          generation = null;
          assert.equal(catalog.activeFor(policy).directory, walletDirectory);
        }
        assert.ok(
          retainedDirectories.every((dir) => fs.existsSync(path.join(dir, 'wallet.sqlite')))
        );
        let view = require('../src/main/wallet/railgun-kohaku-read').createRailgunKohakuRead({
          runner,
          journal: walletJournal,
          receipt: checked.value.receipt,
        });
        assert.throws(() =>
          require('../src/main/wallet/railgun-kohaku-read').createRailgunKohakuRead({
            runner,
            journal: walletJournal,
            receipt: {},
          })
        );
        const originalValue = checked.value.result.received[0].value;
        checked.value.result.received[0].value = '999999999';
        const balances = await view.balance(),
          notes = await view.notes();
        assert.equal(
          balances.reduce((sum, item) => sum + item.amount, 0n),
          stage === 10 ? 3000n : stage === 20 ? 2000n : 2700n
        );
        checked.value.result.received[0].value = originalValue;
        assert.ok(
          balances.every((item) => item.tag === 'unverified' && item.asset.__type === 'erc20')
        );
        assert.equal(notes.length, stage === 10 ? 2 : stage === 20 ? 1 : 2);
        assert.equal((await view.notes(undefined, true)).length, stage === 30 ? 3 : 2);
        assert.equal((await view.balance([{ __type: 'native' }])).length, 0);
        assert.equal(await view.instanceId(), checked.value.result.instanceId);
        assert.equal((await view.status()).spendableGranted, false);
        assert.equal(view.prepareTransfer, undefined);
        const kohakuReads = {
          unspentNotes: notes.length,
          observedAmount: balances.reduce((sum, item) => sum + item.amount, 0n).toString(),
          tag: 'unverified',
          spendableGranted: false,
        };
        // The non-enrolled vault composition keeps the actual coverage store
        // visible so this qualifier can exercise two additional read-only
        // windows and journal re-attestation without adding a product API.
        if (accountIdentity && attempt === 'restore') {
          const readOnlyWindows = [];
          const beforeReadOnly = await walletSession.inspectWalletState();
          for (let windowIndex = 0; windowIndex < 2; windowIndex++) {
            const previousView = view,
              previousReceipt = checked.value.receipt;
            const renewed = await coordinator.withPublicSnapshot(async (snapshot) => {
              await assert.rejects(previousView.balance());
              return runner.restoreReadOnly({
                handle,
                snapshot,
                walletSession,
                coverageStore,
                walletId,
              });
            });
            const renewedCoverage = await coverageStore.read(renewed.value.receipt);
            const renewedState = await walletSession.inspectWalletState();
            assert.deepEqual(renewedState, beforeReadOnly);
            evidence = {
              snapshot: renewed.evidence,
              coverage: renewedCoverage,
              state: renewedState,
              receipt: renewed.value.receipt,
            };
            await walletJournal.revalidate(evidence);
            assert.throws(() => walletJournal.assertReceipt(previousReceipt));
            await assert.rejects(previousView.balance());
            checked = renewed;
            view = require('../src/main/wallet/railgun-kohaku-read').createRailgunKohakuRead({
              runner,
              journal: walletJournal,
              receipt: checked.value.receipt,
            });
            assert.equal(
              (await view.balance()).reduce((sum, item) => sum + item.amount, 0n).toString(),
              kohakuReads.observedAmount
            );
            assert.deepEqual(checked.value.readOnly, { readOnly: true, writeAttempts: 0 });
            readOnlyWindows.push({
              ...checked.value.readOnly,
              previousReceiptRefused: true,
              previousViewRefused: true,
              walletBytesUnchanged: true,
              journalRevalidated: true,
            });
          }
          kohakuReads.readOnlyWindows = readOnlyWindows;
        }
        await assert.rejects(coverageStore.read(checked.value.receipt));
        assert.throws(() => walletJournal.assertReady());
        await assert.rejects(view.balance());
        await assert.rejects(view.notes());
        await assert.rejects(view.instanceId());
        kohakuReads.staleReadsRefused = true;
        const result = { evidence: evidence.snapshot, value: checked.value.result };
        assert.equal(coordinator.assertSnapshot(result.evidence).to.number, stage);
        previousEvidence = result.evidence;
        assert.equal(result.value.scannedLeaves, stage === 30 ? 3 : 2);
        assert.equal(result.value.received.length, stage === 30 ? 3 : 2);
        assert.equal(
          result.value.received.filter((note) => note.spentTxid !== false).length,
          stage >= 20 ? 1 : 0
        );
        assert.equal(
          result.value.received
            .filter((note) => note.spentTxid === false)
            .reduce((total, note) => total + BigInt(note.value), 0n)
            .toString(),
          stage === 10 ? '3000' : stage === 20 ? '2000' : '2700'
        );
        assert.equal(result.value.sent.length, stage === 30 ? 1 : 0);
        assert.equal(result.value.spendableGranted, false);
        runs.push({
          stage,
          attempt,
          restore,
          kohakuReads,
          renewedSameCheckpoint: stage === 20 && !restore,
          elapsedMs: Math.round(performance.now() - started),
          sourceHeaderRequests: requests - beforeRequests,
          // The scan now carries an internal owned-note projection. Keep that
          // projection out of reports, even for this public synthetic fixture.
          // An allowlist also excludes future private fields added by the SDK.
          ...Object.fromEntries(
            [
              'instanceId',
              'scannedLeaves',
              'expectedReceived',
              'expectedSent',
              'quarantine',
              'unrecoverableSent',
              'received',
              'sent',
              'spendableGranted',
              'inventory',
              'guards',
              'poiCalls',
              'electron',
              'closed',
            ].map((key) => [key, result.value[key]])
          ),
          ownedProjection: {
            count: result.value.ownedPoi.length,
            types: [...new Set(result.value.ownedPoi.map((note) => note.type))].sort(),
            fieldChecksPassed: true,
          },
        });
        console.log(
          JSON.stringify({
            restore,
            elapsedMs: runs.at(-1).elapsedMs,
            scannedLeaves: result.value.scannedLeaves,
          })
        );
        walletJournal.close();
        walletSession.close();
        await walletSession.closed;
      }
    }
    if (enrollment) {
      const openWallet = (mode) =>
        require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
          identity: accountIdentity,
          enrollment,
          archive: accountArchive,
          coordinator,
          policy,
          mode,
        });
      const interruptedRestore = await openWallet('active');
      failReadOnlyRestore = true;
      await assert.rejects(
        require('../src/main/wallet/railgun-account-wallet').restoreRailgunAccountWallet(
          interruptedRestore,
          { identity: accountIdentity, enrollment, coordinator }
        )
      );
      assert.equal(failReadOnlyRestore, false);
      assert.equal(interruptedRestore.signal.aborted, true);
      assert.equal(coordinator.signal.aborted, true);
      await assert.rejects(interruptedRestore.view.balance());
      await interruptedRestore.close();
      await close();
      await open(false);
      assert.equal((await coordinator.recover()).to.number, 30);
      const restoredAfterInterruption = await openWallet('active');
      try {
        assert.equal((await restoredAfterInterruption.view.balance())[0].amount, 2700n);
      } finally {
        await restoredAfterInterruption.close();
      }
      runs.push({
        attempt: 'read-only-window-interruption',
        accountClosed: true,
        publicCoordinatorClosed: true,
        coldRecovery: true,
        observedAmount: '2700',
      });
      failPublication = true;
      await assert.rejects(openWallet('new'), /Injected publication interruption/);
      assert.equal(failPublication, false);
      const pending = (await catalog.inspect()).pending;
      assert.ok(pending);
      const before = walletRestores.length;
      await assert.rejects(openWallet('new'));
      assert.equal((await catalog.inspect()).pending.id, pending.id);
      assert.equal(walletRestores.length, before);
      const recovered = await openWallet('pending');
      try {
        assert.equal(walletRestores.at(-1), true);
        assert.equal((await recovered.view.balance())[0].amount, 2700n);
      } finally {
        await recovered.close();
      }
      runs.push({
        attempt: 'journal-complete-before-publication',
        pendingPreserved: true,
        restored: true,
        observedAmount: '2700',
      });
      await advancePublic({ to: 40, anchor: capture.report.anchor });
      failWalletBatch = true;
      await assert.rejects(openWallet('advance'));
      assert.equal(failWalletBatch, false);
      await close();
      enrollment.close();
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity: accountIdentity }
        );
      await open(false);
      await coordinator.recover();
      const beforeActive = walletRestores.length;
      await assert.rejects(openWallet('active'));
      assert.equal(walletRestores.length, beforeActive);
      const advanced = await openWallet('advance');
      let recoveredThrough;
      try {
        assert.equal((await advanced.view.balance())[0].amount, 2700n);
        recoveredThrough = (await advanced.view.status()).to.number;
        assert.equal(recoveredThrough, 40);
        assert.equal(walletRestores.at(-1), false);
      } finally {
        await advanced.close();
      }
      runs.push({
        attempt: 'interrupted-advance',
        activeRefusedPending: true,
        recoveredThrough,
        observedAmount: '2700',
      });
      const obsolete = await catalog.begin('f'.repeat(64));
      await assert.rejects(openWallet('pending'));
      const replacement = await openWallet('new');
      try {
        assert.notEqual(replacement.generationId, obsolete.id);
        assert.ok(fs.statSync(obsolete.directory).isDirectory());
        assert.equal((await replacement.view.balance())[0].amount, 2700n);
      } finally {
        await replacement.close();
      }
      runs.push({
        attempt: 'obsolete-policy-candidate',
        oldDirectoryRetained: true,
        pendingRefused: true,
        newGenerationPublished: true,
        observedAmount: '2700',
      });
      for (let n = 0; n < 12; n++) {
        const rebuilt = await openWallet('new');
        try {
          assert.equal((await rebuilt.view.balance())[0].amount, 2700n);
          assert.equal((await rebuilt.view.status()).to.number, 40);
        } finally {
          await rebuilt.close();
        }
      }
      const retention = await catalog.inspectRetention();
      assert.ok(retention.retired.length >= 8 && retention.listed <= 8);
      for (const id of retention.retired)
        assert.ok(
          fs.statSync(path.join(enrollment.directory, 'railgun-cache-' + id)).isDirectory()
        );
      enrollment.profileGuard.assert(path.join(enrollment.directory, 'source.sqlite'));
      runs.push({
        attempt: 'successive-cache-rebuilds',
        rebuilds: 12,
        retiredGenerations: retention.retired.length,
        listedGenerations: retention.listed,
        retiredDirectoriesRetained: true,
        observedAmount: '2700',
      });
      failPublication = true;
      await assert.rejects(openWallet('new'), /Injected publication interruption/);
      assert.equal(failPublication, false);
      const stranded = (await catalog.inspect()).pending;
      const strandedDirectory = path.join(enrollment.directory, 'railgun-cache-' + stranded.id);
      const strandedHashes = Object.fromEntries(
        fs
          .readdirSync(strandedDirectory)
          .filter((name) => name.endsWith('.json') || name === 'wallet.sqlite')
          .map((name) => [name, sha(fs.readFileSync(path.join(strandedDirectory, name)))])
      );
      const previousWalletPolicy = policy;
      const previousPublicId = publicAccount.generationId;
      const previousPublicDirectory = path.join(
        enrollment.directory,
        'railgun-public-' + previousPublicId
      );
      const retainedFiles = fs
        .readdirSync(previousPublicDirectory)
        .filter(
          (name) => name.endsWith('.json') || name === 'source.sqlite' || name === 'public.sqlite'
        );
      await close();
      const retainedHashes = Object.fromEntries(
        retainedFiles.map((name) => [
          name,
          createHash('sha256')
            .update(fs.readFileSync(path.join(previousPublicDirectory, name)))
            .digest('hex'),
        ])
      );
      await open(false, 'new');
      const candidatePublicId = publicAccount.generationId;
      assert.notEqual(candidatePublicId, previousPublicId);
      await advancePublic({ to: 10, anchor: capture.report.anchor });
      await assert.rejects(openWallet('new')); // Candidate below the durable floor has no wallet authority.
      await close();
      await open(false, 'pending');
      assert.equal(publicAccount.generationId, candidatePublicId);
      await coordinator.recover();
      assert.equal(coordinator.inspect().to.number, 10);
      await advancePublic({ to: 20, anchor: capture.report.anchor });
      await advancePublic({ to: 30, anchor: capture.report.anchor });
      // Finish the journal but intentionally omit catalog publication, then cold resume.
      await coordinator.advance({ to: 40, anchor: capture.report.anchor });
      await close();
      await open(false, 'pending');
      await publicAccount.publish();
      assert.equal(coordinator.inspect().to.number, 40);
      policy = require('../src/main/wallet/railgun-account-wallet').getRailgunAccountWalletPolicy({
        archive: accountArchive,
        enrollment,
        coordinator,
      });
      assert.notEqual(policy, previousWalletPolicy);
      await assert.rejects(openWallet('active'));
      await assert.rejects(openWallet('pending'));
      const rebuiltPublicWallet = await openWallet('new');
      try {
        assert.equal((await rebuiltPublicWallet.view.balance())[0].amount, 2700n);
        assert.equal((await rebuiltPublicWallet.view.status()).to.number, 40);
      } finally {
        await rebuiltPublicWallet.close();
      }
      for (const [name, hash] of Object.entries(strandedHashes))
        assert.equal(sha(fs.readFileSync(path.join(strandedDirectory, name))), hash);
      for (const [name, hash] of Object.entries(retainedHashes))
        assert.equal(
          createHash('sha256')
            .update(fs.readFileSync(path.join(previousPublicDirectory, name)))
            .digest('hex'),
          hash
        );
      enrollment.profileGuard.assert(path.join(previousPublicDirectory, 'source.sqlite'));
      runs.push({
        attempt: 'interrupted-public-generation-rebuild',
        belowFloorWalletRefused: true,
        pendingResumedThrough: 10,
        completeBeforePublicationRecovered: true,
        oldWalletRefusedAfterCutover: true,
        strandedPendingRefusedAfterCutover: true,
        strandedPendingFilesUnchanged: true,
        effectiveWalletPolicyChanged: true,
        oldPublicFilesUnchanged: true,
        observedAmount: '2700',
        recoveredThrough: 40,
      });
      await close();
      await open(false);
      await coordinator.recover();
      assert.equal(
        require('../src/main/wallet/railgun-account-wallet').getRailgunAccountWalletPolicy({
          archive: accountArchive,
          enrollment,
          coordinator,
        }),
        policy
      );
      const restoredPublicWallet = await openWallet('active');
      try {
        assert.equal((await restoredPublicWallet.view.balance())[0].amount, 2700n);
      } finally {
        await restoredPublicWallet.close();
      }
      runs.push({
        attempt: 'public-generation-cold-restore',
        observedAmount: '2700',
        recoveredThrough: 40,
      });
    }
    if (enrollment) {
      const walletCatalogFile = getPrivacyStoragePath(
        enrollment.getContext('storage', 'railgun-wallet-catalog-v1:' + walletId),
        enrollment.directory
      );
      for (const [name, hash] of legacyHashes) {
        // The existing wallet catalog legitimately changes during wallet rebuilds.
        if (path.join(enrollment.directory, name) === walletCatalogFile) continue;
        assert.equal(sha(fs.readFileSync(path.join(enrollment.directory, name))), hash);
      }
      runs.push({
        attempt: 'legacy-public-policy-upgrade',
        oldPolicy: 'e'.repeat(64),
        authenticatedHeight: 10,
        readOnlyInspectionPreservedInventory: true,
        legacySourcePublicJournalUnchanged: true,
      });
      const reservations = await enrollment.openReservations();
      const retainedControllerSigning = transactControllerKind ? 1 : 0;
      const retainedController = retainedTransactController;
      assert.equal(!!retainedController, !!transactControllerKind);
      if (retainedControllerSigning) {
        const capsules = await enrollment.openPrivateCapsules();
        await reservations.withSigningRecovery(async (records) => {
          assert.equal(records.length, 1);
          const entry = records[0].entry;
          const stored = await capsules.get(entry.id);
          assert.ok(stored.signature && stored.provedTransaction);
          assert.equal(entry.id, retainedController.id);
          assert.equal(sha(JSON.stringify({ entry, stored })), retainedController.digest);
        });
      }
      assert.deepEqual(await reservations.inspect(), {
        held: 1,
        signing: retainedControllerSigning,
        abandoned: 0,
        legacy: 0,
      });
      await assert.rejects(reservations.reserve(reservationInput), {
        code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
      });
      runs.push({
        attempt: 'account-reservations',
        syntheticInputFacts: true,
        held: 1,
        enrollmentReopenPreserved: true,
        cacheRebuildPreserved: true,
        duplicateRefused: true,
        oldReceiptRefused: true,
        signingEnabled: false,
      });
      const recoveryInput = Object.freeze({
        tree: reservationInput.tree,
        position: reservationInput.position,
        nullifier: reservationInput.nullifier,
        noteHash: reservationInput.noteHash,
      });
      const recoveryWallet =
        await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
          identity: accountIdentity,
          enrollment,
          archive: accountArchive,
          coordinator,
          mode: 'active',
        });
      try {
        await assert.rejects(reservations.abandonRecovered(recoveryInput), {
          code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
        });
        assert.deepEqual(await reservations.inspect(), {
          held: 1,
          signing: retainedControllerSigning,
          abandoned: 0,
          legacy: 0,
        });
      } finally {
        await recoveryWallet.close();
      }
      await reservations.abandonRecovered(recoveryInput);
      assert.deepEqual(await reservations.inspect(), {
        held: 0,
        signing: retainedControllerSigning,
        abandoned: 1,
        legacy: 0,
      });
      const replacement = await reservations.reserve(reservationInput);
      const signingEvidence = Object.freeze({
        submitter: '0x' + '7'.repeat(40),
        operationId: '8'.repeat(64),
        gatesDigest: '9'.repeat(64),
      });
      const capsuleStore = await enrollment.openPrivateCapsules();
      const savedCapsule = await capsuleStore.put(
        replacement,
        reservationCapsule,
        signingEvidence.gatesDigest
      );
      const signingReceipt = await capsuleStore.markSigning(replacement, signingEvidence);
      assert.equal((await reservations.assertReceipt(signingReceipt)).state, 'signing');
      const signedEvidence = (await reservations.assertReceipt(signingReceipt)).signing;
      assert.equal(signedEvidence.submitter, signingEvidence.submitter);
      assert.equal(signedEvidence.operationId, signingEvidence.operationId);
      assert.notEqual(signedEvidence.gatesDigest, signingEvidence.gatesDigest);
      await assert.rejects(reservations.assertReceipt(replacement));
      await assert.rejects(reservations.abandon(signingReceipt));
      await close();
      enrollment.close();
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          {
            identity: accountIdentity,
          }
        );
      const recoveredReservations = await enrollment.openReservations();
      const recoveredCapsules = await enrollment.openPrivateCapsules();
      assert.deepEqual(await recoveredCapsules.get(savedCapsule.holdId), savedCapsule);
      let recoveryReceipt;
      await recoveredReservations.withSigningRecovery(async (records, recoveryContext) => {
        recoveryContext.assertCurrent();
        assert.equal(records.length, retainedControllerSigning + 1);
        if (retainedController) {
          const entry = records.find((record) => record.entry.id === retainedController.id)?.entry;
          assert.ok(entry);
          const stored = await recoveredCapsules.get(entry.id);
          assert.equal(sha(JSON.stringify({ entry, stored })), retainedController.digest);
        }
        recoveryReceipt = records.find((record) => record.entry.id === savedCapsule.holdId).receipt;
        recoveredReservations.assertReceiptContext(recoveryReceipt, 'recovery');
        assert.equal(
          (await recoveredReservations.assertReceipt(recoveryReceipt)).id,
          savedCapsule.holdId
        );
      });
      await assert.rejects(recoveredReservations.assertReceipt(recoveryReceipt));
      await assert.rejects(recoveredReservations.assertReceipt(signingReceipt));
      await assert.rejects(recoveredReservations.abandonRecovered(recoveryInput), {
        code: 'RAILGUN_RESERVATION_NOT_RECOVERABLE',
      });
      await assert.rejects(recoveredReservations.reserve(reservationInput), {
        code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
      });
      assert.deepEqual(await recoveredReservations.inspect(), {
        held: 0,
        signing: retainedControllerSigning + 1,
        abandoned: 1,
        legacy: 0,
      });
      await open(false);
      runs.push({
        attempt: 'reservation-lifecycle',
        capsulePersistedBeforeSigning: true,
        capsulePreservedOnReopen: true,
        recoveryReceiptRevokedAfterPhase: true,
        gatesDigestBindsCapsule: true,
        syntheticInputFacts: true,
        syntheticSigningEvidence: true,
        liveWalletBlockedRecovery: true,
        drainedWalletAllowedHeldRecovery: true,
        abandonedInputReservedAgain: true,
        oldHeldReceiptRefused: true,
        signingReceiptRequiresCurrentStore: true,
        signingStatePreservedOnReopen: true,
        signingStateCannotBeAbandoned: true,
        lifecycleSigningKeyReleased: false,
        additionalControllerSigningPreserved: !!retainedController,
      });
    }
    if (kohaku) {
      const account =
        await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
          identity: accountIdentity,
          enrollment,
          archive: accountArchive,
          coordinator,
          mode: 'active',
        });
      try {
        kohakuQualification = await kohaku.qualify({
          outputDirectory: directory,
          account,
          owners: { identity: accountIdentity, enrollment, coordinator },
          archive: accountArchive,
          proverArchive,
          artifactDirectory,
          row: stagingRow,
          observeKeys: (observer) => {
            spendingReplyObserver = observer;
          },
          readKeyCounts: () => ({ privateViewingKeys, privateReceiveKeys }),
          measureResources: () => contractResources.snapshot(),
        });
      } finally {
        await account.close();
      }
    }
    if (process.env.FREEDOM_RAILGUN_PRIVATE_OPERATION) {
      const kind = process.env.FREEDOM_RAILGUN_PRIVATE_OPERATION;
      assert.ok(
        enrollment &&
          proverArchive &&
          ['railgun-private-transfer', 'railgun-token-unshield'].includes(kind)
      );
      const account =
        await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
          identity: accountIdentity,
          enrollment,
          archive: accountArchive,
          coordinator,
          mode: 'active',
        });
      try {
        productionPrivateOperation = await require('./fixtures/railgun-enrolled-signing').qualify({
          account,
          owners: { identity: accountIdentity, enrollment, coordinator },
          archive: accountArchive,
          proverArchive,
          artifactDirectory,
          kind,
          observeKeys: (observer) => {
            spendingReplyObserver = observer;
          },
        });
      } finally {
        await account.close();
      }
    }
    assert.equal(applications.length, enrollment ? 10 : 3);
    if (accountIdentity) {
      const handle = scope.getContext({ ...subject, role: 'engine' });
      walletSession = startRailgunSessionWorker({
        handle,
        storage: {
          format: 'paged-v2',
          filename: path.join(directory, 'cancel-wallet.sqlite'),
          key: Buffer.alloc(32, 64),
          binding: 'd'.repeat(64),
          create: true,
        },
        createProvider: ({ signal }) => ({
          signal,
          request: async () => {
            throw Error('No wallet RPC');
          },
        }),
        onClose: () => {},
      });
      await walletSession.ready;
      const cancelledCoverage = createRailgunWalletCoverageStore({
        session: walletSession,
        walletId,
        policy,
        assertScan: runner.assertScan,
      });
      lockOnViewingKey = true;
      await assert.rejects(
        coordinator.withPublicSnapshot((snapshot) =>
          runner.run({
            handle,
            snapshot,
            walletSession,
            coverageStore: cancelledCoverage,
            walletId,
            restore: false,
          })
        ),
        { code: 'RAILGUN_SCAN_COORDINATOR_REFUSED' }
      );
      assert.ok(cancelledViewingClosed);
      await cancelledViewingClosed;
      assert.equal(vault.isUnlocked(), false);
      assert.equal(accountIdentity.signal.aborted, true);
      assert.equal(cancelledViewingMessages, 1);
      assert.equal(
        cancelledViewingProcessClosed,
        true,
        JSON.stringify({
          closed: cancelledViewingProcess,
          keyProduced: !!cancelledViewingKey,
          vaultUnlocked: vault.isUnlocked(),
        })
      );
      assert.ok(
        cancelledViewingKey instanceof Uint8Array && cancelledViewingKey.every((v) => v === 0)
      );
      walletSession.close();
      await walletSession.closed;
    }
    if (kohaku) {
      assert.deepEqual(
        readContracts.map((entry) => entry.calls),
        [11, 11, 11, 11, 13, 13, 13, 13]
      );
      assert.ok(contractResources.snapshot().utilityStarts > 0);
      assert.ok(contractResources.snapshot().workerStarts > 0);
      if (privateAdapterMode) {
        assert.equal(kohakuQualification.privateAdapter.reads.calls, 13);
        assert.equal(kohakuQualification.privateAdapter.closedReadRefusals.calls, 3);
        assert.equal(
          kohakuQualification.privateAdapter.forwarding.checkedCalls,
          privateAdapterDenied ? 0 : 1
        );
        if (!privateAdapterDenied)
          assert.equal(kohakuQualification.privateAdapter.preparedReadRefusals.calls, 3);
        assert.equal(kohakuQualification.productionRestrictedPrivateHost, true);
        assert.equal(kohakuQualification.productionRestrictedPrivateAdapter, true);
        assert.equal(kohakuQualification.genericHostQualified, false);
      } else if (publicAdapterMode) {
        const adapter = kohakuQualification.publicAdapterQualification;
        assert.equal(adapter.readyReads.calls, 13);
        assert.equal(adapter.preparedReads.calls, 3);
        assert.equal(adapter.closedReads.calls, 3);
        assert.equal(adapter.readyReads.genuineOwnedSnapshotCompared, true);
        assert.equal(adapter.readyReads.detachedMutationIsolation, true);
        for (const reads of [adapter.readyReads, adapter.preparedReads, adapter.closedReads])
          assert.equal(reads.noAdditionalMeasuredWork, true);
        assert.equal(adapter.readyReads.eligibilityGranted, false);
        assert.equal(adapter.readyReads.genericHostQualified, false);
        assert.equal(adapter.originalSettlement.originalValueOrErrorIdentity, true);
        assert.equal(adapter.originalSettlement.genuinePublicFacadeTokenDistinct, true);
        assert.equal(
          adapter.originalSettlement.acknowledgedValueEqualsRequest,
          process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE === 'acknowledged'
        );
        assert.equal(
          adapter.originalSettlement.journalErrorCode,
          process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE === 'lost-response'
            ? 'PRIVATE_BROADCAST_UNCERTAIN'
            : null
        );
        assert.equal(
          adapter.originalSettlement.canonicalUncertaintyHash,
          process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE === 'lost-response'
        );
        assert.equal(adapter.genuineAdoptingHost, true);
        assert.equal(adapter.readyOnlyReads, true);
        assert.equal(adapter.originalPublicErrorsRemainRejected, true);
        assert.equal(adapter.privateOutcomeUnionUsed, false);
        assert.equal(adapter.facadeInternalsExposed, false);
        assert.equal(adapter.sourceDerivedNoAdditionalRpcKeysJobs, true);
        assert.equal(
          adapter.heldOutwardBeforeCallbackRelease,
          process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE === 'review-cancelled'
        );
        assert.equal(
          adapter.originalSettlement.status,
          process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE === 'acknowledged'
            ? 'fulfilled'
            : 'rejected'
        );
        assert.deepEqual(
          adapter.originalSettlement.fields,
          process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE === 'acknowledged'
            ? {
                broadcastSource: 'string',
                chainId: 'number',
                explorerUrl: 'object',
                from: 'string',
                hash: 'string',
                nonce: 'number',
                to: 'string',
                value: 'string',
              }
            : process.env.FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE === 'lost-response'
              ? { code: 'string', submissionStatus: 'string', transactionHash: 'string' }
              : { code: 'string' }
        );
        assert.deepEqual(kohakuQualification.contract.reads, []);
        assert.equal(kohakuQualification.contract.forwarding.checkedCalls, 1);
      } else {
        require('./fixtures/railgun-kohaku-contract-conformance').assertInstanceReadVector(
          kohakuQualification.contract.reads,
          {
            lane: publicShield ? 'public' : 'private',
            heldReview: process.env.FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW === '1',
          }
        );
        assert.equal(kohakuQualification.contract.forwarding.checkedCalls, 1);
      }
    }
    nativeAssertions.assertEmpty();
    if (snapshotProbe) assert.equal(snapshotAdapterQualification?.instances, 1);
    if (localReviewProbe) assert.equal(localRelayReviewQualification?.admittedQuoteJobs, 3);
    if (relayPreparationProbe)
      assert.equal(unsignedRelayPreparationQualification?.relayRestores, 2);
    if (exactReviewProbe) assert.equal(exactRelayReviewQualification?.relayRestores, 2);
    assert.deepEqual(hashes(), sourceSha256);
    assert.doesNotMatch(JSON.stringify(runs), /"(?:ownedPoi|npk|nullifier|blindedCommitment)"\s*:/);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          ...(snapshotProbe ? { snapshotAdapterQualification } : {}),
          ...(localReviewProbe ? { localRelayReviewQualification } : {}),
          ...(relayPreparationProbe ? { unsignedRelayPreparationQualification } : {}),
          ...(exactReviewProbe ? { exactRelayReviewQualification } : {}),
          syntheticPublicHistory: true,
          liveAcquisition: false,
          publicViewingVector: true,
          vaultBoundAccount: !!accountIdentity,
          enrolledWalletComposition: !!enrollment,
          authenticatedPublicJobs: !!enrollment,
          enrolledPublicComposition: !!enrollment,
          privateOperationJobs,
          productionPrivateOperation,
          ...(kohaku
            ? {
                kohakuQualification,
                readContracts,
                contractResourceActivity: contractResources.snapshot(),
              }
            : {}),
          ...(publicShield ? { sourceInventoryIsExecutionCoverage: false } : {}),
          cancelledViewingProcess,
          cancelledViewingMessages: accountIdentity ? cancelledViewingMessages : null,
          viewingKeyTransferCancelled: accountIdentity ? cancelledViewingProcessClosed : null,
          cancelledViewingKeyWiped: accountIdentity
            ? cancelledViewingKey.every((v) => v === 0)
            : null,
          independentEngineIdentityMatches: !!accountIdentity,
          walletCoverageGranted: true,
          receiptReplayRefused: enrollment ? null : true,
          durableJournal: true,
          generationSwap: true,
          explicitlyCheckedRebuildDirectories: retainedDirectories.length,
          spendableGranted: false,
          submissions: 0,
          anchor: capture.report.anchor,
          logSetSha256: capture.logSetSha256,
          ...(stagingQualification || kohaku?.inputType === 'Transact'
            ? {
                originalInputSha256: sha(originalSourceBytes),
                derivedInputSha256: sha(sourceBytes),
                derivedCreatorHistory: true,
              }
            : {}),
          requests,
          applications,
          publicPolicy: enrollment ? publicAccount.policy : null,
          runs,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    const cleanup = async (label, run) => {
      try {
        await run();
      } catch (error) {
        nativeAssertions.record(error, 'wallet-journal.' + label);
      }
    };
    await cleanup('walletJournal.close', () => walletJournal?.close());
    await cleanup('walletSession.close', () => walletSession?.close());
    await cleanup('walletSession.closed', () => walletSession?.closed);
    await cleanup('publicOwners.close', close);
    await cleanup('enrollment.close', () => enrollment?.close());
    await cleanup('identity.close', () => accountIdentity?.close());
    await cleanup('vault.lock', () => vault?.lockVault());
    await cleanup('kohaku.close', () => kohaku?.close());
    await cleanup('runtime.restore', () => restoreContractRuntime?.());
    await cleanup('meter.close', () => contractResources?.close());
    nativeAssertions.assertEmpty();
  }
}
main().then(
  () => {
    if (qualificationLock) releaseProfileLock(qualificationLock);
    app.exit(0);
  },
  (error) => {
    console.error(error.stack);
    if (qualificationLock) releaseProfileLock(qualificationLock);
    app.exit(1);
  }
);
