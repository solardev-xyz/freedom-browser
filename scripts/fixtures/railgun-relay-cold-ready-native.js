/** Fixed second-main qualification of one PUBLIC disposable ready-local record.
 * Process history is an outer-owned attestation, not authenticated by this file. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { types } = require('util');
const native = require('./railgun-native-assertions');
const { assert } = native;
const wallet = '../../src/main/wallet/';
const network = '../../src/main/networks/';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const SOURCE_SHA = 'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41';
const LIST = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';
const FROM = 5900000,
  TO = 5944730,
  ANCHOR = 5944800;
const ROLES = [
  'spending-public',
  'viewing-identity',
  'public-plan',
  'wallet-restore',
  'public-plan',
  'dual-proof-C',
];
// A retained signed record resumes with its original signature: proof A runs
// inside the completed snapshot before the same independent verifier.
const SIGNED_ROLES = [...ROLES.slice(0, -1), 'proof-A', 'dual-proof-C'];
// A Transact first run leaves a ready-local record over the derived Transact
// history; its cold mode is the ready-record verifier route (C only).
const MODES = Object.freeze({
  'railgun-relay-positive-native-v1': 'ready',
  'railgun-relay-signed-stop-native-v1': 'signed',
  'railgun-relay-transact-native-v1': 'transact',
  'railgun-relay-signing-stop-native-v1': 'signing',
});
const SCENARIO = Object.freeze({
  ready: 'synthetic-list',
  signed: 'synthetic-list-signed-stop',
  transact: 'synthetic-list-transact',
  signing: 'synthetic-list-signing-stop',
});
// A signing-local record cannot resume: the completed account opens, resume
// refuses before any proof snapshot or signer, and discard runs no utility.
const SIGNING_ROLES = ROLES.slice(0, 4);
const roles = (mode) =>
  mode === 'signed' ? SIGNED_ROLES : mode === 'signing' ? SIGNING_ROLES : ROLES;
const shape = (v, keys) => assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const tag = (n) => '0x' + n.toString(16);
function bounded(filename, limit, digest) {
  assert.ok(path.isAbsolute(filename) && path.normalize(filename) === filename);
  assert.equal(fs.realpathSync(filename), filename);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit);
  const bytes = fs.readFileSync(filename);
  assert.equal(bytes.length, stat.size);
  if (digest !== undefined) assert.equal(sha(bytes), digest);
  return bytes;
}
function checkedConfig(config) {
  shape(config, [
    'schema',
    'approved',
    'sourceFilename',
    'archive',
    'proverArchive',
    'artifactDirectory',
    'firstDirectory',
    'firstReportSha256',
    'firstOutcomeFilename',
    'firstOutcomeSha256',
    'directory',
  ]);
  assert.equal(config.schema, 'railgun-relay-cold-ready-config-v1');
  assert.equal(config.approved, true);
  for (const name of [
    'sourceFilename',
    'archive',
    'proverArchive',
    'artifactDirectory',
    'firstDirectory',
    'firstOutcomeFilename',
    'directory',
  ]) {
    assert.ok(path.isAbsolute(config[name]) && path.normalize(config[name]) === config[name]);
  }
  for (const name of ['firstReportSha256', 'firstOutcomeSha256'])
    assert.match(config[name], /^[0-9a-f]{64}$/);
}
function admission(config, outcome, first) {
  checkedConfig(config);
  shape(outcome, [
    'schema',
    'firstDirectory',
    'reportSha256',
    'qualified',
    'postChecksUnchanged',
    'originalDriver',
    'originalMain',
  ]);
  assert.equal(outcome.schema, 'railgun-relay-cold-first-outcome-v1');
  assert.equal(outcome.firstDirectory, config.firstDirectory);
  assert.equal(outcome.reportSha256, config.firstReportSha256);
  assert.equal(outcome.qualified, true);
  assert.equal(outcome.postChecksUnchanged, true);
  for (const name of ['originalDriver', 'originalMain']) {
    shape(outcome[name], ['pid', 'exitCode', 'signal', 'natural']);
    assert.ok(Number.isSafeInteger(outcome[name].pid) && outcome[name].pid > 0);
    assert.equal(outcome[name].exitCode, 0);
    assert.equal(outcome[name].signal, null);
    assert.equal(outcome[name].natural, true);
  }
  assert.notEqual(outcome.originalDriver.pid, outcome.originalMain.pid);
  assert.ok(Object.hasOwn(MODES, first.schema));
  const mode = MODES[first.schema];
  assert.equal(first.scenario, SCENARIO[mode]);
  if (mode === 'transact') {
    assert.equal(first.selectedInputType, 'Transact');
    assert.match(first.translatedTxidRowSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(first.syntheticList, LIST);
  assert.equal(first.rpcOwner, 'genuine-private-rpc');
  assert.equal(first.syntheticProviderHost, 'synthetic.invalid');
  if (mode === 'signing') {
    assert.equal(first.result.status, 'recovery-required');
    assert.equal(first.result.signingAttempted, true);
    assert.equal(first.result.signatureSaved, false);
    assert.equal(first.stopKind, 'controlled-signing-reply-cancellation');
    assert.equal(first.proofProduced, false);
  } else if (mode === 'signed')
    assert.deepEqual(first.result, {
      status: 'recovery-required',
      stage: 'proof',
      operationId: first.result.operationId,
      signingAttempted: true,
      signatureSaved: true,
    });
  else assert.equal(first.result.status, 'ready-local');
  assert.match(first.result.operationId, /^[0-9a-f]{64}$/);
  for (const name of [
    'recordDigest',
    'publicFixtureRecordSha256',
    'publicFixtureEntrySha256',
    ...(mode === 'signed' ? ['signatureSha256'] : []),
  ])
    assert.match(first[name], /^[0-9a-f]{64}$/);
  if (mode !== 'signing')
    for (const name of [
      ...(mode === 'signed' ? [] : ['authenticatedReadyReadback', 'auditCustodyUnchanged']),
      'proofProduced',
      'signatureIndependentlyVerified',
      'proofsIndependentlyVerified',
    ])
      assert.equal(first[name], true);
  if (mode === 'signed') assert.equal(first.proofPersisted, false);
  for (const name of [
    'productionServiceAuthority',
    'liveServiceContact',
    'relaySendPermitted',
    'transportAttempted',
    'actualProductionListQualified',
  ])
    assert.equal(first[name], false);
  assert.equal(first.recoverySequenceDelta, { signed: 3, signing: 2 }[mode] ?? 4);
  assert.equal(first.originalSourceSha256, SOURCE_SHA);
  return mode;
}
function readAdmission(filename) {
  const bytes = bounded(filename, 8192),
    config = JSON.parse(bytes);
  checkedConfig(config); // Refuse before reading any caller-derived input.
  const firstBytes = bounded(
    path.join(config.firstDirectory, 'report.json'),
    4 * 1024 * 1024,
    config.firstReportSha256
  );
  const outcomeBytes = bounded(config.firstOutcomeFilename, 16384, config.firstOutcomeSha256);
  const first = JSON.parse(firstBytes),
    outcome = JSON.parse(outcomeBytes);
  const mode = admission(config, outcome, first);
  return { config, first, outcome, configSha256: sha(bytes), mode };
}
function translate(bytes) {
  assert.equal(sha(bytes), SOURCE_SHA);
  const source = JSON.parse(bytes);
  assert.deepEqual(
    source.logs.map((v) => v.blockNumber),
    [10, 20, 30]
  );
  return source.logs.map((v) => ({
    ...v,
    blockNumber: 5944700 + v.blockNumber,
    blockHash: hex(5944700 + v.blockNumber + 1),
    transactionHash: hex(5944700 + v.blockNumber + 1000),
  }));
}
function rpcReply(method, params, logs) {
  if (method === 'eth_chainId') {
    assert.deepEqual(params, []);
    return '0xaa36a7';
  }
  if (method === 'eth_getLogs') {
    assert.deepEqual(params, [
      {
        address: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
        fromBlock: tag(FROM),
        toBlock: tag(TO),
      },
    ]);
    // Original transaction/log indexes (all zero except the derived Transact
    // history's second log in its block-30 transaction).
    return logs.map((v) => ({
      ...v,
      blockNumber: tag(v.blockNumber),
      transactionIndex: tag(v.transactionIndex),
      logIndex: tag(v.logIndex),
    }));
  }
  assert.equal(method, 'eth_getBlockByNumber');
  assert.ok(Array.isArray(params) && params.length === 2 && params[1] === false);
  const n = params[0] === 'finalized' ? ANCHOR : Number(BigInt(params[0]));
  assert.ok(
    ['finalized', ...[FROM, TO, ANCHOR, FROM - 1, 5944710, 5944720].map(tag)].includes(params[0])
  );
  return { number: tag(n), hash: hex(n + 1), parentHash: hex(n) };
}
function assertRpc(rows) {
  const counts = {};
  for (const row of rows) {
    const key =
      row.method === 'eth_getBlockByNumber' ? row.method + ':' + row.params[0] : row.method;
    counts[key] = (counts[key] || 0) + 1;
  }
  const expected = {
    eth_chainId: 1,
    eth_getLogs: 2,
    ...Object.fromEntries(
      ['finalized', tag(FROM), tag(ANCHOR), tag(FROM - 1)].map((v) => [
        'eth_getBlockByNumber:' + v,
        8,
      ])
    ),
    ['eth_getBlockByNumber:' + tag(TO)]: 10,
    ['eth_getBlockByNumber:' + tag(5944710)]: 2,
    ['eth_getBlockByNumber:' + tag(5944720)]: 2,
  };
  // Proof A reads snapshot storage, not RPC: signed run a observed exactly the
  // ready resume's requests, so both modes share this exact map.
  assert.deepEqual(counts, expected);
  assert.equal(rows.length, 49);
  return counts;
}
function rpcRows(rows) {
  const counts = {};
  for (const row of rows) {
    const key =
      row.method === 'eth_getBlockByNumber' ? row.method + ':' + row.params[0] : row.method;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
function installServices(logs) {
  for (const name of [
    'railgun-account-public',
    'railgun-poi-source',
    'railgun-public-services',
    'railgun-poi-root',
    'railgun-private-preflight',
    'railgun-shield-preflight',
  ])
    assert.equal(require.cache[require.resolve(wallet + name)], undefined);
  for (const name of ['private-rpc'])
    assert.equal(require.cache[require.resolve(network + name)], undefined);
  const transport = require(network + 'wallet-tor-transport');
  const registry = require(network + 'network-registry');
  const tor = require('../../src/main/tor-manager');
  const settings = require('../../src/main/settings-store');
  const { getPrivacyContext } = require(network + 'privacy-context');
  const originals = [
    transport.createWalletTorTransport,
    registry.getNetwork,
    registry.getEndpoints,
    registry.getEndpointSources,
    tor.getWalletSocksEndpoint,
    settings.isWalletTorExperimentAvailable,
  ];
  const endpoint = Object.freeze({ signal: new AbortController().signal });
  const url = 'https://synthetic.invalid/railgun';
  const rows = [],
    clients = [];
  let stopped = false,
    refusedAttempts = 0;
  const factory = () => {
    assert.equal(stopped, false);
    assert.equal(clients.length, 0);
    let closed = false,
      resolve;
    const barrier = new Promise((yes) => {
      resolve = yes;
    });
    const client = {
      closed: barrier,
      release() {},
      close() {
        closed = true;
        resolve();
      },
      async request(handle, address, options) {
        try {
          assert.equal(stopped, false);
          assert.equal(closed, false);
          const subject = getPrivacyContext(handle).subject;
          assert.equal(subject.role, 'protocol-rpc');
          assert.equal(subject.operation, null);
          assert.equal(address, url);
          assert.equal(options.method, 'POST');
          assert.equal(options.signal.aborted, false);
          const wire = JSON.parse(options.body);
          shape(wire, ['jsonrpc', 'id', 'method', 'params']);
          assert.equal(wire.jsonrpc, '2.0');
          assert.equal(typeof wire.id, 'string');
          const value = rpcReply(wire.method, wire.params, logs);
          rows.push({ method: wire.method, params: structuredClone(wire.params) });
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result: value })),
          };
        } catch (error) {
          refusedAttempts++;
          native.record(error, 'cold-synthetic-transport');
          throw error;
        }
      },
    };
    clients.push(client);
    return client;
  };
  const networkInfo = (id) => {
    assert.equal(id, 11155111);
    return { access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } };
  };
  const endpoints = (id, role) => {
    assert.equal(id, 11155111);
    assert.equal(role, 'rpc');
    return [url];
  };
  const sources = (id, role) => {
    endpoints(id, role);
    return [{ keyed: false, coverage: { 11155111: url } }];
  };
  const socks = () => endpoint,
    available = () => true;
  transport.createWalletTorTransport = factory;
  registry.getNetwork = networkInfo;
  registry.getEndpoints = endpoints;
  registry.getEndpointSources = sources;
  tor.getWalletSocksEndpoint = socks;
  settings.isWalletTorExperimentAvailable = available;
  return {
    rows,
    get refusedAttempts() {
      return refusedAttempts;
    },
    async close() {
      stopped = true;
      for (const c of clients) c.close();
      await Promise.all(clients.map((c) => c.closed));
      assert.equal(refusedAttempts, 0);
    },
    restore() {
      assert.deepEqual(
        [
          transport.createWalletTorTransport,
          registry.getNetwork,
          registry.getEndpoints,
          registry.getEndpointSources,
          tor.getWalletSocksEndpoint,
          settings.isWalletTorExperimentAvailable,
        ],
        [factory, networkInfo, endpoints, sources, socks, available]
      );
      [
        transport.createWalletTorTransport,
        registry.getNetwork,
        registry.getEndpoints,
        registry.getEndpointSources,
        tor.getWalletSocksEndpoint,
        settings.isWalletTorExperimentAvailable,
      ] = originals;
    },
  };
}
function observe(promise, use, pending) {
  assert.ok(types.isPromise(promise) && !types.isProxy(promise));
  const settlement = new Promise((resolve) => {
    try {
      Promise.prototype.then.call(
        promise,
        (value) => {
          try {
            use(value);
          } catch (error) {
            native.record(error, 'cold-observation');
          }
          resolve();
        },
        (error) => {
          native.record(error, 'cold-original-rejection');
          resolve();
        }
      );
    } catch (error) {
      native.record(error, 'cold-observer-registration');
      resolve();
    }
  });
  pending.push(settlement);
}
function installJobs(firstRecordSha256, mode = 'ready') {
  assert.match(firstRecordSha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.values(MODES).includes(mode));
  const expectedRoles = roles(mode);
  for (const name of [
    'railgun-identity',
    'railgun-public-run',
    'railgun-wallet-run',
    'railgun-relay-proof',
    'railgun-account-store',
    'railgun-source-ledger',
  ])
    assert.equal(require.cache[require.resolve(wallet + name)], undefined);
  let deadline;
  const runtime = require(wallet + 'railgun-process'),
    sessions = require(wallet + 'railgun-session-worker');
  // Call-time custody matcher observation (state, ledger state, interrupted step).
  const custodyData = require(wallet + 'railgun-relay-recovery-data'),
    match = custodyData.matchRailgunRelayLocalReservation,
    custodyRows = [];
  const matched = function (...args) {
    const result = Reflect.apply(match, this, args);
    custodyRows.push({
      state: result.record?.state ?? null,
      reservationState: result.reservationState,
      step: result.interruptedStep,
    });
    return result;
  };
  custodyData.matchRailgunRelayLocalReservation = matched;
  const originals = [
    runtime.startRailgunProcess,
    sessions.startRailgunSessionWorker,
    sessions.startRailgunReadOnlySessionWorker,
  ];
  const rows = [],
    workers = [],
    pending = [],
    loans = [];
  const guards = require('../qualify-railgun-relay-proof').EXPECTED_GUARDS;
  const start = function (options, ...rest) {
    const input = JSON.parse(options.input),
      filename = options.filename;
    let role;
    if (filename === require.resolve(wallet + 'railgun-identity-job')) role = input.purpose;
    else if (filename === require.resolve(wallet + 'railgun-public-job')) {
      assert.equal(input.mode, 'plan');
      role = 'public-plan';
    } else if (filename === require.resolve(wallet + 'railgun-wallet-job')) {
      assert.equal(input.restore, true);
      assert.equal(input.privateIntent, undefined);
      assert.equal(input.privateOperation, undefined);
      role = 'wallet-restore';
    } else if (
      mode === 'signed' &&
      filename === require.resolve(wallet + 'railgun-relay-prove-job')
    ) {
      role = 'proof-A';
    } else {
      assert.equal(filename, require.resolve(wallet + 'railgun-relay-verify-job'));
      role = 'dual-proof-C';
    }
    assert.equal(role, expectedRoles[rows.length]);
    if (rows.length) assert.equal(rows.at(-1).closedObserved, true);
    const expectedKey = {
      'spending-public': 'spending-public',
      'viewing-identity': 'viewing-identity',
      'wallet-restore': 'wallet-viewing',
      'proof-A': 'relay-prove-local',
    }[role];
    assert.equal(options.binaryKey === true, !!expectedKey);
    if (role === 'dual-proof-C') {
      assert.ok(Number.isFinite(deadline) && deadline - performance.now() > 15000);
      assert.ok(options.startupMs > 0 && options.startupMs <= 60000);
      assert.equal(options.lifetimeMs, options.startupMs);
    }
    if (role === 'proof-A') {
      assert.ok(Number.isFinite(deadline) && deadline - performance.now() > 45000);
      assert.ok(options.startupMs > 0 && options.startupMs <= 110000);
    }
    const row = {
      role,
      inputSha256: sha(options.input),
      methods: {},
      storageMethods: {},
      keyRequests: 0,
      keyReplies: 0,
      results: 0,
      closedObserved: false,
      readyObserved: false,
    };
    rows.push(row);
    if (role === 'dual-proof-C' || role === 'proof-A') {
      row.completedRemainingMs = deadline - performance.now();
      row.recordStream = require(
        wallet + 'railgun-relay-record-stream'
      ).normalizeRailgunRelayRecordStreamManifest(input.recordStream);
      // Proof A streams the retained signed record. The verifier streams the
      // ready candidate, which equals the retained record only when it was ready.
      if (role === (mode === 'signed' ? 'proof-A' : 'dual-proof-C'))
        assert.equal(row.recordStream.sha256, firstRecordSha256);
    }
    const broker = options.broker;
    const dispatch = function (wire) {
      const message = JSON.parse(wire);
      const count = Object.values(row.methods).reduce((a, b) => a + b, 0);
      assert.equal(message.id, count + 1);
      const method = message.method ?? message.channel;
      assert.ok(typeof method === 'string');
      row.methods[method] = (row.methods[method] || 0) + 1;
      if (message.method === 'key') {
        assert.equal(message.purpose, expectedKey);
        assert.equal(++row.keyRequests, 1);
      } else if (['result', 'jobResult'].includes(message.method)) {
        assert.equal(++row.results, 1);
        const value = message.value;
        assert.deepEqual(message.guards ?? value.guards, guards);
        row.guards = structuredClone(guards);
        if (role === 'dual-proof-C') {
          for (const key of [
            'transactionVerified',
            'prePoiVerified',
            'historicalEventSignatureVerified',
            'historicalMembershipPathVerified',
          ])
            assert.equal(value[key], true);
          for (const key of [
            'inputOwnershipVerified',
            'currentMembershipVerified',
            'authorityGranted',
          ])
            assert.equal(value[key], false);
          row.verification = {
            recordDigest: value.recordDigest,
            transactionDigest: value.transactionDigest,
            payloadDigest: value.payloadDigest,
          };
        }
      } else if (role === 'public-plan') assert.equal(message.method, 'sourceNext');
      else if (role === 'dual-proof-C') {
        assert.equal(message.method, 'relay-verify-record');
        assert.equal(message.index, row.methods['relay-verify-record'] - 1);
        assert.ok(message.index < row.recordStream.chunks);
      } else if (role === 'proof-A' && message.method === 'relay-proof-record') {
        assert.equal(message.index, row.methods['relay-proof-record'] - 1);
        assert.ok(message.index < row.recordStream.chunks);
      } else {
        assert.ok(['wallet-restore', 'proof-A'].includes(role));
        assert.ok(['public', 'wallet'].includes(message.channel));
        const inner = JSON.parse(message.wire);
        assert.ok(
          ['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end'].includes(inner.method)
        );
        const key = message.channel + ':' + inner.method;
        row.storageMethods[key] = (row.storageMethods[key] || 0) + 1;
      }
      const result = Reflect.apply(broker.dispatch, broker, [wire]);
      observe(
        result,
        (reply) => {
          if (message.method === 'key') {
            assert.ok(Buffer.isBuffer(reply) && reply.length === 32);
            loans.push(reply);
            row.keyReplies++;
          }
        },
        pending
      );
      return result;
    };
    const task = Reflect.apply(originals[0], this, [
      { ...options, broker: { ...broker, dispatch } },
      ...rest,
    ]);
    observe(
      task.ready,
      () => {
        row.readyObserved = true;
      },
      pending
    );
    observe(
      task.closed,
      (value) => {
        assert.equal(value.code, 'RAILGUN_PROCESS_CLOSED');
        assert.equal(value.exitCode, 15);
        assert.equal(value.escalated, false);
        assert.equal(value.peerDisconnected, false);
        row.closed = structuredClone(value);
        row.closedObserved = true;
      },
      pending
    );
    return task;
  };
  const worker = (original, readOnly) =>
    function (...args) {
      const instance = Reflect.apply(original, this, args);
      const row = { readOnly, closedObserved: false };
      workers.push(row);
      observe(
        instance.closed,
        (value) => {
          assert.equal(value.exitCode, 0);
          row.closed = structuredClone(value);
          row.closedObserved = true;
        },
        pending
      );
      return instance;
    };
  const ordinary = worker(originals[1], false),
    readonly = worker(originals[2], true);
  runtime.startRailgunProcess = start;
  sessions.startRailgunSessionWorker = ordinary;
  sessions.startRailgunReadOnlySessionWorker = readonly;
  return {
    rows,
    workers,
    custodyRows,
    deadline(value) {
      assert.equal(deadline, undefined);
      assert.ok(Number.isFinite(value) && value > performance.now());
      deadline = value;
    },
    async finish() {
      await Promise.all(pending);
      native.assertEmpty();
      assert.deepEqual(
        rows.map((v) => v.role),
        expectedRoles
      );
      assert.equal(loans.length, mode === 'signed' ? 4 : 3);
      if (mode === 'signing') assert.equal(rows.length, SIGNING_ROLES.length);
      assert.ok(loans.every((b) => b.every((v) => v === 0)));
      for (const row of rows) {
        assert.equal(row.closedObserved, true);
        assert.equal(row.readyObserved, true);
        assert.equal(row.results, 1);
        assert.equal(row.keyRequests, row.keyReplies);
        if (row.role === 'public-plan')
          assert.deepEqual(row.methods, { sourceNext: 2, jobResult: 1 });
        if (row.role === 'dual-proof-C')
          assert.deepEqual(row.methods, {
            'relay-verify-record': row.recordStream.chunks,
            result: 1,
          });
        if (row.role === 'proof-A') {
          assert.equal(row.methods.key, 1);
          assert.equal(row.methods.result, 1);
          assert.equal(row.methods['relay-proof-record'], row.recordStream.chunks);
        }
      }
      // Proof A shares the completed snapshot's read-only worker (signed run a).
      // A signing discard never opens a proof snapshot; its workers are observed.
      if (mode !== 'signing')
        assert.deepEqual(
          workers.map((v) => v.readOnly),
          [false, false, true]
        );
      assert.ok(workers.every((v) => v.closedObserved));
    },
    restore() {
      assert.equal(custodyData.matchRailgunRelayLocalReservation, matched);
      custodyData.matchRailgunRelayLocalReservation = match;
      assert.deepEqual(
        [
          runtime.startRailgunProcess,
          sessions.startRailgunSessionWorker,
          sessions.startRailgunReadOnlySessionWorker,
        ],
        [start, ordinary, readonly]
      );
      [
        runtime.startRailgunProcess,
        sessions.startRailgunSessionWorker,
        sessions.startRailgunReadOnlySessionWorker,
      ] = originals;
    },
  };
}
async function qualify(account, owners, config, first, signal, mode = 'ready', jobs = null) {
  if (mode === 'signing') return discardSigning(account, owners, config, first, signal, jobs);
  const signed = mode === 'signed';
  const operation = require(wallet + 'railgun-relay-operation');
  const reservations = await owners.enrollment.openReservations({ existingOnly: true });
  const recovery = await owners.enrollment.openRelayRecoveryStore({ existingOnly: true });
  const id = first.result.operationId;
  const inventory = async () => ({
    privateCounts: await reservations.inspect(),
    relay: await reservations.listRelay(recovery),
    recovery: await recovery.inspect(),
  });
  const before = await inventory(),
    pair = await reservations.readRelay(recovery, id);
  assert.deepEqual(before.privateCounts, { held: 0, signing: 0, abandoned: 0, legacy: 0 });
  assert.deepEqual(before.relay, [{ id, state: 'signing-local' }]);
  assert.deepEqual(before.recovery, {
    records: 1,
    sequence: signed ? 3 : 4,
    capacity: 10,
    states: [{ id, state: signed ? 'signed' : 'ready-local' }],
  });
  assert.equal(pair.interruptedStep, null);
  assert.equal(pair.entry.origin, 'relay-local-v4');
  assert.equal(pair.entry.state, 'signing-local');
  assert.equal(pair.record.state, signed ? 'signed' : 'ready-local');
  if (signed) {
    assert.equal(pair.record.proved, null);
    assert.equal(sha(JSON.stringify(pair.record.signature)), first.signatureSha256);
  }
  const recordText = JSON.stringify(pair.record),
    entryText = JSON.stringify(pair.entry);
  assert.equal(sha(recordText), first.publicFixtureRecordSha256);
  assert.equal(pair.recordDigest, first.recordDigest);
  assert.equal(sha(entryText), first.publicFixtureEntrySha256);
  const result = await operation.resumeRailgunAccountRelayOperation({
    account,
    owners,
    operationId: id,
    archive: config.archive,
    proverArchive: config.proverArchive,
    artifactDirectory: config.artifactDirectory,
    signal,
  });
  assert.deepEqual(result, { status: 'ready-local', operationId: id });
  const after = await inventory(),
    final = await reservations.readRelay(recovery, id);
  if (signed) return signedResume({ before, after, pair, final, first, id, recordText, entryText });
  assert.deepEqual(after, before);
  assert.equal(final.interruptedStep, null);
  assert.equal(JSON.stringify(final.entry), entryText);
  assert.equal(JSON.stringify(final.record), recordText);
  assert.equal(final.recordDigest, first.recordDigest);
  return {
    result,
    recordDigest: pair.recordDigest,
    recordSha256: sha(recordText),
    entrySha256: sha(entryText),
    signatureSha256: sha(JSON.stringify(pair.record.signature)),
    transactionSha256: sha(JSON.stringify(pair.record.proved.transaction)),
    payloadSha256: sha(JSON.stringify(pair.record.proved.payload)),
    authenticatedPairUnchanged: true,
    recoverySequenceBefore: 4,
    recoverySequenceAfter: 4,
    privateCountsUnchanged: true,
    relayOperations: 1,
    ledgerTransitionsSourceDerived: 2,
    ledgerAdditionalTransitionsSourceDerived: 0,
  };
}
// Signing-local cold continuation: resume must refuse before any utility or
// signer; discard writes the tombstone before releasing the input.
async function discardSigning(account, owners, config, first, signal, jobs) {
  const operation = require(wallet + 'railgun-relay-operation');
  const reservations = await owners.enrollment.openReservations({ existingOnly: true });
  const recovery = await owners.enrollment.openRelayRecoveryStore({ existingOnly: true });
  const id = first.result.operationId;
  const inventory = async () => ({
    privateCounts: await reservations.inspect(),
    relay: await reservations.listRelay(recovery),
    recovery: await recovery.inspect(),
  });
  const before = await inventory(),
    pair = await reservations.readRelay(recovery, id);
  assert.deepEqual(before.privateCounts, { held: 0, signing: 0, abandoned: 0, legacy: 0 });
  assert.deepEqual(before.relay, [{ id, state: 'signing-local' }]);
  assert.deepEqual(before.recovery, {
    records: 1,
    sequence: 2,
    capacity: 10,
    states: [{ id, state: 'signing-local' }],
  });
  assert.equal(pair.interruptedStep, null);
  assert.equal(pair.record.state, 'signing-local');
  assert.equal(pair.record.signature, null);
  assert.equal(sha(JSON.stringify(pair.record)), first.publicFixtureRecordSha256);
  assert.equal(sha(JSON.stringify(pair.entry)), first.publicFixtureEntrySha256);
  assert.equal(pair.recordDigest, first.recordDigest);
  const facts = {
    tree: pair.entry.facts.tree,
    position: pair.entry.facts.position,
    nullifier: pair.entry.facts.nullifier,
    noteHash: pair.entry.facts.noteHash,
  };
  const available = async () => {
    try {
      await reservations.assertAvailable(facts);
      return null;
    } catch (error) {
      return error?.code ?? 'unknown';
    }
  };
  assert.equal(await available(), 'RAILGUN_PRIVATE_INPUT_RESERVED');
  const utilitiesBefore = jobs.rows.length;
  const resumed = await operation.resumeRailgunAccountRelayOperation({
    account,
    owners,
    operationId: id,
    archive: config.archive,
    proverArchive: config.proverArchive,
    artifactDirectory: config.artifactDirectory,
    signal,
  });
  assert.deepEqual(resumed, { status: 'refused', stage: 'cold-proof', operationId: id });
  assert.equal(jobs.rows.length, utilitiesBefore);
  assert.deepEqual(await inventory(), before);
  const watch = jobs.custodyRows.length;
  const discarded = await operation.discardRailgunAccountRelayOperation({
    account,
    owners,
    operationId: id,
    signal,
  });
  assert.deepEqual(discarded, { status: 'discarded-signed', operationId: id });
  assert.equal(jobs.rows.length, utilitiesBefore);
  const sequence = jobs.custodyRows.slice(watch).map((v) => [v.state, v.reservationState, v.step]);
  const tombstone = sequence.findIndex((v) => v[0] === 'discarded-signed');
  assert.deepEqual(sequence[tombstone], ['discarded-signed', 'signing-local', 'release-signed']);
  assert.deepEqual(sequence.at(-1), ['discarded-signed', 'discarded-signed', null]);
  const after = await inventory(),
    final = await reservations.readRelay(recovery, id);
  assert.deepEqual(after.privateCounts, before.privateCounts);
  assert.deepEqual(after.relay, [{ id, state: 'discarded-signed' }]);
  assert.deepEqual(after.recovery, {
    ...before.recovery,
    sequence: 3,
    states: [{ id, state: 'discarded-signed' }],
  });
  assert.equal(final.interruptedStep, null);
  assert.equal(final.record.state, 'discarded-signed');
  assert.equal(final.record.signature, null);
  assert.equal(final.recordDigest, first.recordDigest);
  assert.equal(await available(), null);
  return {
    result: discarded,
    resumeRefusal: resumed,
    recordDigest: final.recordDigest,
    signingRecordSha256: sha(JSON.stringify(pair.record)),
    discardedRecordSha256: sha(JSON.stringify(final.record)),
    entrySha256Before: sha(JSON.stringify(pair.entry)),
    entrySha256After: sha(JSON.stringify(final.entry)),
    custodyTransitions: sequence,
    tombstoneBeforeRelease: true,
    inputReservedBeforeDiscard: true,
    inputAvailableAfterDiscard: true,
    recoverySequenceBefore: 2,
    recoverySequenceAfter: 3,
    privateCountsUnchanged: true,
    relayOperations: 1,
    signerUtilities: 0,
  };
}
// The original signature and every immutable field survive; only the proof
// slot and state advance. The ledger entry is byte-identical.
function signedResume({ before, after, pair, final, first, id, recordText, entryText }) {
  assert.deepEqual(after.privateCounts, before.privateCounts);
  assert.deepEqual(after.relay, before.relay);
  assert.deepEqual(after.recovery, {
    ...before.recovery,
    sequence: 4,
    states: [{ id, state: 'ready-local' }],
  });
  assert.equal(final.interruptedStep, null);
  assert.equal(JSON.stringify(final.entry), entryText);
  assert.equal(final.record.state, 'ready-local');
  assert.ok(final.record.proved && typeof final.record.proved === 'object');
  assert.deepEqual(final.record.signature, pair.record.signature);
  assert.equal(sha(JSON.stringify(final.record.signature)), first.signatureSha256);
  assert.equal(JSON.stringify({ ...final.record, state: 'signed', proved: null }), recordText);
  assert.equal(final.recordDigest, first.recordDigest);
  const finalText = JSON.stringify(final.record);
  return {
    result: { status: 'ready-local', operationId: id },
    recordDigest: final.recordDigest,
    signedRecordSha256: sha(recordText),
    recordSha256: sha(finalText),
    entrySha256: sha(entryText),
    signatureSha256: first.signatureSha256,
    transactionSha256: sha(JSON.stringify(final.record.proved.transaction)),
    payloadSha256: sha(JSON.stringify(final.record.proved.payload)),
    originalSignaturePreserved: true,
    entryUnchanged: true,
    recoverySequenceBefore: 3,
    recoverySequenceAfter: 4,
    privateCountsUnchanged: true,
    relayOperations: 1,
    ledgerAdditionalTransitionsSourceDerived: 0,
  };
}
function sourceSnapshot() {
  const map = require('./railgun-relay-retained-run').sourceHashes();
  for (const name of [
    'qualify-railgun-relay-positive.js',
    'qualify-railgun-relay-positive.test.js',
    'qualify-railgun-relay-cold-ready.js',
    'qualify-railgun-relay-cold-ready.test.js',
  ])
    map['scripts/' + name] = sha(fs.readFileSync(path.join(__dirname, '..', name)));
  for (const name of [
    'scripts/fixtures/railgun-shield-offline-deployment.js',
    'docs/qualification/railgun-public-contract-bytecodes-2026-10-04.json',
    'scripts/fixtures/railgun-poi-signed-event.json',
    'docs/qualification/railgun-poi-read-2026-10-03.json',
  ])
    map[name] = sha(fs.readFileSync(path.join(__dirname, '../..', name)));
  return map;
}
async function execute(admitted) {
  const { config, first, outcome, configSha256, mode } = admitted;
  assert.equal(admission(config, outcome, first), mode);
  const signed = mode === 'signed';
  const retained = require('./railgun-relay-retained-run');
  const source = bounded(config.sourceFilename, 8466, SOURCE_SHA),
    logs =
      mode === 'transact'
        ? require('./railgun-relay-positive-native').translateTransact(source).logs
        : translate(source),
    before = sourceSnapshot();
  assert.deepEqual(before, first.sourceSha256);
  const pins = () => ({
    engineSha256: require(wallet + 'railgun-engine-manifest.json').sha256,
    proverSha256: require(wallet + 'railgun-prover-manifest.json').sha256,
    artifactManifestSha256: sha(JSON.stringify(require(wallet + 'railgun-artifacts').manifest)),
  });
  assert.deepEqual(pins(), first.fixturePins);
  const verify = () => {
    require(wallet + 'railgun-engine-runtime').verifyRailgunEngineRuntime(config.archive);
    require(wallet + 'railgun-prover-runtime').verifyRailgunProverRuntime(config.proverArchive);
  };
  verify();
  const inputs = Object.fromEntries(
    [
      'sourceFilename',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'firstDirectory',
      'firstOutcomeFilename',
    ].map((k) => [k, config[k]])
  );
  retained.freshDirectory(config.directory, inputs);
  const profileDirectory = path.join(config.firstDirectory, 'profile');
  assert.equal(fs.realpathSync(profileDirectory), profileDirectory);
  const { app } = require('electron');
  const profile = require('../../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: profileDirectory },
  });
  const lockApi = require('../../src/main/profile-lock'),
    lock = lockApi.acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const services = installServices(logs),
    jobs = installJobs(first.publicFixtureRecordSha256, mode),
    vault = require('../../src/main/identity/vault');
  const controller = new AbortController(),
    start = performance.now(),
    timer = setTimeout(() => controller.abort(), 300000);
  let identity, enrollment, publicAccount, account, report, failure;
  const current = () => {
    assert.equal(controller.signal.aborted, false);
    assert.ok(performance.now() >= start && performance.now() - start < 300000);
  };
  try {
    await vault.unlockVault(
      path.join(profile.userDataDir, 'identity'),
      'public-fixture-password-not-a-user-credential',
      0
    );
    current();
    identity = await require(wallet + 'railgun-identity').openRailgunIdentity({
      archive: config.archive,
    });
    current();
    enrollment = await require(
      wallet + 'railgun-account-enrollment'
    ).openRailgunCooperativeAccountEnrollment({ identity, create: false });
    require(wallet + 'railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
    current();
    const publicApi = require(wallet + 'railgun-account-public');
    publicAccount = await publicApi.openRailgunAccountPublic({
      enrollment,
      archive: config.archive,
      create: false,
      mode: 'active',
    });
    current();
    const owners = { identity, enrollment, coordinator: publicAccount.coordinator },
      destination = publicApi.getRailgunAccountPublicDestination(owners.coordinator, enrollment);
    account = await require(wallet + 'railgun-account-wallet').openRailgunCompletedAccountWallet({
      ...owners,
      archive: config.archive,
      destination,
      signal: controller.signal,
      timeoutMs: 180000,
    });
    current();
    jobs.deadline(
      require(wallet + 'railgun-account-wallet').readRailgunCompletedAccountRelayState(
        account,
        owners
      ).deadline
    );
    report = await qualify(account, owners, config, first, controller.signal, mode, jobs);
    current();
  } catch (error) {
    failure = error;
  } finally {
    for (const use of [
      () => account?.close(),
      () => publicAccount?.close(),
      () => enrollment?.close(),
      () => identity?.close(),
      () => vault.lockVault(),
      () => services.close(),
    ])
      try {
        await use();
      } catch (error) {
        failure ??= error;
      }
    try {
      await jobs.finish();
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
    clearTimeout(timer);
  }
  if (failure) throw failure;
  current();
  native.assertEmpty();
  const signing = mode === 'signing';
  if (!signing)
    assert.deepEqual(jobs.rows.at(-1).verification, {
      recordDigest: report.recordDigest,
      transactionDigest: report.transactionSha256,
      payloadDigest: report.payloadSha256,
    });
  if (signed) assert.equal(jobs.rows.at(-1).recordStream.sha256, report.recordSha256);
  // A signing discard opens no proof snapshot; its RPC map is observed first.
  const rpc = signing ? services.rows.length : assertRpc(services.rows);
  assert.deepEqual(sourceSnapshot(), before);
  verify();
  bounded(
    path.join(config.firstDirectory, 'report.json'),
    4 * 1024 * 1024,
    config.firstReportSha256
  );
  bounded(config.firstOutcomeFilename, 16384, config.firstOutcomeSha256);
  bounded(config.sourceFilename, 8466, SOURCE_SHA);
  current();
  fs.writeFileSync(
    path.join(config.directory, 'report.json'),
    JSON.stringify(
      {
        schema: signed
          ? 'railgun-relay-signed-cold-native-v1'
          : signing
            ? 'railgun-relay-signing-discard-native-v1'
            : mode === 'transact'
              ? 'railgun-relay-transact-cold-native-v1'
              : 'railgun-relay-cold-ready-native-v1',
        ...(mode === 'transact' ? { selectedInputType: 'Transact' } : {}),
        ...report,
        firstReportSha256: config.firstReportSha256,
        firstOutcomeSha256: config.firstOutcomeSha256,
        configSha256,
        processHistoryAuthority: 'outer-original-process-owner',
        sourceSha256: before,
        fixturePins: pins(),
        originalJobs: jobs.rows,
        originalStorageWorkers: jobs.workers,
        syntheticRpc: rpc,
        syntheticRpcRequests: signing ? services.rows.length : 49,
        ...(signing
          ? { syntheticRpcObserved: rpcRows(services.rows), storageWorkersObserved: true }
          : {}),
        syntheticRefusedAttempts: services.refusedAttempts,
        relaySigningOperations: 0,
        proofProducerOperations: signed ? 1 : 0,
        quoteOrPoiRequests: 0,
        originalCompletedDeadlineMs: 180000,
        leaseAndFloorWritesPermitted: true,
        wholeProfileBytesUnchangedClaimed: false,
        relaySendPermitted: false,
        transportAttempted: false,
        productionServiceAuthority: false,
        liveServiceContact: false,
        ...(signed
          ? { coldSignedResumeQualified: true }
          : signing
            ? { coldSigningDiscardQualified: true }
            : { coldReadyLocalQualified: true }),
        mainModuleCache: require('./railgun-relay-positive-native').inspectMainModuleCache(),
      },
      null,
      2
    ) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
}
module.exports = {
  admission,
  readAdmission,
  translate,
  rpcReply,
  assertRpc,
  installServices,
  observe,
  installJobs,
  qualify,
  signedResume,
  sourceSnapshot,
  execute,
  ROLES,
  SIGNED_ROLES,
};
