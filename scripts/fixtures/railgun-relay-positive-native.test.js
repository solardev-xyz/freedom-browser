/** Controlled process/service tests; no actual engine, SQLite or crypto execution. */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, 'railgun-relay-positive-native.js'), 'utf8');
const w = '../../src/main/wallet/',
  n = '../../src/main/networks/';
const guards = require(w + 'railgun-relay-quote-data').EXPECTED_GUARDS;
const resolved = (name) => (name.endsWith('.js') ? name : name + '.js');
function load(overrides = {}, cached = []) {
  const errors = [];
  const sticky = {
    assert,
    record: (e) => errors.push(e),
    assertEmpty: () => assert.deepEqual(errors, []),
    observeClosed: (work, use) => work.then(use).catch((e) => errors.push(e)),
  };
  const req = (name) =>
    name === './railgun-native-assertions'
      ? sticky
      : Object.hasOwn(overrides, name)
        ? overrides[name]
        : require(name);
  req.resolve = resolved;
  req.cache = Object.fromEntries(cached.map((name) => [resolved(w + name), {}]));
  const module = { exports: {} };
  Function(
    'require',
    'module',
    '__dirname',
    'structuredClone',
    source
  )(req, module, __dirname, (v) => JSON.parse(JSON.stringify(v)));
  return { ...module.exports, errors };
}
const args = ['/public.json', '/fresh', '/engine.asar', 'enrolled', '/prover.asar', '/artifacts'];
test('exact opt-in and unchanged public source/range calculation give 79 roles', () => {
  const f = load();
  expect(f.select(undefined, [], {})).toBeNull();
  expect(f.select('synthetic-list', args, {}).scenario).toBe('synthetic-list');
  expect(f.ranges()).toHaveLength(60);
  expect(f.expectedRoles()).toHaveLength(79);
  expect(f.expectedRoles().slice(-14)).toEqual([
    'membership-fixture',
    'quote',
    'construct',
    'reconstruct',
    'membership',
    'pre-poi-binding',
    'relay-sign',
    'signature-C',
    'proof-A',
    'dual-proof-C',
    'audit-unmodified',
    'audit-signature',
    'audit-transaction-proof',
    'audit-pre-poi-proof',
  ]);
});
test.each(['', '1', 'unrelated-history', 'declined-disclosure'])(
  'rejects old/wrong mode %s',
  (v) => {
    expect(() => load().select(v, args, {})).toThrow();
  }
);
test('competing env flag, relative path or extra argument refuse', () => {
  const f = load();
  expect(() =>
    f.select('synthetic-list', args, { FREEDOM_RAILGUN_RELAY_REFUSAL: 'unrelated-history' })
  ).toThrow();
  expect(() => f.select('synthetic-list', ['relative', ...args.slice(1)], {})).toThrow();
  expect(() => f.select('synthetic-list', [...args, 'extra'], {})).toThrow();
});
function roleOptions(role) {
  let filename,
    input = {},
    purpose;
  if (['spending-public', 'viewing-identity'].includes(role)) {
    filename = w + 'railgun-identity-job';
    input.purpose = role;
    purpose = role;
  } else if (role.startsWith('public-')) {
    filename = w + 'railgun-public-job';
    input.mode = role.slice(7);
  } else if (role.startsWith('wallet-')) {
    filename = w + 'railgun-wallet-job';
    input.restore = role === 'wallet-restore';
    purpose = 'wallet-viewing';
  } else if (['construct', 'reconstruct'].includes(role)) {
    filename = w + 'railgun-relay-wallet-job';
    input = role === 'construct' ? { relayRequest: {} } : { relayDraftText: '{}' };
    purpose = role === 'construct' ? 'relay-prepare' : 'relay-reconstruct';
  } else if (role === 'membership-fixture') filename = './railgun-relay-positive-membership-job';
  else if (role.startsWith('audit-')) {
    filename = './railgun-relay-positive-audit-job';
    input.auditCase = role.slice(6);
  } else {
    filename =
      w +
      {
        quote: 'railgun-relay-quote-job',
        membership: 'railgun-poi-job',
        'pre-poi-binding': 'railgun-relay-pre-poi-job',
        'relay-sign': 'railgun-relay-sign-job',
        'signature-C': 'railgun-relay-signature-verify-job',
        'proof-A': 'railgun-relay-prove-job',
        'dual-proof-C': 'railgun-relay-verify-job',
      }[role];
    purpose = {
      'pre-poi-binding': 'relay-pre-poi',
      'relay-sign': 'relay-sign',
      'proof-A': 'relay-prove-local',
    }[role];
  }
  if (role === 'proof-A' || role === 'dual-proof-C' || role.startsWith('audit-'))
    input.recordStream = {
      schema: 'railgun-relay-local-record-stream-v1',
      bytes: 2,
      sha256: '00'.repeat(32),
      chunks: 1,
    };
  return { filename: resolved(filename), input: JSON.stringify(input), purpose };
}
test.each(['success', 'missing-result', 'exit-one'])(
  'observer preserves original task and broker reply identities across all 79 roles (%s)',
  async (fault) => {
    let task;
    const original = jest.fn(() => task),
      runtime = { startRailgunProcess: original };
    const issued = jest.fn(),
      draft = jest.fn(),
      f = load({ [w + 'railgun-process']: runtime }),
      observation = f.installJobs(draft, issued);
    for (const role of f.expectedRoles()) {
      let end;
      task = {
        closed: new Promise((resolve) => {
          end = resolve;
        }),
      };
      const options = roleOptions(role),
        keyReply = Promise.resolve(new Uint8Array(32)),
        reply = Promise.resolve('original');
      const dispatch = jest.fn((wire) => (JSON.parse(wire).method === 'key' ? keyReply : reply));
      options.broker = { dispatch };
      expect(runtime.startRailgunProcess(options)).toBe(task);
      const forwarded = original.mock.calls.at(-1)[0].broker.dispatch;
      let id = 0;
      if (options.purpose)
        expect(
          forwarded(JSON.stringify({ id: ++id, method: 'key', purpose: options.purpose }))
        ).toBe(keyReply);
      if (role === 'proof-A' || role === 'dual-proof-C' || role.startsWith('audit-'))
        expect(
          forwarded(
            JSON.stringify({
              id: ++id,
              method: role === 'proof-A' ? 'relay-proof-record' : 'relay-verify-record',
              index: 0,
            })
          )
        ).toBe(reply);
      if (role === 'membership')
        expect(forwarded(JSON.stringify({ id: ++id, method: 'input' }))).toBe(reply);
      if (!(fault === 'missing-result' && role === 'spending-public'))
        expect(
          forwarded(
            JSON.stringify({
              id: id + 1,
              method: role.startsWith('public-') ? 'jobResult' : 'result',
              value: { guards },
            })
          )
        ).toBe(reply);
      expect(options.broker.dispatch).toBe(dispatch);
      await reply;
      end({
        code: 'RAILGUN_PROCESS_CLOSED',
        exitCode: fault === 'exit-one' && role === 'spending-public' ? 1 : 15,
        escalated: false,
        peerDisconnected: false,
      });
      await task.closed;
    }
    if (fault === 'success') await observation.finish();
    else {
      expect(observation.rows[0].closedObserved).toBe(true);
      expect(observation.rows[0].closed.exitCode).toBe(fault === 'exit-one' ? 1 : 15);
      expect(observation.rows[0].results).toBe(fault === 'missing-result' ? 0 : 1);
      expect(f.errors.length).toBeGreaterThan(0);
      await expect(observation.finish()).rejects.toThrow();
      const diagnostic = refusalDiagnostic(
        {
          status: 'recovery-required',
          stage: 'signer',
          signingAttempted: true,
          signatureSaved: false,
        },
        observation,
        { rows: [] }
      ).value;
      expect(diagnostic.jobs[0].closedObserved).toBe(true);
      expect(diagnostic.jobs[0].exitCode).toBe(fault === 'exit-one' ? 1 : 15);
    }
    expect(issued).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(observation.rows.reduce((sum, v) => sum + v.keyReplies, 0)).toBe(9);
    observation.restore();
    expect(runtime.startRailgunProcess).toBe(original);
  }
);
test('unexpected downstream role refuses before original start', () => {
  const original = jest.fn(),
    runtime = { startRailgunProcess: original };
  const f = load({ [w + 'railgun-process']: runtime }),
    observer = f.installJobs();
  expect(() =>
    runtime.startRailgunProcess({ ...roleOptions('relay-sign'), broker: { dispatch: jest.fn() } })
  ).toThrow();
  expect(original).not.toHaveBeenCalled();
  observer.restore();
});
test('missing closure cannot admit next role even after a successful broker reply', async () => {
  const task = { closed: new Promise(() => {}) },
    runtime = { startRailgunProcess: jest.fn(() => task) };
  const f = load({ [w + 'railgun-process']: runtime }),
    observer = f.installJobs();
  runtime.startRailgunProcess({
    ...roleOptions('spending-public'),
    broker: { dispatch: async () => null },
  });
  expect(() =>
    runtime.startRailgunProcess({
      ...roleOptions('viewing-identity'),
      broker: { dispatch: async () => null },
    })
  ).toThrow();
  observer.restore();
});
function rpcRows() {
  const rows = [];
  for (let i = 0; i < 4; i++)
    for (const tag of [
      'finalized',
      ...[5944800, 5900000, 5944730, 5899999].map((v) => '0x' + v.toString(16)),
    ])
      rows.push({ method: 'eth_getBlockByNumber', params: [tag, false] });
  for (const [method, count] of Object.entries({
    eth_chainId: 2,
    eth_getBlockByNumber: 3,
    eth_getCode: 4,
    eth_getStorageAt: 2,
    eth_call: 8,
  }))
    for (let i = 0; i < count; i++) rows.push({ method, operation: 'relay-preflight', params: [] });
  return rows;
}
test('39 request contract distinguishes four source refreshes and all preflight methods', () => {
  const f = load(),
    rows = rpcRows();
  expect(Object.values(f.assertOperationRpc(rows).headers).reduce((a, b) => a + b, 0)).toBe(20);
  expect(() => f.assertOperationRpc(rows.slice(1))).toThrow();
  expect(() => f.assertOperationRpc([...rows, rows[0]])).toThrow();
  const bad = structuredClone(rows);
  bad[20].method = 'eth_sendRawTransaction';
  expect(() => f.assertOperationRpc(bad)).toThrow();
});
function serviceFixture(genuine = false, scenario = 'synthetic-list') {
  const transport = { createWalletTorTransport: jest.fn() },
    settings = { isWalletTorExperimentAvailable: jest.fn() },
    tor = { getWalletSocksEndpoint: jest.fn() },
    registry = { getNetwork: jest.fn(), getEndpoints: jest.fn(), getEndpointSources: jest.fn() };
  const note = { blindedCommitment: '0x' + '12'.repeat(32), type: 'Shield' },
    list = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';
  const f = load({
    [n + 'network-registry']: registry,
    [n + 'wallet-tor-transport']: transport,
    '../../src/main/settings-store': settings,
    '../../src/main/tor-manager': tor,
    [n + 'privacy-context']: genuine
      ? require(n + 'privacy-context')
      : { getPrivacyContext: (v) => v },
    [w + 'railgun-poi-records']: { REQUIRED_LIST: list },
  });
  const protocol = jest.fn(() => true),
    adapter = f.installServices([], () => note, scenario, protocol);
  const handle = {
    signal: new AbortController().signal,
    subject: { role: 'poi', chainId: 11155111 },
  };
  return { f, transport, registry, settings, tor, adapter, note, list, handle, protocol };
}
test('services require exact four requests and never synthesize arbitrary success', async () => {
  const x = serviceFixture();
  const rpcTransport = x.transport.createWalletTorTransport();
  await rpcTransport.request(
    {
      subject: {
        kind: 'private-account',
        role: 'protocol-rpc',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        operation: null,
      },
    },
    'https://synthetic.invalid/railgun',
    {
      method: 'POST',
      signal: x.handle.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc', method: 'eth_chainId', params: [] }),
    }
  );
  const proof = { leaf: x.note.blindedCommitment.slice(2), root: '34'.repeat(32) },
    event = { signedPOIEvent: { index: 0 } };
  x.adapter.fixture({ proof, event });
  const t = x.transport.createWalletTorTransport();
  const context = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
  const request = (method, params) =>
    t.request(x.handle, 'https://ppoi.fdi.network', {
      method: 'POST',
      signal: x.handle.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method,
        params: { ...context, ...params },
      }),
    });
  await request('ppoi_pois_per_list', { listKeys: [x.list], blindedCommitmentDatas: [x.note] });
  expect(
    JSON.parse(
      (
        await request('ppoi_merkle_proofs', {
          listKey: x.list,
          blindedCommitments: [x.note.blindedCommitment],
        })
      ).body
    ).result
  ).toEqual([proof]);
  await request('ppoi_poi_events', { listKey: x.list, startIndex: 0, endIndex: 0 });
  await request('ppoi_validate_poi_merkleroots', { listKey: x.list, poiMerkleroots: [proof.root] });
  await expect(request('ppoi_validate_poi_merkleroots', {})).rejects.toThrow();
  t.close();
  await t.closed;
  x.adapter.assertClosed();
  await x.adapter.close();
  x.adapter.restore();
});
test('protocol selection is fixed at lower transport; public route cannot send', async () => {
  const x = serviceFixture(),
    t = x.transport.createWalletTorTransport();
  const handle = {
    signal: new AbortController().signal,
    subject: {
      kind: 'private-account',
      role: 'protocol-rpc',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      operation: 'relay-preflight',
    },
  };
  const request = (method) =>
    t.request(handle, 'https://synthetic.invalid/railgun', {
      method: 'POST',
      signal: handle.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params: [] }),
    });
  expect(JSON.parse((await request('eth_call')).body).result).toBe(true);
  expect(x.protocol).toHaveBeenCalledWith('eth_call', []);
  handle.subject.operation = null;
  await expect(request('eth_sendRawTransaction')).rejects.toThrow();
  await x.adapter.close();
  x.adapter.restore();
});
test('real RPC owner establishes genuine destination/budget and exact provider host over synthetic transport', async () => {
  const x = serviceFixture(true);
  // Execute the unmodified pure main module with only its existing transport/registry leaves replaced.
  const filename = path.join(__dirname, n, 'private-rpc.js');
  const module = { exports: {} };
  const overrides = {
    './network-registry': x.registry,
    './wallet-tor-transport': x.transport,
    '../settings-store': x.settings,
    '../tor-manager': x.tor,
    './privacy-context': require(n + 'privacy-context'),
  };
  Function(
    'require',
    'module',
    fs.readFileSync(filename, 'utf8')
  )((name) => overrides[name] ?? require(name), module);
  const rpc = module.exports;
  const scope = require(n + 'privacy-context').createPrivacyScope({
    profileId: 'synthetic-rpc-fixture',
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
  const client = rpc.createPrivateRpc(handle, 'protocol-rpc');
  const destination = rpc.getPrivateRpcDestination(client, handle);
  expect(rpc.assertPrivateRpcDestination(client, handle, destination)).toBe(destination);
  expect(rpc.getPrivateRpcDestinationDetails(destination).url).toBe(
    'https://synthetic.invalid/railgun'
  );
  expect(client.trust.queried).toEqual(['synthetic.invalid']);
  expect(() => rpc.getPrivateRpcDestination({ ...client }, handle)).toThrow();
  const budget = rpc.createPrivateRpcReadBudget({
    client,
    handle,
    destination,
    signal: new AbortController().signal,
    deadline: performance.now() + 5000,
    envelope: { headers: [{ tag: 'finalized', maxRequests: 2 }] },
  });
  try {
    for (let i = 0; i < 2; i++)
      await client.request(
        'eth_getBlockByNumber',
        ['finalized', false],
        (v) => v.number === '0x' + (5944800).toString(16),
        budget.budget
      );
    expect(x.adapter.requests.map((v) => v.method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
    ]);
  } finally {
    budget.close();
    await budget.closed;
    client.release();
    scope.close();
    await x.adapter.close();
    x.adapter.restore();
  }
});
test('custody observer delegates exact identity and prevents issuance before paired marker', () => {
  let result = {
    record: { id: 'id', state: 'held' },
    recordDigest: 'digest',
    reservationState: 'held',
    interruptedStep: null,
  };
  const original = jest.fn(() => result),
    data = { matchRailgunRelayLocalReservation: original };
  const f = load({ [w + 'railgun-relay-recovery-data']: data }),
    o = f.installCustody();
  o.jobs({ rows: [] });
  expect(data.matchRailgunRelayLocalReservation('text', {})).toBe(result);
  expect(() => o.issued()).toThrow();
  o.restore();
  expect(data.matchRailgunRelayLocalReservation).toBe(original);
});
test('signed custody before signature-C closure becomes sticky failure without changing original return', () => {
  const result = {
    record: { id: 'id', state: 'signed' },
    recordDigest: 'digest',
    reservationState: 'signing-local',
    interruptedStep: null,
  };
  const data = { matchRailgunRelayLocalReservation: () => result },
    f = load({ [w + 'railgun-relay-recovery-data']: data }),
    o = f.installCustody();
  o.jobs({ rows: [{ role: 'signature-C', closedObserved: false }] });
  expect(data.matchRailgunRelayLocalReservation('text', {})).toBe(result);
  expect(f.errors).toHaveLength(1);
  expect(() => o.finish()).toThrow();
  o.restore();
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixedJob(options = {}) {
  const ready = deferred(),
    closed = deferred();
  const scope = { getContext: () => ({}), close: jest.fn() };
  let request;
  const close = jest.fn(() => {
    if (options.throwClose) throw Error('close failed');
    closed.resolve({
      code: 'RAILGUN_PROCESS_CLOSED',
      exitCode: 15,
      escalated: false,
      peerDisconnected: false,
    });
  });
  const task = { ready: ready.promise, closed: closed.promise, close };
  const f = load({
    [n + 'privacy-context']: { createPrivacyScope: () => scope },
    [w + 'railgun-process']: {
      startRailgunProcess: (opts) => {
        request = opts.broker.dispatch;
        return task;
      },
    },
  });
  return { f, ready, closed, scope, task, request: (wire) => request(wire) };
}
test('fixed fixture job waits original close and response; no second result', async () => {
  const x = fixedJob(),
    validate = jest.fn();
  const work = x.f.runFixtureJob('membership-fixture', {}, validate, null, 10000);
  expect(await x.request('{"id":1,"method":"result","value":{"ok":true}}')).toBe(
    '{"id":1,"value":null}'
  );
  x.ready.resolve();
  expect(await work).toEqual({ ok: true });
  expect(validate).toHaveBeenCalledTimes(1);
  expect(x.scope.close).toHaveBeenCalledTimes(1);
});
test('throwing close never skips held original ready/closed barriers', async () => {
  const x = fixedJob({ throwClose: true });
  let settled = false;
  const work = x.f.runFixtureJob('membership-fixture', {}, () => {}, null, 10000);
  const observed = work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await expect(x.request('{"id":2,"method":"result","value":{}}')).rejects.toThrow();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(x.scope.close).not.toHaveBeenCalled();
  x.ready.resolve();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  x.closed.resolve({
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  });
  await expect(work).rejects.toThrow();
  await observed;
  expect(x.scope.close).toHaveBeenCalledTimes(1);
});
test('failed result validator remains sticky through successful original ready and closure', async () => {
  const x = fixedJob();
  const work = x.f.runFixtureJob(
    'membership-fixture',
    {},
    () => {
      throw Error('bad result');
    },
    null,
    10000
  );
  await expect(x.request('{"id":1,"method":"result","value":{}}')).rejects.toThrow('bad result');
  x.ready.resolve();
  await expect(work).rejects.toThrow('bad result');
});
function composed(mutation) {
  const hash = (v) => require('crypto').createHash('sha256').update(v).digest('hex');
  const list = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';
  const note = { id: '0:1', amount: 2000n, spentTxid: false },
    owned = {
      id: note.id,
      type: 'Shield',
      blockNumber: 5944710,
      hash: '0x' + '01'.repeat(32),
      npk: '0x' + '02'.repeat(32),
      blindedCommitment: '0x' + '03'.repeat(32),
    };
  let state = { records: 0, sequence: 0, capacity: 10, states: [] },
    ready,
    helper;
  const entry = { id: 'ab'.repeat(32), state: 'signing-local' },
    pair = { entry, recordDigest: 'cd'.repeat(32), interruptedStep: null };
  const reservations = {
    inspect: async () => ({ held: 0, signing: 0, abandoned: 0, legacy: 0 }),
    listRelay: async () => (state.records ? [entry] : []),
    readRelay: async () => ({ ...pair, record: ready }),
  };
  const recovery = { inspect: async () => JSON.parse(JSON.stringify(state)) };
  const owners = {
    identity: {
      descriptor: {
        walletId: 'ef'.repeat(32),
        spendingPublicKey: ['01'.repeat(32), '02'.repeat(32)],
      },
    },
    enrollment: {
      openReservations: async () => reservations,
      openRelayRecoveryStore: async () => recovery,
    },
  };
  const account = { close: jest.fn(async () => {}) };
  const requests = [],
    services = {
      requests,
      poiMethods: [],
      fixture: jest.fn(),
      selected: jest.fn(),
      assertClosed: jest.fn(),
      mark: jest.fn(),
      timeline: [],
    };
  const custody = { quote: jest.fn(), finish: jest.fn(), rows: [], credentialMargin: () => 180000 };
  const launched = [];
  const inventory = {
    engineSha256: require(w + 'railgun-engine-manifest.json').sha256,
    proverSha256: require(w + 'railgun-prover-manifest.json').sha256,
    artifactVkeys: Object.fromEntries(
      ['01x02', 'POI_3x3'].map((variant) => [
        variant,
        require(w + 'railgun-artifacts').manifest[variant].find((v) => v.kind === 'vkey').sha256,
      ])
    ),
  };
  const runtime = {
    startRailgunProcess(opts) {
      launched.push(opts.filename);
      let done;
      const closed = new Promise((resolve) => {
        done = resolve;
      });
      const work = Promise.resolve().then(async () => {
        const input = JSON.parse(opts.input);
        let value;
        if (opts.filename.includes('membership-job')) {
          value = {
            inputSha256: hash(opts.input),
            selectedSha256: hash(JSON.stringify(input.selected)),
            note: { blindedCommitment: owned.blindedCommitment, type: 'Shield' },
            proof: { leaf: owned.blindedCommitment.slice(2), root: '04'.repeat(32) },
            event: { signedPOIEvent: { index: 0 } },
            quote: {
              data: Buffer.from(
                JSON.stringify({
                  feeExpiration: input.createdAt + 240000,
                  requiredPOIListKeys: [list],
                })
              ).toString('hex'),
              signature: '11'.repeat(64),
            },
            gas: {},
            createdAt: input.createdAt,
            controls: {
              badEventRefused: true,
              productionKeyRefused: true,
              badPathRefused: true,
              otherEventAndPathVerified: true,
              otherNoteUnequal: true,
              otherEventSelectedJoinRefused: true,
            },
            syntheticList: list,
            productionServiceAuthority: false,
            engineSha256: inventory.engineSha256,
            guards,
          };
          if (mutation === 'helper') value.selectedSha256 = '00'.repeat(32);
          helper = value;
        } else {
          const auditCase = input.auditCase,
            rows = [{ domain: 'signature', verified: auditCase !== 'signature' }];
          if (auditCase !== 'signature')
            rows.push({ domain: '01x02', verified: auditCase !== 'transaction-proof' });
          if (!['signature', 'transaction-proof'].includes(auditCase))
            rows.push({ domain: 'POI_3x3', verified: auditCase !== 'pre-poi-proof' });
          value = {
            auditCase,
            recordDigest: pair.recordDigest,
            originalRecordSha256: hash(JSON.stringify(ready)),
            checkedRecordSha256:
              auditCase === 'unmodified' ? hash(JSON.stringify(ready)) : 'ab'.repeat(32),
            codecAccepted: true,
            transactionMatcherAccepted: true,
            pairMatcherAccepted: true,
            primitiveResults: rows,
            productionOutcome: auditCase === 'unmodified' ? 'verified' : 'refused',
            productionCode:
              auditCase === 'unmodified' ? null : 'RAILGUN_RELAY_PROOF_VERIFICATION_REFUSED',
            guards,
            inventory,
          };
          if (mutation === 'audit') value.primitiveResults = [];
          await opts.broker.dispatch(
            JSON.stringify({ id: 1, method: 'relay-verify-record', index: 0 })
          );
        }
        await opts.broker.dispatch(
          JSON.stringify({ id: input.auditCase ? 2 : 1, method: 'result', value })
        );
      });
      return {
        ready: work,
        closed,
        close: () =>
          done({
            code: 'RAILGUN_PROCESS_CLOSED',
            exitCode: 15,
            escalated: false,
            peerDisconnected: false,
          }),
      };
    },
  };
  const operation = jest.fn(async (v) => {
    const fields = JSON.parse(Buffer.from(helper.quote.data, 'hex'));
    const summary = {
      selection: { noteId: note.id },
      amounts: { input: '2000', fee: '100', self: '1900', cap: '100' },
      quote: {
        requiredPOIListKeys: mutation === 'list' ? ['wrong'] : fields.requiredPOIListKeys,
        quoteSha256: 'q',
        signedBytesSha256: 'b',
        expiresAt: fields.feeExpiration,
      },
    };
    v.review(summary);
    v.reviewDisclosure({ listKey: list, input: owned });
    requests.push(...rpcRows());
    ready = {
      state: 'ready-local',
      history: { note: helper.note, proof: helper.proof, event: helper.event },
    };
    state = {
      records: 1,
      sequence: 4,
      capacity: 10,
      states: [{ id: entry.id, state: 'ready-local' }],
    };
    if (mutation === 'history') ready.history.note = { ...helper.note, blindedCommitment: 'wrong' };
    if (mutation === 'sequence') state.sequence = 3;
    return {
      status: mutation === 'refusal' ? 'recovery-required' : 'ready-local',
      operationId: entry.id,
    };
  });
  const f = load({
    [w + 'railgun-process']: runtime,
    [n + 'privacy-context']: {
      createPrivacyScope: () => ({ getContext: () => ({}), close: () => {} }),
    },
    [w + 'railgun-account-wallet']: {
      readRailgunAccountOwnedNotes: () => ({ read: { received: [note] }, ownedPoi: [owned] }),
    },
    [w + 'railgun-relay-operation']: { proveRailgunAccountRelayOperation: operation },
    [w + 'railgun-poi-records']: { verifyPoiEvent: () => {} },
    [w + 'railgun-relay-quote-data']: {
      ...require(w + 'railgun-relay-quote-data'),
      normalizeRailgunRelayQuote: (quote) => ({
        fields: JSON.parse(Buffer.from(quote.data, 'hex')),
        quoteSha256: 'q',
        signedBytesSha256: 'b',
      }),
    },
    [w + 'railgun-relay-record-stream']: {
      createRailgunRelayVerifyRecordSender: () => ({
        manifest: { chunks: 1 },
        read: () => ({ index: 0, data: '00' }),
        close: () => {},
      }),
    },
  });
  return {
    run: () =>
      f.qualify({
        account,
        owners,
        archive: '/engine.asar',
        proverArchive: '/prover.asar',
        artifactDirectory: '/artifacts',
        scenario: 'synthetic-list',
        services,
        custody,
        jobs: { rows: Array.from({ length: 79 }, (_, i) => ({ keyReplies: i < 9 ? 1 : 0 })) },
      }),
    launched,
    operation,
    account,
  };
}
test('controlled whole composition has one helper then four distinct audits and unchanged custody', async () => {
  const x = composed();
  const result = await x.run();
  expect(result.auditCustodyUnchanged).toBe(true);
  expect(result.publicFixtureEntrySha256).toBe(
    require('crypto')
      .createHash('sha256')
      .update(JSON.stringify({ id: 'ab'.repeat(32), state: 'signing-local' }))
      .digest('hex')
  );
  expect(result.audits.map((v) => v.auditCase)).toEqual([
    'unmodified',
    'signature',
    'transaction-proof',
    'pre-poi-proof',
  ]);
  expect(x.launched).toHaveLength(5);
  expect(x.account.close).toHaveBeenCalledTimes(1);
});
test.each(['helper', 'list', 'history', 'sequence', 'refusal', 'audit'])(
  'controlled %s fault prevents downstream qualification',
  async (mutation) => {
    const x = composed(mutation);
    await expect(x.run()).rejects.toThrow();
    expect(x.account.close).not.toHaveBeenCalled();
    if (mutation === 'helper') expect(x.operation).not.toHaveBeenCalled();
    expect(x.launched.length).toBeLessThan(5);
  }
);
test('protocol fixture uses pinned 01x02 key, exact draft root/nullifier and no extra getter', () => {
  const { Interface } = require('ethers');
  const vkey = {
    vk_alpha_1: ['1', '2'],
    vk_beta_2: [
      ['3', '4'],
      ['5', '6'],
    ],
    vk_gamma_2: [
      ['7', '8'],
      ['9', '10'],
    ],
    vk_delta_2: [
      ['11', '12'],
      ['13', '14'],
    ],
    IC: [['15', '16']],
  };
  const bytes = Buffer.from(JSON.stringify(vkey)),
    digest = require('crypto').createHash('sha256').update(bytes).digest('hex');
  const deployment = {
    request: jest.fn((call) => {
      assert.equal(call.method, 'eth_getBlockByNumber');
      return { number: '0xb49491', hash: '0x' + '12'.repeat(32), timestamp: '0x01' };
    }),
  };
  const f = load({
    fs: {
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: bytes.length }),
      readFileSync: () => bytes,
    },
    './railgun-shield-offline-deployment': { createOfflineShieldDeployment: () => deployment },
    [w + 'railgun-artifacts']: {
      manifest: {
        '01x02': [{ kind: 'vkey', name: 'key.json', size: bytes.length, sha256: digest }],
      },
    },
    [w + 'railgun-relay-capsule']: {
      normalizeRailgunRelayDraftCapsule: () => ({
        data: {
          selection: { tree: 2 },
          intent: {
            expected: { merkleRoot: '0x' + '01'.repeat(32), nullifier: '0x' + '02'.repeat(32) },
          },
        },
      }),
    },
  });
  const p = f.createProtocol('/artifacts');
  expect(() => p.request('eth_getBlockByNumber', ['latest', false])).toThrow();
  p.draft({ relayDraft: {} });
  expect(() => p.draft({ relayDraft: {} })).toThrow();
  p.request('eth_getBlockByNumber', ['latest', false]);
  const abi = new Interface([
    'function rootHistory(uint256,bytes32) view returns (bool)',
    'function nullifiers(uint256,bytes32) view returns (bool)',
    'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
  ]);
  const call = (name, args) =>
    p.request('eth_call', [
      {
        to: require(w + 'railgun-shield-pins.json').proxy,
        data: abi.encodeFunctionData(name, args),
      },
      { blockHash: '0x' + '12'.repeat(32), requireCanonical: true },
    ]);
  expect(
    abi.decodeFunctionResult('rootHistory', call('rootHistory', [2, '0x' + '01'.repeat(32)]))[0]
  ).toBe(true);
  expect(
    abi.decodeFunctionResult('nullifiers', call('nullifiers', [2, '0x' + '02'.repeat(32)]))[0]
  ).toBe(false);
  expect(() => call('rootHistory', [3, '0x' + '01'.repeat(32)])).toThrow();
  expect(() => call('nullifiers', [2, '0x' + '03'.repeat(32)])).toThrow();
  expect(() => call('getVerificationKey', [1, 1])).toThrow();
  const decoded = abi.decodeFunctionResult(
    'getVerificationKey',
    call('getVerificationKey', [1, 2])
  )[0];
  expect(decoded.beta2.x.map(String)).toEqual(['4', '3']);
  expect(decoded.delta2.y.map(String)).toEqual(['14', '13']);
  expect(() => p.request('eth_sendRawTransaction', [])).toThrow();
});
function cacheFixture() {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(require('os').tmpdir(), 'railgun-cache-control-'))
  );
  const root = path.join(base, 'copy'),
    dep = path.join(root, 'node_modules');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dep, { recursive: true });
  const electron = {},
    cache = {};
  const add = (base, relative, bytes = 'module.exports = {};') => {
    const filename = path.join(base, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    cache[filename] = { id: filename, filename, loaded: true, exports: {} };
    return filename;
  };
  add(root, 'scripts/fixture.js');
  add(root, 'src/main/fixture.js');
  add(dep, 'one/index.js');
  const contents = path.join(base, 'runtime/Electron.app/Contents');
  const executable = path.join(contents, 'MacOS/Electron');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'synthetic executable, never executed');
  const containerPath = path.join(contents, 'Resources/default_app.asar');
  fs.mkdirSync(path.dirname(containerPath), { recursive: true });
  const container = Buffer.alloc(110862, 0x63),
    member = Buffer.alloc(95, 0x6d),
    memberPath = containerPath + '/package.json';
  fs.writeFileSync(containerPath, container);
  cache[memberPath] = { id: memberPath, filename: memberPath, loaded: true, exports: {} };
  for (const name of ['electron', 'electron/common', 'electron/main'])
    cache[name] = { id: 'electron', filename: name, loaded: true, exports: electron };
  const flags = {};
  // Explicit synthetic hash authority. No actual Electron archive is opened.
  const crypto = require('crypto'),
    overrides = {
      fs: {
        ...fs,
        readFileSync: (filename, ...args) =>
          filename === memberPath
            ? flags.memberSize
              ? Buffer.alloc(94)
              : member
            : fs.readFileSync(filename, ...args),
      },
      'original-fs': {
        ...fs,
        readFileSync: (filename, ...args) =>
          filename === containerPath ? container : fs.readFileSync(filename, ...args),
      },
      crypto: {
        ...crypto,
        createHash: (algorithm) => {
          const hash = crypto.createHash(algorithm);
          return {
            update(value) {
              if (value === container || value === member)
                return {
                  digest: () =>
                    value === container
                      ? flags.containerHash
                        ? '00'.repeat(32)
                        : '0eb2491b0a9ac94790389d39c09dd5005c6c1f0665842943829bbd0193f6cc4f'
                      : flags.memberHash
                        ? '00'.repeat(32)
                        : '3688987acbbeeea464615eee547ab4feca1c33e71ff85607e84e5167ebc595fc',
                };
              return hash.update(value);
            },
          };
        },
      },
    };
  const inspect = load(overrides).collectMainModuleCache;
  return {
    base,
    root,
    dep,
    cache,
    electron,
    add,
    inspect,
    flags,
    containerPath,
    memberPath,
    executable,
    overrides,
  };
}
test('publication cache classifies exact copied application, canonical dependencies and virtual aliases', () => {
  const f = cacheFixture(),
    inspect = f.inspect;
  f.add(f.root, 'package.json', '{}');
  f.add(f.root, 'docs/qualification/railgun-poi-read-2026-10-03.json', '{}');
  f.add(f.dep, 'sqlite/prebuilds/test.node', 'synthetic binary bytes only');
  for (const name of ['electron', 'electron/common', 'electron/main'])
    f.cache[name] = { id: 'electron', filename: name, loaded: true, exports: f.electron };
  const result = inspect({
    root: f.root,
    cache: f.cache,
    electron: f.electron,
    executable: f.executable,
  });
  expect(result.scope).toBe('main-require-cache-at-publication');
  expect(result.historicalExecutionCoverage).toBe(false);
  expect(result.utilityImportCoverage).toBe(false);
  expect(result.virtualModules).toEqual(['electron', 'electron/common', 'electron/main']);
  expect(result.modules.map((v) => v.class + ':' + v.relativePath)).toEqual([
    'application:docs/qualification/railgun-poi-read-2026-10-03.json',
    'application:package.json',
    'application:scripts/fixture.js',
    'application:src/main/fixture.js',
    'dependency:one/index.js',
    'dependency:sqlite/prebuilds/test.node',
    'runtime-bootstrap:default_app.asar/package.json',
  ]);
  for (const row of result.modules) {
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toContain(f.base);
  }
});
test.each([
  'original-root',
  'external',
  'application-symlink',
  'dependency-alias',
  'wrong-app-extra',
  'asar',
  'unloaded',
  'filename-mismatch',
  'unlisted-virtual',
  'virtual-id',
  'virtual-exports',
  'virtual-shadow',
  'mount-symlink',
  'hardlink',
  'copied-engine',
  'nested-dependency',
  'copied-runtime',
  'mount-relative',
])('publication cache refuses %s', (name) => {
  const f = cacheFixture(),
    inspect = f.inspect;
  if (name === 'original-root') f.add(path.join(f.base, 'original'), 'src/main/fallback.js');
  if (name === 'external') f.add(path.join(f.base, 'outside'), 'injected.js');
  if (name === 'application-symlink') {
    const target = f.add(path.join(f.base, 'original'), 'src/main/fallback.js');
    delete f.cache[target];
    const alias = path.join(f.root, 'src/main/escaped.js');
    fs.symlinkSync(target, alias);
    f.cache[alias] = { id: alias, filename: alias, loaded: true };
  }
  if (name === 'dependency-alias') {
    const filename = path.join(f.dep, 'alias.js');
    fs.symlinkSync(path.join(f.dep, 'one/index.js'), filename);
    f.cache[filename] = { id: filename, filename, loaded: true };
  }
  if (name === 'wrong-app-extra') f.add(f.root, 'docs/unreviewed.json', '{}');
  if (name === 'asar') f.add(f.dep, 'engine.asar/index.js');
  if (name === 'unloaded') Object.values(f.cache)[0].loaded = false;
  if (name === 'filename-mismatch') Object.values(f.cache)[0].filename = '/different';
  if (name.startsWith('virtual') || name === 'unlisted-virtual') {
    const key = name === 'unlisted-virtual' ? 'original-fs' : 'electron';
    f.cache[key] = { id: 'electron', filename: key, loaded: true, exports: f.electron };
    if (name === 'virtual-id') f.cache[key].id = 'other';
    if (name === 'virtual-exports') f.cache[key].exports = {};
    if (name === 'virtual-shadow') fs.writeFileSync(path.join(f.root, 'electron'), 'shadow');
  }
  if (name === 'mount-symlink') {
    f.root = path.join(f.base, 'other-copy');
    fs.mkdirSync(f.root);
    fs.symlinkSync(f.dep, path.join(f.root, 'node_modules'));
  }
  if (name === 'hardlink')
    fs.linkSync(path.join(f.dep, 'one/index.js'), path.join(f.dep, 'alias.js'));
  if (name === 'copied-engine') f.add(f.root, 'scripts/fixtures/railgun-engine/index.js');
  if (name === 'nested-dependency') f.add(f.root, 'src/node_modules/one/index.js');
  if (name === 'copied-runtime')
    f.executable = f.add(f.dep, 'electron/dist/Electron.app/Contents/MacOS/Electron');
  if (name === 'mount-relative') {
    f.root = path.join(f.base, 'relative-copy');
    fs.mkdirSync(f.root);
    fs.symlinkSync(path.relative(f.root, f.dep), path.join(f.root, 'node_modules'));
  }
  expect(() =>
    inspect({ root: f.root, cache: f.cache, electron: f.electron, executable: f.executable })
  ).toThrow();
});
test('cache publication refuses original application fallback before opening its bytes', () => {
  const f = cacheFixture(),
    inspect = f.inspect;
  const outside = f.add(path.join(f.base, 'original'), 'src/main/fallback.js');
  const original = fs.readFileSync,
    read = jest.spyOn(fs, 'readFileSync').mockImplementation(function (filename, ...args) {
      if (filename === outside) throw Error('Forbidden original source read');
      return Reflect.apply(original, this, [filename, ...args]);
    });
  try {
    expect(() =>
      inspect({ root: f.root, cache: f.cache, electron: f.electron, executable: f.executable })
    ).toThrow('outside declared roots');
    expect(read.mock.calls.some((args) => args[0] === outside)).toBe(false);
  } finally {
    read.mockRestore();
  }
});
test.each([
  ['scripts/fixtures/railgun-engine/index.js', 'Copied engine or nested dependency'],
  ['src/node_modules/unapproved/index.js', 'Copied engine or nested dependency'],
])('cache refuses %s before reading its source', (relative, reason) => {
  const f = cacheFixture();
  const forbidden = f.add(f.root, relative);
  const original = fs.readFileSync;
  const read = jest.spyOn(fs, 'readFileSync').mockImplementation(function (filename, ...args) {
    if (filename === forbidden) throw Error('Unexpected forbidden source read');
    return Reflect.apply(original, this, [filename, ...args]);
  });
  try {
    expect(() =>
      f.inspect({ root: f.root, cache: f.cache, electron: f.electron, executable: f.executable })
    ).toThrow(reason);
    expect(read.mock.calls.some((args) => args[0] === forbidden)).toBe(false);
  } finally {
    read.mockRestore();
  }
});

test('cache rows bind content hashes and detect membership drift during observation', () => {
  const f = cacheFixture(),
    inspect = f.inspect,
    original = fs.readFileSync;
  const target = path.join(f.dep, 'one/index.js'),
    read = jest.spyOn(fs, 'readFileSync').mockImplementation(function (filename, ...args) {
      const result = Reflect.apply(original, this, [filename, ...args]);
      if (filename === target) f.cache.unexpected = {};
      return result;
    });
  try {
    expect(() =>
      inspect({ root: f.root, cache: f.cache, electron: f.electron, executable: f.executable })
    ).toThrow();
  } finally {
    read.mockRestore();
  }
});

test.each([
  'missing-bootstrap',
  'missing-virtual',
  'container-hash',
  'member-hash',
  'member-size',
  'container-size',
  'container-alias',
  'other-member',
])('pinned CLI cache refuses %s', (name) => {
  const f = cacheFixture();
  if (name === 'missing-bootstrap') delete f.cache[f.memberPath];
  if (name === 'missing-virtual') delete f.cache['electron/main'];
  if (name === 'container-hash') f.flags.containerHash = true;
  if (name === 'member-hash') f.flags.memberHash = true;
  if (name === 'member-size') f.flags.memberSize = true;
  if (name === 'container-size') fs.writeFileSync(f.containerPath, 'wrong');
  if (name === 'container-alias') {
    const original = f.overrides['original-fs'].realpathSync;
    f.overrides['original-fs'].realpathSync = (filename) =>
      filename === f.containerPath ? '/other/container' : original(filename);
  }
  if (name === 'other-member') {
    const filename = f.containerPath + '/main.js';
    f.cache[filename] = { id: filename, filename, loaded: true };
  }
  expect(() =>
    f.inspect({ root: f.root, cache: f.cache, electron: f.electron, executable: f.executable })
  ).toThrow();
});

function refusalDiagnostic(result, jobs = { rows: [] }, custody = { rows: [] }) {
  try {
    load().assertReadyLocal(result, jobs, custody);
    throw Error('Expected original ready-local refusal');
  } catch (error) {
    expect(error.name).toBe('AssertionError');
    expect(error.expected).toBe('ready-local');
    expect(error.actual).toBe(
      ['refused', 'recovery-required'].includes(result.status) ? result.status : 'unrecognized'
    );
    return { value: JSON.parse(error.message.split('\n')[0]), message: error.message };
  }
}
test.each([
  'preflight',
  'reserve',
  'signing-marker',
  'signer',
  'signature-verification',
  'signature-storage',
  'proof',
])('failure-only diagnostics preserve ready-local refusal at %s', (stage) => {
  const result = {
    status: 'recovery-required',
    stage,
    signingAttempted: true,
    signatureSaved: stage === 'proof',
    operationId: 'not-exported',
  };
  const { value } = refusalDiagnostic(result);
  expect(value.result).toEqual({
    status: 'recovery-required',
    stage,
    signingAttempted: true,
    signatureSaved: stage === 'proof',
  });
  expect(value.jobs).toEqual([]);
  expect(value.custodyStates).toEqual([]);
});
test('ready-local success does not inspect diagnostic observations or change the result', () => {
  const unreadable = {
    get rows() {
      throw Error('No success-side observation read');
    },
  };
  expect(
    load().assertReadyLocal({ status: 'ready-local' }, unreadable, unreadable)
  ).toBeUndefined();
});
test('public diagnostics project existing key/closure counts and collapse adjacent custody states', () => {
  const row = {
    role: 'relay-sign',
    results: 1,
    keyRequests: 1,
    keyReplies: 1,
    closedObserved: true,
    closed: { exitCode: 15, escalated: false, peerDisconnected: false },
  };
  const states = ['held', 'held', 'signing-local', 'signing-local', 'signed'];
  const { value } = refusalDiagnostic(
    { status: 'recovery-required', stage: 'proof', signingAttempted: true, signatureSaved: true },
    { rows: [row] },
    {
      rows: states.map((state) => ({
        state,
        reservationState: state === 'held' ? 'held' : 'signing-local',
      })),
    }
  );
  expect(value.jobs).toEqual([
    {
      role: row.role,
      results: 1,
      keyRequests: 1,
      keyReplies: 1,
      closedObserved: true,
      ...row.closed,
    },
  ]);
  expect(value.custodyStates).toEqual([
    { state: 'held', reservationState: 'held' },
    { state: 'signing-local', reservationState: 'signing-local' },
    { state: 'signed', reservationState: 'signing-local' },
  ]);
});
test('diagnostics never project IDs, record/key/error content or unknown free text and remain bounded', () => {
  const secret = 'DO_NOT_EXPORT_PRIVATE_SENTINEL';
  const row = {
    role: secret,
    results: Infinity,
    keyRequests: -1,
    keyReplies: secret,
    closedObserved: false,
    closed: { exitCode: Infinity, escalated: secret, peerDisconnected: secret },
    operationId: secret,
    record: secret,
    signature: secret,
    key: secret,
    error: new Error(secret),
  };
  const result = {
    status: secret,
    stage: secret,
    signingAttempted: secret,
    signatureSaved: secret,
    operationId: secret,
  };
  const custody = {
    rows: Array.from({ length: 1000 }, (_, i) => ({
      state: i % 2 ? 'signed' : 'held',
      reservationState: secret,
      record: secret,
    })),
  };
  const { value, message } = refusalDiagnostic(result, { rows: Array(1000).fill(row) }, custody);
  expect(message).not.toContain(secret);
  expect(Buffer.byteLength(message)).toBeLessThan(32768);
  expect(value.jobs).toHaveLength(load().expectedRoles().length);
  expect(value.jobRowsTruncated).toBe(true);
  expect(value.custodyRowsTruncated).toBe(true);
  expect(value.custodyStates).toHaveLength(16);
  expect(value.result).toEqual({
    status: 'unrecognized',
    stage: 'unrecognized',
    signingAttempted: null,
    signatureSaved: null,
  });
  expect(value.jobs[0]).toEqual({
    role: 'unrecognized',
    results: null,
    keyRequests: null,
    keyReplies: null,
    closedObserved: false,
    exitCode: null,
    escalated: null,
    peerDisconnected: null,
  });
});
test('qualifier invokes failure diagnostics before any ready custody read or audit launch', () => {
  const at = source.indexOf('  assertReadyLocal(result, jobs, custody);');
  const call = source.indexOf('result = await operation.proveRailgunAccountRelayOperation({');
  expect(call).toBeGreaterThan(0);
  expect(at).toBeGreaterThan(call);
  expect(at).toBeLessThan(source.indexOf('  const ready = await reservations.readRelay'));
  const body = source.slice(
    source.indexOf('function assertReadyLocal'),
    source.indexOf('function installSignedStop')
  );
  expect(body.length).toBeGreaterThan(0);
  expect(body).not.toMatch(/require\(|await |readRelay|inspect\(|console\.|writeFile/);
});
test('signed stop admits its own opt-in and ends roles at the held dual verifier', () => {
  const f = load();
  expect(f.select(f.SIGNED_STOP, args, {}).scenario).toBe('synthetic-list-signed-stop');
  expect(() => f.select('synthetic-list-signed', args, {})).toThrow();
  const roles = f.expectedRoles(f.SIGNED_STOP);
  expect(roles).toEqual(f.expectedRoles().slice(0, -4));
  expect(roles).toHaveLength(75);
  expect(roles.at(-1)).toBe('dual-proof-C');
  expect(() => f.expectedRoles('other')).toThrow();
});
test('signed stop RPC keeps exact preflight and exactly three uniform header reads', () => {
  const f = load(),
    all = rpcRows(),
    headers = all.slice(0, 20),
    protocol = all.slice(20);
  const rows = [...headers.slice(0, 15), ...protocol];
  expect(f.assertOperationRpc(rows, f.SIGNED_STOP).headers.finalized).toBe(3);
  expect(() => f.assertOperationRpc(rows)).toThrow();
  for (const reads of [1, 2, 4])
    expect(() =>
      f.assertOperationRpc([...headers.slice(0, 5 * reads), ...protocol], f.SIGNED_STOP)
    ).toThrow();
  expect(() =>
    f.assertOperationRpc([...headers.slice(0, 16), ...protocol], f.SIGNED_STOP)
  ).toThrow();
  expect(() =>
    f.assertOperationRpc([...headers.slice(0, 15), ...protocol.slice(1)], f.SIGNED_STOP)
  ).toThrow();
});
function signedHold(secondAdmission) {
  const verified = {
    observation: { utilityExitObserved: true },
    process: { exitCode: 15 },
  };
  const original = jest.fn(async () => verified),
    proof = { verifyRailgunRelayProof: original };
  const f = load({ [w + 'railgun-relay-proof']: proof });
  const control = new AbortController(),
    jobs = { rows: [{ role: 'dual-proof-C' }] };
  const hold = f.installSignedStop(control, jobs, secondAdmission);
  return { f, verified, original, proof, control, hold };
}
test('signed stop holds the genuine verifier result, probes admission, then aborts once', async () => {
  let abortedDuringProbe = null;
  const x = signedHold(async () => {
    abortedDuringProbe = x.control.signal.aborted;
    return { status: 'refused', stage: 'admission' };
  });
  expect(x.proof.verifyRailgunRelayProof).not.toBe(x.original);
  await expect(x.proof.verifyRailgunRelayProof({ input: 1 })).resolves.toBe(x.verified);
  expect(x.original).toHaveBeenCalledWith({ input: 1 });
  expect(abortedDuringProbe).toBe(false);
  expect(x.control.signal.aborted).toBe(true);
  expect(x.hold.observation).toEqual({
    held: 1,
    utilityExitObserved: true,
    exitCode: 15,
    secondAdmission: { status: 'refused', stage: 'admission' },
    requestAbortedWhileHeld: true,
  });
  expect(x.f.errors).toEqual([]);
  await x.proof.verifyRailgunRelayProof({});
  expect(x.f.errors).toHaveLength(1);
  x.hold.restore();
  expect(x.proof.verifyRailgunRelayProof).toBe(x.original);
});
test('signed stop probe failure is sticky but still aborts; verifier refusal is unchanged', async () => {
  const x = signedHold(async () => {
    throw new Error('admitted');
  });
  await x.proof.verifyRailgunRelayProof({});
  expect(x.control.signal.aborted).toBe(true);
  expect(x.f.errors).toHaveLength(1);
  const y = signedHold(async () => ({}));
  y.original.mockRejectedValueOnce(new Error('refused'));
  await expect(y.proof.verifyRailgunRelayProof({})).rejects.toThrow('refused');
  expect(y.control.signal.aborted).toBe(false);
  expect(y.hold.observation.held).toBe(0);
});
function stopped(mutation) {
  const id = 'cd'.repeat(32);
  const helper = { note: { n: 1 }, proof: { p: 1 }, event: { e: 1 }, controls: { c: true } };
  let record = {
    state: 'signed',
    proved: null,
    signature: { r: '1' },
    history: { note: helper.note, proof: helper.proof, event: helper.event },
  };
  if (mutation === 'ready') record = { ...record, state: 'ready-local', proved: {} };
  if (mutation === 'proved') record = { ...record, proved: {} };
  const recoveryState = {
    records: 1,
    sequence: mutation === 'sequence' ? 4 : 3,
    states: [{ id, state: mutation === 'ready' ? 'ready-local' : 'signed' }],
  };
  const reservations = {
    inspect: async () => ({ private: mutation === 'released' ? 1 : 0 }),
    listRelay: async () => (mutation === 'released' ? [] : [{ id, state: 'signing-local' }]),
    readRelay: async () => ({
      record,
      entry: { id, state: 'signing-local' },
      interruptedStep: null,
      recordDigest: 'ef'.repeat(32),
    }),
    reserve: jest.fn(async () => {
      if (mutation === 'reservable') return {};
      throw Object.assign(new Error('reserved'), {
        code:
          mutation === 'other-code'
            ? 'RAILGUN_RESERVATIONS_CAPACITY'
            : 'RAILGUN_PRIVATE_INPUT_RESERVED',
      });
    }),
  };
  const custody = {
    rows: [{ state: 'held' }],
    finish: jest.fn(),
    credentialMargin: () => 100000,
  };
  const f = load();
  const headers = rpcRows().slice(0, 15),
    protocol = rpcRows().slice(20);
  const services = {
    requests: [{ method: 'bootstrap' }, ...headers, ...protocol],
    poiMethods: ['m'],
    assertClosed: jest.fn(),
  };
  const roles = f.expectedRoles(f.SIGNED_STOP);
  const jobs = { rows: roles.map((_, i) => ({ keyReplies: i < 9 ? 1 : 0 })) };
  const observation = {
    held: 1,
    utilityExitObserved: true,
    exitCode: 15,
    secondAdmission:
      mutation === 'admitted'
        ? { status: 'ready-local', operationId: id }
        : {
            status: 'refused',
            stage: 'admission',
            ownedNoteReads: mutation === 'read' ? 1 : 0,
            utilitiesStarted: 0,
            keyLoans: 0,
          },
    requestAbortedWhileHeld: true,
  };
  const account = { close: jest.fn(async () => {}) };
  return {
    f,
    custody,
    account,
    run: () =>
      f.finishSignedStop({
        result:
          mutation === 'unsaved'
            ? {
                status: 'recovery-required',
                stage: 'signature-storage',
                operationId: id,
                signingAttempted: true,
                signatureSaved: false,
              }
            : {
                status: 'recovery-required',
                stage: 'proof',
                operationId: id,
                signingAttempted: true,
                signatureSaved: true,
              },
        hold: { observation },
        helper,
        margins: [],
        operationStart: performance.now(),
        services,
        rpcBefore: 1,
        reservations,
        recovery: { inspect: async () => recoveryState },
        before: { private: { private: 0 }, relay: [], recovery: { records: 0, sequence: 0 } },
        jobs,
        custody,
        account,
        owned: { nullifier: '0x' + '0a'.repeat(32), hash: '0x' + '0b'.repeat(32) },
        selected: { id: '0:1' },
      }),
    reservations,
  };
}
test('signed stop report binds the retained signed record and unreleased hold', async () => {
  const x = stopped();
  const report = await x.run();
  expect(report).toMatchObject({
    schema: 'railgun-relay-signed-stop-native-v1',
    scenario: 'synthetic-list-signed-stop',
    recoverySequenceDelta: 3,
    syntheticOperationRequests: 34,
    proofPersisted: false,
    coldRestartQualified: false,
    stopKind: 'controlled-request-abort-after-independent-verification',
    crashOrNetworkInterruption: false,
    sameInputPrivateReservation: {
      refusedCode: 'RAILGUN_PRIVATE_INPUT_RESERVED',
      durableChange: false,
    },
  });
  expect(report.syntheticOperationRpc.headers.finalized).toBe(3);
  expect(x.reservations.reserve).toHaveBeenCalledWith({
    tree: 0,
    position: 1,
    nullifier: '0x' + '0a'.repeat(32),
    noteHash: '0x' + '0b'.repeat(32),
    kind: 'railgun-private-transfer',
    intentDigest: '0x' + '11'.repeat(32),
    checkpointHash: '22'.repeat(32),
    poiDigest: '33'.repeat(32),
  });
  expect(report.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(x.custody.finish).toHaveBeenCalledWith(['held', 'signing-local', 'signed']);
  expect(x.account.close).toHaveBeenCalledTimes(1);
});
test.each([
  'ready',
  'proved',
  'sequence',
  'released',
  'admitted',
  'unsaved',
  'read',
  'reservable',
  'other-code',
])('signed stop refuses %s outcome', async (mutation) => {
  await expect(stopped(mutation).run()).rejects.toThrow();
});

const publicSource = fs.readFileSync(
  path.join(
    __dirname,
    '../../docs/qualification/railgun-unsigned-relay-preparation-2026-10-06/public-source.json'
  )
);
test('Transact translation keeps original log indexes and offsets logs and TXID row together', () => {
  const f = load(),
    t = f.translateTransact(publicSource);
  expect(t.logs.map((v) => [v.blockNumber - 5944700, v.transactionIndex, v.logIndex])).toEqual([
    [10, 0, 0],
    [20, 0, 0],
    [30, 0, 0],
    [30, 0, 1],
  ]);
  expect(t.logs[2].transactionHash).toBe(t.logs[3].transactionHash);
  expect(t.row.blockNumber).toBe(5944730);
  expect(BigInt('0x' + t.row.graphID.slice(2, 66))).toBe(5944730n);
  expect('0x' + t.row.txid).toBe(t.logs[3].transactionHash);
  expect(t.row.nullifiers).toEqual(['0x' + (888).toString(16).padStart(64, '0')]);
  expect(f.translate(publicSource).logs.map((v) => v.logIndex)).toEqual([0, 0, 0]);
  expect(() => f.translateTransact(Buffer.concat([publicSource, Buffer.from(' ')]))).toThrow();
});
test('indexer row round-trips through the genuine public TXID page normalizer', () => {
  const f = load(),
    t = f.translateTransact(publicSource);
  const row = { ...t.row, verificationHash: '0x' + '0c'.repeat(32) };
  const page = require(w + 'railgun-public-services').normalizeTxidPage(
    [f.indexerRow(row)],
    '0x00'
  );
  expect(page.transactions).toEqual([row]);
  expect(page.exhausted).toBe(true);
});
test('Transact services answer only exact TXID wire requests from service contexts', async () => {
  const x = serviceFixture(false, 'synthetic-list-transact');
  const f = x.f,
    t = f.translateTransact(publicSource);
  const row = { ...t.row, verificationHash: '0x' + '0c'.repeat(32) };
  const state = { count: 1, root: '0d'.repeat(32) };
  const handle = (role) => ({
    signal: new AbortController().signal,
    subject: { kind: 'service', principal: 'railgun-public-sync', role, chainId: 11155111 },
  });
  const client = x.transport.createWalletTorTransport();
  const send = (role, url, body) =>
    client.request(handle(role), url, {
      method: 'POST',
      signal: new AbortController().signal,
      body: JSON.stringify(body),
    });
  const indexer = require(w + 'railgun-public-services').INDEXER_URL;
  await expect(
    send('indexer', indexer, { query: 'q transactions(', variables: { after: '0x00' } })
  ).rejects.toThrow();
  x.adapter.txid({ row, state });
  const page = JSON.parse(
    (await send('indexer', indexer, { query: 'q transactions(', variables: { after: '0x00' } }))
      .body
  );
  expect(page.data.transactions).toEqual([f.indexerRow(row)]);
  const empty = JSON.parse(
    (
      await send('indexer', indexer, {
        query: 'q transactions(',
        variables: { after: row.graphID },
      })
    ).body
  );
  expect(empty).toEqual({ data: { transactions: [] } });
  const context = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
  const rpc = (method, params) => ({ jsonrpc: '2.0', id: 'i', method, params });
  expect(
    JSON.parse(
      (await send('poi', 'https://ppoi.fdi.network', rpc('ppoi_validated_txid', context))).body
    ).result
  ).toEqual({ validatedTxidIndex: 0, validatedMerkleroot: state.root });
  const valid = rpc('ppoi_validate_txid_merkleroot', {
    ...context,
    tree: 0,
    index: 0,
    merkleroot: state.root,
  });
  expect(JSON.parse((await send('poi', 'https://ppoi.fdi.network', valid)).body).result).toBe(true);
  await expect(
    send('poi', 'https://ppoi.fdi.network', { ...valid, params: { ...valid.params, index: 1 } })
  ).rejects.toThrow();
  await expect(send('poi', indexer, valid)).rejects.toThrow();
  await expect(
    send('indexer', indexer, { query: 'q transactions(', variables: { after: '0x01' } })
  ).rejects.toThrow();
  // Attempts are logged before validation: a refused early query still counts.
  expect(x.adapter.timeline.map((v) => v.method)).toEqual([
    'txidPage',
    'txidPage',
    'ppoi_validated_txid',
    'ppoi_validate_txid_merkleroot',
    'ppoi_validate_txid_merkleroot',
  ]);
});
test('Shield scenarios refuse TXID service traffic', async () => {
  const x = serviceFixture();
  expect(() => x.adapter.txid({ row: {}, state: { count: 1, root: '0d'.repeat(32) } })).toThrow();
  const client = x.transport.createWalletTorTransport();
  await expect(
    client.request(
      {
        signal: new AbortController().signal,
        subject: {
          kind: 'service',
          principal: 'railgun-public-sync',
          role: 'poi',
          chainId: 11155111,
        },
      },
      'https://ppoi.fdi.network',
      {
        method: 'POST',
        signal: new AbortController().signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'i',
          method: 'ppoi_validated_txid',
          params: {},
        }),
      }
    )
  ).rejects.toThrow();
});
function transactTimeline() {
  const mark = (label) => ({ kind: 'mark', label });
  const service = (method) => ({ kind: 'service', role: 'poi', method });
  const poi = (method) => ({ kind: 'poi', method });
  return [
    mark('txid-setup'),
    service('ppoi_validated_txid'),
    { kind: 'service', role: 'indexer', method: 'txidPage', after: '0x00' },
    service('ppoi_validated_txid'),
    service('ppoi_validate_txid_merkleroot'),
    service('ppoi_validated_txid'),
    service('ppoi_validate_txid_merkleroot'),
    mark('txid-setup-complete'),
    mark('staging-call'),
    mark('staging-consent'),
    service('ppoi_validated_txid'),
    service('ppoi_validate_txid_merkleroot'),
    service('ppoi_validated_txid'),
    service('ppoi_validate_txid_merkleroot'),
    mark('staging-complete'),
    mark('root-consent'),
    mark('input-disclosure'),
    poi('ppoi_pois_per_list'),
    poi('ppoi_merkle_proofs'),
    poi('ppoi_poi_events'),
    poi('ppoi_validate_poi_merkleroots'),
    service('ppoi_validated_txid'),
    service('ppoi_validate_txid_merkleroot'),
    mark('operation-complete'),
  ];
}
test('Transact ordering admits TXID queries only after their own consent', () => {
  const f = load();
  const value = f.assertTransactTimeline(transactTimeline());
  expect(value.setupServiceCalls).toHaveLength(6);
  expect(value.stagingServiceCalls).toHaveLength(4);
  expect(value.operationCalls).toHaveLength(6);
  const move = (from, to) => {
    const rows = transactTimeline();
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    return rows;
  };
  // staging query before staging consent; root query before membership;
  // root query between root consent and input disclosure; missing mark.
  // Indexes: staging consent 9, first staging query 10, input disclosure 16,
  // membership POI 17-20, first root query 21.
  for (const rows of [move(10, 9), move(21, 17), move(21, 16), transactTimeline().slice(1)])
    expect(() => f.assertTransactTimeline(rows)).toThrow();
  const late = transactTimeline();
  late.push({ kind: 'service', role: 'poi', method: 'ppoi_validated_txid' });
  expect(() => f.assertTransactTimeline(late)).toThrow();
});
test('Transact roles add keyless TXID setup and staging around the unchanged relay order', () => {
  const f = load(),
    roles = f.expectedRoles(f.TRANSACT),
    positive = f.expectedRoles();
  expect(roles).toHaveLength(92);
  expect(roles.slice(0, 65)).toEqual(positive.slice(0, 65));
  expect(roles.filter((v) => positive.slice(-14).includes(v))).toEqual(positive.slice(-14));
  expect(roles.slice(65, 73)).toEqual([
    'txid-row-fixture',
    'txid-inspect',
    'txid-inspect',
    'txid-project',
    'txid-project',
    'txid-apply',
    'txid-apply',
    'wallet-restore',
  ]);
  expect(f.select(f.TRANSACT, args, {}).scenario).toBe('synthetic-list-transact');
});
