/** Source/mock controls only. No engine, prover, real profile or native SQLite. */
const { createHash } = require('crypto');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const digest = 'a'.repeat(64);
const load = () => require('./railgun-relay-cold-ready-native');
const wallet = '../../src/main/wallet/';
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function admissionInput() {
  const config = {
    schema: 'railgun-relay-cold-ready-config-v1',
    approved: true,
    sourceFilename: '/public/source.json',
    archive: '/public/engine.asar',
    proverArchive: '/public/prover.asar',
    artifactDirectory: '/public/artifacts',
    firstDirectory: '/public/first',
    firstReportSha256: digest,
    firstOutcomeFilename: '/public/outcome.json',
    firstOutcomeSha256: digest,
    directory: '/public/cold',
  };
  const outcome = {
    schema: 'railgun-relay-cold-first-outcome-v1',
    firstDirectory: config.firstDirectory,
    reportSha256: digest,
    qualified: true,
    postChecksUnchanged: true,
    originalDriver: { pid: 100, exitCode: 0, signal: null, natural: true },
    originalMain: { pid: 200, exitCode: 0, signal: null, natural: true },
  };
  const first = {
    schema: 'railgun-relay-positive-native-v1',
    scenario: 'synthetic-list',
    syntheticList: '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c',
    rpcOwner: 'genuine-private-rpc',
    syntheticProviderHost: 'synthetic.invalid',
    result: { status: 'ready-local', operationId: digest },
    recordDigest: digest,
    publicFixtureRecordSha256: digest,
    publicFixtureEntrySha256: digest,
    authenticatedReadyReadback: true,
    auditCustodyUnchanged: true,
    proofProduced: true,
    signatureIndependentlyVerified: true,
    proofsIndependentlyVerified: true,
    productionServiceAuthority: false,
    liveServiceContact: false,
    relaySendPermitted: false,
    transportAttempted: false,
    actualProductionListQualified: false,
    recoverySequenceDelta: 4,
    originalSourceSha256: 'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41',
  };
  return { config, outcome, first };
}
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});
test('fixed approved attestation admits only declared public first-run identity', () => {
  const v = admissionInput();
  expect(() => load().admission(v.config, v.outcome, v.first)).not.toThrow();
});
test.each([
  ['unapproved', (v) => (v.config.approved = false)],
  ['profile argument', (v) => (v.config.profile = '/existing')],
  ['other directory', (v) => (v.outcome.firstDirectory = '/other')],
  ['failed driver', (v) => (v.outcome.originalDriver.exitCode = 1)],
  ['signalled main', (v) => (v.outcome.originalMain.signal = 'SIGTERM')],
  ['unnatural exit', (v) => (v.outcome.originalMain.natural = false)],
  ['same pid', (v) => (v.outcome.originalDriver.pid = 200)],
  ['post drift', (v) => (v.outcome.postChecksUnchanged = false)],
  ['unqualified', (v) => (v.outcome.qualified = false)],
  ['wrong report', (v) => (v.outcome.reportSha256 = 'b'.repeat(64))],
  ['real list', (v) => (v.first.syntheticList = 'b'.repeat(64))],
  ['signed only', (v) => (v.first.result.status = 'signed')],
  ['wrong provider', (v) => (v.first.syntheticProviderHost = 'synthetic.invalid:443')],
  ['entry absent', (v) => delete v.first.publicFixtureEntrySha256],
  ['send grant', (v) => (v.first.relaySendPermitted = true)],
  ['relative input', (v) => (v.config.archive = 'engine.asar')],
])('%s refuses before any owner/profile access', (_name, change) => {
  const v = admissionInput();
  change(v);
  expect(() => load().admission(v.config, v.outcome, v.first)).toThrow();
});
const tag = (n) => '0x' + n.toString(16);
function rpcRows() {
  const rows = [{ method: 'eth_chainId', params: [] }];
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let pass = 0; pass < 4; pass++)
      for (const t of ['finalized', tag(5900000), tag(5944730), tag(5944800), tag(5899999)])
        rows.push({ method: 'eth_getBlockByNumber', params: [t, false] });
    rows.push({
      method: 'eth_getLogs',
      params: [
        {
          address: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
          fromBlock: tag(5900000),
          toBlock: tag(5944730),
        },
      ],
    });
    for (const n of [5944710, 5944720, 5944730])
      rows.push({ method: 'eth_getBlockByNumber', params: [tag(n), false] });
  }
  return rows;
}
test('49 RPC map includes range-to/event overlap and only bounded public responses', () => {
  const m = load();
  const rows = rpcRows();
  expect(m.assertRpc(rows)['eth_getBlockByNumber:' + tag(5944730)]).toBe(10);
  for (const row of rows) expect(() => m.rpcReply(row.method, row.params, [])).not.toThrow();
});
test.each(['extra-chain', 'missing-header', 'wrong-tag', 'poi', 'wrong-range'])(
  'RPC refusal: %s',
  (name) => {
    const m = load();
    const rows = rpcRows();
    if (name === 'extra-chain') rows.push(rows[0]);
    if (name === 'missing-header') rows.splice(1, 1);
    if (name === 'wrong-tag') rows[1].params[0] = tag(0);
    if (name === 'poi') {
      expect(() => m.rpcReply('ppoi_pois_per_list', [], [])).toThrow();
      return;
    }
    if (name === 'wrong-range') {
      expect(() =>
        m.rpcReply(
          'eth_getLogs',
          [
            {
              address: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
              fromBlock: '0x0',
              toBlock: tag(5944730),
            },
          ],
          []
        )
      ).toThrow();
      return;
    }
    expect(() => m.assertRpc(rows)).toThrow();
  }
);
test('real RPC creates genuine destination/read budget with one chain handshake through synthetic transport', async () => {
  jest.doMock('../../src/main/networks/wallet-tor-transport', () => ({
    createWalletTorTransport: jest.fn(),
  }));
  jest.doMock('../../src/main/networks/network-registry', () => ({
    getNetwork: jest.fn(),
    getEndpoints: jest.fn(),
    getEndpointSources: jest.fn(),
  }));
  jest.doMock('../../src/main/tor-manager', () => ({ getWalletSocksEndpoint: jest.fn() }));
  jest.doMock('../../src/main/settings-store', () => ({
    isWalletTorExperimentAvailable: jest.fn(),
  }));
  const m = load(),
    services = m.installServices([]);
  const scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'cold-rpc-test',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
  });
  const rpc = require('../../src/main/networks/private-rpc');
  const client = rpc.createPrivateRpc(handle, 'protocol-rpc');
  try {
    const destination = rpc.getPrivateRpcDestination(client, handle);
    expect(rpc.assertPrivateRpcDestination(client, handle, destination)).toBe(destination);
    expect(() => rpc.getPrivateRpcDestination({ ...client }, handle)).toThrow();
    expect(client.trust.queried).toEqual(['synthetic.invalid']);
    const b = rpc.createPrivateRpcReadBudget({
      client,
      handle,
      destination,
      signal: new AbortController().signal,
      deadline: performance.now() + 60000,
      envelope: {
        headers: [{ tag: 'finalized', maxRequests: 4 }],
        logs: {
          address: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
          fromBlock: tag(5900000),
          toBlock: tag(5944730),
        },
        eventHeaders: { fromBlock: tag(5900000), toBlock: tag(5944730), maxRequests: 3 },
      },
    });
    await client.request('eth_getBlockByNumber', ['finalized', false], () => true, b.budget);
    await client.request('eth_getBlockByNumber', ['finalized', false], () => true, b.budget);
    expect(services.rows.map((v) => v.method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
    ]);
    b.close();
    await b.closed;
  } finally {
    client.release();
    scope.close();
    await services.close();
    services.restore();
  }
});
function custody() {
  const entry = { id: digest, origin: 'relay-local-v4', state: 'signing-local' },
    record = {
      state: 'ready-local',
      signature: { R8: ['one', 'two'], S: 'three' },
      proved: { transaction: { data: 'original' }, payload: { proof: 'original' } },
    };
  let pair = { entry, record, recordDigest: digest, interruptedStep: null };
  const rec = {
    inspect: jest.fn(async () => ({
      records: 1,
      sequence: 4,
      capacity: 10,
      states: [{ id: digest, state: 'ready-local' }],
    })),
  };
  const res = {
    inspect: jest.fn(async () => ({ held: 0, signing: 0, abandoned: 0, legacy: 0 })),
    listRelay: jest.fn(async () => [{ id: digest, state: 'signing-local' }]),
    readRelay: jest.fn(async () => structuredClone(pair)),
  };
  const owners = {
    enrollment: {
      openReservations: jest.fn(async () => res),
      openRelayRecoveryStore: jest.fn(async () => rec),
    },
  };
  const first = {
    result: { operationId: digest },
    recordDigest: digest,
    publicFixtureRecordSha256: sha(JSON.stringify(record)),
    publicFixtureEntrySha256: sha(JSON.stringify(entry)),
  };
  const config = {
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
  };
  return { owners, res, rec, first, config, change: (fn) => fn(pair) };
}
test('canonical record/entry and measured sequence survive C-only continuation without store mutation methods', async () => {
  const c = custody(),
    run = jest.fn(async () => ({ status: 'ready-local', operationId: digest }));
  jest.doMock(wallet + 'railgun-relay-operation', () => ({
    resumeRailgunAccountRelayOperation: run,
  }));
  const signal = new AbortController().signal;
  const result = await load().qualify({}, c.owners, c.config, c.first, signal);
  expect(result.authenticatedPairUnchanged).toBe(true);
  expect(result.recoverySequenceBefore).toBe(4);
  expect(result.recoverySequenceAfter).toBe(4);
  expect(c.owners.enrollment.openReservations).toHaveBeenCalledWith({ existingOnly: true });
  expect(c.owners.enrollment.openRelayRecoveryStore).toHaveBeenCalledWith({ existingOnly: true });
  expect(Object.keys(run.mock.calls[0][0]).sort()).toEqual(
    [
      'account',
      'owners',
      'operationId',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'signal',
    ].sort()
  );
});
test.each([
  'signature',
  'proof',
  'entry',
  'sequence',
  'orphan',
  'private-count',
  'first-hash',
  'first-entry-hash',
  'downgraded',
  'refused',
])('cold custody refuses %s divergence', async (name) => {
  const c = custody();
  const run = jest.fn(async () => {
    if (name === 'signature') c.change((p) => (p.record.signature.S = 'new'));
    if (name === 'proof') c.change((p) => (p.record.proved.payload.proof = 'new'));
    if (name === 'entry') c.change((p) => (p.entry.extra = true));
    if (name === 'sequence')
      c.rec.inspect.mockResolvedValue({
        records: 1,
        sequence: 5,
        capacity: 10,
        states: [{ id: digest, state: 'ready-local' }],
      });
    if (name === 'private-count')
      c.res.inspect.mockResolvedValue({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
    return { status: name === 'refused' ? 'refused' : 'ready-local', operationId: digest };
  });
  jest.doMock(wallet + 'railgun-relay-operation', () => ({
    resumeRailgunAccountRelayOperation: run,
  }));
  if (name === 'orphan')
    c.res.listRelay.mockResolvedValue([
      { id: digest, state: 'signing-local' },
      { id: 'b'.repeat(64), state: 'held' },
    ]);
  if (name === 'first-hash') c.first.publicFixtureRecordSha256 = 'b'.repeat(64);
  if (name === 'first-entry-hash') c.first.publicFixtureEntrySha256 = 'b'.repeat(64);
  if (name === 'downgraded') c.change((p) => (p.record.state = 'signed'));
  await expect(
    load().qualify({}, c.owners, c.config, c.first, new AbortController().signal)
  ).rejects.toThrow();
  if (['orphan', 'first-hash', 'first-entry-hash', 'downgraded'].includes(name))
    expect(run).not.toHaveBeenCalled();
});
test('late original resume remains pending and is observed before custody comparison', async () => {
  const c = custody(),
    gate = deferred();
  jest.doMock(wallet + 'railgun-relay-operation', () => ({
    resumeRailgunAccountRelayOperation: () => gate.promise,
  }));
  const abort = new AbortController();
  let settled = false;
  const p = load()
    .qualify({}, c.owners, c.config, c.first, abort.signal)
    .finally(() => {
      settled = true;
    });
  await new Promise(setImmediate);
  abort.abort();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  gate.reject(Error('original refusal'));
  await expect(p).rejects.toThrow('original refusal');
});
async function jobHarness({
  hold = false,
  wrongExit = false,
  wrongKey = false,
  wrongGuard = false,
} = {}) {
  const tasks = [],
    original = jest.fn((options) => {
      const gate = deferred();
      const task = { ready: Promise.resolve(), closed: gate.promise, close: jest.fn() };
      tasks.push({ options, task, gate });
      return task;
    });
  jest.doMock(wallet + 'railgun-process', () => ({ startRailgunProcess: original }));
  jest.doMock(wallet + 'railgun-session-worker', () => ({
    startRailgunSessionWorker: jest.fn(() => ({ closed: Promise.resolve({ exitCode: 0 }) })),
    startRailgunReadOnlySessionWorker: jest.fn(() => ({
      closed: Promise.resolve({ exitCode: 0 }),
    })),
  }));
  const m = load(),
    observer = m.installJobs(digest),
    runtime = require(wallet + 'railgun-process'),
    sessions = require(wallet + 'railgun-session-worker');
  observer.deadline(performance.now() + 180000);
  const guards = require('../qualify-railgun-relay-proof').EXPECTED_GUARDS;
  sessions.startRailgunSessionWorker({});
  sessions.startRailgunSessionWorker({});
  sessions.startRailgunReadOnlySessionWorker({});
  for (const [index, role] of m.ROLES.entries()) {
    const identity = ['spending-public', 'viewing-identity'].includes(role),
      publicJob = role === 'public-plan',
      restore = role === 'wallet-restore';
    const input = identity
      ? { purpose: role }
      : publicJob
        ? { mode: 'plan' }
        : restore
          ? { restore: true }
          : {
              recordStream: {
                schema: 'railgun-relay-local-record-stream-v1',
                bytes: 1,
                sha256: digest,
                chunks: 1,
              },
            };
    const filename = require.resolve(
      wallet +
        (identity
          ? 'railgun-identity-job'
          : publicJob
            ? 'railgun-public-job'
            : restore
              ? 'railgun-wallet-job'
              : 'railgun-relay-verify-job')
    );
    const bytes = Buffer.alloc(32, 7),
      broker = {
        dispatch: jest.fn(async (wire) =>
          JSON.parse(wire).method === 'key'
            ? bytes
            : JSON.stringify({ id: JSON.parse(wire).id, value: null })
        ),
      };
    const returned = runtime.startRailgunProcess({
      input: JSON.stringify(input),
      ...(identity || restore
        ? { executionJob: identity ? role : 'wallet-viewing' }
        : { filename, binaryKey: false }),
      startupMs: 60000,
      lifetimeMs: 60000,
      broker,
    });
    expect(returned).toBe(tasks[index].task);
    const dispatch = tasks[index].options.broker.dispatch;
    let id = 0;
    if (identity || restore)
      await dispatch(
        JSON.stringify({
          id: ++id,
          method: 'key',
          purpose: wrongKey ? 'relay-sign' : restore ? 'wallet-viewing' : role,
        })
      );
    if (publicJob) {
      await dispatch(JSON.stringify({ id: ++id, method: 'sourceNext' }));
      await dispatch(JSON.stringify({ id: ++id, method: 'sourceNext' }));
    }
    if (role === 'dual-proof-C')
      await dispatch(JSON.stringify({ id: ++id, method: 'relay-verify-record', index: 0 }));
    const actualGuards = wrongGuard ? { ...guards, attempts: 1 } : guards;
    const value =
      role === 'dual-proof-C'
        ? {
            guards: actualGuards,
            recordDigest: digest,
            transactionDigest: digest,
            payloadDigest: digest,
            transactionVerified: true,
            prePoiVerified: true,
            historicalEventSignatureVerified: true,
            historicalMembershipPathVerified: true,
            inputOwnershipVerified: false,
            currentMembershipVerified: false,
            authorityGranted: false,
          }
        : { guards: actualGuards };
    await dispatch(
      JSON.stringify({
        id: id + 1,
        method: publicJob ? 'jobResult' : 'result',
        value,
        ...(identity ? { guards: actualGuards } : {}),
      })
    );
    bytes.fill(0);
    if (index !== 5 || !hold)
      tasks[index].gate.resolve({
        code: 'RAILGUN_PROCESS_CLOSED',
        exitCode: wrongExit ? 1 : 15,
        escalated: false,
        peerDisconnected: false,
      });
    await Promise.resolve();
  }
  return { observer, tasks };
}
test('six fixed original jobs and three wiped binary loans retain their original handles', async () => {
  const { observer } = await jobHarness();
  await observer.finish();
  expect(observer.rows).toHaveLength(6);
  expect(observer.workers).toHaveLength(3);
  observer.restore();
});
test('held original C closure cannot publish a finished observation', async () => {
  const { observer, tasks } = await jobHarness({ hold: true });
  let done = false;
  const finish = observer.finish().then(() => {
    done = true;
  });
  await new Promise(setImmediate);
  expect(done).toBe(false);
  tasks[5].gate.resolve({
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  });
  await finish;
  observer.restore();
});
test.each(['wrongKey', 'wrongGuard', 'wrongExit'])('job observer refuses %s', async (name) => {
  await expect(
    (async () => {
      const { observer } = await jobHarness({ [name]: true });
      await observer.finish();
    })()
  ).rejects.toThrow();
});
test('local observation envelope ignores hostile native Promise species return', async () => {
  const m = load(),
    gate = deferred(),
    pending = [],
    seen = [];
  const then = jest.fn();
  gate.promise.constructor = {
    [Symbol.species]: function (executor) {
      executor(
        () => {},
        () => {}
      );
      return { then };
    },
  };
  m.observe(gate.promise, (v) => seen.push(v), pending);
  await Promise.resolve();
  expect(seen).toEqual([]);
  expect(then).not.toHaveBeenCalled();
  gate.resolve(7);
  await Promise.all(pending);
  expect(seen).toEqual([7]);
  expect(then).not.toHaveBeenCalled();
});
test('unapproved config is refused before first report/outcome reads', () => {
  const fs = require('fs');
  const v = admissionInput();
  v.config.approved = false;
  const bytes = Buffer.from(JSON.stringify(v.config));
  const real = jest.spyOn(fs, 'realpathSync').mockImplementation((p) => p);
  const stat = jest.spyOn(fs, 'lstatSync').mockReturnValue({
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
    size: bytes.length,
  });
  const read = jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p !== '/public/config.json') throw Error('Unexpected input read');
    return bytes;
  });
  // Load first so the filesystem trap is restricted to the actual admission call.
  try {
    expect(() => load().readAdmission('/public/config.json')).toThrow();
    expect(read.mock.calls.map((v) => v[0])).toEqual(['/public/config.json']);
  } finally {
    real.mockRestore();
    stat.mockRestore();
    read.mockRestore();
  }
});
test('combined twelve-file copy gives identical positive and cold source snapshots', () => {
  const fs = require('fs'),
    path = require('path'),
    vm = require('vm');
  const file = path.join(__dirname, 'railgun-relay-positive-native.js');
  const source = fs.readFileSync(file, 'utf8');
  const declarations = [
    ...source.matchAll(/const sourceHashes = ([\s\S]*?);\n {2}const before = sourceHashes\(\);/g),
  ];
  expect(declarations).toHaveLength(1);
  const retained = require('./railgun-relay-retained-run');
  const expected = vm.runInNewContext('(' + declarations[0][1] + ')', {
    fs,
    path,
    sha,
    retained,
    __dirname,
  })();
  const actual = load().sourceSnapshot();
  expect(actual).toEqual(expected);
  for (const name of [
    'scripts/qualify-railgun-relay-cold-ready.js',
    'scripts/qualify-railgun-relay-cold-ready.test.js',
    'scripts/fixtures/railgun-relay-cold-ready-native.js',
    'scripts/fixtures/railgun-relay-cold-ready-native.test.js',
    'scripts/fixtures/railgun-shield-offline-deployment.js',
    'docs/qualification/railgun-public-contract-bytecodes-2026-10-04.json',
  ])
    expect(actual[name]).toMatch(/^[0-9a-f]{64}$/);
});
test('cold publication uses the fixed shared cache inspector after original cleanup and postchecks', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, 'railgun-relay-cold-ready-native.js'),
    'utf8'
  );
  const inspection = source.indexOf(
    "mainModuleCache: require('./railgun-relay-positive-native').inspectMainModuleCache()"
  );
  expect(inspection).toBeGreaterThan(source.indexOf('await jobs.finish()'));
  expect(inspection).toBeGreaterThan(
    source.lastIndexOf('assert.deepEqual(sourceSnapshot(), before)')
  );
  expect(inspection).toBeGreaterThan(source.lastIndexOf('bounded(config.firstOutcomeFilename'));
  expect(source).not.toContain('collectMainModuleCache(');
});
test.each(['method', 'json'])(
  'caught cold synthetic transport refusal %s remains sticky and prevents successful closure',
  async (fault) => {
    jest.doMock('../../src/main/networks/wallet-tor-transport', () => ({
      createWalletTorTransport: jest.fn(),
    }));
    jest.doMock('../../src/main/networks/network-registry', () => ({
      getNetwork: jest.fn(),
      getEndpoints: jest.fn(),
      getEndpointSources: jest.fn(),
    }));
    jest.doMock('../../src/main/tor-manager', () => ({ getWalletSocksEndpoint: jest.fn() }));
    jest.doMock('../../src/main/settings-store', () => ({
      isWalletTorExperimentAvailable: jest.fn(),
    }));
    const m = load(),
      services = m.installServices([]);
    const scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
      profileId: 'cold-refused-transport',
      signal: new AbortController().signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'railgun:0',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'protocol-rpc',
    });
    const transport =
      require('../../src/main/networks/wallet-tor-transport').createWalletTorTransport();
    try {
      await expect(
        transport.request(handle, 'https://synthetic.invalid/railgun', {
          method: 'POST',
          signal: scope.signal,
          body:
            fault === 'json'
              ? '{invalid'
              : JSON.stringify({
                  jsonrpc: '2.0',
                  id: 'forbidden',
                  method: 'ppoi_pois_per_list',
                  params: [],
                }),
        })
      ).rejects.toThrow();
      expect(services.rows).toHaveLength(0);
      expect(services.refusedAttempts).toBe(1);
      expect(() => require('./railgun-native-assertions').assertEmpty()).toThrow();
      await expect(services.close()).rejects.toThrow();
    } finally {
      scope.close();
      services.restore();
    }
  }
);
test.each([
  'railgun-account-public',
  'railgun-poi-source',
  'railgun-public-services',
  'railgun-poi-root',
  'railgun-private-preflight',
  'railgun-shield-preflight',
  'railgun-source-ledger',
])('cold observer refuses already-captured factory consumer %s', (name) => {
  const fs = require('fs'),
    path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, 'railgun-relay-cold-ready-native.js'),
    'utf8'
  );
  const req = (value) => require(value);
  req.resolve = (value) => require.resolve(value);
  req.cache = { [require.resolve(wallet + name)]: {} };
  const module = { exports: {} };
  Function('require', 'module', '__dirname', source)(req, module, __dirname);
  expect(() =>
    name === 'railgun-source-ledger'
      ? module.exports.installJobs(digest)
      : module.exports.installServices([])
  ).toThrow();
});
function signedAdmission() {
  const v = admissionInput();
  v.first = {
    ...v.first,
    schema: 'railgun-relay-signed-stop-native-v1',
    scenario: 'synthetic-list-signed-stop',
    result: {
      status: 'recovery-required',
      stage: 'proof',
      operationId: digest,
      signingAttempted: true,
      signatureSaved: true,
    },
    signatureSha256: digest,
    proofPersisted: false,
    recoverySequenceDelta: 3,
  };
  delete v.first.authenticatedReadyReadback;
  delete v.first.auditCustodyUnchanged;
  return v;
}
test('signed-stop first report admits only the signed resume mode', () => {
  const f = load();
  expect(f.admission(...Object.values(admissionInput()))).toBe('ready');
  const v = signedAdmission();
  expect(f.admission(v.config, v.outcome, v.first)).toBe('signed');
  expect(f.SIGNED_ROLES).toEqual([...f.ROLES.slice(0, -1), 'proof-A', 'dual-proof-C']);
});
test.each([
  ['ready scenario', (v) => (v.first.scenario = 'synthetic-list')],
  ['unsaved signature', (v) => (v.first.result.signatureSaved = false)],
  ['refused', (v) => (v.first.result.status = 'refused')],
  ['other stage', (v) => (v.first.result.stage = 'signature-storage')],
  ['persisted proof', (v) => (v.first.proofPersisted = true)],
  ['ready sequence', (v) => (v.first.recoverySequenceDelta = 4)],
  ['missing signature hash', (v) => delete v.first.signatureSha256],
  ['unknown schema', (v) => (v.first.schema = 'railgun-relay-signed-native-v1')],
])('signed admission refuses %s', (_, change) => {
  const v = signedAdmission();
  change(v);
  expect(() => load().admission(v.config, v.outcome, v.first)).toThrow();
});
function signedCustody() {
  const entry = { id: digest, origin: 'relay-local-v4', state: 'signing-local' },
    signature = { R8: ['one', 'two'], S: 'three' },
    record = { state: 'signed', signature, intent: { i: 1 }, proved: null };
  let state = 'signed';
  const ready = {
    ...record,
    state: 'ready-local',
    proved: { transaction: { t: 1 }, payload: { p: 1 } },
  };
  const read = () => ({
    entry,
    record: structuredClone(state === 'signed' ? record : ready),
    recordDigest: digest,
    interruptedStep: null,
  });
  const rec = {
    inspect: jest.fn(async () => ({
      records: 1,
      sequence: state === 'signed' ? 3 : 4,
      capacity: 10,
      states: [{ id: digest, state: state === 'signed' ? 'signed' : 'ready-local' }],
    })),
  };
  const res = {
    inspect: jest.fn(async () => ({ held: 0, signing: 0, abandoned: 0, legacy: 0 })),
    listRelay: jest.fn(async () => [{ id: digest, state: 'signing-local' }]),
    readRelay: jest.fn(async () => read()),
  };
  const owners = {
    enrollment: {
      openReservations: jest.fn(async () => res),
      openRelayRecoveryStore: jest.fn(async () => rec),
    },
  };
  const first = {
    result: { operationId: digest },
    recordDigest: digest,
    publicFixtureRecordSha256: sha(JSON.stringify(record)),
    publicFixtureEntrySha256: sha(JSON.stringify(entry)),
    signatureSha256: sha(JSON.stringify(signature)),
  };
  const config = { archive: '/e', proverArchive: '/p', artifactDirectory: '/a' };
  return {
    owners,
    first,
    config,
    ready,
    advance: () => (state = 'ready'),
    mutate: (fn) => fn({ ready, record, entry }),
  };
}
test('signed resume reuses the original signature and changes only proof and state', async () => {
  const c = signedCustody(),
    run = jest.fn(async () => {
      c.advance();
      return { status: 'ready-local', operationId: digest };
    });
  jest.doMock(wallet + 'railgun-relay-operation', () => ({
    resumeRailgunAccountRelayOperation: run,
  }));
  const report = await load().qualify(
    {},
    c.owners,
    c.config,
    c.first,
    new AbortController().signal,
    'signed'
  );
  expect(report).toMatchObject({
    originalSignaturePreserved: true,
    entryUnchanged: true,
    recoverySequenceBefore: 3,
    recoverySequenceAfter: 4,
    signatureSha256: c.first.signatureSha256,
    recordSha256: sha(JSON.stringify(c.ready)),
  });
});
test.each([
  ['re-signed', (x) => (x.ready.signature = { R8: ['x', 'y'], S: 'z' })],
  ['changed intent', (x) => (x.ready.intent = { i: 2 })],
  ['unproved', (x) => (x.ready.proved = null)],
])('signed resume refuses %s ready record', async (_, change) => {
  const c = signedCustody();
  c.mutate(change);
  jest.doMock(wallet + 'railgun-relay-operation', () => ({
    resumeRailgunAccountRelayOperation: async () => {
      c.advance();
      return { status: 'ready-local', operationId: digest };
    },
  }));
  await expect(
    load().qualify({}, c.owners, c.config, c.first, new AbortController().signal, 'signed')
  ).rejects.toThrow();
});
test('signed resume refuses a ready first record and an unadvanced store', async () => {
  const c = signedCustody();
  jest.doMock(wallet + 'railgun-relay-operation', () => ({
    resumeRailgunAccountRelayOperation: async () => ({
      status: 'ready-local',
      operationId: digest,
    }),
  }));
  await expect(
    load().qualify({}, c.owners, c.config, c.first, new AbortController().signal, 'signed')
  ).rejects.toThrow();
  const r = custody();
  await expect(
    load().qualify({}, r.owners, r.config, r.first, new AbortController().signal, 'signed')
  ).rejects.toThrow();
});
test('signed resume shares the exact ready RPC map', () => {
  const f = load(),
    rows = rpcRows();
  expect(f.assertRpc(rows)).toBeTruthy();
  expect(() => f.assertRpc([...rows, rows.find((v) => v.method === 'eth_getLogs')])).toThrow();
});
test('Transact first report admits the ready-record verifier mode only', () => {
  const v = admissionInput();
  v.first = {
    ...v.first,
    schema: 'railgun-relay-transact-native-v1',
    scenario: 'synthetic-list-transact',
    selectedInputType: 'Transact',
    translatedTxidRowSha256: digest,
  };
  expect(load().admission(v.config, v.outcome, v.first)).toBe('transact');
  for (const change of [
    (x) => (x.first.scenario = 'synthetic-list'),
    (x) => (x.first.selectedInputType = 'Shield'),
    (x) => delete x.first.translatedTxidRowSha256,
    (x) => (x.first.result.status = 'recovery-required'),
  ]) {
    const bad = structuredClone(v);
    change(bad);
    expect(() => load().admission(bad.config, bad.outcome, bad.first)).toThrow();
  }
});
test('cold log replies keep original transaction and log indexes', () => {
  const f = load();
  const logs = [
    { blockNumber: 5944730, transactionIndex: 0, logIndex: 0, data: '0x' },
    { blockNumber: 5944730, transactionIndex: 0, logIndex: 1, data: '0x' },
  ];
  const reply = f.rpcReply(
    'eth_getLogs',
    [
      {
        address: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
        fromBlock: tag(5900000),
        toBlock: tag(5944730),
      },
    ],
    logs
  );
  expect(reply.map((v) => [v.transactionIndex, v.logIndex])).toEqual([
    ['0x0', '0x0'],
    ['0x0', '0x1'],
  ]);
});

test.each(['legacy-filename', 'mixed-route'])(
  'cold observer refuses an extracted identity %s before original launch',
  (kind) => {
    const original = jest.fn();
    jest.doMock(wallet + 'railgun-process', () => ({ startRailgunProcess: original }));
    jest.doMock(wallet + 'railgun-session-worker', () => ({
      startRailgunSessionWorker: jest.fn(),
      startRailgunReadOnlySessionWorker: jest.fn(),
    }));
    const observer = load().installJobs(digest),
      runtime = require(wallet + 'railgun-process');
    observer.deadline(performance.now() + 180000);
    try {
      expect(() =>
        runtime.startRailgunProcess({
          filename: require.resolve(wallet + 'railgun-identity-job'),
          input: JSON.stringify({ purpose: 'spending-public' }),
          broker: { dispatch: jest.fn() },
          ...(kind === 'mixed-route' ? { executionJob: 'spending-public' } : {}),
        })
      ).toThrow();
      expect(original).not.toHaveBeenCalled();
    } finally {
      observer.restore();
    }
  }
);
