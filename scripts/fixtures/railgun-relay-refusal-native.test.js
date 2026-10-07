/** Source/mock controls only. Never loads SQLite, engine or native processes. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, 'railgun-relay-refusal-native.js'), 'utf8');
const w = '../../src/main/wallet/',
  n = '../../src/main/networks/';
function load(overrides = {}, cached = []) {
  const errors = [];
  const native = {
    assert,
    record: (e) => errors.push(e),
    assertEmpty: () => assert.deepEqual(errors, []),
    observeClosed: (work, use) => work.then(use).catch((e) => errors.push(e)),
  };
  const req = (name) =>
    name === './railgun-native-assertions'
      ? native
      : Object.hasOwn(overrides, name)
        ? overrides[name]
        : require(name);
  req.resolve = (name) => require.resolve(name);
  req.cache = Object.fromEntries(cached.map((v) => [require.resolve(w + v), {}]));
  const module = { exports: {} };
  Function(
    'require',
    'module',
    'structuredClone',
    source
  )(req, module, (v) => JSON.parse(JSON.stringify(v)));
  return { ...module.exports, errors };
}
const args = ['/public.json', '/fresh', '/engine.asar', 'enrolled', '/prover.asar', '/artifacts'];
test('default selection does nothing and both exact flags admit absolute fixture paths', () => {
  const f = load();
  expect(f.select(undefined, [], {})).toBeNull();
  for (const scenario of ['declined-disclosure', 'unrelated-history'])
    expect(f.select(scenario, args, {}).scenario).toBe(scenario);
});
test.each(['', '1', 'accepted', 'held-close'])('invalid flag %s refuses', (v) => {
  expect(() => load().select(v, args, {})).toThrow();
});
test.each([
  args.slice(0, 5),
  [...args, 'extra'],
  args.map((v, i) => (i === 3 ? 'legacy' : v)),
  args.map((v, i) => (i === 0 ? 'relative' : v)),
])('invalid composition/path/arity refuses %#', (v) => {
  expect(() => load().select('unrelated-history', v, {})).toThrow();
});
test('competing fixture mode refuses', () => {
  expect(() =>
    load().select('unrelated-history', args, { FREEDOM_RAILGUN_KOHAKU: 'shield-transfer' })
  ).toThrow();
});
test('public data translation preserves ciphertext and type while moving only explicit block identity', () => {
  const bytes = fs.readFileSync(
    path.join(
      __dirname,
      '../../docs/qualification/railgun-unsigned-relay-preparation-2026-10-06/public-source.json'
    )
  );
  const f = load(),
    result = f.translate(bytes),
    original = JSON.parse(bytes);
  expect(result.logs.map((v) => v.blockNumber)).toEqual([5944710, 5944720, 5944730]);
  for (let i = 0; i < 3; i++) {
    for (const key of Object.keys(original.logs[i]))
      if (!['blockNumber', 'blockHash', 'transactionHash'].includes(key))
        expect(result.logs[i][key]).toEqual(original.logs[i][key]);
  }
  expect(() => f.translate(Buffer.from(bytes.toString().replace('5944', '5945') + ' '))).toThrow();
  const ranges = f.ranges();
  expect(ranges).toHaveLength(60);
  expect(ranges[0]).toEqual({ from: 0, to: 99999 });
  expect(ranges.at(-1)).toEqual({ from: 5900000, to: 5944730 });
  ranges.forEach((v, i) => {
    expect(v.to - v.from).toBeLessThan(100000);
    if (i) expect(v.from).toBe(ranges[i - 1].to + 1);
  });
  expect(f.expectedRoles()).toHaveLength(68);
  expect(f.expectedRoles().slice(-5)).toEqual([
    'wallet-scan',
    'wallet-restore',
    'quote',
    'construct',
    'reconstruct',
  ]);
});
function services(scenario) {
  const rpc = { createPrivateRpc: jest.fn() },
    transport = { createWalletTorTransport: jest.fn() },
    settings = { isWalletTorExperimentAvailable: jest.fn() },
    tor = { getWalletSocksEndpoint: jest.fn() };
  const old = [
    rpc.createPrivateRpc,
    transport.createWalletTorTransport,
    settings.isWalletTorExperimentAvailable,
    tor.getWalletSocksEndpoint,
  ];
  const handle = { signal: new AbortController().signal, subject: { role: 'poi' } };
  const note = { blindedCommitment: '0x' + '12'.repeat(32), type: 'Shield' };
  const f = load({
    [n + 'private-rpc']: rpc,
    [n + 'wallet-tor-transport']: transport,
    '../../src/main/settings-store': settings,
    '../../src/main/tor-manager': tor,
    [n + 'privacy-context']: { getPrivacyContext: (v) => v },
  });
  return {
    adapter: f.installServices([], () => note, scenario),
    rpc,
    transport,
    settings,
    tor,
    old,
    handle,
    note,
  };
}
test('decline forbids constructing any transport and restores exact functions', () => {
  const x = services('declined-disclosure');
  expect(() => x.transport.createWalletTorTransport()).toThrow();
  x.adapter.assertClosed();
  x.adapter.restore();
  expect([
    x.rpc.createPrivateRpc,
    x.transport.createWalletTorTransport,
    x.settings.isWalletTorExperimentAvailable,
    x.tor.getWalletSocksEndpoint,
  ]).toEqual(x.old);
});
test('local service serves exactly status then unrelated leaf; production normalizer refuses it', async () => {
  const x = services('unrelated-history'),
    t = x.transport.createWalletTorTransport();
  const { REQUIRED_LIST, normalizePoiProofs } = require(w + 'railgun-poi-records');
  const request = (method, params) =>
    t.request(x.handle, 'https://ppoi.fdi.network', {
      method: 'POST',
      signal: x.handle.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'public-test',
        method,
        params: {
          chainType: '0',
          chainID: '11155111',
          txidVersion: 'V2_PoseidonMerkle',
          ...params,
        },
      }),
    });
  const first = await request('ppoi_pois_per_list', {
    listKeys: [REQUIRED_LIST],
    blindedCommitmentDatas: [x.note],
  });
  expect(JSON.parse(first.body).result[x.note.blindedCommitment][REQUIRED_LIST]).toBe('Valid');
  const second = await request('ppoi_merkle_proofs', {
    listKey: REQUIRED_LIST,
    blindedCommitments: [x.note.blindedCommitment],
  });
  expect(() => normalizePoiProofs(JSON.parse(second.body).result, [x.note])).toThrow();
  await expect(request('ppoi_poi_events', {})).rejects.toThrow();
  t.close();
  await t.closed;
  x.adapter.assertClosed();
  x.adapter.restore();
});
function qualification(scenario, mutation) {
  const requests = [];
  const state = { records: 0, sequence: 0, capacity: 10, states: [] };
  const reservations = {
    inspect: async () => ({ held: 0, signing: 0, abandoned: 0, legacy: 0 }),
    listRelay: async () => [],
  };
  const recovery = { inspect: async () => structuredClone(state) };
  const owners = {
    enrollment: {
      openReservations: async () => reservations,
      openRelayRecoveryStore: async () => recovery,
    },
  };
  const account = { close: jest.fn(async () => {}) };
  const note = { id: '0:1', amount: 2000n, spentTxid: false };
  const record = {
    id: note.id,
    type: 'Shield',
    blockNumber: 5944710,
    blindedCommitment: '0x' + '12'.repeat(32),
  };
  const mocks = {
    [w + 'railgun-account-wallet']: {
      readRailgunAccountOwnedNotes: () => ({ read: { received: [note] }, ownedPoi: [record] }),
    },
    './railgun-relay-quote-native-vectors': {
      buildVectors: () => ({ cases: [{ quote: {} }], gas: {} }),
    },
    [w + 'railgun-relay-operation']: {
      proveRailgunAccountRelayOperation: async (v) => {
        if (mutation === 'early') return { status: 'refused', stage: 'admission' };
        expect(
          v.review({
            selection: { noteId: note.id },
            amounts: { input: '2000', fee: '100', self: '1900', cap: '100' },
          })
        ).toBe(true);
        expect(v.reviewDisclosure({ input: { ...record } })).toBe(scenario === 'unrelated-history');
        if (mutation === 'stored') state.records = 1;
        for (let i = 0; i < 3; i++)
          for (const tag of [
            'finalized',
            ...[5944800, 5900000, 5944730, 5899999].map((v) => '0x' + v.toString(16)),
          ])
            requests.push({ method: 'eth_getBlockByNumber', params: [tag, false] });
        return {
          status: 'refused',
          stage:
            mutation === 'stage'
              ? 'signer'
              : scenario === 'unrelated-history'
                ? 'membership'
                : 'disclosure',
        };
      },
    },
  };
  return {
    run: () =>
      load(mocks).qualify({
        account,
        owners,
        scenario,
        services: { selected: jest.fn(), assertClosed: jest.fn(), poiMethods: [], requests },
      }),
    account,
  };
}
test.each(['declined-disclosure', 'unrelated-history'])(
  'expected %s envelope with both reviews and unchanged custody',
  async (scenario) => {
    const f = qualification(scenario);
    expect((await f.run()).noDurableRelayRows).toBe(true);
    expect(f.account.close).toHaveBeenCalled();
  }
);
test.each(['early', 'stored', 'stage'])(
  'qualifier does not accept %s refusal as success',
  async (mutation) => {
    await expect(qualification('unrelated-history', mutation).run()).rejects.toThrow();
  }
);
test('observer refuses an unplanned signer before invoking its original launcher', () => {
  const original = jest.fn(),
    runtime = { startRailgunProcess: original };
  const f = load({ [w + 'railgun-process']: runtime });
  const observer = f.installJobs();
  expect(() =>
    runtime.startRailgunProcess({
      filename: require.resolve(w + 'railgun-relay-sign-job'),
      input: '{}',
    })
  ).toThrow();
  expect(original).not.toHaveBeenCalled();
  observer.restore();
});

test('observer preserves original task/reply identities and exact predeclared 68 closures', async () => {
  let next;
  const original = jest.fn(() => next),
    runtime = { startRailgunProcess: original };
  const f = load({ [w + 'railgun-process']: runtime });
  const observed = f.installJobs();
  const guards = require(w + 'railgun-relay-quote-data').EXPECTED_GUARDS;
  const expected = f.expectedRoles();
  for (const role of expected) {
    let resolve;
    next = {
      closed: new Promise((yes) => {
        resolve = yes;
      }),
    };
    let filename, input, purpose;
    if (role === 'spending-public' || role === 'viewing-identity') {
      filename = 'railgun-identity-job';
      input = { purpose: role };
      purpose = role;
    } else if (role.startsWith('public-')) {
      filename = 'railgun-public-job';
      input = { mode: role.slice(7) };
    } else if (role.startsWith('wallet-')) {
      filename = 'railgun-wallet-job';
      input = { restore: role === 'wallet-restore' };
      purpose = 'wallet-viewing';
    } else if (role === 'quote') {
      filename = 'railgun-relay-quote-job';
      input = {};
    } else {
      filename = 'railgun-relay-wallet-job';
      input = role === 'construct' ? { relayRequest: {} } : { relayDraftText: '{}' };
      purpose = role === 'construct' ? 'relay-prepare' : 'relay-reconstruct';
    }
    const keyReply = Promise.resolve(new Uint8Array(32)),
      resultReply = Promise.resolve('original');
    const dispatch = jest.fn((wire) =>
      JSON.parse(wire).method === 'key' ? keyReply : resultReply
    );
    const route = ['spending-public', 'viewing-identity'].includes(role)
      ? { executionJob: role }
      : role.startsWith('wallet-')
        ? { executionJob: 'wallet-viewing' }
        : { filename: require.resolve(w + filename) };
    const options = { ...route, input: JSON.stringify(input), broker: { dispatch } };
    expect(runtime.startRailgunProcess(options)).toBe(next);
    const forwarded = original.mock.calls.at(-1)[0];
    expect(options.broker.dispatch).toBe(dispatch);
    let id = 0;
    if (purpose)
      expect(forwarded.broker.dispatch(JSON.stringify({ id: ++id, method: 'key', purpose }))).toBe(
        keyReply
      );
    const message = {
      id: id + 1,
      method: role.startsWith('public-') ? 'jobResult' : 'result',
      value: { guards },
    };
    expect(forwarded.broker.dispatch(JSON.stringify(message))).toBe(resultReply);
    await resultReply;
    resolve({
      code: 'RAILGUN_PROCESS_CLOSED',
      exitCode: 15,
      escalated: false,
      peerDisconnected: false,
    });
    await next.closed;
  }
  await observed.finish();
  expect(observed.rows).toHaveLength(68);
  expect(observed.rows.reduce((sum, row) => sum + row.keyReplies, 0)).toBe(6);
  observed.restore();
  expect(runtime.startRailgunProcess).toBe(original);
});

test('observer closure without a result remains a sticky qualification failure', async () => {
  const closed = Promise.resolve({
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  });
  const runtime = { startRailgunProcess: () => ({ closed }) };
  const f = load({ [w + 'railgun-process']: runtime }),
    observer = f.installJobs();
  runtime.startRailgunProcess({
    executionJob: 'spending-public',
    input: JSON.stringify({ purpose: 'spending-public' }),
    broker: { dispatch: async () => 'original' },
  });
  await closed;
  await Promise.resolve();
  await expect(observer.finish()).rejects.toThrow();
  expect(f.errors).toHaveLength(1);
  observer.restore();
});

test('operation RPC guard requires exactly three canonical refreshes and no other method', () => {
  const rows = [];
  for (let i = 0; i < 3; i++)
    for (const tag of [
      'finalized',
      ...[5944800, 5900000, 5944730, 5899999].map((v) => '0x' + v.toString(16)),
    ])
      rows.push({ method: 'eth_getBlockByNumber', params: [tag, false] });
  const f = load();
  expect(Object.values(f.assertOperationRpc(rows)).reduce((a, b) => a + b, 0)).toBe(15);
  expect(() => f.assertOperationRpc(rows.slice(1))).toThrow();
  expect(() => f.assertOperationRpc([...rows, rows[0]])).toThrow();
  expect(() =>
    f.assertOperationRpc([{ method: 'eth_call', params: ['finalized', false] }, ...rows.slice(1)])
  ).toThrow();
});

test.each([
  'railgun-account-public',
  'railgun-poi-source',
  'railgun-public-services',
  'railgun-poi-root',
  'railgun-private-preflight',
  'railgun-shield-preflight',
])('preloaded factory consumer %s refuses before replacing any service', (name) => {
  const factory = jest.fn();
  const f = load({ [n + 'private-rpc']: { createPrivateRpc: factory } }, [name]);
  expect(() => f.installServices([], () => null, 'unrelated-history')).toThrow();
  expect(factory).not.toHaveBeenCalled();
});

test.each(['legacy-filename', 'mixed-route'])(
  'observer rejects an extracted identity %s before original launch',
  (kind) => {
    const original = jest.fn(),
      runtime = { startRailgunProcess: original };
    const f = load({ [w + 'railgun-process']: runtime }),
      observer = f.installJobs();
    const options = {
      filename: require.resolve(w + 'railgun-identity-job'),
      input: JSON.stringify({ purpose: 'spending-public' }),
      broker: { dispatch: jest.fn() },
      ...(kind === 'mixed-route' ? { executionJob: 'spending-public' } : {}),
    };
    try {
      expect(() => runtime.startRailgunProcess(options)).toThrow();
      expect(original).not.toHaveBeenCalled();
    } finally {
      observer.restore();
    }
  }
);
