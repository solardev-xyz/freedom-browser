const { EventEmitter } = require('events');
const {
  EndpointReferences,
  NamingConfig,
  buildSnapshot,
  wireQuorum,
  MAX_REMEMBERED,
  MAX_RPC_ENDPOINTS,
  CONTROL_WATCHDOG_MS,
} = require('./naming-config');

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
    refs.propose();
    const pinned = refs.ref('https://pinned.example');
    refs.settle(true);
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
  const unavailable = () => Object.assign(new Error('unavailable'), { code: 'core_unavailable' });

  /** A client whose core processes answer as `answer` says: `start()` makes
   * a ready one, `end()` its child's exit (the 'exit' event comes with
   * `exit()`, later). */
  function fakeClient(
    answer = (method) =>
      method === 'naming.configure' ? { ens: 1, tezos: 1, lifecycle: 1 } : { lifecycle: 2 }
  ) {
    const client = new EventEmitter();
    client.sent = []; // [process, method, params, context]
    let number = 0;
    client.start = () => {
      number += 1;
      client.current = { number, ready: true, ended: false };
      client.hello = { protocol: 1 };
      client.emit('ready', client.hello);
    };
    client.end = () => {
      client.current.ended = true;
    };
    client.exit = () => {
      client.current = null;
      client.hello = null;
      client.emit('exit', {});
    };
    client.serves = (gen) => Boolean(gen) && gen === client.current && !gen.ended;
    client.requestTo = jest.fn(async (gen, method, params, context) => {
      if (!client.serves(gen)) throw unavailable();
      client.sent.push([gen.number, method, params, context]);
      return answer(method, params, gen.number);
    });
    return client;
  }

  const methods = (client) => client.sent.map(([n, m]) => `${n}:${m}`);
  const make = (client, extra = {}) =>
    new NamingConfig({ client, sources: sources(extra), log: { warn: jest.fn() } });

  test('each handshake configures, then sends availability, under a new key', async () => {
    const client = fakeClient();
    const config = make(client);
    client.start();
    expect(await config.whenReady()).toBe(true);
    expect(methods(client)).toEqual(['1:naming.configure', '1:naming.availability']);
    const [, , params, context] = client.sent[0];
    expect(params.reset).toBe('none');
    expect(context).toEqual({ caller: 'shell' });
    expect(client.sent[1][2]).toEqual({ ready: false, enabled: true });
    expect(config.generations).toEqual({ ens: 1, tezos: 1, lifecycle: 2 });
    // A new core process: a new key, so new references.
    client.exit();
    client.start();
    await config.whenReady();
    expect(client.sent[2][2].rpc[0].endpoint).not.toBe(params.rpc[0].endpoint);
  });

  test('a settings change resets providers; nothing goes without a core', async () => {
    const client = fakeClient();
    const config = make(client);
    await config.configure({ reset: true });
    expect(client.sent).toEqual([]);
    client.start();
    await config.configure({ reset: true });
    // In order: after the initialization.
    expect(methods(client)).toEqual([
      '1:naming.configure',
      '1:naming.availability',
      '1:naming.configure',
    ]);
    expect(client.sent[2][2].reset).toBe('providers');
  });

  test('naming waits for initialization, which a failure leaves to retry', async () => {
    let fail = true;
    const client = fakeClient((method) => {
      if (method === 'naming.configure' && fail)
        throw Object.assign(new Error('x'), { code: 'invalid_argument' });
      return method === 'naming.configure' ? { ens: 1, tezos: 1, lifecycle: 0 } : { lifecycle: 1 };
    });
    const config = make(client);
    expect(await config.whenReady()).toBe(false);
    client.start();
    expect(await config.whenReady()).toBe(false);
    // Availability waits for a configuration that took.
    expect(methods(client)).toEqual(['1:naming.configure', '1:naming.configure']);
    fail = false;
    expect(await config.whenReady()).toBe(true);
    expect(methods(client).slice(-2)).toEqual(['1:naming.configure', '1:naming.availability']);
    expect(config.generations).toEqual({ ens: 1, tezos: 1, lifecycle: 1 });
  });

  test('waiters on a failed initialization share one retry', async () => {
    let fail = true;
    const client = fakeClient((method) => {
      if (method === 'naming.configure' && fail) throw unavailable();
      return { ens: 1, tezos: 1, lifecycle: 1 };
    });
    const config = make(client);
    client.start();
    const waiting = [config.whenReady(), config.whenReady(), config.whenReady()];
    // They all wait on the failing attempt, then on one retry.
    await Promise.resolve();
    fail = false;
    expect(await Promise.all(waiting)).toEqual([true, true, true]);
    expect(methods(client)).toEqual([
      '1:naming.configure',
      '1:naming.configure',
      '1:naming.availability',
    ]);
  });

  test('built after the handshake, it initializes at once', async () => {
    const client = fakeClient();
    client.start();
    const config = make(client);
    expect(await config.whenReady()).toBe(true);
  });

  test('a provider reset takes the lifecycle the reply reports', async () => {
    const client = fakeClient((method, params) => {
      if (method === 'naming.availability') return { lifecycle: 1 };
      return { ens: 1, tezos: 1, lifecycle: params.reset === 'providers' ? 2 : 1 };
    });
    const config = make(client);
    client.start();
    await config.whenReady();
    await config.configure({ reset: true });
    expect(config.generations.lifecycle).toBe(2);
    // A late, lower report never moves it back.
    config.adopt(config.core, { lifecycle: 1 }, ['lifecycle']);
    expect(config.generations.lifecycle).toBe(2);
  });

  test('an initialized process whose child has exited is not ready', async () => {
    const client = fakeClient();
    const config = make(client);
    client.start();
    const first = client.current;
    expect(await config.whenServing()).toBe(first);
    // Its child exits; the client's 'exit' comes later, after the drain.
    client.end();
    expect(await config.whenReady()).toBe(false);
    expect(await config.whenServing()).toBeNull();
    // No retry for a process that has gone.
    expect(methods(client)).toEqual(['1:naming.configure', '1:naming.availability']);
    client.exit();
    client.start();
    expect(await config.whenServing()).toBe(client.current);
  });

  test('a new core process counts its generations from zero', async () => {
    const client = fakeClient((method, _params, n) =>
      n === 1 ? { ens: 20, tezos: 12, lifecycle: 9 } : { ens: 1, tezos: 0, lifecycle: 1 }
    );
    const config = make(client);
    client.start();
    await config.whenReady();
    expect(config.generations).toEqual({ ens: 20, tezos: 12, lifecycle: 9 });
    client.exit();
    expect(config.generations).toEqual({ ens: 0, tezos: 0, lifecycle: 0 });
    client.start();
    expect(await config.whenReady()).toBe(true);
    expect(config.generations).toEqual({ ens: 1, tezos: 0, lifecycle: 1 });
  });

  test('nothing meant for one core process reaches another', async () => {
    let release;
    const client = fakeClient((method, _params, n) => {
      // The first process's first configure is held.
      if (n === 1 && method === 'naming.configure' && !release) {
        return new Promise((resolve) => {
          release = () => resolve({ ens: 1, tezos: 1, lifecycle: 1 });
        });
      }
      return { ens: 1, tezos: 1, lifecycle: 1 };
    });
    const config = make(client);
    client.start();
    const first = config.whenReady();
    await Promise.resolve();
    // Its child exits before the reply; a settings change comes while the
    // client restarts, before 'exit'.
    client.end();
    const change = config.configure({ reset: true });
    release();
    expect(await first).toBe(false);
    // Bound to the process that exited: it fails, and the next process's
    // initialization reads the settings afresh.
    await expect(change).rejects.toMatchObject({ code: 'core_unavailable' });
    client.exit();
    client.start();
    expect(await config.whenReady()).toBe(true);
    // The first process got its one configure; the second only its own.
    expect(methods(client)).toEqual([
      '1:naming.configure',
      '2:naming.configure',
      '2:naming.availability',
    ]);
    expect(config.endpointUrl(client.sent[1][2].rpc[0].endpoint)).toBe('https://a.rpc.example');
    // The first process's references don't map.
    expect(config.endpointUrl(client.sent[0][2].rpc[0].endpoint)).toBeUndefined();
  });

  test('a refused proposal leaves the configuration the core runs mapped', async () => {
    let urls = ['https://a.rpc.example'];
    let refuse = false;
    const client = fakeClient((method) => {
      if (method === 'naming.configure' && refuse) throw unavailable();
      return { ens: 1, tezos: 1, lifecycle: 1 };
    });
    const config = new NamingConfig({
      client,
      sources: sources({
        ens: {
          getEffectiveRpcEndpoints: () => urls,
          getDirectRpcCandidate: () => ({ url: null }),
          resolutionPolicy: () => ({ order: ['quorum'] }),
        },
      }),
      log: { warn: jest.fn() },
    });
    client.start();
    await config.whenReady();
    const active = client.sent[0][2].rpc[0].endpoint;
    refuse = true;
    for (let round = 0; round < 20; round++) {
      urls = Array.from({ length: MAX_RPC_ENDPOINTS }, (_, i) => `https://r${round}-${i}.example`);
      await expect(config.configure()).rejects.toMatchObject({ code: 'core_unavailable' });
    }
    expect(config.core.refs.url(active)).toBe('https://a.rpc.example');
    // Accepted, a proposal replaces it.
    refuse = false;
    await config.configure();
    const accepted = client.sent.at(-1)[2].rpc[0].endpoint;
    for (let i = 0; i < MAX_REMEMBERED; i++) config.core.refs.ref(`https://n${i}.example`);
    expect(config.core.refs.url(accepted)).toBe('https://r19-0.example');
    expect(config.core.refs.url(active)).toBeUndefined();
  });

  test('a proposal stays mapped while the core considers it', async () => {
    let urls = ['https://a.rpc.example'];
    let release;
    const client = fakeClient((method) =>
      method === 'naming.configure' && release === null
        ? new Promise((resolve) => {
            release = () => resolve({ ens: 2, tezos: 2, lifecycle: 1 });
          })
        : { ens: 1, tezos: 1, lifecycle: 1 }
    );
    const config = make(client, {
      ens: {
        getEffectiveRpcEndpoints: () => urls,
        getDirectRpcCandidate: () => ({ url: null }),
        resolutionPolicy: () => ({ order: ['quorum'] }),
      },
    });
    client.start();
    await config.whenReady();
    urls = ['https://new.rpc.example'];
    release = null;
    const change = config.configure();
    await Promise.resolve();
    const proposed = client.sent.at(-1)[2].rpc[0].endpoint;
    for (let i = 0; i < MAX_REMEMBERED + 10; i++) config.core.refs.ref(`https://n${i}.example`);
    expect(config.core.refs.url(proposed)).toBe('https://new.rpc.example');
    release();
    await change;
    expect(config.generations.ens).toBe(2);
  });

  test('a lookup waits for the controls queued before it, in order', async () => {
    let release;
    const client = fakeClient((method) =>
      method === 'naming.configure' && release === null
        ? new Promise((resolve) => {
            release = () => resolve({ ens: 2, tezos: 1, lifecycle: 1 });
          })
        : { ens: 1, tezos: 1, lifecycle: 1 }
    );
    const config = make(client);
    client.start();
    await config.whenReady();
    // A settings change goes out and waits for its reply; an invalidation
    // queues behind it; then a lookup asks for the process.
    release = null;
    const change = config.configure({ reset: true });
    const invalidation = config.invalidate('naming.invalidate_content', { name: 'a.eth' });
    let served = null;
    config.whenServing().then((gen) => (served = gen));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(served).toBeNull();
    expect(methods(client).slice(-1)).toEqual(['1:naming.configure']);
    release();
    await change;
    await invalidation;
    await new Promise(setImmediate);
    // Served only after both, with the generation the change brought.
    expect(served).toBe(client.current);
    expect(methods(client).slice(-2)).toEqual([
      '1:naming.configure',
      '1:naming.invalidate_content',
    ]);
    expect(config.generations.ens).toBe(2);
  });

  test('control requests carry a hang watchdog', async () => {
    const client = fakeClient();
    make(client);
    client.start();
    await new Promise(setImmediate);
    const watched = client.requestTo.mock.calls.map(([, method, , , options]) => [
      method,
      options?.watchdogMs,
    ]);
    expect(watched).toEqual([
      ['naming.configure', CONTROL_WATCHDOG_MS],
      ['naming.availability', CONTROL_WATCHDOG_MS],
    ]);
  });

  test('a process gone keeps its references and generations for its last replies', async () => {
    const client = fakeClient((method) =>
      method === 'naming.configure' ? { ens: 3, tezos: 1, lifecycle: 1 } : { lifecycle: 2 }
    );
    const config = make(client);
    client.start();
    const first = client.current;
    await config.whenReady();
    const ref = client.sent[0][2].rpc[0].endpoint;
    client.exit();
    client.start();
    // The current process knows nothing of it; the first still does.
    expect(config.endpointUrl(ref)).toBeUndefined();
    expect(config.endpointUrl(ref, first)).toBe('https://a.rpc.example');
    expect(config.generationsOf(first)).toEqual({ ens: 3, tezos: 1, lifecycle: 2 });
  });

  test('a control that fails is owed: nothing is served until it goes', async () => {
    let refuse = false;
    const client = fakeClient((method) => {
      if (refuse && method !== 'naming.resolve_tezos') {
        throw Object.assign(new Error('busy'), { code: 'busy' });
      }
      return method === 'naming.configure' ? { ens: 2, tezos: 2, lifecycle: 1 } : { lifecycle: 1 };
    });
    const config = make(client);
    client.start();
    await config.whenReady();
    const before = client.sent.length;
    // A settings change fails locally (the client is full).
    refuse = true;
    await expect(config.configure({ reset: true })).rejects.toMatchObject({ code: 'busy' });
    // While it can't go, the process isn't served.
    expect(await config.whenServing()).toBeNull();
    // Once it can, it goes first, with its reset, and then the process is served.
    refuse = false;
    expect(await config.whenServing()).toBe(client.current);
    const resent = client.sent.slice(before).filter(([, method]) => method === 'naming.configure');
    expect(resent.at(-1)[2].reset).toBe('providers');
    expect(await config.whenServing()).toBe(client.current);
  });

  test('a failed invalidation is owed as clearing its cache', async () => {
    let refuse = true;
    const client = fakeClient((method) => {
      if (refuse && method.startsWith('naming.invalidate')) throw new Error('busy');
      return method === 'naming.configure' ? { ens: 1, tezos: 1, lifecycle: 1 } : { lifecycle: 1 };
    });
    const config = make(client);
    client.start();
    await config.whenReady();
    await expect(
      config.invalidate('naming.invalidate_content', { name: 'a.eth' })
    ).rejects.toThrow();
    await expect(config.invalidate('naming.invalidate_tezos', { name: 'a.tez' })).rejects.toThrow();
    refuse = false;
    const before = client.sent.length;
    expect(await config.whenServing()).toBe(client.current);
    // ENS content: a provider reset clears every ENS cache; Tezos: all of it.
    expect(client.sent.slice(before).map(([, method, params]) => [method, params.reset])).toEqual([
      ['naming.configure', 'providers'],
      ['naming.invalidate_tezos', undefined],
    ]);
  });

  test('controls asked for are counted at once, per scope', async () => {
    const client = fakeClient();
    const config = make(client);
    client.start();
    await config.whenReady();
    const gen = client.current;
    const before = config.requestedOf(gen);
    const pending = config.availability();
    // Counted before it is sent or answered.
    expect(config.requestedOf(gen)).toEqual({ ...before, lifecycle: before.lifecycle + 1 });
    await pending;
    config.configure({ reset: false }).catch(() => {});
    expect(config.requestedOf(gen)).toEqual({
      ens: before.ens + 1,
      tezos: before.tezos + 1,
      lifecycle: before.lifecycle + 1,
    });
  });
});
