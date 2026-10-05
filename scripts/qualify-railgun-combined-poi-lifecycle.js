/** Offline actual partial EOA submission through durable combined POI over genuinely scanned, disposable
 * enrolled accounts. Service/RPC responses and list signing trust are fixtures;
 * account, POI/preflight hosts, reservations, signer and A/B/C are production.
 * electron scripts/qualify-railgun-combined-poi-lifecycle.js SOURCE NEW_DIRECTORY ENGINE PROVER ARTIFACTS BYTECODES [Shield|Transact] [change|second-spend|second-spend-ingest|restart-setup|restart-resume|restart-prove-stop|restart-cold-submit|restart-cold-submit-lost|restart-sign-stop|restart-recover-stop|restart-recovered-submit|restart-recovered-submit-lost|facade-second-spend-ingest]
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const sticky = require('./fixtures/railgun-native-assertions');
const { assert } = sticky;
const lifecycle = require('./fixtures/railgun-combined-poi-lifecycle');
const audit = lifecycle.createAudit();
const { createHash, randomUUID } = require('crypto');
const restartData = require('./fixtures/railgun-combined-poi-restart-data');
const { Interface, Transaction } = require('ethers');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const OFFSET = 5944700;
let lock,
  phase = 'setup',
  sealRestart;
async function bounded(work, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Fixture drain exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length >= 6 && args.length <= 8);
  const changeMode = args.length === 8;
  if (changeMode)
    assert.ok(
      [
        'change',
        'second-spend',
        'second-spend-ingest',
        'restart-setup',
        'restart-resume',
        'restart-prove-stop',
        'restart-sign-stop',
        'restart-recover-stop',
        'restart-recovered-submit',
        'restart-recovered-submit-lost',
        'restart-cold-submit',
        'restart-cold-submit-lost',
        'facade-second-spend-ingest',
      ].includes(args[7])
    );
  const facadeMode = args[7] === 'facade-second-spend-ingest';
  const restartSetup = args[7] === 'restart-setup';
  const proveStop = args[7] === 'restart-prove-stop';
  const signStop = args[7] === 'restart-sign-stop';
  const recoverStop = args[7] === 'restart-recover-stop';
  const recoveredSubmit = ['restart-recovered-submit', 'restart-recovered-submit-lost'].includes(
    args[7]
  );
  const stopWithoutSubmission = proveStop || signStop || recoverStop;
  const coldLost =
    args[7] === 'restart-cold-submit-lost' || args[7] === 'restart-recovered-submit-lost';
  const coldSubmit = args[7] === 'restart-cold-submit' || coldLost || recoveredSubmit;
  const restartResume =
    args[7] === 'restart-resume' || proveStop || signStop || recoverStop || coldSubmit;
  const terminalMode =
    args[7] === 'second-spend-ingest' || (restartResume && !stopWithoutSubmission) || facadeMode;
  const secondSpendMode = args[7] === 'second-spend' || terminalMode;
  const [sourceFilename, directory, archive, proverArchive, artifactDirectory, bytecodes] = args;
  const inputCreator = args[6] ?? 'Shield';
  assert.ok(['Shield', 'Transact'].includes(inputCreator));
  const testCase = coldLost ? 'lost-reply' : 'acknowledged';
  const transact = inputCreator === 'Transact';
  assert.ok(args.slice(0, 6).every((value) => path.isAbsolute(value)));
  assert.equal(fs.existsSync(directory), restartResume);
  const restored = restartResume
    ? (recoverStop
        ? require('./fixtures/railgun-combined-poi-second-recovery-data').loadSigned
        : recoveredSubmit
          ? require('./fixtures/railgun-combined-poi-second-recovery-data').loadRecovered
          : coldSubmit
            ? require('./fixtures/railgun-combined-poi-second-handoff').load
            : restartData.load)(directory, { inputCreator })
    : undefined;
  const runID = restored?.handoff.runID ?? randomUUID();
  const reportFilename = path.join(
    directory,
    signStop
      ? 'second-sign-report.json'
      : recoverStop
        ? 'second-recover-report.json'
        : proveStop
          ? 'second-prove-report.json'
          : coldSubmit
            ? 'second-submit-report.json'
            : restartResume
              ? 'restart-report.json'
              : 'report.json'
  );
  assert.equal(fs.existsSync(reportFilename), false);
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
  if (!restartResume) fs.mkdirSync(directory, { mode: 0o700 });
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
      ...(() => {
        const files = [];
        const visit = (directory) => {
          for (const name of fs.readdirSync(directory).sort()) {
            const file = path.join(directory, name),
              info = fs.lstatSync(file);
            assert.equal(info.isSymbolicLink(), false);
            if (info.isDirectory()) visit(file);
            else if (/\.(js|json|mjs)$/.test(name)) files.push(file);
          }
        };
        visit(path.join(__dirname, '../src/main'));
        return files;
      })(),
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
  const runtimes =
    restartSetup || restartResume || facadeMode
      ? restartData.runtimeHashes({
          archive,
          proverArchive,
          artifactDirectory,
          bytecodes,
        })
      : undefined;
  if (restartResume) {
    assert.deepEqual(sourceHashes, restored.handoff.sourceHashes);
    assert.deepEqual(runtimes, restored.handoff.runtimes);
    assert.equal(sha(sourceBytes), restored.handoff.sourceSha256);
    assert.deepEqual(restartData.profileSnapshot(directory), restored.handoff.files);
  }
  const coldStorage = restartResume
    ? require('./fixtures/railgun-combined-poi-restart-storage').install({
        directory,
        phase: () => phase,
      })
    : undefined;
  const runtime = require('../src/main/wallet/railgun-process');
  const originalStart = runtime.startRailgunProcess;
  const sessionModule = require('../src/main/wallet/railgun-session-worker');
  const originalSession = sessionModule.startRailgunSessionWorker;
  const originalReadOnlySession = sessionModule.startRailgunReadOnlySessionWorker;
  const workers = new Set(),
    workerResults = [];
  let workerStarts = 0;
  const trackWorker = (start, readOnly) => (options) => {
    workerStarts++;
    const worker = start(options);
    workers.add(worker);
    sticky.observeClosed(
      worker.closed,
      (result) => {
        assert.ok(Number.isInteger(result.exitCode));
        workers.delete(worker);
        workerResults.push({ readOnly, ...result });
      },
      'storage.closed'
    );
    return worker;
  };
  sessionModule.startRailgunSessionWorker = trackWorker(originalSession, false);
  sessionModule.startRailgunReadOnlySessionWorker = trackWorker(originalReadOnlySession, true);
  const children = new Set(),
    loans = [],
    childResults = [];
  const keys = {},
    jobs = {},
    guards = [];
  const signatureStop = signStop
    ? require('./fixtures/railgun-combined-poi-second-signature-stop').create()
    : undefined;
  let reservations, capsules;
  runtime.startRailgunProcess = (options) => {
    const job = path.basename(options.filename),
      launchPhase = phase,
      broker = options.broker;
    audit.start(options);
    if (
      [
        'railgun-combined-poi-row-job.js',
        'railgun-combined-poi-list-job.js',
        'railgun-own-poi-prove-job.js',
        'railgun-poi-output-recover-job.js',
        'railgun-poi-verify-job.js',
      ].includes(job)
    ) {
      const subject = require('../src/main/networks/privacy-context').getPrivacyContext(
        options.handle
      ).subject;
      assert.equal(subject.kind, 'private-account');
      assert.equal(subject.protocol, 'railgun');
      assert.equal(subject.deployment, 'sepolia');
      assert.equal(subject.chainId, 11155111);
      const expected = {
        'railgun-combined-poi-row-job.js': ['engine', 'combined-poi-row-fixture', false],
        'railgun-combined-poi-list-job.js': ['engine', 'fixture-list-binding', false],
        'railgun-own-poi-prove-job.js': ['engine', 'poi-prove', true],
        'railgun-poi-output-recover-job.js': ['engine', 'poi-output-recover', true],
        'railgun-poi-verify-job.js': ['prover', 'poi-verify', false],
      }[job];
      if (job === 'railgun-combined-poi-list-job.js')
        assert.equal(subject.principal, 'disposable-list');
      assert.equal(subject.role, expected[0]);
      assert.equal(subject.operation, expected[1]);
      assert.equal(!!options.binaryKey, expected[2]);
    }
    jobs[job] = (jobs[job] || 0) + 1;
    const task = originalStart({
      ...options,
      ...(broker
        ? {
            broker: {
              ...broker,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                if (launchPhase === 'second-proof-recovery' && message.method === 'key') {
                  assert.equal(
                    message.purpose,
                    {
                      'railgun-wallet-job.js': 'wallet-viewing',
                      'railgun-private-recover-job.js': 'private-recover',
                    }[job]
                  );
                  assert.ok(
                    ['railgun-wallet-job.js', 'railgun-private-recover-job.js'].includes(job)
                  );
                }
                if (message.method === 'key')
                  keys[message.purpose] = (keys[message.purpose] || 0) + 1;
                const reply = await broker.dispatch(audit.before(job, wire));
                audit.admitted(job, message);
                if (message.method === 'key') {
                  assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
                  loans.push(reply);
                  if (message.purpose === 'spending-sign') {
                    const second = launchPhase.startsWith('second-');
                    assert.equal((await reservations.inspect()).signing, second ? 2 : 1);
                    if (second) {
                      assert.equal(secondCreatorVerified, true);
                      assert.equal(secondCreatorExited, true);
                      assert.equal(secondPoiExited, true);
                      secondTransport.assertKeyAdmission();
                      for (const method of [
                        'ppoi_validated_txid',
                        'ppoi_validate_txid_merkleroot',
                      ]) {
                        const key = 'service:poi:' + method;
                        assert.equal(
                          (postChain.report().validated[key] || 0) - (secondRootBaseline[key] || 0),
                          3
                        );
                      }
                    }
                    const saved = await capsules.inspect();
                    assert.equal(saved.records, second ? 2 : 1);
                    assert.equal(saved.signatures, second ? 1 : 0);
                    assert.equal(saved.proofs, second ? 1 : 0);
                  }
                }
                if (
                  launchPhase.startsWith('second-') &&
                  job === 'railgun-note-provenance-job.js' &&
                  message.method === 'result'
                ) {
                  assert.equal(message.value.unshieldCommitmentVerified, true);
                  assert.equal(message.value.pathVerified, true);
                  assert.equal(message.value.suppliedCreatorEventsMatched, true);
                  assert.equal(message.value.coverage.matchedRows, 1);
                  assert.equal(message.value.coverage.knownOmissions, 0);
                  secondCreatorVerified = true;
                }
                if (message.method === 'result' && message.value?.guards) {
                  const value = message.value.guards;
                  assert.equal(value.attempts, 0);
                  assert.ok(value.hooks.length > 0);
                  assert.equal(value.canaries, value.hooks.length);
                  guards.push({
                    job,
                    phase: launchPhase,
                    attempts: value.attempts,
                    hooks: value.hooks.length,
                  });
                }
                if (signatureStop)
                  return signatureStop.after(job, launchPhase, message, reply, {
                    reservations,
                    capsules,
                  });
                return reply;
              },
            },
          }
        : {}),
    });
    children.add(task);
    sticky.observeClosed(
      task.closed,
      (result) => {
        childResults.push({ job, phase: launchPhase, ...result });
        audit.closed(job, result);
        if (
          launchPhase.startsWith('second-') &&
          ['railgun-note-provenance-job.js', 'railgun-poi-job.js'].includes(job)
        ) {
          assert.equal(result.code, 'RAILGUN_PROCESS_CLOSED');
          assert.ok(Number.isInteger(result.exitCode));
          assert.equal(result.escalated, false);
          assert.equal(result.peerDisconnected, false);
          if (job === 'railgun-note-provenance-job.js') secondCreatorExited = true;
          else secondPoiExited = true;
        }
        children.delete(task);
      },
      'utility.closed'
    );
    return task;
  };
  const signatureModule = require('./fixtures/railgun-own-poi-membership-signature');
  const originalInstallSignature = signatureModule.install;
  let signature, services;
  try {
    signatureModule.install = (...args) => {
      assert.equal(signature, undefined);
      signature = restartResume
        ? signatureModule.installReplay(
            require('./fixtures/railgun-combined-poi-list-replay').replayOptions(restored.wire.list)
          )
        : originalInstallSignature(...args);
      return signature;
    };
    services = require('./fixtures/railgun-partial-controller-services').install({
      bytecodes,
      artifactDirectory,
      source,
      anchor,
      perHandlePoi: true,
    });
    assert.ok(signature);
    if (restartResume) {
      assert.equal(Object.hasOwn(signature, 'sign'), false);
      assert.equal(Object.hasOwn(signature, 'exportPublicKey'), false);
    }
  } finally {
    signatureModule.install = originalInstallSignature;
  }
  const storeObserver = require('./fixtures/railgun-combined-poi-store-observer').install();

  const transport = require('../src/main/networks/wallet-tor-transport');
  const originalTransport = transport.createWalletTorTransport;
  const { getPrivacyContext, createPrivacyScope } = require('../src/main/networks/privacy-context');
  const signers = require('../src/main/wallet/signers'),
    originalSigner = signers.getSigner;
  const facadeRpcCounts = {};
  const methods = {},
    eoa = {
      addressAttempts: 0,
      signatureAttempts: 0,
      signatures: 0,
      sends: 0,
      journalBeforeSend: 0,
      controlledLostAcknowledgments: 0,
      unexpectedFailures: 0,
      reviews: 0,
    };
  let identity,
    enrollment,
    publicAccount,
    account,
    completion,
    txid,
    staged,
    preview,
    recovery,
    journalScope,
    facade,
    facadeFirstReport;
  let expectedOwner,
    expectedTransaction,
    signedTransaction,
    receipt,
    transaction,
    reviewedEndpoint,
    changeStartPosition,
    creatorCheckpoint;
  let fixtureCurrent = true,
    postChain,
    secondTransport,
    lastSecondTransportReport,
    secondColdRefusalStage,
    secondColdRetryDifferences = [],
    connected,
    restartWire,
    restartBootstrap,
    secondSealed;
  let secondCreatorVerified = false,
    secondCreatorExited = false,
    secondPoiExited = false,
    secondRootBaseline;
  const roleMethods = {};
  const wrapperClients = new Set();
  const wrapperTransport = { creates: 0, closes: 0, entries: 0, transactionEntries: 0, pending: 0 };
  const closeWrapperClients = async () => {
    fixtureCurrent = false;
    for (const client of wrapperClients) client.close();
    await bounded(Promise.all([...wrapperClients].map((client) => client.closed)));
    assert.equal(wrapperTransport.pending, 0);
    assert.equal(wrapperTransport.creates, wrapperTransport.closes);
  };
  const constraints = [];
  const pins = require('../src/main/wallet/railgun-shield-pins.json');
  const { PRIVATE_EVENTS } = require('../src/main/wallet/railgun-transact-receipt');
  const { TRANSACT_ABI } = require('../src/main/wallet/railgun-private-policy');
  const abi = new Interface([
    ...PRIVATE_EVENTS,
    TRANSACT_ABI,
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ]);
  const quantity = (value) => '0x' + BigInt(value).toString(16);
  const inclusion = 11834600,
    finalized = inclusion + 10;
  const header = (number) => ({
    number: quantity(number),
    hash: hex(number + 1000),
    parentHash: hex(number + 999),
    timestamp: quantity(number),
    transactions: signedTransaction ? [signedTransaction.hash] : [],
  });
  const journalFor = (handle) =>
    require('../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(handle);
  const buildReceipt = (signed) => {
    const [[inner]] = abi.decodeFunctionData('transact', signed.data);
    assert.equal(inner.commitments.length, 2);
    assert.equal(inner.nullifiers.length, 1);
    assert.equal(inner.boundParams.commitmentCiphertext.length, 1);
    const recipient = '0x' + inner.unshieldPreimage.npk.slice(-40);
    assert.equal(recipient, expectedOwner);
    const gross = inner.unshieldPreimage.value,
      fee = (gross * 25n) / 10000n,
      net = gross - fee;
    const treasury = require('../src/main/wallet/railgun-transact-receipt-policy').treasury;
    const events = [
      [pins.proxy, 'Nullified', [inner.boundParams.treeNumber, inner.nullifiers]],
      [pins.wrappedNative, 'Transfer', [pins.proxy, recipient, net]],
      [pins.wrappedNative, 'Transfer', [pins.proxy, treasury, fee]],
      [pins.proxy, 'Unshield', [recipient, [0, pins.wrappedNative, 0], net, fee]],
      [
        pins.proxy,
        'Transact',
        [0, changeStartPosition, [inner.commitments[0]], inner.boundParams.commitmentCiphertext],
      ],
    ];
    transaction = {
      hash: signed.hash.toLowerCase(),
      from: signed.from.toLowerCase(),
      to: pins.proxy,
      chainId: quantity(signed.chainId),
      nonce: quantity(signed.nonce),
      value: '0x0',
      input: signed.data,
      blockNumber: quantity(inclusion),
      blockHash: header(inclusion).hash,
      transactionIndex: '0x0',
    };
    receipt = {
      status: '0x1',
      gasUsed: '0x100000',
      effectiveGasPrice: '0x64',
      transactionHash: transaction.hash,
      from: transaction.from,
      to: pins.proxy,
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
      transactionIndex: '0x0',
      logs: events.map(([address, name, values], index) => ({
        ...abi.encodeEventLog(name, values),
        address,
        transactionHash: transaction.hash,
        blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash,
        transactionIndex: '0x0',
        logIndex: quantity(index),
        removed: false,
      })),
    };
    assert.equal(receipt.logs.length, 5);
  };
  signers.getSigner = (index) => {
    const genuine = originalSigner(index);
    return Object.freeze({
      async getAddress() {
        eoa.addressAttempts++;
        return genuine.getAddress();
      },
      async signTransaction(value) {
        eoa.signatureAttempts++;
        assert.equal(eoa.signatureAttempts, secondTransport && !restartResume ? 2 : 1);
        assert.equal(value.to.toLowerCase(), pins.proxy.toLowerCase());
        if (secondTransport) secondTransport.assertSigning(value);
        else assert.equal(value.data, expectedTransaction.data);
        assert.equal(BigInt(value.value), 0n);
        const raw = await genuine.signTransaction(value);
        eoa.signatures++;
        return raw;
      },
    });
  };
  transport.createWalletTorTransport = (...args) => {
    assert.equal(fixtureCurrent, true);
    const client = originalTransport(...args);
    wrapperTransport.creates++;
    let closed = false,
      innerClosed = false,
      pending = 0,
      resolveClosed;
    const drain = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const finish = () => {
      if (closed && innerClosed && pending === 0) resolveClosed();
    };
    assert.ok(client.closed && typeof client.closed.then === 'function');
    sticky.observeClosed(
      client.closed,
      () => {
        innerClosed = true;
        finish();
      },
      'inner-transport.closed'
    );
    const wrapper = {
      ...client,
      closed: drain,
      close() {
        if (!closed) wrapperTransport.closes++;
        closed = true;
        try {
          client.close();
        } finally {
          finish();
        }
      },
      async request(handle, url, options) {
        wrapperTransport.entries++;
        wrapperTransport.pending++;
        pending++;
        let controlled = false;
        const current = () => {
          assert.equal(fixtureCurrent, true);
          assert.equal(closed, false);
          assert.equal(options.signal.aborted, false);
          return getPrivacyContext(handle);
        };
        try {
          const { subject } = current();
          const called = JSON.parse(options.body);
          if (facadeMode) {
            const label = require('./fixtures/railgun-kohaku-partial-native').rpcLabel(
              subject,
              called
            );
            facadeRpcCounts[label] = (facadeRpcCounts[label] || 0) + 1;
          }
          const roleKey = subject.kind + ':' + subject.role + ':' + (called.method ?? 'page');
          roleMethods[roleKey] = (roleMethods[roleKey] || 0) + 1;
          if (secondTransport) {
            if (subject.role === 'transaction-rpc') {
              wrapperTransport.transactionEntries++;
              methods[called.method] = (methods[called.method] || 0) + 1;
            }
            const handled = await secondTransport.route(subject, url, options, handle);
            if (handled !== undefined) {
              current();
              if (called.method === 'eth_sendRawTransaction') {
                eoa.sends++;
                eoa.journalBeforeSend++;
                assert.equal(eoa.sends, restartResume ? 1 : 2);
              }
              return handled;
            }
          }
          if (postChain) {
            const handled = await postChain.route(subject, url, options, handle);
            if (handled !== undefined) {
              current();
              return handled;
            }
          }
          assert.equal(restartResume, false, 'Unexpected resume RPC/service admission');
          if (subject.role !== 'transaction-rpc') {
            const response = await client.request(handle, url, options);
            current();
            return response;
          }
          wrapperTransport.transactionEntries++;
          assert.equal(options.method, 'POST');
          const wire = JSON.parse(options.body);
          assert.deepEqual(Object.keys(wire).sort(), ['id', 'jsonrpc', 'method', 'params']);
          assert.equal(wire.jsonrpc, '2.0');
          assert.equal(typeof wire.id, 'string');
          assert.equal(typeof wire.method, 'string');
          assert.ok(Array.isArray(wire.params));
          methods[wire.method] = (methods[wire.method] || 0) + 1;
          assert.equal(subject.kind, 'public-address');
          assert.equal(subject.chainId, 11155111);
          assert.equal(subject.principal, expectedOwner);
          assert.equal(subject.operation, null);
          assert.equal(
            url,
            reviewedEndpoint ?? 'https://synthetic.invalid/railgun-partial-controller'
          );
          assert.equal(options.method, 'POST');
          assert.equal(options.signal.aborted, false);
          assert.ok(Array.isArray(wire.params));
          if (['eth_chainId', 'eth_getCode', 'eth_getBalance'].includes(wire.method)) {
            const response = await client.request(handle, url, options);
            current();
            return response;
          }
          let result;
          if (wire.method === 'eth_getTransactionCount') {
            assert.equal(wire.params[0].toLowerCase(), expectedOwner);
            assert.ok(['latest', 'pending'].includes(wire.params[1]));
            result = '0x0';
          } else if (wire.method === 'eth_gasPrice') {
            assert.deepEqual(wire.params, []);
            result = '0x64';
          } else if (['eth_estimateGas', 'eth_call'].includes(wire.method)) {
            assert.equal(wire.params[0].from.toLowerCase(), expectedOwner);
            assert.equal(wire.params[0].to.toLowerCase(), pins.proxy.toLowerCase());
            assert.equal(wire.params[0].data, expectedTransaction.data);
            assert.equal(BigInt(wire.params[0].value), 0n);
            if (wire.method === 'eth_call') assert.equal(wire.params[1], 'latest');
            result = wire.method === 'eth_estimateGas' ? '0x100000' : '0x';
          } else if (wire.method === 'eth_sendRawTransaction') {
            eoa.sends++;
            assert.equal(eoa.sends, 1);
            assert.equal(eoa.signatures, 1);
            signedTransaction = Transaction.from(wire.params[0]);
            assert.equal(signedTransaction.from.toLowerCase(), expectedOwner);
            assert.equal(signedTransaction.chainId, 11155111n);
            assert.equal(signedTransaction.data, expectedTransaction.data);
            const records = await journalFor(handle).list();
            current();
            assert.equal(records.length, 1);
            assert.equal(records[0].state, 'attempted');
            assert.equal(records[0].hash, signedTransaction.hash.toLowerCase());
            assert.deepEqual(
              records[0].intent,
              require('../src/main/wallet/railgun-transact-intent').railgunTransactJournalIntent(
                signedTransaction
              )
            );
            eoa.journalBeforeSend++;
            buildReceipt(signedTransaction);
            if (testCase === 'lost-response') {
              controlled = true;
              eoa.controlledLostAcknowledgments++;
              throw Error('Simulated lost EOA acknowledgement');
            }
            result = signedTransaction.hash;
          } else if (
            ['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(wire.method)
          ) {
            assert.deepEqual(wire.params, [signedTransaction.hash.toLowerCase()]);
            result = wire.method === 'eth_getTransactionReceipt' ? receipt : transaction;
          } else if (wire.method === 'eth_blockNumber') {
            assert.deepEqual(wire.params, []);
            result = quantity(finalized + 2);
          } else if (wire.method === 'eth_getBlockByNumber') {
            assert.equal(wire.params[1], false);
            const number =
              wire.params[0] === 'finalized' ? finalized : Number(BigInt(wire.params[0]));
            assert.ok([inclusion, finalized, finalized + 1].includes(number));
            result = header(number);
          } else throw Error('Unexpected transaction RPC method');
          current();
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
          };
        } catch (error) {
          if (secondTransport?.isLostReply?.(error)) {
            assert.equal(coldLost, true);
            controlled = true;
            eoa.sends++;
            eoa.journalBeforeSend++;
            eoa.controlledLostAcknowledgments++;
            assert.equal(eoa.sends, 1);
            assert.equal(eoa.controlledLostAcknowledgments, 1);
          }
          if (!controlled) sticky.record(error, 'combined.transport');
          if (!controlled) eoa.unexpectedFailures++;
          throw error;
        } finally {
          pending--;
          wrapperTransport.pending--;
          finish();
        }
      },
    };
    wrapperClients.add(wrapper);
    return wrapper;
  };
  const snapshot = () => ({
    keys: { ...keys },
    jobs: { ...jobs },
    eoa: { ...eoa },
    methods: { ...methods },
    services: services.report(),
    wrapperTransport: { ...wrapperTransport },
  });
  const captureActivity = () => ({
    keys: { ...keys },
    jobs: { ...jobs },
    methods: { ...methods },
    eoa: { ...eoa },
    transportEntries: services.report().transportEntries,
    wrapperEntries: wrapperTransport.entries,
  });
  const facadeMeasure = () => ({
    jobs: { ...jobs },
    keys: { ...keys },
    methods: { ...methods },
    eoa: { ...eoa },
    rpcCounts: { ...facadeRpcCounts },
    workers: { started: workerStarts, exited: workerResults.length },
  });
  if (facadeMode) facade = require('./fixtures/railgun-kohaku-second-instance').install();
  // Transparent timing observers installed before consumers capture fixed
  // exports. No source/currentness/result replacement or capability issuer.
  const phaseTimings = [],
    restoreTimings = [];
  const copyTimings = () => phaseTimings.map((v) => ({ ...v }));
  let sourceReturned;
  const timeMethod = (module, name, sourceMethod) => {
    const original = module[name];
    assert.equal(typeof original, 'function');
    module[name] = async (...args) => {
      const start = performance.now();
      if (!sourceMethod) sourceReturned = undefined;
      const value = await original(...args);
      const end = performance.now();
      if (sourceMethod && value.status === 'captured') sourceReturned = end;
      phaseTimings.push({
        name: sourceMethod ? 'retained-source' : 'retained-preflight',
        elapsedMs: Math.round(end - start),
        status: value.status,
        ...(!sourceMethod && sourceReturned !== undefined
          ? { sourceReturnToPreflightCompletionMs: Math.round(end - sourceReturned) }
          : {}),
      });
      return value;
    };
    restoreTimings.push(() => {
      module[name] = original;
    });
  };
  const sourceCapture = require('../src/main/wallet/railgun-poi-source-capture');
  timeMethod(sourceCapture, 'captureRailgunPoiSourceForRetainedInput', true);
  const witnessHost = require('../src/main/wallet/railgun-own-witness');
  timeMethod(witnessHost, 'preflightRailgunRetainedPoiCompleted', false);
  timeMethod(witnessHost, 'preflightRailgunRetainedPoiForSubmission', false);
  const vault = require('../src/main/identity/vault');
  const started = performance.now();
  const runs = [];
  try {
    if (restartResume) {
      phase = 'restart-bootstrap';
      await vault.unlockVault(
        path.join(directory, 'profile', 'identity'),
        'public-fixture-password-not-a-user-credential',
        0
      );
      identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
        archive,
      });
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity, create: false }
        );
      publicAccount =
        await require('../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
          enrollment,
          archive,
          create: false,
        });
      expectedOwner = restored.wire.transaction.from;
      transaction = restored.wire.transaction;
      receipt = restored.wire.receipt;
      // Header fixture uses the saved public transaction hash, never a signing capability.
      signedTransaction = { hash: transaction.hash };
      journalScope = createPrivacyScope({
        profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
        signal: enrollment.signal,
      });
      const journal = journalFor(
        journalScope.getContext({
          kind: 'public-address',
          principal: expectedOwner,
          chainId: 11155111,
          role: 'transaction-rpc',
        })
      );
      const activity = () => ({
        ...captureActivity(),
        services: services.report(),
        storageWorkers: {
          starts: workerStarts,
          exits: workerResults.length,
          pending: workers.size,
        },
        roleMethods: { ...roleMethods },
        chain: postChain?.report(),
        audit: audit.snapshot(),
      });
      const restart = require('./fixtures/railgun-combined-poi-restart');
      const result = await (
        signStop
          ? restart.signStop
          : recoverStop
            ? restart.recoverStop
            : proveStop
              ? restart.proveStop
              : coldSubmit
                ? coldLost
                  ? restart.coldSubmitLost
                  : restart.coldSubmit
                : restart.resume
      )({
        sealed: coldSubmit || recoverStop ? restored.handoff : undefined,
        signatureStop,
        recoveryStorage: coldStorage.recovery,
        profileSnapshot: () => restartData.profileSnapshot(directory),
        identity,
        enrollment,
        publicAccount,
        archive,
        proverArchive,
        artifactDirectory,
        source,
        wire: restored.wire,
        signal: identity.signal,
        bytecodes,
        header,
        journal: () => journal,
        activity,
        phase: (name) => {
          phase = name;
        },
        installChain: (value) => {
          assert.equal(postChain, undefined);
          postChain = value;
        },
        installTransport(value) {
          if (value) {
            assert.equal(secondTransport, undefined);
            secondRootBaseline = postChain.report().validated;
          }
          if (!value && secondTransport) lastSecondTransportReport = secondTransport.report();
          secondTransport = value;
        },
        recordReview() {
          eoa.reviews++;
          assert.equal(eoa.reviews, 1);
        },
        recordColdRefusalStage(value) {
          secondColdRefusalStage = [
            'admission',
            'history',
            'prior-attempt',
            'disclosure-review',
            'wallet',
            'source',
            'txid',
            'recovery',
            'creator',
            'proof',
            'membership',
            'root',
            'submission',
            'preflight',
            'eoa',
          ].includes(value)
            ? value
            : 'unclassified';
        },
        recordColdRetryDifference(value) {
          if (
            [
              'keys',
              'jobs',
              'methods',
              'eoa',
              'transportEntries',
              'wrapperEntries',
              'services',
              'storageWorkers',
              'roleMethods',
              'chain',
              'audit',
            ].includes(value) &&
            !secondColdRetryDifferences.includes(value)
          )
            secondColdRetryDifferences.push(value);
        },
        adoptStores(a, b) {
          reservations = a;
          capsules = b;
        },
        pendingChildren: () => children.size,
        unwipedLoans: () => loans.filter((key) => key.some((v) => v !== 0)).length,
        assertBootstrapDrained() {
          assert.equal(children.size, 0);
          assert.equal(workers.size, 2);
          assert.ok(loans.every((key) => key.every((v) => v === 0)));
          assert.equal(keys['spending-sign'] || 0, 0);
          assert.equal(eoa.signatureAttempts, 0);
          assert.equal(eoa.sends, 0);
          assert.equal(eoa.reviews, 0);
          assert.equal(postChain.report().posts, 0);
          assert.equal(services.report().poiMethods.ppoi_pois_per_list || 0, 0);
          sticky.assertEmpty();
        },
        beforeSecond() {
          restartBootstrap = {
            observed: activity(),
            expected:
              coldSubmit || recoverStop
                ? require('./fixtures/railgun-combined-poi-second-cold-counts').assertColdBootstrap(
                    activity()
                  )
                : require('./fixtures/railgun-combined-poi-restart-counts').assertBootstrap(
                    activity(),
                    restored.wire,
                    source
                  ),
          };
          assert.deepEqual(
            Object.keys(restartData.profileSnapshot(directory).accounts),
            Object.keys(restored.handoff.files.accounts)
          );
          assert.equal(
            restartData.profileSnapshot(directory).inventory,
            restored.handoff.files.inventory
          );
          assert.equal(
            restartData.profileSnapshot(directory).encryptedVault,
            restored.handoff.files.encryptedVault
          );
          assert.deepEqual(
            restartData.profileSnapshot(directory).submissions,
            restored.handoff.files.submissions
          );
        },
      });
      connected = result.report;
      secondSealed = result.sealed;
      assert.equal(keys['spending-sign'] || 0, coldSubmit || recoverStop ? 0 : 1);
      assert.equal(eoa.sends, stopWithoutSubmission ? 0 : 1);
      assert.equal(eoa.signatures, stopWithoutSubmission ? 0 : 1);
      assert.equal(eoa.reviews, stopWithoutSubmission ? 0 : 1);
      assert.equal(jobs['railgun-private-operate-job.js'] || 0, coldSubmit || recoverStop ? 0 : 1);
      assert.equal(jobs['railgun-spend-sign-job.js'] || 0, coldSubmit || recoverStop ? 0 : 1);
      assert.equal(
        jobs['railgun-private-verify-job.js'] || 0,
        signStop ? 0 : proveStop || coldSubmit || recoverStop ? 1 : 2
      );
      assert.equal(jobs['railgun-private-receive-job.js'] || 0, 0);
      assert.equal(jobs['railgun-own-poi-prove-job.js'] || 0, 0);
      assert.equal(jobs['railgun-private-recover-job.js'] || 0, recoverStop ? 1 : 0);
      assert.equal(postChain.report().posts, 0);
      assert.equal(eoa.unexpectedFailures, 0);
    } else {
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
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          {
            identity,
            create: true,
          }
        );
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
        creatorCheckpoint = (await txid.inspect()).checkpoint.state;
        assert.deepEqual(creatorCheckpoint, state);
        await txid.close();
        txid = null;
        // Advance observes the latest index once, then acquires root acceptance
        // before preparing and again before completing the durable checkpoint.
        assert.deepEqual(services.report().publicServiceMethods, {
          latest: 3,
          page: 1,
          validate: 2,
        });
      }
      phase = 'wallet-scan';
      account = await wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'new' });
      const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
      changeStartPosition = baseline.trees.find((tree) => tree.tree === 0).length;
      assert.equal(changeStartPosition, 3);
      const selected = baseline.ownedPoi.find(
        (record) =>
          record.type === inputCreator &&
          baseline.read.received.some(
            (note) => note.id === record.id && note.spentTxid === false && note.amount > 1n
          )
      );
      assert.ok(selected);
      const note = baseline.read.received.find((note) => note.id === selected.id);
      assert.ok(selected.blockNumber >= OFFSET);
      reservations = await enrollment.openReservations();
      capsules = await enrollment.openPrivateCapsules();
      const recipient = (
        await require('../src/main/wallet/signers').getSigner(0).getAddress()
      ).toLowerCase();
      if (restartSetup) {
        // Direct vault import omits the application's public wallet metadata.
        // Cold submission reads it before review without borrowing the EOA key.
        const metadata = path.join(vaultDirectory, 'vault-meta.json');
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
      await services.setSelected({
        archive,
        enrollment,
        record: selected,
        submitter: recipient,
        merkleRoot: baseline.trees.find((tree) => tree.tree === note.tree).root,
      });
      expectedOwner = recipient;
      let stored, firstFacade;
      if (facadeMode) {
        phase = 'first-facade';
        firstFacade = await facade.first({
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          account,
          capsules,
          archive,
          proverArchive,
          artifactDirectory,
          note,
          record: selected,
          recipient,
          amount: note.amount / 2n,
          measure: facadeMeasure,
          recordReview() {
            eoa.reviews++;
          },
          onStored(value) {
            stored = value;
            expectedTransaction = value.provedTransaction;
          },
        });
        assert.equal(
          firstFacade.submitted.hash.toLowerCase(),
          signedTransaction.hash.toLowerCase()
        );
        assert.equal(eoa.sends, 1);
        assert.equal(eoa.signatures, 1);
        assert.equal(eoa.journalBeforeSend, 1);
        facadeFirstReport = firstFacade.report;
        account = null;
      } else {
        const rpc = require('../src/main/networks/private-rpc');
        preview = createPrivacyScope({
          profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
          signal: enrollment.signal,
        });
        const protocolSubject = {
          ...getPrivacyContext(enrollment.getContext('engine')).subject,
          role: 'protocol-rpc',
        };
        delete protocolSubject.operation;
        const protocolHandle = preview.getContext(protocolSubject);
        const transactionHandle = preview.getContext({
          kind: 'public-address',
          principal: recipient,
          chainId: 11155111,
          role: 'transaction-rpc',
        });
        for (const [handle, role] of [
          [protocolHandle, 'protocol-rpc'],
          [transactionHandle, 'transaction-rpc'],
        ]) {
          const client = rpc.createPrivateRpc(handle, role);
          const observation = rpc.getPrivateRpcDestination(client, handle);
          const details = rpc.getPrivateRpcDestinationDetails(observation);
          assert.equal(details.url, 'https://synthetic.invalid/railgun-partial-controller');
          if (role === 'transaction-rpc') reviewedEndpoint = details.url;
          constraints.push(
            rpc.createPrivateRpcDestinationConstraint({
              observation,
              signal: enrollment.signal,
              deadline: performance.now() + 300000,
            })
          );
        }
        const destinationConstraints = Object.freeze({
          protocol: constraints[0].constraint,
          transaction: constraints[1].constraint,
        });
        const options = {
          account,
          owners,
          archive,
          proverArchive,
          artifactDirectory,
          destinationConstraints,
          request: {
            kind: 'railgun-partial-unshield',
            noteId: selected.id,
            recipient,
            unshieldAmount: (note.amount / 2n).toString(),
          },
        };
        if (transact) {
          phase = 'transact-staging';
          staged =
            await require('../src/main/wallet/railgun-transact-staging').stageRailgunTransactInput({
              account,
              owners,
              request: options.request,
              archive,
              signal: enrollment.signal,
            });
          assert.equal(staged.status, 'staged');
          account = options.account = staged.account;
          options.stagingReceipt = staged.receipt;
        }
        phase = 'prove';
        const proved =
          await require('../src/main/wallet/railgun-private-operation').proveRailgunAccountPrivateOperation(
            options
          );
        assert.equal(proved.status, 'proved', JSON.stringify(proved));
        completion = proved.completion;
        stored = await capsules.get(proved.holdId);
        assert.equal(stored.capsule.version, 2);
        assert.ok(stored.signature && stored.provedTransaction);
        expectedTransaction = stored.provedTransaction;
        assert.equal(keys['spending-sign'], 1);
        await account.close();
        account = null;
        staged?.close();
        staged = null;
      }
      const savedBefore = await reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        assert.equal(records.length, 1);
        const entry = records[0];
        assert.equal(entry.entry.state, 'signing');
        assert.deepEqual(await capsules.readSigned(entry.receipt), stored);
        return entry.entry;
      });
      const captureSelector = Object.fromEntries(
        ['tree', 'position', 'nullifier', 'noteHash'].map((key) => [key, savedBefore.facts[key]])
      );
      const capture = () =>
        require('../src/main/wallet/railgun-own-operation').captureRailgunOwnOperation({
          enrollment,
          selector: captureSelector,
          signal: enrollment.signal,
        });
      if (!facadeMode) {
        const submit =
          require('../src/main/wallet/railgun-private-submission').submitRailgunPrivateTransaction;
        const submitOptions = {
          identity,
          enrollment,
          completion: completion.receipt,
          proverArchive,
          artifactDirectory,
          gasLimit: 1500000n,
          maxGasFee: 2000000000000000n,
          review: async (request) => {
            eoa.reviews++;
            assert.equal(methods.eth_estimateGas, 1);
            assert.equal(methods.eth_call, 1);
            assert.equal(eoa.sends, 0);
            assert.equal(eoa.signatureAttempts, 0);
            assert.equal(request.fundingAddressPublic, true);
            assert.equal(request.operation, 'railgun-partial-unshield');
            assert.equal(request.transaction.data, expectedTransaction.data);
            assert.equal(request.from.toLowerCase(), recipient);
            return true;
          },
        };
        phase = 'copied-completion';
        const beforeCopy = snapshot();
        assert.deepEqual(
          await submit({ ...submitOptions, completion: { ...completion.receipt } }),
          {
            status: 'recovery-required',
            stage: 'completion',
          }
        );
        assert.deepEqual(snapshot(), beforeCopy);
        phase = 'submit';
        if (testCase === 'bad-verifier') services.setMode('wrong-verifier');
        const beforeSubmit = snapshot();
        const submitted = await submit(submitOptions);
        if (testCase === 'bad-verifier') {
          assert.deepEqual(submitted, { status: 'recovery-required', stage: 'preflight' });
          assert.equal(eoa.signatureAttempts, 0);
          assert.equal(eoa.sends, 0);
          assert.equal(eoa.reviews, 0);
          assert.deepEqual(methods, beforeSubmit.methods);
          assert.equal(
            services.report().selectedNullifierQueries,
            beforeSubmit.services.selectedNullifierQueries
          );
          assert.deepEqual(
            services
              .report()
              .verificationKeyVariants.slice(beforeSubmit.services.verificationKeyVariants.length),
            ['01x01']
          );
          assert.deepEqual(await capture(), { status: 'refused', stage: 'journal' });
          runs.push({
            mode: 'bad-verifier',
            actualWrong01x01Rejected: true,
            noEoaSignatureOrSend: true,
            eoaSigningExercised: false,
            receiptResolutionExercised: false,
          });
        } else {
          if (testCase === 'lost-response') {
            assert.equal(submitted.transactionHash, signedTransaction.hash.toLowerCase());
            assert.equal(submitted.submissionStatus, 'unknown');
          } else assert.equal(submitted.hash.toLowerCase(), signedTransaction.hash.toLowerCase());
          assert.equal(eoa.signatures, 1);
          assert.equal(eoa.sends, 1);
          assert.equal(eoa.journalBeforeSend, 1);
          assert.equal(eoa.reviews, 1);
          assert.equal(eoa.unexpectedFailures, 0);
          assert.deepEqual(
            services
              .report()
              .verificationKeyVariants.slice(beforeSubmit.services.verificationKeyVariants.length),
            ['01x02']
          );
          assert.equal(
            services.report().selectedNullifierQueries,
            beforeSubmit.services.selectedNullifierQueries + 1
          );
          assert.deepEqual(await capture(), { status: 'refused', stage: 'journal' });
          runs.push({
            mode: 'submitted',
            acknowledged: testCase === 'acknowledged',
            uncertainHashPreserved: testCase === 'lost-response',
            unresolvedCaptureRefused: true,
          });
        }
        const beforeReplay = snapshot();
        assert.deepEqual(await submit(submitOptions), {
          status: 'recovery-required',
          stage: 'completion',
        });
        assert.deepEqual(snapshot(), beforeReplay);
        completion.close();
        completion = null;
        for (const constraint of constraints) constraint.close();
        preview.close();
        preview = null;
      }
      const openJournal = () => {
        journalScope?.close();
        journalScope = createPrivacyScope({
          profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
          signal: enrollment.signal,
        });
        return journalFor(
          journalScope.getContext({
            kind: 'public-address',
            principal: recipient,
            chainId: 11155111,
            role: 'transaction-rpc',
          })
        );
      };
      if (testCase !== 'bad-verifier') {
        let journal = openJournal();
        const attempted = (await journal.list())[0];
        assert.equal(attempted.state, testCase === 'lost-response' ? 'attempted' : 'submitted');
        await assert.rejects(journal.assertCanSubmit());
        phase = 'resolve';
        recovery =
          require('../src/main/wallet/railgun-transact-recovery').openRailgunTransactRecovery(
            recipient
          );
        const canonicalReceipt = receipt;
        const canonicalObservation = await recovery.observe(signedTransaction.hash.toLowerCase());
        assert.equal(canonicalObservation.transact.status, 'matched');
        assert.equal(canonicalObservation.transact.version, 2);
        assert.equal(canonicalObservation.transact.output.kind, 'partial-unshield');
        let invalidReceiptReviews = 0;
        try {
          receipt = { ...canonicalReceipt, logs: [...canonicalReceipt.logs].reverse() };
          await assert.rejects(
            recovery.resolve(signedTransaction.hash.toLowerCase(), {
              minimumConfirmations: 3,
              review: async () => {
                invalidReceiptReviews++;
                return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
              },
            })
          );
          assert.equal(invalidReceiptReviews, 0);
          assert.deepEqual(await capture(), { status: 'refused', stage: 'journal' });
        } finally {
          receipt = canonicalReceipt;
        }
        runs.push({
          mode: 'reversed-receipt-order',
          refusedBeforeReview: true,
          unresolvedCaptureStillRefused: true,
        });
        const resolved = await recovery.resolve(signedTransaction.hash.toLowerCase(), {
          minimumConfirmations: 3,
          review: async (request) => {
            assert.equal(request.transact.status, 'matched');
            assert.equal(request.transact.version, 2);
            assert.equal(request.transact.output.kind, 'partial-unshield');
            assert.equal(request.transact.output.change.position, changeStartPosition);
            assert.equal(request.transact.output.unshield.recipient, recipient);
            assert.equal(
              request.transact.receiptPolicy,
              require('../src/main/wallet/railgun-transact-receipt-policy').id
            );
            return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
          },
        });
        assert.ok(resolved.resolution);
        recovery.close();
        recovery = null;
        const noCaptureWork = captureActivity();
        const active = await capture();
        assert.equal(active.status, 'captured', JSON.stringify(active));
        assert.equal(active.capture.version, 1);
        assert.equal(active.capture.capsule.version, 2);
        for (const flag of [
          'accountAuthenticated',
          'sourceAuthenticated',
          'currentFinalityVerified',
          'txidPathVerified',
          'txidRootAccepted',
          'poiVerified',
          'spendingEnabled',
        ])
          assert.equal(active.capture[flag], false);
        assert.deepEqual(captureActivity(), noCaptureWork);
        phase = 'actual-partial-row';
        const expected = active.capture.capsule.preparation.expected;
        const [[actual]] = abi.decodeFunctionData('transact', signedTransaction.data);
        assert.deepEqual(Array.from(actual.commitments), [
          expected.changeCommitment,
          expected.unshieldCommitment,
        ]);
        assert.deepEqual(Array.from(actual.nullifiers), [expected.nullifier]);
        assert.equal(actual.unshieldPreimage.value.toString(), expected.unshieldAmount);
        const row = {
          version: 'V2',
          // Own-operation matching uses the existing zero-slot indexer policy;
          // the third ID limb is not the receipt's Transact log index.
          graphID: hex(inclusion) + hex(0).slice(2) + hex(0).slice(2),
          commitments: Array.from(actual.commitments),
          nullifiers: Array.from(actual.nullifiers),
          boundParamsHash: expected.boundParamsHash,
          blockNumber: inclusion,
          txid: signedTransaction.hash.toLowerCase().slice(2),
          timestamp: inclusion,
          utxoTreeIn: Number(actual.boundParams.treeNumber),
          utxoTreeOut: 0,
          utxoBatchStartPositionOut: changeStartPosition,
          unshield: {
            tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
            toAddress: recipient,
            value: actual.unshieldPreimage.value.toString(),
          },
        };
        const parent = getPrivacyContext(enrollment.getContext('engine'));
        const rowScope = createPrivacyScope({ profileId: parent.profileId, signal: parent.signal });
        let rowTask, projected;
        try {
          rowTask = runtime.startRailgunProcess({
            handle: rowScope.getContext({
              ...parent.subject,
              operation: 'combined-poi-row-fixture',
            }),
            filename: require.resolve('./fixtures/railgun-combined-poi-row-job'),
            input: JSON.stringify({ archive, priorRows: source.txidRows ?? [], row }),
            startupMs: 30000,
            lifetimeMs: 60000,
            broker: {
              signal: rowScope.signal,
              dispatch: async (text) => {
                assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
                assert.equal(projected, undefined);
                const m = JSON.parse(text);
                assert.deepEqual(Object.keys(m).sort(), ['id', 'method', 'value']);
                assert.equal(m.id, 1);
                assert.equal(m.method, 'result');
                assert.deepEqual(Object.keys(m.value).sort(), [
                  'checkpoints',
                  'guards',
                  'rows',
                  'state',
                ]);
                projected = m.value;
                assert.equal(projected.rows.length, transact ? 2 : 1);
                assert.equal(projected.checkpoints.length, projected.rows.length);
                assert.deepEqual(projected.checkpoints.at(-1), projected.state);
                if (transact) assert.deepEqual(projected.checkpoints[0], creatorCheckpoint);
                const { verificationHash, ...actualRow } = projected.rows.at(-1);
                assert.match(verificationHash, /^0x[0-9a-f]{64}$/);
                assert.deepEqual(actualRow, row);
                return JSON.stringify({ id: 1, value: null });
              },
            },
          });
          await rowTask.ready;
          assert.ok(projected);
        } finally {
          try {
            rowTask?.close();
          } finally {
            await rowTask?.closed;
            rowScope.close();
          }
        }
        sticky.assertEmpty();
        const rowMatch = require('../src/main/wallet/railgun-own-txid').matchRailgunOwnTxid({
          capsule: active.capture.capsule,
          record: active.capture.record,
          transaction,
          receipt,
          row: projected.rows.at(-1),
        });
        assert.equal(rowMatch.output.kind, 'partial-unshield');
        postChain = require('./fixtures/railgun-combined-poi-chain').create({
          source,
          receipt,
          rows: projected.rows,
          state: projected.state,
          checkpoints: projected.checkpoints,
          finalized,
          header,
          accountIndex: enrollment.descriptor.accountIndex,
        });
        phase = 'ingest-actual-partial-events';
        assert.ok(
          inclusion >=
            anchor.number + 1 + Math.floor((finalized - anchor.number - 1) / 100000) * 100000
        );
        for (let from = anchor.number + 1; from <= finalized; from += 100000)
          await publicAccount.advance({
            to: Math.min(from + 99999, finalized),
            anchor: { number: finalized, hash: header(finalized).hash },
          });
        phase = 'ingest-actual-partial-txid';
        txid = await require('../src/main/wallet/railgun-account-txid').openRailgunAccountTxid({
          enrollment,
          coordinator: publicAccount.coordinator,
          archive,
          create: !transact,
        });
        await txid.advance();
        const actualTxidState = (await txid.inspect()).checkpoint.state;
        const differingFields = [
          ...new Set([...Object.keys(actualTxidState), ...Object.keys(projected.state)]),
        ].filter(
          (key) => JSON.stringify(actualTxidState[key]) !== JSON.stringify(projected.state[key])
        );
        if (differingFields.length)
          console.error(JSON.stringify({ diagnostic: 'txid-state-difference', differingFields }));
        assert.deepEqual(actualTxidState, projected.state);
        await txid.close();
        txid = null;
        const completed = await lifecycle.run({
          changeMode,
          restartSetup,
          secondSpendMode,
          terminalMode,
          facade,
          facadeMeasure,
          header,
          bytecodes,
          signature,
          outerSignal: identity.signal,
          archive,
          proverArchive,
          artifactDirectory,
          identity,
          enrollment,
          publicAccount,
          inputCreator,
          selector: captureSelector,
          capture: active.capture,
          chain: postChain,
          audit,
          storeObserver,
          timings: () => copyTimings(),
          phase: (name) => {
            phase = name;
          },
          journal: () => journal,
          activity: () => ({
            ...captureActivity(),
            services: services.report(),
            storageWorkers: {
              starts: workerStarts,
              exits: workerResults.length,
              pending: workers.size,
            },
            roleMethods: { ...roleMethods },
          }),
          recordSecondReview() {
            eoa.reviews++;
            assert.equal(eoa.reviews, 2);
          },
          installSecondTransport(value) {
            if (value) {
              assert.equal(secondTransport, undefined);
              secondRootBaseline = postChain.report().validated;
            }
            if (!value && secondTransport) lastSecondTransportReport = secondTransport.report();
            secondTransport = value;
          },
          adoptStores(nextReservations, nextCapsules) {
            reservations = nextReservations;
            capsules = nextCapsules;
          },
          pendingChildren: () => children.size,
          unwipedLoans: () => loans.filter((key) => key.some((v) => v !== 0)).length,
          adopt: (nextEnrollment, nextPublic) => {
            enrollment = nextEnrollment;
            publicAccount = nextPublic;
            journalScope?.close();
            journalScope = null;
            journal = openJournal();
          },
        });
        connected = completed.report;
        restartWire = completed.restartWire;
        // Kept privately for the later genuine normal-scan + acceptance adapter.
        // Never serialized into report.json or used to fabricate an owned note.
        assert.equal(completed.continuation.ownEvidence.row.txid, row.txid);
        assert.deepEqual(completed.continuation.events, postChain.continuation.logs);
        runs.push({
          mode: 'actual-partial-source-and-mirror',
          protocolLogs: 3,
          totalReceiptLogs: 5,
          actualSignedCalldata: true,
          realPublicProjectionAndTxidMirror: true,
          rows: projected.rows.length,
          changeCreditedByWallet: changeMode,
          secondSpend: secondSpendMode,
        });
      }
      phase = 'private-history';
      ({ reservations, capsules } = await enrollment.openPrivateRecoveryStores());
      await reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        assert.equal(records.length, secondSpendMode ? 2 : 1);
        const original = records.find((value) => value.entry.id === savedBefore.id);
        assert.ok(original);
        assert.deepEqual(original.entry, savedBefore);
        assert.deepEqual(await capsules.readSigned(original.receipt), stored);
      });
      assert.equal(keys['spending-sign'], secondSpendMode ? 2 : 1);
      assert.equal(eoa.sends, secondSpendMode ? 2 : testCase === 'bad-verifier' ? 0 : 1);
      assert.equal(eoa.unexpectedFailures, 0);
      assert.equal(jobs['railgun-private-operate-job.js'], secondSpendMode ? 2 : 1);
      assert.equal(jobs['railgun-spend-sign-job.js'], secondSpendMode ? 2 : 1);
      assert.equal(jobs['railgun-private-verify-job.js'], secondSpendMode ? 4 : 2);
      assert.equal(jobs['railgun-private-receive-job.js'], 1);
      assert.equal(jobs['railgun-private-recover-job.js'] || 0, recoverStop ? 1 : 0);
    }
    assert.ok(loans.every((key) => key.every((value) => value === 0)));
    phase = 'close';
    await publicAccount?.close();
    publicAccount = null;
    journalScope?.close();
    journalScope = null;
    enrollment.close();
    identity.close();
    vault.lockVault();
    await bounded(Promise.all([...children].map((child) => child.closed)));
    assert.equal(children.size, 0);
    await bounded(Promise.all([...workers].map((worker) => worker.closed)));
    assert.equal(workers.size, 0);
    assert.equal(workerResults.length, workerStarts);
    assert.ok(workerResults.every((worker) => worker.exitCode === 0));
    assert.ok(childResults.every((child) => Number.isInteger(child.exitCode)));
    const expectedUtilityFailures = childResults
      .filter((child) => child.code !== 'RAILGUN_PROCESS_CLOSED')
      .map(({ phase, job, code, exitCode, escalated, peerDisconnected }) => ({
        phase,
        job,
        code,
        exitCode,
        escalated,
        peerDisconnected,
      }));
    assert.deepEqual(
      expectedUtilityFailures,
      (signStop
        ? ['second-prove']
        : restartResume
          ? []
          : ['combined-wrong-output', 'combined-attempted-wrong-output']
      ).map((phase) => ({
        phase,
        job: signStop ? 'railgun-private-operate-job.js' : 'railgun-poi-output-recover-job.js',
        code: 'RAILGUN_SESSION_REVOKED',
        exitCode: 15,
        escalated: false,
        peerDisconnected: false,
      }))
    );
    await closeWrapperClients();
    await services.close();
    assert.equal(services.report().pendingRequests, 0);
    assert.equal(services.report().transportCreates, services.report().transportCloses);
    assert.equal(services.report().unexpectedTransportFailures, 0);
    storeObserver.close();
    assert.equal(storeObserver.report().unwiped, 0);
    sticky.assertEmpty();
    assert.deepEqual(inventory(), sourceHashes);
    const report = {
      schema: facadeMode
        ? 'railgun-two-kohaku-instances-native-v1'
        : signStop
          ? 'railgun-combined-second-sign-stop-native-v1'
          : recoverStop
            ? 'railgun-combined-second-recover-stop-native-v1'
            : proveStop
              ? 'railgun-combined-second-proved-native-v1'
              : coldSubmit
                ? 'railgun-combined-second-cold-submit-native-v1'
                : restartResume
                  ? 'railgun-combined-change-restart-native-v1'
                  : terminalMode
                    ? 'railgun-combined-poi-second-ingest-native-v1'
                    : secondSpendMode
                      ? 'railgun-combined-poi-second-spend-native-v1'
                      : changeMode
                        ? 'railgun-combined-poi-change-native-v1'
                        : 'railgun-combined-poi-native-v1',
      runID,
      ...(restartSetup ? { setupPID: process.pid } : {}),
      ...(proveStop ? { provePID: process.pid } : {}),
      ...(coldSubmit && !recoveredSubmit ? { provePID: restored.handoff.provePID } : {}),
      ...(signStop ? { signPID: process.pid } : {}),
      ...(recoverStop || recoveredSubmit
        ? {
            signPID: restored.handoff.signPID,
            recoverPID: recoverStop ? process.pid : restored.handoff.recoverPID,
          }
        : {}),
      ...(restartResume
        ? {
            setupPID: restored.handoff.setupPID,
            resumePID: process.pid,
            bootstrap: restartBootstrap,
            coldStorageWrites: coldStorage.report(),
          }
        : {}),
      restartSetup,
      restartResume,
      secondProveStopQualified: proveStop,
      secondSignStopQualified: signStop,
      secondRecoveryStopQualified: recoverStop,
      changeMode,
      secondSpendMode,
      terminalMode,
      connected,
      combinedChain: postChain.report(),
      roleMethods,
      utilityAudit: audit.snapshot(),
      storageKeyObservation: storeObserver.report(),
      phaseTimings: copyTimings(),
      fixtureAssertions: sticky.report(),
      expectedUtilityFailures,
      sourceSha256: sha(sourceBytes),
      sourceHashes,
      inputCreator,
      testCase,
      runs,
      keys,
      jobs,
      guards,
      childResults,
      workerStarts,
      workerResults,
      eoa,
      methods,
      services: services.report(),
      genuinePartialProofAndCompletion: !restartResume,
      genuineRpcClientsAndDestinationConstraints: true,
      syntheticInterceptedTransport: true,
      delegatingGenuineVaultSignerObserver: true,
      genuineSubmissionFreshVerifierAndPreflight: !stopWithoutSubmission,
      genuineEoaSignerAndJournalExercised: !stopWithoutSubmission && testCase !== 'bad-verifier',
      receiptResolutionExercised: !stopWithoutSubmission && testCase !== 'bad-verifier',
      wrapperTransport: { ...wrapperTransport },
      simulatedChainAndServices: true,
      receiptAndFinalitySynthetic: true,
      namedTreasuryPolicyOnly: true,
      realTorOrLiveSubmissionQualified: false,
      partialFacadeQualified: false,
      partialPoiLifecycleQualified: false,
      combinedPoiRetainedFirstStageQualified: !restartResume,
      legacyMixedV1V2MigrationNativeQualified: false,
      hostOsEgressTraced: false,
      hostTransportFactoryIntercepted: true,
      utilityRuntimeGuardsExercised: true,
      sourceAndMirrorActualFirstTransaction: true,
      changeEligibilityEstablished: false,
      disposableChangeMembershipQualified: changeMode,
      normalChangeScanQualified: changeMode && !restartResume,
      actualServiceAcceptance: false,
      ...(changeMode
        ? {
            changeCreditedByNormalScan: !restartResume,
            restoredPreviouslyScannedChange: restartResume,
          }
        : { noChangeCreditingOrSecondSpendClaim: true }),
      secondSpendQualified: secondSpendMode,
      secondColdSubmitQualified: coldSubmit,
      twoKohakuInstancesQualified: facadeMode,
      ...(facadeMode ? { facadeInstances: facade.report(), firstFacade: facadeFirstReport } : {}),
      secondSpendWalletIngestionQualified: terminalMode,
      newProcessRestartQualified: restartResume && !stopWithoutSubmission,
      secondSignedUnfinishedRecoveryQualified: recoveredSubmit,
      unchangedOriginalCapsuleSignatureProofAndSigningHold: true,
      elapsedMs: Math.round(performance.now() - started),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 524288);
    fs.writeFileSync(reportFilename, JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    if (restartSetup)
      sealRestart = () =>
        restartData.seal({
          directory,
          wire: restartWire,
          report,
          sourceHashes,
          runtimes,
          sourceSha256: sha(sourceBytes),
          runID,
        });
    if (proveStop)
      sealRestart = () =>
        require('./fixtures/railgun-combined-poi-second-handoff').seal({
          directory,
          predecessor: restored.handoff,
          report,
          ...secondSealed,
        });
    if (signStop || recoverStop)
      sealRestart = () =>
        require('./fixtures/railgun-combined-poi-second-recovery-data')[
          signStop ? 'sealSigned' : 'sealRecovered'
        ]({
          directory,
          predecessor: restored.handoff,
          report,
          ...secondSealed,
        });
    if (!restartSetup && !stopWithoutSubmission)
      console.log(JSON.stringify({ status: 'qualified', elapsedMs: report.elapsedMs }));
  } finally {
    recovery?.close();
    completion?.close();
    staged?.close();
    for (const constraint of constraints) constraint.close();
    preview?.close();
    journalScope?.close();
    try {
      await account?.close();
    } finally {
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
          await bounded(Promise.all([...children].map((child) => child.closed)));
          for (const worker of workers) worker.close();
          await bounded(Promise.all([...workers].map((worker) => worker.closed)));
          await closeWrapperClients();
          await services.close();
          storeObserver.close();
          coldStorage?.close();
          for (const restore of restoreTimings) restore();
          facade?.close();
          signers.getSigner = originalSigner;
          runtime.startRailgunProcess = originalStart;
          sessionModule.startRailgunSessionWorker = originalSession;
          sessionModule.startRailgunReadOnlySessionWorker = originalReadOnlySession;
          if (!fs.existsSync(reportFilename))
            fs.writeFileSync(
              path.join(
                directory,
                signStop
                  ? 'second-sign-diagnostic.json'
                  : recoverStop
                    ? 'second-recover-diagnostic.json'
                    : proveStop
                      ? 'second-prove-diagnostic.json'
                      : coldSubmit
                        ? 'second-submit-diagnostic.json'
                        : restartResume
                          ? 'restart-diagnostic.json'
                          : 'diagnostic.json'
              ),
              JSON.stringify(
                {
                  phase,
                  keys,
                  jobs,
                  childResults,
                  eoa,
                  methods,
                  services: services.report(),
                  secondTransport: lastSecondTransportReport,
                  ...(secondColdRefusalStage ? { secondColdRefusalStage } : {}),
                  ...(secondColdRetryDifferences.length ? { secondColdRetryDifferences } : {}),
                  fixtureAssertions: sticky.report(),
                },
                null,
                2
              ) + '\n',
              { flag: 'wx', mode: 0o600 }
            );
        }
      }
    }
  }
}
main().then(
  () => {
    try {
      const released = releaseProfileLock(lock);
      if (sealRestart) assert.equal(released, true);
      sealRestart?.();
      if (sealRestart)
        console.log(JSON.stringify({ status: 'qualified', phase: 'restart-sealed' }));
      app.exit(0);
    } catch (error) {
      const location = String(error?.stack ?? '').match(
        /railgun-combined-poi-restart-data\.js:(\d+):\d+/
      );
      console.error(
        JSON.stringify({ status: 'refused', phase: 'restart-seal', line: location?.[1] ?? null })
      );
      app.exit(1);
    }
  },
  (error) => {
    const line = String(error?.stack ?? '')
      .split('\n')
      .map((part) =>
        part.match(
          /(qualify-railgun-combined-poi-lifecycle|railgun-combined-poi-(?:chain|lifecycle|row-job|store-observer|change-scan|change-inventory|list-acceptance|second-chain|second-spend|terminal-data|terminal-ingest|restart|restart-data|restart-storage|list-replay|second-handoff|second-cold|second-cold-counts|second-sign-counts|second-signature-stop|second-recovery|second-recovery-data|second-recovery-storage)|railgun-kohaku-second-instance)\.js:(\d+):\d+/
        )
      )
      .find(Boolean);
    console.error(
      JSON.stringify({
        status: 'refused',
        phase,
        assertionFile: line ? line[1] : null,
        assertionLine: line ? Number(line[2]) : null,
        fixtureViolations: sticky.report().length,
      })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
