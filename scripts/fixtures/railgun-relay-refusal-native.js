/** Default-off disposable Shield refusal campaign. All service responses are
 * synthetic in-memory fixtures. Production trust pins and owner APIs are unchanged. */
const native = require('./railgun-native-assertions');
const { assert } = native;
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const network = '../../src/main/networks/';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const SOURCE_SHA = 'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41';
const OFFSET = 5944700;
const THROUGH = OFFSET + 30;
const ANCHOR = OFFSET + 100;
const SCENARIOS = ['declined-disclosure', 'unrelated-history'];
const hex = (v) => '0x' + v.toString(16).padStart(64, '0');
function select(flag, args, env) {
  if (flag === undefined) return null;
  assert.ok(SCENARIOS.includes(flag));
  assert.equal(args.length, 6);
  const [sourceFilename, directory, archive, composition, proverArchive, artifactDirectory] = args;
  assert.equal(composition, 'enrolled');
  for (const p of [sourceFilename, directory, archive, proverArchive, artifactDirectory])
    assert.ok(typeof p === 'string' && path.isAbsolute(p));
  for (const key of Object.keys(env))
    if (key.startsWith('FREEDOM_RAILGUN_') && key !== 'FREEDOM_RAILGUN_RELAY_REFUSAL')
      assert.equal(env[key], undefined);
  return { scenario: flag, sourceFilename, directory, archive, proverArchive, artifactDirectory };
}
function translate(bytes) {
  assert.equal(sha(bytes), SOURCE_SHA);
  const original = JSON.parse(bytes);
  assert.deepEqual(
    original.logs.map((v) => v.blockNumber),
    [10, 20, 30]
  );
  const logs = original.logs.map((v) => ({
    ...v,
    blockNumber: OFFSET + v.blockNumber,
    blockHash: hex(OFFSET + v.blockNumber + 1),
    transactionHash: hex(OFFSET + v.blockNumber + 1000),
  }));
  return { logs, originalSha256: sha(bytes), translatedSha256: sha(JSON.stringify(logs)) };
}
function ranges() {
  const values = [];
  for (let from = 0; from <= THROUGH; from += 100000)
    values.push({ from, to: Math.min(from + 99999, THROUGH) });
  assert.equal(values.length, 60);
  return values;
}
function installServices(logs, expectedNote, scenario) {
  for (const name of [
    'railgun-account-public',
    'railgun-poi-source',
    'railgun-public-services',
    'railgun-poi-root',
    'railgun-private-preflight',
    'railgun-shield-preflight',
  ])
    assert.equal(!!require.cache[require.resolve(wallet + name)], false);
  const rpc = require(network + 'private-rpc');
  const transport = require(network + 'wallet-tor-transport');
  const settings = require('../../src/main/settings-store');
  const tor = require('../../src/main/tor-manager');
  const { getPrivacyContext } = require(network + 'privacy-context');
  const { REQUIRED_LIST } = require(wallet + 'railgun-poi-records');
  const originals = [
    rpc.createPrivateRpc,
    transport.createWalletTorTransport,
    settings.isWalletTorExperimentAvailable,
    tor.getWalletSocksEndpoint,
  ];
  const endpoint = Object.freeze({ signal: new AbortController().signal });
  const requests = [],
    poiMethods = [];
  let factories = 0,
    closes = 0;
  const header = (n) => ({ number: '0x' + n.toString(16), hash: hex(n + 1), parentHash: hex(n) });
  const rpcFactory = (handle, _role, options = {}) => {
    const signal = AbortSignal.any([
      getPrivacyContext(handle).signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const active = () => {
      getPrivacyContext(handle);
      assert.equal(signal.aborted, false);
    };
    return {
      signal,
      trust: { queried: ['synthetic.invalid'] },
      release() {},
      assertActive: active,
      async request(method, params, validate) {
        active();
        requests.push({ method, params: structuredClone(params) });
        let result;
        if (method === 'eth_getLogs') {
          assert.equal(params.length, 1);
          const f = params[0];
          assert.equal(
            f.address.toLowerCase(),
            require(wallet + 'railgun-shield-pins.json').proxy.toLowerCase()
          );
          result = logs
            .filter(
              (v) =>
                v.blockNumber >= Number(BigInt(f.fromBlock)) &&
                v.blockNumber <= Number(BigInt(f.toBlock))
            )
            .map((v) => ({
              ...v,
              blockNumber: '0x' + v.blockNumber.toString(16),
              transactionIndex: '0x0',
              logIndex: '0x0',
            }));
        } else {
          assert.equal(method, 'eth_getBlockByNumber');
          assert.equal(params.length, 2);
          assert.equal(params[1], false);
          const number = params[0] === 'finalized' ? ANCHOR : Number(BigInt(params[0]));
          assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= ANCHOR);
          result = header(number);
        }
        assert.equal(validate(result), true);
        return { result };
      },
    };
  };
  const transportFactory = () => {
    assert.equal(scenario, 'unrelated-history');
    assert.equal(++factories, 1);
    let closed = false,
      resolve;
    const barrier = new Promise((yes) => {
      resolve = yes;
    });
    return {
      closed: barrier,
      close() {
        if (!closed) {
          closed = true;
          closes++;
          resolve();
        }
      },
      async request(handle, url, options) {
        assert.equal(closed, false);
        assert.equal(getPrivacyContext(handle).subject.role, 'poi');
        assert.equal(url, 'https://ppoi.fdi.network');
        assert.equal(options.method, 'POST');
        assert.equal(options.signal.aborted, false);
        const v = JSON.parse(options.body),
          note = expectedNote();
        assert.ok(note && note.type === 'Shield');
        assert.deepEqual(Object.keys(v).sort(), ['id', 'jsonrpc', 'method', 'params']);
        assert.equal(v.jsonrpc, '2.0');
        assert.equal(typeof v.id, 'string');
        const context = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
        let result;
        if (poiMethods.length === 0) {
          assert.equal(v.method, 'ppoi_pois_per_list');
          assert.deepEqual(v.params, {
            ...context,
            listKeys: [REQUIRED_LIST],
            blindedCommitmentDatas: [note],
          });
          result = { [note.blindedCommitment]: { [REQUIRED_LIST]: 'Valid' } };
        } else {
          assert.equal(poiMethods.length, 1);
          assert.equal(v.method, 'ppoi_merkle_proofs');
          assert.deepEqual(v.params, {
            ...context,
            listKey: REQUIRED_LIST,
            blindedCommitments: [note.blindedCommitment],
          });
          result = structuredClone(
            require('../../docs/qualification/railgun-poi-read-2026-10-03.json').serviceObservation
              .proofs
          );
          assert.equal(result.length, 1);
          assert.notEqual('0x' + result[0].leaf, note.blindedCommitment);
        }
        poiMethods.push(v.method);
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: v.id, result })),
        };
      },
    };
  };
  const available = () => true,
    socks = () => endpoint;
  rpc.createPrivateRpc = rpcFactory;
  transport.createWalletTorTransport = transportFactory;
  settings.isWalletTorExperimentAvailable = available;
  tor.getWalletSocksEndpoint = socks;
  return {
    requests,
    poiMethods,
    assertClosed() {
      assert.equal(factories, scenario === 'unrelated-history' ? 1 : 0);
      assert.equal(closes, factories);
      assert.deepEqual(
        poiMethods,
        scenario === 'unrelated-history' ? ['ppoi_pois_per_list', 'ppoi_merkle_proofs'] : []
      );
    },
    restore() {
      assert.equal(rpc.createPrivateRpc, rpcFactory);
      assert.equal(transport.createWalletTorTransport, transportFactory);
      assert.equal(settings.isWalletTorExperimentAvailable, available);
      assert.equal(tor.getWalletSocksEndpoint, socks);
      [
        rpc.createPrivateRpc,
        transport.createWalletTorTransport,
        settings.isWalletTorExperimentAvailable,
        tor.getWalletSocksEndpoint,
      ] = originals;
    },
  };
}
function installJobs() {
  for (const name of [
    'railgun-identity',
    'railgun-public-run',
    'railgun-wallet-run',
    'railgun-relay-quote-verify',
  ])
    assert.equal(!!require.cache[require.resolve(wallet + name)], false);
  const runtime = require(wallet + 'railgun-process'),
    original = runtime.startRailgunProcess;
  const rows = [],
    pending = new Set();
  const observed = function (options, ...rest) {
    const input = JSON.parse(options.input);
    let role;
    if (options.filename === require.resolve(wallet + 'railgun-identity-job')) role = input.purpose;
    else if (options.filename === require.resolve(wallet + 'railgun-public-job'))
      role = 'public-' + input.mode;
    else if (options.filename === require.resolve(wallet + 'railgun-wallet-job'))
      role = input.restore ? 'wallet-restore' : 'wallet-scan';
    else if (options.filename === require.resolve(wallet + 'railgun-relay-quote-job'))
      role = 'quote';
    else if (options.filename === require.resolve(wallet + 'railgun-relay-wallet-job'))
      role = input.relayRequest ? 'construct' : 'reconstruct';
    else assert.fail('Unexpected utility: ' + path.basename(options.filename));
    assert.ok(expectedRoles()[rows.length] === role, 'Unexpected original utility order: ' + role);
    if (rows.length) assert.equal(rows.at(-1).closedObserved, true);
    const row = {
      role,
      inputSha256: sha(options.input),
      messages: 0,
      keyRequests: 0,
      keyReplies: 0,
      results: 0,
      closedObserved: false,
      methods: {},
    };
    rows.push(row);
    const dispatch = function (...args) {
      const message = JSON.parse(args[0]);
      assert.equal(message.id, ++row.messages);
      const method = message.method ?? message.channel + '.' + JSON.parse(message.wire).method;
      row.methods[method] = (row.methods[method] ?? 0) + 1;
      if (['construct', 'reconstruct'].includes(role) && message.channel !== undefined) {
        assert.ok(['public', 'wallet'].includes(message.channel));
        assert.ok(
          ['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end'].includes(
            JSON.parse(message.wire).method
          )
        );
      }
      if (role === 'quote') assert.equal(message.method, 'result');
      if (['spending-public', 'viewing-identity'].includes(role))
        assert.ok(['key', 'result'].includes(message.method));
      if (message.method === 'key') {
        row.keyRequests++;
        const purpose = {
          'spending-public': 'spending-public',
          'viewing-identity': 'viewing-identity',
          'wallet-scan': 'wallet-viewing',
          'wallet-restore': 'wallet-viewing',
          construct: 'relay-prepare',
          reconstruct: 'relay-reconstruct',
        }[role];
        assert.ok(purpose);
        assert.equal(message.purpose, purpose);
      }
      const returned = Reflect.apply(options.broker.dispatch, this, args);
      if (message.method === 'key' || ['result', 'jobResult'].includes(message.method)) {
        const observation = Promise.prototype.then.call(
          returned,
          (reply) => {
            if (message.method === 'key') {
              assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
              row.keyReplies++;
            } else {
              row.results++;
              row.guards = structuredClone(message.guards ?? message.value.guards);
            }
          },
          (error) => {
            native.record(error, 'relay-refusal.broker');
          }
        );
        pending.add(observation);
        observation
          .finally(() => pending.delete(observation))
          .catch((error) => native.record(error, 'relay-refusal.observer'));
      }
      return returned;
    };
    const task = Reflect.apply(original, this, [
      { ...options, broker: { ...options.broker, dispatch } },
      ...rest,
    ]);
    native.observeClosed(
      task.closed,
      (value) => {
        assert.equal(row.results, 1);
        assert.equal(value.code, 'RAILGUN_PROCESS_CLOSED');
        assert.equal(value.exitCode, 15);
        assert.equal(value.escalated, false);
        assert.equal(value.peerDisconnected, false);
        row.closed = structuredClone(value);
        row.closedObserved = true;
      },
      'relay-refusal.' + role
    );
    return task;
  };
  runtime.startRailgunProcess = observed;
  return {
    rows,
    async finish() {
      await Promise.all([...pending]);
      assert.deepEqual(
        rows.map((r) => r.role),
        expectedRoles()
      );
      for (const row of rows) {
        assert.equal(row.closedObserved, true);
        assert.equal(row.results, 1);
        assert.deepEqual(row.guards, require(wallet + 'railgun-relay-quote-data').EXPECTED_GUARDS);
        assert.equal(
          row.keyRequests,
          [
            'spending-public',
            'viewing-identity',
            'wallet-scan',
            'wallet-restore',
            'construct',
            'reconstruct',
          ].includes(row.role)
            ? 1
            : 0
        );
        assert.equal(row.keyReplies, row.keyRequests);
      }
      native.assertEmpty();
    },
    restore() {
      assert.equal(runtime.startRailgunProcess, observed);
      runtime.startRailgunProcess = original;
    },
  };
}
function expectedRoles() {
  return [
    'spending-public',
    'viewing-identity',
    ...ranges().flatMap((range) =>
      range.to < OFFSET + 10 ? ['public-plan'] : ['public-plan', 'public-apply']
    ),
    'wallet-scan',
    'wallet-restore',
    'quote',
    'construct',
    'reconstruct',
  ];
}
function assertOperationRpc(requests) {
  const counts = {};
  for (const row of requests) {
    assert.equal(row.method, 'eth_getBlockByNumber');
    assert.equal(row.params.length, 2);
    assert.equal(row.params[1], false);
    counts[row.params[0]] = (counts[row.params[0]] ?? 0) + 1;
  }
  const expected = Object.fromEntries(
    ['finalized', ...[ANCHOR, 5900000, THROUGH, 5899999].map((v) => '0x' + v.toString(16))].map(
      (tag) => [tag, 3]
    )
  );
  assert.deepEqual(counts, expected);
  return counts;
}
async function qualify({
  account,
  owners,
  archive,
  proverArchive,
  artifactDirectory,
  scenario,
  services,
}) {
  const api = require(wallet + 'railgun-account-wallet');
  const baseline = api.readRailgunAccountOwnedNotes(account, owners);
  const selected = baseline.read.received.filter(
    (v) => v.spentTxid === false && v.amount === 2000n
  );
  assert.equal(selected.length, 1);
  const note = selected[0],
    record = baseline.ownedPoi.find((v) => v.id === note.id);
  assert.ok(record && record.type === 'Shield' && record.blockNumber === OFFSET + 10);
  const reservations = await owners.enrollment.openReservations();
  const recovery = await owners.enrollment.openRelayRecoveryStore();
  const before = {
    private: await reservations.inspect(),
    relay: await reservations.listRelay(recovery),
    recovery: await recovery.inspect(),
  };
  assert.deepEqual(before.relay, []);
  const vectors = require('./railgun-relay-quote-native-vectors').buildVectors(archive, Date.now());
  const rpcBefore = services.requests.length;
  let reviewed = 0,
    disclosed = 0;
  const result = await require(
    wallet + 'railgun-relay-operation'
  ).proveRailgunAccountRelayOperation({
    account,
    owners,
    archive,
    proverArchive,
    artifactDirectory,
    request: {
      noteId: note.id,
      quote: vectors.cases[0].quote,
      gas: vectors.gas,
      maxFee: '100',
      signal: new AbortController().signal,
    },
    review(summary) {
      reviewed++;
      assert.equal(summary.selection.noteId, note.id);
      assert.deepEqual(summary.amounts, { input: '2000', fee: '100', self: '1900', cap: '100' });
      return true;
    },
    reviewDisclosure(summary) {
      disclosed++;
      assert.equal(summary.input.type, 'Shield');
      assert.equal(summary.input.id, note.id);
      assert.equal(summary.input.blindedCommitment, record.blindedCommitment);
      services.selected({ blindedCommitment: record.blindedCommitment, type: 'Shield' });
      return scenario === 'unrelated-history';
    },
  });
  assert.equal(reviewed, 1);
  assert.equal(disclosed, 1);
  assert.deepEqual(result, {
    status: 'refused',
    stage: scenario === 'unrelated-history' ? 'membership' : 'disclosure',
  });
  services.assertClosed();
  const canonicalHeaders = assertOperationRpc(services.requests.slice(rpcBefore));
  const after = {
    private: await reservations.inspect(),
    relay: await reservations.listRelay(recovery),
    recovery: await recovery.inspect(),
  };
  assert.deepEqual(after, before);
  await account.close();
  return {
    schema: 'railgun-relay-refusal-native-v1',
    scenario,
    result,
    selectedInputType: 'Shield',
    inputAmount: '2000',
    feeAmount: '100',
    selfAmount: '1900',
    exactReviewCallbacks: reviewed,
    disclosureCallbacks: disclosed,
    capturedHistoryUnrelated: scenario === 'unrelated-history',
    refusalBeforeMembershipVerifier: true,
    signatureVerificationOfCapturedHistoryInThisRun: false,
    selectedServiceMethods: [...services.poiMethods],
    syntheticOperationCanonicalHeaders: canonicalHeaders,
    noDurableRelayRows: true,
    custodyLogicalInspectionUnchanged: true,
    relaySignerLaunched: false,
    relaySigningLoanIssued: false,
    proofProduced: false,
    liveServiceContact: false,
    realServiceAuthority: false,
    relaySendPermitted: false,
    syntheticPublicHistory: true,
  };
}
async function execute(config) {
  const { app } = require('electron');
  const retained = require('./railgun-relay-retained-run');
  const bytes = retained.readBounded(config.sourceFilename, 8466, {
    bytes: 8466,
    sha256: SOURCE_SHA,
  });
  const derived = translate(bytes);
  const archive = require(wallet + 'railgun-engine-runtime').verifyRailgunEngineRuntime(
    config.archive
  );
  const sourceHashes = () => ({
    ...retained.sourceHashes(),
    'scripts/qualify-railgun-wallet-journal.js': sha(
      fs.readFileSync(path.join(__dirname, '../qualify-railgun-wallet-journal.js'))
    ),
    'scripts/fixtures/railgun-poi-signed-event.json': sha(
      fs.readFileSync(path.join(__dirname, 'railgun-poi-signed-event.json'))
    ),
    'docs/qualification/railgun-poi-read-2026-10-03.json': sha(
      fs.readFileSync(
        path.join(__dirname, '../../docs/qualification/railgun-poi-read-2026-10-03.json')
      )
    ),
  });
  const before = sourceHashes();
  for (const entry of [
    'scripts/fixtures/railgun-relay-refusal-native.js',
    'scripts/fixtures/railgun-relay-refusal-native.test.js',
    'src/main/wallet/railgun-relay-operation.js',
    'src/main/wallet/railgun-account-wallet.js',
    'src/main/wallet/railgun-account-poi.js',
    'src/main/wallet/railgun-private-reservations.js',
    'src/main/wallet/railgun-relay-recovery-store.js',
  ])
    assert.match(before[entry], /^[0-9a-f]{64}$/);
  assert.equal(
    path.join(fs.realpathSync(path.dirname(config.directory)), path.basename(config.directory)),
    config.directory
  );
  retained.freshDirectory(config.directory, {
    sourceFilename: config.sourceFilename,
    archive: config.archive,
    proverArchive: config.proverArchive,
    artifactDirectory: config.artifactDirectory,
  });
  const profile = require('../../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(config.directory, 'profile') },
  });
  const lockApi = require('../../src/main/profile-lock');
  const lock = lockApi.acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  let selected, identity, enrollment, publicAccount, account, report, failure;
  const services = installServices(derived.logs, () => selected, config.scenario);
  services.selected = (v) => {
    assert.equal(selected, undefined);
    selected = Object.freeze({ ...v });
  };
  const jobs = installJobs();
  const vault = require('../../src/main/identity/vault');
  const started = performance.now();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    identity?.close();
    enrollment?.close();
  }, 900000);
  const current = () => {
    assert.equal(expired, false);
    assert.ok(performance.now() >= started && performance.now() - started < 900000);
  };
  try {
    const vaultDirectory = path.join(profile.userDataDir, 'identity');
    await vault.importVault(
      vaultDirectory,
      'public-fixture-password-not-a-user-credential',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    identity = await require(wallet + 'railgun-identity').openRailgunIdentity({ archive });
    current();
    enrollment = await require(
      wallet + 'railgun-account-enrollment'
    ).openRailgunCooperativeAccountEnrollment({ identity, create: true });
    publicAccount = await require(wallet + 'railgun-account-public').openRailgunAccountPublic({
      enrollment,
      archive,
      create: true,
    });
    for (const range of ranges()) {
      current();
      await publicAccount.advance({
        to: range.to,
        anchor: { number: ANCHOR, hash: hex(ANCHOR + 1) },
      });
    }
    const api = require(wallet + 'railgun-account-wallet'),
      coordinator = publicAccount.coordinator;
    const policy = api.getRailgunAccountWalletPolicy({ archive, enrollment, coordinator });
    await enrollment.catalog.begin(policy);
    account = await api.openRailgunAccountWallet({
      identity,
      enrollment,
      archive,
      coordinator,
      policy,
      mode: 'pending',
    });
    await account.close();
    account = await api.openRailgunAccountWallet({
      identity,
      enrollment,
      archive,
      coordinator,
      policy,
      mode: 'active',
    });
    current();
    report = await qualify({
      account,
      owners: { identity, enrollment, coordinator },
      archive,
      proverArchive: config.proverArchive,
      artifactDirectory: config.artifactDirectory,
      scenario: config.scenario,
      services,
    });
    await jobs.finish();
    current();
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    for (const use of [
      () => account?.close(),
      () => publicAccount?.close(),
      () => enrollment?.close(),
      () => identity?.close(),
      () => vault.lockVault(),
    ])
      try {
        await use();
      } catch (error) {
        failure ??= error;
      }
    for (const use of [
      () => services.restore(),
      () => jobs.restore(),
      () => lockApi.releaseProfileLock(lock),
    ])
      try {
        use();
      } catch (error) {
        failure ??= error;
      }
  }
  if (failure) throw failure;
  current();
  native.assertEmpty();
  assert.deepEqual(sourceHashes(), before);
  assert.equal(
    require(wallet + 'railgun-engine-runtime').verifyRailgunEngineRuntime(config.archive),
    archive
  );
  assert.equal(
    sha(retained.readBounded(config.sourceFilename, 8466, { bytes: 8466, sha256: SOURCE_SHA })),
    derived.originalSha256
  );
  current();
  fs.writeFileSync(
    path.join(config.directory, 'report.json'),
    JSON.stringify(
      {
        ...report,
        originalSourceSha256: derived.originalSha256,
        translatedLogsSha256: derived.translatedSha256,
        blockOffset: OFFSET,
        setupRanges: ranges(),
        originalJobs: jobs.rows,
        sourceSha256: before,
        syntheticRpcRequests: services.requests.length,
        originalControllerDeadlineMs: 180000,
        overallFixtureDeadlineMs: 900000,
        sourceInventoryIsExecutionCoverage: false,
      },
      null,
      2
    ) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
}
module.exports = {
  select,
  translate,
  ranges,
  expectedRoles,
  assertOperationRpc,
  installServices,
  installJobs,
  qualify,
  execute,
};
