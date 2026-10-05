/** Offline partial EOA submission and capture over genuinely scanned, disposable
 * enrolled accounts. Service/RPC responses and list signing trust are fixtures;
 * account, POI/preflight hosts, reservations, signer and A/B/C are production.
 * electron script SOURCE NEW_DIRECTORY ENGINE PROVER ARTIFACTS BYTECODES [Shield|Transact] [acknowledged|lost-response|bad-verifier|preparation-review-close|transaction-review-close] [direct|kohaku]
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { Interface, Transaction } = require('ethers');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const OFFSET = 5944700;
let lock,
  phase = 'setup';
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
  assert.ok(args.length >= 6 && args.length <= 9);
  const [sourceFilename, directory, archive, proverArchive, artifactDirectory, bytecodes] = args;
  const inputCreator = args[6] ?? 'Shield';
  assert.ok(['Shield', 'Transact'].includes(inputCreator));
  const testCase = args[7] ?? 'acknowledged';
  const route = args[8] ?? 'direct';
  assert.ok(['direct', 'kohaku'].includes(route));
  const facadeRoute = route === 'kohaku';
  const cancellationCase = ['preparation-review-close', 'transaction-review-close'].includes(
    testCase
  );
  assert.ok(
    ['acknowledged', 'lost-response', 'bad-verifier'].includes(testCase) ||
      (facadeRoute && inputCreator === 'Shield' && cancellationCase)
  );
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
    if (facadeRoute) {
      const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, {
          withFileTypes: true,
        })) {
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(filename);
          else if (entry.isFile() && /\.(js|json)$/.test(entry.name)) files.push(filename);
        }
      };
      walk(path.join(__dirname, '../src/main'));
    }
    return Object.fromEntries(
      [...new Set(files)]
        .sort()
        .map((file) => [
          path.relative(path.join(__dirname, '..'), file),
          sha(fs.readFileSync(file)),
        ])
    );
  };
  const sourceHashes = inventory();
  let facadeRuntimePins;
  if (facadeRoute) {
    const engineManifest = require('../src/main/wallet/railgun-engine-manifest.json');
    const proverManifest = require('../src/main/wallet/railgun-prover-manifest.json');
    const archiveFs = require('original-fs');
    const engineSha256 = sha(archiveFs.readFileSync(archive)),
      proverSha256 = sha(archiveFs.readFileSync(proverArchive));
    assert.equal(engineSha256, engineManifest.sha256);
    assert.equal(proverSha256, proverManifest.sha256);
    facadeRuntimePins = {
      engineSha256,
      proverSha256,
      publicVectorSha256: sha(sourceBytes),
      bytecodeInputSha256: sha(fs.readFileSync(bytecodes)),
      engineInventorySha256: engineManifest.inventory.sha256,
      proverInventorySha256: proverManifest.inventorySha256,
    };
  }
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
    worker.closed.then((result) => {
      workers.delete(worker);
      workerResults.push({ readOnly, ...result });
    });
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
  let reservations, capsules;
  runtime.startRailgunProcess = (options) => {
    const job = path.basename(options.filename),
      launchPhase = phase,
      broker = options.broker;
    jobs[job] = (jobs[job] || 0) + 1;
    const task = originalStart({
      ...options,
      ...(broker
        ? {
            broker: {
              ...broker,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                if (message.method === 'key')
                  keys[message.purpose] = (keys[message.purpose] || 0) + 1;
                const reply = await broker.dispatch(wire);
                if (message.method === 'key') {
                  assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
                  loans.push(reply);
                  if (message.purpose === 'spending-sign') {
                    assert.equal((await reservations.inspect()).signing, 1);
                    const saved = await capsules.inspect();
                    assert.equal(saved.records, 1);
                    assert.equal(saved.signatures, 0);
                    assert.equal(saved.proofs, 0);
                  }
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
                return reply;
              },
            },
          }
        : {}),
    });
    children.add(task);
    task.closed.then((result) => {
      children.delete(task);
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
  const originalTransport = transport.createWalletTorTransport;
  const { getPrivacyContext, createPrivacyScope } = require('../src/main/networks/privacy-context');
  const signers = require('../src/main/wallet/signers'),
    originalSigner = signers.getSigner;
  const rpcCounts = {};
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
    plugin,
    facadeObservers;
  let expectedOwner,
    expectedTransaction,
    signedTransaction,
    receipt,
    transaction,
    reviewedEndpoint,
    changeStartPosition;
  let fixtureCurrent = true;
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
    if (facadeRoute) {
      assert.equal(gross.toString(), preparationSummary.unshieldAmount);
      const preparation = observedProof.stored.capsule.preparation;
      assert.equal(gross.toString(), preparation.unshieldAmount);
      assert.equal(inner.commitments[0], preparation.expected.changeCommitment);
      assert.equal(inner.commitments[1], preparation.expected.unshieldCommitment);
      if (testCase === 'acknowledged') {
        assert.equal(gross, 1n);
        assert.equal(fee, 0n);
      }
    }
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
        assert.equal(eoa.signatureAttempts, 1);
        assert.equal(value.to.toLowerCase(), pins.proxy.toLowerCase());
        assert.equal(value.data, expectedTransaction.data);
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
      pending = 0,
      resolveClosed;
    const drain = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const finish = () => {
      if (closed && pending === 0) resolveClosed();
    };
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
          if (facadeRoute) {
            const label = require('./fixtures/railgun-kohaku-partial-native').rpcLabel(
              subject,
              JSON.parse(options.body)
            );
            rpcCounts[label] = (rpcCounts[label] || 0) + 1;
          }
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
    ...(facadeRoute
      ? {
          rpcCounts: { ...rpcCounts },
          workers: { started: workerStarts, exited: workerResults.length },
        }
      : {}),
  });
  const captureActivity = () => ({
    keys: { ...keys },
    jobs: { ...jobs },
    methods: { ...methods },
    eoa: { ...eoa },
    transportEntries: services.report().transportEntries,
    wrapperEntries: wrapperTransport.entries,
  });
  const facadeTools = facadeRoute ? require('./fixtures/railgun-kohaku-partial-native') : null;
  let observedProof, observedReceiver, observedSubmission, preparationSummary, facadeContext;
  const facadePhases = [];
  const measure = () => ({
    ...snapshot(),
    workers: { started: workerStarts, exited: workerResults.length },
  });
  if (facadeRoute)
    facadeObservers = facadeTools.installObservers({
      onReceiver(options, result) {
        assert.equal(options.identity, identity);
        assert.equal(options.enrollment, enrollment);
        assert.equal(options.recipient, identity.descriptor.instanceId);
        assert.equal(observedReceiver, undefined);
        observedReceiver = result;
      },
      async onProved(options, result) {
        assert.equal(options.owners.identity, identity);
        assert.equal(options.owners.enrollment, enrollment);
        assert.deepEqual(options.request, facadeContext.request);
        assert.equal(result.status, 'proved');
        assert.equal(observedProof, undefined);
        const stored = await capsules.get(result.holdId);
        assert.equal(stored.capsule.noteHash, facadeContext.note.hash);
        facadeTools.assertAmounts({
          summary: preparationSummary,
          stored,
          receiver: observedReceiver,
          ...facadeContext,
          privateRecipient: identity.descriptor.instanceId,
        });
        observedProof = { result, stored };
        expectedTransaction = stored.provedTransaction;
      },
      onSubmitted(options, result) {
        assert.equal(options.identity, identity);
        assert.equal(options.enrollment, enrollment);
        assert.equal(options.completion, observedProof.result.completion.receipt);
        assert.equal(observedSubmission, undefined);
        observedSubmission = result;
      },
    });
  const vault = require('../src/main/identity/vault');
  const started = performance.now();
  const runs = [];
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
    await services.setSelected({
      archive,
      enrollment,
      record: selected,
      submitter: recipient,
      merkleRoot: baseline.trees.find((tree) => tree.tree === note.tree).root,
    });
    expectedOwner = recipient;
    let proved, stored, savedBefore, token, broadcaster;
    const inspectStored = () =>
      reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        assert.equal(records.length, 1);
        assert.equal(records[0].entry.state, 'signing');
        assert.deepEqual(await capsules.readSigned(records[0].receipt), stored);
        return records[0].entry;
      });
    const finalizeControl = async () => {
      await plugin.closed;
      const before = measure();
      await publicAccount.close();
      publicAccount = null;
      enrollment.close();
      identity.close();
      vault.lockVault();
      await bounded(Promise.all([...children].map((child) => child.closed)));
      await bounded(Promise.all([...workers].map((worker) => worker.closed)));
      assert.equal(children.size, 0);
      assert.equal(workers.size, 0);
      assert.equal(workerResults.length, workerStarts);
      assert.ok(workerResults.every((result) => result.exitCode === 0));
      assert.ok(
        childResults.every(
          (result) => result.code === 'RAILGUN_PROCESS_CLOSED' && Number.isInteger(result.exitCode)
        )
      );
      assert.ok(loans.every((key) => key.every((byte) => byte === 0)));
      await closeWrapperClients();
      await services.close();
      assert.equal(services.report().pendingRequests, 0);
      assert.equal(services.report().unexpectedTransportFailures, 0);
      assert.deepEqual(inventory(), sourceHashes);
      const expected = {
        jobs: {},
        keys: {},
        methods: {},
        rpcCounts: {},
        eoa: {},
        workers: { exited: 2 },
      };
      facadeTools.assertCounts(before, measure(), expected);
      facadePhases.push({ phase: 'control-final-close', expected, before, after: measure() });
      fs.writeFileSync(
        path.join(directory, 'report.json'),
        JSON.stringify(
          {
            schema: 'railgun-kohaku-partial-control-native-v1',
            sourceHashes,
            route,
            inputCreator,
            testCase,
            runs,
            facadePhases,
            observerCounts: { ...facadeObservers.counts },
            keys,
            jobs,
            methods,
            eoa,
            workers: { started: workerStarts, exited: workerResults.length },
            childResults,
            services: services.report(),
            wrapperTransport,
            runtimeVersions: process.versions,
            runtimePins: facadeRuntimePins,
            noLiveNetwork: true,
            syntheticChainAndListTrust: true,
            allOriginalCallbacksChildrenWorkersAndLoansDrained: true,
            physicalSocketDrainQualified: false,
            partialFacadeSubmissionQualified: false,
          },
          null,
          2
        ) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
    };
    if (facadeRoute) {
      const setupExpected = facadeTools.setupCounts(source, anchor, transact);
      facadeTools.assertCounts(
        Object.fromEntries(Object.keys(setupExpected).map((key) => [key, {}])),
        measure(),
        setupExpected
      );
      facadePhases.push({
        phase: 'setup',
        expected: setupExpected,
        after: measure(),
      });
      const amount = testCase === 'acknowledged' ? 1n : note.amount / 2n;
      facadeContext = {
        note,
        amount,
        recipient,
        request: Object.freeze({
          kind: 'railgun-partial-unshield',
          noteId: selected.id,
          recipient,
          unshieldAmount: amount.toString(),
        }),
      };
      const preparationEntered = facadeTools.deferred(),
        preparationRelease = facadeTools.deferred();
      const transactionEntered = facadeTools.deferred(),
        transactionRelease = facadeTools.deferred();
      const { createRailgunKohakuPlugin } = require('../src/main/wallet/railgun-kohaku-plugin');
      assert.deepEqual(await capsules.inspect(), {
        records: 0,
        signatures: 0,
        proofs: 0,
        capacity: 32,
      });
      const beforePrepare = measure();
      const expectPrepare = facadeTools.prepareCounts(transact);
      plugin = createRailgunKohakuPlugin({
        account,
        owners,
        signal: enrollment.signal,
        mode: 'private',
        archive,
        proverArchive,
        artifactDirectory,
        gasLimit: 1500000n,
        maxGasFee: 2000000000000000n,
        reviewPreparation: async (summary) => {
          assert.equal(preparationSummary, undefined);
          preparationSummary = summary;
          assert.equal(summary.inputType, inputCreator);
          assert.equal(summary.inputAmount, note.amount.toString());
          assert.equal(summary.unshieldAmount, amount.toString());
          assert.equal(summary.changeAmount, (note.amount - amount).toString());
          assert.equal(
            summary.destinations.protocolRpc,
            'https://synthetic.invalid/railgun-partial-controller'
          );
          assert.equal(summary.destinations.transactionRpc, summary.destinations.protocolRpc);
          assert.equal(summary.destinations.retainedSource, summary.destinations.protocolRpc);
          reviewedEndpoint = summary.destinations.transactionRpc;
          facadeTools.assertCounts(beforePrepare, measure(), {
            jobs: {},
            keys: {},
            methods: {},
            rpcCounts: {},
            workers: {},
            eoa: { addressAttempts: 1 },
          });
          preparationEntered.resolve();
          return testCase === 'preparation-review-close' ? preparationRelease.promise : true;
        },
        reviewTransaction: async (request) => {
          eoa.reviews++;
          assert.equal(methods.eth_estimateGas, 1);
          assert.equal(methods.eth_call, 1);
          assert.equal(eoa.sends, 0);
          assert.equal(eoa.signatureAttempts, 0);
          assert.equal(request.operation, 'railgun-partial-unshield');
          assert.equal(request.transaction.data, expectedTransaction.data);
          assert.equal(request.from.toLowerCase(), recipient);
          transactionEntered.resolve();
          return testCase === 'transaction-review-close' ? transactionRelease.promise : true;
        },
      });
      broadcaster =
        require('../src/main/wallet/railgun-kohaku-broadcaster').createRailgunKohakuBroadcaster(
          plugin
        );
      phase = 'facade-prepare';
      const preparing = plugin.prepareUnshield(
        {
          asset: { __type: 'erc20', contract: pins.wrappedNative },
          amount,
          noteId: selected.id,
        },
        recipient
      );
      if (testCase === 'preparation-review-close') {
        try {
          await facadeTools.heldClose({
            plugin,
            entered: preparationEntered,
            release: preparationRelease,
            pending: preparing,
            owners,
            closeAccount: () => account.close(),
            bounded,
            snapshot: measure,
            runs,
            name: 'held-preparation-review-close',
          });
        } finally {
          preparationRelease.resolve(true);
        }
        assert.deepEqual(facadeObservers.counts, {
          prove: 0,
          receiver: 0,
          submit: 0,
        });
        assert.deepEqual(await capsules.inspect(), {
          records: 0,
          signatures: 0,
          proofs: 0,
          capacity: 32,
        });
        account = null;
        await finalizeControl();
        return;
      }
      token = await preparing;
      facadeTools.assertCounts(beforePrepare, measure(), expectPrepare);
      assert.deepEqual(facadeObservers.counts, {
        prove: 1,
        receiver: 1,
        submit: 0,
      });
      facadePhases.push({
        phase: 'prepare',
        expected: expectPrepare,
        before: beforePrepare,
        after: measure(),
      });
      proved = observedProof.result;
      stored = observedProof.stored;
      assert.deepEqual(await capsules.inspect(), {
        records: 1,
        signatures: 1,
        proofs: 1,
        capacity: 32,
      });
      const beforeCopy = measure();
      await assert.rejects(broadcaster.broadcast({ ...token }));
      await assert.rejects(broadcaster.broadcast(Object.freeze({ __type: 'privateOperation' })));
      facadeTools.assertCounts(beforeCopy, measure(), {
        jobs: {},
        keys: {},
        methods: {},
        rpcCounts: {},
      });
      assert.deepEqual(measure(), beforeCopy);
      assert.equal(facadeObservers.counts.submit, 0);
      runs.push({
        mode: 'copied-unregistered-token',
        zeroDownstreamAdmission: true,
        originalTokenRetained: true,
        noFabricatedForeignPlugin: true,
        synchronousRefusalNoBorrowedWork: true,
      });
      if (testCase === 'transaction-review-close') {
        const before = measure();
        const pending = broadcaster.broadcast(token);
        try {
          await facadeTools.heldClose({
            plugin,
            entered: transactionEntered,
            release: transactionRelease,
            pending,
            owners,
            closeAccount: () => account.close(),
            bounded,
            snapshot: measure,
            runs,
            name: 'held-final-transaction-review-close',
          });
        } finally {
          transactionRelease.resolve(true);
        }
        facadeTools.assertCounts(before, measure(), facadeTools.submitCounts(testCase));
        facadePhases.push({
          phase: 'held-final-transaction-review-close',
          expected: facadeTools.submitCounts(testCase),
          before,
          after: measure(),
        });
        assert.deepEqual(facadeObservers.counts, {
          prove: 1,
          receiver: 1,
          submit: 1,
        });
        savedBefore = await inspectStored();
        assert.ok(savedBefore);
        assert.equal(eoa.signatureAttempts, 0);
        assert.equal(eoa.sends, 0);
        account = null;
        await finalizeControl();
        return;
      }
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
      proved =
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
      savedBefore = await reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        assert.equal(records.length, 1);
        const entry = records[0];
        assert.equal(entry.entry.state, 'signing');
        assert.deepEqual(await capsules.readSigned(entry.receipt), stored);
        return entry.entry;
      });
    }
    const captureSelector = Object.fromEntries(
      ['tree', 'position', 'nullifier', 'noteHash'].map((key) => [
        key,
        facadeRoute
          ? {
              tree: stored.capsule.selection.tree,
              position: stored.capsule.selection.position,
              nullifier: stored.capsule.preparation.expected.nullifier,
              noteHash: stored.capsule.noteHash,
            }[key]
          : savedBefore.facts[key],
      ])
    );
    const capture = () =>
      require('../src/main/wallet/railgun-own-operation').captureRailgunOwnOperation({
        enrollment,
        selector: captureSelector,
        signal: enrollment.signal,
      });
    const submit =
      require('../src/main/wallet/railgun-private-submission').submitRailgunPrivateTransaction;
    const submitOptions = {
      identity,
      enrollment,
      completion: completion?.receipt,
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
    if (!facadeRoute) {
      phase = 'copied-completion';
      const beforeCopy = snapshot();
      assert.deepEqual(await submit({ ...submitOptions, completion: { ...completion.receipt } }), {
        status: 'recovery-required',
        stage: 'completion',
      });
      assert.deepEqual(snapshot(), beforeCopy);
    }
    phase = 'submit';
    if (testCase === 'bad-verifier') services.setMode('wrong-verifier');
    const beforeSubmit = snapshot();
    const submitted = facadeRoute
      ? await broadcaster.broadcast(token)
      : await submit(submitOptions);
    if (facadeRoute) {
      await bounded(plugin.closed);
      account = null;
      assert.equal(submitted, observedSubmission);
      assert.deepEqual(facadeObservers.counts, {
        prove: 1,
        receiver: 1,
        submit: 1,
      });
      facadeTools.assertCounts(beforeSubmit, snapshot(), facadeTools.submitCounts(testCase));
      facadePhases.push({
        phase: 'submit',
        expected: facadeTools.submitCounts(testCase),
        before: beforeSubmit,
        after: snapshot(),
      });
      savedBefore = await inspectStored();
    }
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
    if (facadeRoute) {
      await assert.rejects(broadcaster.broadcast(token));
      assert.equal(facadeObservers.counts.submit, 1);
      await bounded(plugin.closed);
      runs.push({
        mode: 'replay-after-broadcast',
        zeroAdditionalSend: true,
        closedObserved: true,
        originalCallbacksDrained: true,
      });
    } else
      assert.deepEqual(await submit(submitOptions), {
        status: 'recovery-required',
        stage: 'completion',
      });
    assert.deepEqual(snapshot(), beforeReplay);
    completion?.close();
    completion = null;
    for (const constraint of constraints) constraint.close();
    preview?.close();
    preview = null;
    const beforeRetainedRecovery = facadeRoute ? measure() : null;
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
      phase = 'missing-poi-authority';
      const gatesBefore = captureActivity();
      // Capture alone supplies neither genuine membership nor retained proof
      // history. The combined-POI qualifier owns that separate lifecycle.
      const missingMembership =
        await require('../src/main/wallet/railgun-own-poi-proof').proveRailgunOwnPoi({
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          archive,
          proverArchive,
          artifactDirectory,
          membershipReceipt: undefined,
          signal: enrollment.signal,
        });
      assert.deepEqual(missingMembership, { status: 'refused', stage: 'context' });
      // Use the genuine capsule digest and existing-only opener without
      // fabricating retained history or exercising partial admission.
      const missingRetained =
        await require('../src/main/wallet/railgun-poi-output-recovery').recoverRailgunPoiOutput({
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          archive,
          capsuleDigest: active.capture.capsuleDigest,
          signal: enrollment.signal,
        });
      assert.deepEqual(missingRetained, { status: 'refused', stage: 'stored' });
      const gatesAfter = captureActivity();
      assert.deepEqual(gatesAfter.jobs, gatesBefore.jobs);
      assert.deepEqual(gatesAfter.keys, gatesBefore.keys);
      assert.deepEqual(gatesAfter.methods, gatesBefore.methods);
      assert.deepEqual(gatesAfter.eoa, gatesBefore.eoa);
      assert.equal(gatesAfter.transportEntries, gatesBefore.transportEntries);
      assert.equal(gatesAfter.wrapperEntries, gatesBefore.wrapperEntries);
      assert.equal(jobs['railgun-own-poi-prove-job.js'] || 0, 0);
      assert.equal(jobs['railgun-poi-output-recover-job.js'] || 0, 0);
      runs.push({
        mode: 'missing-poi-authority',
        partialMembershipAdmissionExercised: false,
        zeroNewRpcOrCredentials: true,
        keylessSelectorJobDelta: 0,
        zeroNewProofOrOutputJobs: true,
        proofMissingGenuineMembershipRefused: true,
        proofInnerPartialGuardNativeExercised: false,
        outputMissingRetainedHistoryRefused: true,
        outputInnerPartialGuardNativeExercised: false,
        noFabricatedMembershipOrRetainedRecord: true,
      });
      phase = 'archive';
      const ready = (await journal.list())[0],
        now = Date.now;
      const archiveClockOffsetMs = 2 * 86400000,
        archiveRealStart = now(),
        patchStarted = performance.now();
      let archiveClockPatchDurationMs;
      try {
        // This process-global fixture clock persists archivedAt two days ahead.
        Date.now = () => now() + archiveClockOffsetMs;
        await journal.archiveResolved(
          [{ hash: ready.hash, revision: ready.revision }],
          [{ blockNumber: finalized + 1, blockHash: header(finalized + 1).hash }]
        );
      } finally {
        Date.now = now;
        archiveClockPatchDurationMs = performance.now() - patchStarted;
      }
      const archiveRealEnd = now();
      const archived = await capture();
      assert.equal(archived.status, 'captured');
      assert.equal(archived.capture.bindingDigest, active.capture.bindingDigest);
      assert.equal(typeof archived.capture.record.archivedAt, 'number');
      const archivedAt = archived.capture.record.archivedAt;
      assert.ok(archivedAt >= archiveRealStart + archiveClockOffsetMs);
      assert.ok(archivedAt <= archiveRealEnd + archiveClockOffsetMs);
      assert.ok(
        Math.abs(archivedAt - archiveRealEnd - archiveClockOffsetMs) <=
          archiveRealEnd - archiveRealStart
      );
      phase = 'cold-store-reopen';
      await publicAccount.close();
      publicAccount = null;
      journalScope.close();
      journalScope = null;
      enrollment.close();
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity }
        );
      journal = openJournal();
      const cold = await capture();
      assert.equal(cold.status, 'captured');
      assert.deepEqual(cold.capture, archived.capture);
      assert.deepEqual(captureActivity(), gatesAfter);
      runs.push({
        mode: 'strict-resolution-and-capture',
        strictFiveLogs: true,
        activeCaptured: true,
        archivedStableBinding: true,
        sameProcessColdStoreReopen: true,
        noCaptureRpcKeyOrCrypto: true,
        captureAuthorityGranted: false,
        archivedAtForwardDatedByFixtureClockMs: archiveClockOffsetMs,
        archivedAtAheadOfRealClockMs: archivedAt - archiveRealEnd,
        processGlobalArchiveClockPatchDurationMs: archiveClockPatchDurationMs,
        receiptChangePosition: changeStartPosition,
        receiptChangePositionIndependentlyTreeVerified: false,
      });
    }
    phase = 'private-history';
    ({ reservations, capsules } = await enrollment.openPrivateRecoveryStores());
    await reservations.withSigningRecovery(async (records, context) => {
      context.assertCurrent();
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].entry, savedBefore);
      assert.deepEqual(await capsules.readSigned(records[0].receipt), stored);
    });
    assert.equal(keys['spending-sign'], 1);
    assert.equal(eoa.sends, testCase === 'bad-verifier' ? 0 : 1);
    assert.equal(eoa.unexpectedFailures, 0);
    assert.equal(jobs['railgun-private-operate-job.js'], 1);
    assert.equal(jobs['railgun-spend-sign-job.js'], 1);
    assert.equal(jobs['railgun-private-verify-job.js'], 2);
    assert.equal(jobs['railgun-private-receive-job.js'], 1);
    assert.equal(jobs['railgun-private-recover-job.js'] || 0, 0);
    assert.ok(loans.every((key) => key.every((value) => value === 0)));
    if (facadeRoute) {
      const expected = facadeTools.recoveryCounts(testCase === 'bad-verifier');
      facadeTools.assertCounts(beforeRetainedRecovery, measure(), expected);
      facadePhases.push({
        phase: 'retained-recovery',
        expected,
        before: beforeRetainedRecovery,
        after: measure(),
      });
    }
    const beforeFinalClose = facadeRoute ? measure() : null;
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
    assert.ok(
      childResults.every(
        (child) => child.code === 'RAILGUN_PROCESS_CLOSED' && Number.isInteger(child.exitCode)
      )
    );
    await closeWrapperClients();
    await services.close();
    assert.equal(services.report().pendingRequests, 0);
    assert.equal(services.report().transportCreates, services.report().transportCloses);
    assert.equal(services.report().unexpectedTransportFailures, 0);
    assert.deepEqual(inventory(), sourceHashes);
    if (facadeRoute) {
      const expected = {
        jobs: {},
        keys: {},
        methods: {},
        rpcCounts: {},
        eoa: {},
        workers: testCase === 'bad-verifier' ? { exited: 2 } : {},
      };
      facadeTools.assertCounts(beforeFinalClose, measure(), expected);
      facadePhases.push({
        phase: 'final-close',
        expected,
        before: beforeFinalClose,
        after: measure(),
      });
    }
    const report = {
      schema: 'railgun-partial-submission-native-v1',
      ...(facadeRoute
        ? {
            route,
            facadePhases,
            observerCounts: { ...facadeObservers.counts },
            actualPartialCapsuleAmountsMatched: true,
            genuineChangeReceiverConservationMatched: true,
            partialPreparationSummaryMatched: true,
            receiptGrossAndOrderedCommitmentsMatched: testCase !== 'bad-verifier',
            actualRailgunContractExecutionQualified: false,
            facadeActivationQualified: false,
            runtimeVersions: process.versions,
            runtimePins: facadeRuntimePins,
          }
        : {}),
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
      genuinePartialProofAndCompletion: true,
      genuineRpcClientsAndDestinationConstraints: true,
      syntheticInterceptedTransport: true,
      delegatingGenuineVaultSignerObserver: true,
      genuineSubmissionFreshVerifierAndPreflight: true,
      genuineEoaSignerAndJournalExercised: testCase !== 'bad-verifier',
      receiptResolutionExercised: testCase !== 'bad-verifier',
      wrapperTransport: { ...wrapperTransport },
      simulatedChainAndServices: true,
      receiptAndFinalitySynthetic: true,
      namedTreasuryPolicyOnly: true,
      realTorOrLiveSubmissionQualified: false,
      partialFacadeQualified: facadeRoute,
      ...(facadeRoute
        ? {
            countContract: 'source-predicted-jobs-keys-storage-workers-all-role-rpc-eoa',
            durableStorageQualified: 'authenticated-record-state-and-unchanged-originals',
            sqlStatementOrFsyncCountsQualified: false,
            transportAllocationAndGuardHookCounts: 'observed-only-not-qualified-by-count-contract',
          }
        : {}),
      partialPoiLifecycleQualified: false,
      noChangeCreditingOrSecondSpendClaim: true,
      newProcessRestartQualified: false,
      unchangedOriginalCapsuleSignatureProofAndSigningHold: true,
      elapsedMs: Math.round(performance.now() - started),
    };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ status: 'qualified', elapsedMs: report.elapsedMs }));
  } finally {
    plugin?.close();
    if (plugin) await bounded(plugin.closed);
    facadeObservers?.close();
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
          signers.getSigner = originalSigner;
          runtime.startRailgunProcess = originalStart;
          sessionModule.startRailgunSessionWorker = originalSession;
          sessionModule.startRailgunReadOnlySessionWorker = originalReadOnlySession;
          if (!fs.existsSync(path.join(directory, 'report.json')))
            fs.writeFileSync(
              path.join(directory, 'diagnostic.json'),
              JSON.stringify(
                { phase, keys, jobs, childResults, eoa, methods, services: services.report() },
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
