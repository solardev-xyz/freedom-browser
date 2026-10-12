const { EventEmitter } = require('events');
const {
  EndpointReferences,
  NamingConfig,
  buildSnapshot,
  wireQuorum,
  MAX_REMEMBERED,
  MAX_RPC_ENDPOINTS,
} = require('./naming-config');

const tick = () => new Promise(setImmediate);

function sources(overrides = {}) {
  const network = {
    zkProof: true,
    quorum: { k: 3, m: 2, timeoutMs: 5000, anchor: 'latest', anchorTtlMs: 30000 },
    verification: { order: ['myotis', 'quorum'], preferVerified: true },
  };
  return {
    ens: {
      getEffectiveRpcEndpoints: () => ['https://a.rpc.example', 'https://b.rpc.example'],
      getDirectRpcCandidate: () => ({ url: 'https://b.rpc.example', userConfigured: true }),
      resolutionPolicy: (n) => ({
        order: n.verification.order,
        preferVerified: n.verification.preferVerified,
      }),
    },
    tezos: { getRpcEndpoints: () => ['https://t1.tez.example/'] },
    registry: {
      getNetwork: () => network,
      getEndpoints: (_chain, role) => (role === 'prover' ? ['https://prover.example'] : []),
    },
    myotis: { isEnabled: () => true, isReady: () => false },
    ...overrides,
  };
}

describe('EndpointReferences', () => {
  test('a URL keeps its reference, which maps back; another key gives another', () => {
    const refs = new EndpointReferences(Buffer.alloc(32, 1));
    const ref = refs.ref('https://a.rpc.example');
    expect(ref).toMatch(/^e[0-9a-f]{32}$/);
    expect(refs.ref('https://a.rpc.example')).toBe(ref);
    expect(refs.url(ref)).toBe('https://a.rpc.example');
    expect(refs.ref('https://b.rpc.example')).not.toBe(ref);
    expect(new EndpointReferences(Buffer.alloc(32, 2)).ref('https://a.rpc.example')).not.toBe(ref);
    expect(refs.url('e00')).toBeUndefined();
    expect(refs.url(undefined)).toBeUndefined();
  });

  test('a lookup counts as a use, and the current configuration is never forgotten', () => {
    const refs = new EndpointReferences();
    const pinned = refs.ref('https://pinned.example');
    refs.pin([pinned]);
    const looked = refs.ref('https://looked.example');
    for (let i = 0; i < MAX_REMEMBERED + 10; i++) {
      refs.ref(`https://n${i}.example`);
      refs.url(looked);
    }
    expect(refs.url(pinned)).toBe('https://pinned.example');
    expect(refs.url(looked)).toBe('https://looked.example');
    expect(refs.urls.size).toBe(MAX_REMEMBERED);
  });

  test('it remembers the most recently used references', () => {
    const refs = new EndpointReferences();
    const first = refs.ref('https://first.example');
    for (let i = 0; i < MAX_REMEMBERED - 1; i++) refs.ref(`https://n${i}.example`);
    // Used again, the first is the most recent; the next one in line goes.
    refs.ref('https://first.example');
    const second = refs.ref('https://n0.example');
    refs.ref('https://one-more.example');
    expect(refs.url(first)).toBe('https://first.example');
    expect(refs.url(second)).toBe('https://n0.example');
    expect(refs.urls.size).toBe(MAX_REMEMBERED);
  });
});

describe('the snapshot', () => {
  test('carries references, not URLs, in the shape naming.configure takes', () => {
    const refs = new EndpointReferences();
    const snapshot = buildSnapshot(refs, sources());
    expect(snapshot).toEqual({
      rpc: [
        { endpoint: refs.ref('https://a.rpc.example') },
        { endpoint: refs.ref('https://b.rpc.example') },
      ],
      direct: { endpoint: refs.ref('https://b.rpc.example'), user_configured: true },
      prover: { endpoint: refs.ref('https://prover.example'), zk: true },
      policy: { order: ['myotis', 'quorum'], prefer_verified: true },
      quorum: { k: 3, m: 2, timeout_ms: 5000, anchor: 'latest', anchor_ttl_ms: 30000 },
      myotis_enabled: true,
      tezos: [refs.ref('https://t1.tez.example/')],
    });
    expect(JSON.stringify(snapshot)).not.toContain('example');
  });

  test('no direct candidate, no prover, no quorum, and at most 64 RPC endpoints', () => {
    const many = Array.from({ length: MAX_RPC_ENDPOINTS + 5 }, (_, i) => `https://n${i}.example`);
    const snapshot = buildSnapshot(
      new EndpointReferences(),
      sources({
        ens: {
          getEffectiveRpcEndpoints: () => many,
          getDirectRpcCandidate: () => ({ url: null, userConfigured: false }),
          resolutionPolicy: () => ({ order: ['quorum'] }),
        },
        registry: { getNetwork: () => ({ zkProof: false }), getEndpoints: () => [] },
      })
    );
    expect(snapshot.rpc).toHaveLength(MAX_RPC_ENDPOINTS);
    expect(snapshot.direct).toBeNull();
    expect(snapshot.prover).toBeNull();
    expect(snapshot.quorum).toBeNull();
    expect(snapshot.policy).toEqual({ order: ['quorum'], prefer_verified: false });
  });

  test('only the quorum fields today reads go, renamed, their values raw', () => {
    expect(wireQuorum({ k: '4', timeoutMs: 'x', anchorTtlMs: 1, extra: true })).toEqual({
      k: '4',
      timeout_ms: 'x',
      anchor_ttl_ms: 1,
    });
    // A wire-spelt alias can't overwrite what today reads, nor can an
    // inherited name come along.
    const raw = Object.assign(Object.create({ m: 9 }), {
      timeoutMs: 5000,
      timeout_ms: 1,
      anchorTtlMs: 30000,
      anchor_ttl_ms: 0,
      toString: 'x',
    });
    expect(wireQuorum(raw)).toEqual({ timeout_ms: 5000, anchor_ttl_ms: 30000 });
  });
});

describe('NamingConfig', () => {
  function fakeClient() {
    const client = new EventEmitter();
    client.request = jest.fn(async (method) =>
      method === 'naming.configure' ? { ens: 1, tezos: 1 } : { lifecycle: 2 }
    );
    return client;
  }

  test('each handshake configures, then sends availability, under a new key', async () => {
    const client = fakeClient();
    const config = new NamingConfig({ client, sources: sources(), log: { warn: jest.fn() } });
    client.emit('ready');
    await tick();
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'naming.configure',
      'naming.availability',
    ]);
    const [, params, context] = client.request.mock.calls[0];
    expect(params.reset).toBe('none');
    expect(context).toEqual({ caller: 'shell' });
    expect(client.request.mock.calls[1][1]).toEqual({ ready: false, enabled: true });
    expect(config.generations).toEqual({ ens: 1, tezos: 1, lifecycle: 2 });
    const first = params.rpc[0].endpoint;
    // A new core process: a new key, so new references.
    client.emit('exit');
    client.emit('ready');
    await tick();
    expect(client.request.mock.calls[2][1].rpc[0].endpoint).not.toBe(first);
  });

  test('a settings change resets providers; nothing goes without a core', async () => {
    const client = fakeClient();
    const config = new NamingConfig({ client, sources: sources(), log: { warn: jest.fn() } });
    await config.configure({ reset: true });
    expect(client.request).not.toHaveBeenCalled();
    client.emit('ready');
    await tick();
    await config.configure({ reset: true });
    expect(client.request.mock.calls.at(-1)[1].reset).toBe('providers');
  });

  test('naming waits for initialization, which a failure leaves to retry', async () => {
    const client = new EventEmitter();
    let fail = true;
    client.request = jest.fn(async (method) => {
      if (method === 'naming.configure' && fail)
        throw Object.assign(new Error('x'), { code: 'invalid_argument' });
      return method === 'naming.configure' ? { ens: 1, tezos: 1, lifecycle: 0 } : { lifecycle: 1 };
    });
    const config = new NamingConfig({ client, sources: sources(), log: { warn: jest.fn() } });
    expect(await config.whenReady()).toBe(false);
    client.emit('ready');
    expect(await config.whenReady()).toBe(false);
    // Availability waits for a configuration that took.
    expect(client.request.mock.calls.map(([m]) => m)).toEqual([
      'naming.configure',
      'naming.configure',
    ]);
    fail = false;
    expect(await config.whenReady()).toBe(true);
    expect(client.request.mock.calls.map(([m]) => m).slice(-2)).toEqual([
      'naming.configure',
      'naming.availability',
    ]);
    expect(config.generations).toEqual({ ens: 1, tezos: 1, lifecycle: 1 });
  });

  test('built after the handshake, it initializes at once', async () => {
    const client = fakeClient();
    client.hello = { protocol: 1 };
    const config = new NamingConfig({ client, sources: sources(), log: { warn: jest.fn() } });
    expect(await config.whenReady()).toBe(true);
  });

  test('a provider reset takes the lifecycle the reply reports', async () => {
    const client = fakeClient();
    client.request = jest.fn(async (method, params) => {
      if (method === 'naming.availability') return { lifecycle: 1 };
      return { ens: 1, tezos: 1, lifecycle: params.reset === 'providers' ? 2 : 1 };
    });
    const config = new NamingConfig({ client, sources: sources(), log: { warn: jest.fn() } });
    client.emit('ready');
    await config.whenReady();
    await config.configure({ reset: true });
    expect(config.generations.lifecycle).toBe(2);
    // A late, lower report never moves it back.
    config.adopt({ lifecycle: 1 }, ['lifecycle']);
    expect(config.generations.lifecycle).toBe(2);
  });
});
