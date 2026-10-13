const { EventEmitter } = require('events');
const {
  ChainConfig,
  ChainReferences,
  buildChainSnapshot,
  wireQuorum,
  isUserConfiguredRpc,
  MAX_RPC_ENDPOINTS,
  CONTROL_WATCHDOG_MS,
} = require('./chain-config');

const LOG_INDEX_URLS = { 100: 'https://gnosis.blockscout.com/api' };

/** A registry with Ethereum, Gnosis and Base as chains.json has them, a
 * user's endpoint on Gnosis, and a custom chain without orders. */
function registry(overrides = {}) {
  const networks = {
    1: {
      name: 'Ethereum',
      access: {
        readOrder: ['myotis', 'colibri', 'quorum', 'direct'],
        broadcastOrder: ['myotis', 'direct'],
      },
      quorum: { k: 3, m: 2, timeoutMs: 5000, anchor: 'latest', anchorTtlMs: 30000 },
    },
    100: { name: 'Gnosis Chain', zkProof: false, access: {}, quorum: { k: '4' } },
    8453: { name: 'Base', access: { readOrder: ['quorum', 'direct'], broadcastOrder: ['direct'] } },
    777: { name: 'Odd Chain', access: {}, quorum: {} },
  };
  const endpoints = {
    1: {
      rpc: ['https://a.eth.example', 'https://b.eth.example'],
      prover: ['https://p1.example', 'https://p2.example'],
    },
    100: { rpc: ['https://user.gno.example', 'https://a.eth.example'], prover: [] },
    8453: { rpc: ['https://base.example'], prover: [] },
    777: { rpc: [], prover: [] },
  };
  return {
    getAllNetworks: () => networks,
    getEndpoints: (chainId, role) => endpoints[String(chainId)]?.[role] ?? [],
    getEndpointSources: (chainId) =>
      String(chainId) === '100'
        ? [{ id: 'mine', keyed: false, coverage: { 100: 'https://user.gno.example' } }]
        : [],
    getEndpointSourceList: () => [{ id: 'mine', builtin: false, removed: false, keyed: false }],
    ...overrides,
  };
}

const myotis = (ready = { 1: true, 100: false }) => ({
  NETWORKS: new Map([
    [1, { chainId: 1, displayName: 'Ethereum' }],
    [100, { chainId: 100, displayName: 'Gnosis' }],
  ]),
  isReady: jest.fn((chainId) => ready[chainId] === true),
});

const sources = (overrides = {}) => ({
  registry: registry(),
  myotis: myotis(),
  logIndexUrls: LOG_INDEX_URLS,
  ...overrides,
});

describe('ChainReferences', () => {
  test('each (chain, URL) has its own reference, which maps back to both', () => {
    const refs = new ChainReferences(Buffer.alloc(32, 1));
    const eth = refs.endpointRef(1, 'https://a.example');
    const gno = refs.endpointRef(100, 'https://a.example');
    expect(eth).toMatch(/^c[0-9a-f]{32}$/);
    expect(gno).not.toBe(eth);
    expect(refs.endpointRef(1, 'https://a.example')).toBe(eth);
    expect(refs.endpoint(eth)).toEqual({ url: 'https://a.example', chainId: 1 });
    expect(refs.endpoint(gno)).toEqual({ url: 'https://a.example', chainId: 100 });
    // Another process's key: other references.
    expect(new ChainReferences(Buffer.alloc(32, 2)).endpointRef(1, 'https://a.example')).not.toBe(
      eth
    );
    expect(refs.endpoint('c00')).toBeNull();
    expect(refs.endpoint(undefined)).toBeNull();
  });
});

describe('the snapshot', () => {
  test('every configured chain, as the router reads it, by reference', () => {
    const refs = new ChainReferences();
    const snapshot = buildChainSnapshot(refs, sources());
    const ref = (chainId, url) => refs.endpointRef(chainId, url);
    expect(snapshot).toEqual({
      chains: [
        {
          chain_id: 1,
          display_name: 'Ethereum',
          read_order: ['myotis', 'colibri', 'quorum', 'direct'],
          broadcast_order: ['myotis', 'direct'],
          // Raw, and only what the router reads.
          quorum: { k: 3, m: 2, timeout_ms: 5000 },
          rpc: [
            { endpoint: ref(1, 'https://a.eth.example'), user_configured: false },
            { endpoint: ref(1, 'https://b.eth.example'), user_configured: false },
          ],
          // The first prover.
          prover: { endpoint: ref(1, 'https://p1.example'), zk: true },
          myotis: true,
          blockscout: null,
        },
        {
          chain_id: 100,
          // Myotis' own name for the chain, which its errors use.
          display_name: 'Gnosis',
          // No orders configured: the router's defaults for a Myotis chain.
          read_order: ['myotis', 'colibri', 'quorum', 'direct'],
          broadcast_order: ['myotis', 'direct'],
          quorum: { k: '4' },
          rpc: [
            { endpoint: ref(100, 'https://user.gno.example'), user_configured: true },
            { endpoint: ref(100, 'https://a.eth.example'), user_configured: false },
          ],
          prover: null,
          myotis: true,
          // The Ant profile's log index.
          blockscout: { endpoint: ref(100, 'https://gnosis.blockscout.com/api') },
        },
        {
          chain_id: 777,
          display_name: 'Odd Chain',
          read_order: ['colibri', 'quorum', 'direct'],
          broadcast_order: ['direct'],
          quorum: {},
          rpc: [],
          prover: null,
          myotis: false,
          blockscout: null,
        },
        {
          chain_id: 8453,
          display_name: 'Base',
          read_order: ['quorum', 'direct'],
          broadcast_order: ['direct'],
          rpc: [{ endpoint: ref(8453, 'https://base.example'), user_configured: false }],
          prover: null,
          myotis: false,
          blockscout: null,
        },
      ],
    });
    // The same URL on two chains: two references.
    expect(snapshot.chains[0].rpc[0].endpoint).not.toBe(snapshot.chains[1].rpc[1].endpoint);
    expect(JSON.stringify(snapshot)).not.toContain('example');
  });

  test('at most 64 RPC endpoints; names only in orders; chains the wire cannot name left out', () => {
    const many = Array.from({ length: MAX_RPC_ENDPOINTS + 3 }, (_, i) => `https://n${i}.example`);
    const snapshot = buildChainSnapshot(
      new ChainReferences(),
      sources({
        registry: registry({
          getAllNetworks: () => ({
            '01': { name: 'Leading zero' },
            abc: { name: 'Not a number' },
            '-1': { name: 'Negative' },
            5: {
              access: { readOrder: ['quorum', 7, null, 'direct', 'quorum'], broadcastOrder: [] },
            },
          }),
          getEndpoints: (_chainId, role) => (role === 'rpc' ? [...many, 42] : [null]),
        }),
      })
    );
    expect(snapshot.chains.map((c) => c.chain_id)).toEqual([5]);
    const [chain] = snapshot.chains;
    expect(chain.rpc).toHaveLength(MAX_RPC_ENDPOINTS);
    // Repeats and unknown names are the core's to drop (deviation
    // `order-validation`); an empty order stays empty, as the router's.
    expect(chain.read_order).toEqual(['quorum', 'direct', 'quorum']);
    expect(chain.broadcast_order).toEqual([]);
    expect(chain.prover).toBeNull();
    expect(chain.display_name).toBe('5');
    expect(chain).not.toHaveProperty('quorum');
  });

  test("the quorum's raw values for k, m and timeoutMs, own ones only", () => {
    expect(wireQuorum({ k: '4', m: null, timeoutMs: 'x', anchor: 'latest' })).toEqual({
      k: '4',
      m: null,
      timeout_ms: 'x',
    });
    expect(wireQuorum(Object.assign(Object.create({ k: 9 }), { timeout_ms: 1 }))).toEqual({});
    expect(wireQuorum(null)).toBeNull();
  });

  test("Direct's user-configured endpoints, as the router tells them", () => {
    const reg = registry({
      getEndpointSources: () => [
        { id: 'keyed', keyed: true, coverage: { 1: 'https://k.example' } },
        { id: 'mine', keyed: false, coverage: { 1: 'https://mine.example' } },
        { id: 'builtin', keyed: false, coverage: { 1: 'https://builtin.example' } },
      ],
      getEndpointSourceList: () => [
        { id: 'mine', builtin: false, removed: false, keyed: false },
        { id: 'builtin', builtin: true, removed: false, keyed: false },
      ],
    });
    expect(isUserConfiguredRpc(reg, 1, 'https://mine.example')).toBe(true);
    expect(isUserConfiguredRpc(reg, 1, 'https://builtin.example')).toBe(false);
    expect(isUserConfiguredRpc(reg, 1, 'https://k.example')).toBe(false);
    expect(isUserConfiguredRpc(reg, 1, 'https://other.example')).toBe(false);
  });
});

describe('ChainConfig', () => {
  const unavailable = () => Object.assign(new Error('unavailable'), { code: 'core_unavailable' });
  const configured = (params, base = 1) => ({
    generations: Object.fromEntries(params.chains.map((c) => [String(c.chain_id), base])),
  });

  /** A client whose core processes answer as `answer` says: `start()` makes
   * a ready one, `end()` its child's exit, `exit()` the client's event. */
  function fakeClient(
    answer = (method, params) => (method === 'chain.configure' ? configured(params) : {})
  ) {
    const client = new EventEmitter();
    client.sent = []; // [process, method, params, context, options]
    let number = 0;
    client.start = () => {
      number += 1;
      client.current = { number, ended: false };
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
    client.requestTo = jest.fn(async (gen, method, params, context, options) => {
      if (!client.serves(gen)) throw unavailable();
      client.sent.push([gen.number, method, params, context, options]);
      return answer(method, params, gen.number);
    });
    return client;
  }

  const methods = (client) => client.sent.map(([n, m]) => `${n}:${m}`);
  const make = (client, extra = {}) =>
    new ChainConfig({ client, sources: sources(extra), log: { warn: jest.fn() } });

  test('each handshake configures, then sends each Myotis chain readiness, under a new key', async () => {
    const client = fakeClient();
    const config = make(client);
    client.start();
    const gen = await config.whenServing();
    expect(gen).toBe(client.current);
    expect(methods(client)).toEqual([
      '1:chain.configure',
      '1:chain.availability',
      '1:chain.availability',
    ]);
    const [, , params, context, options] = client.sent[0];
    expect(context).toEqual({ caller: 'shell' });
    expect(options).toEqual({ watchdogMs: CONTROL_WATCHDOG_MS });
    expect(client.sent.slice(1).map(([, , p]) => p)).toEqual([
      { chain_id: 1, ready: true },
      { chain_id: 100, ready: false },
    ]);
    // The generations the core reported, by chain.
    expect([1, 100, 777, 8453].map((id) => config.generation(id))).toEqual([1, 1, 1, 1]);
    // A chain the core doesn't configure has no current generation.
    expect(config.generation(137)).toBe(Infinity);
    // The executors' view of a reference: the chain it names.
    const ref = params.chains[1].rpc[0].endpoint;
    expect(config.endpoint(ref)).toEqual({ url: 'https://user.gno.example', chainId: 100 });
    expect(config.endpointUrl(ref, gen)).toBe('https://user.gno.example');
    // A new core process: a new key, new references, generations afresh.
    client.exit();
    expect(config.endpoint(ref)).toBeNull();
    expect(config.generation(1)).toBe(Infinity);
    client.start();
    await config.whenServing();
    expect(client.sent[3][2].chains[1].rpc[0].endpoint).not.toBe(ref);
    // The process that made a reply still maps it.
    expect(config.endpointUrl(ref, gen)).toBe('https://user.gno.example');
  });

  test('a registry change goes in order, and a chain the change removes has no generation', async () => {
    let chains = registry().getAllNetworks();
    const client = fakeClient((method, params) =>
      method === 'chain.configure' ? configured(params, client.sent.length) : {}
    );
    const config = make(client, { registry: registry({ getAllNetworks: () => chains }) });
    await config.configure();
    // Nothing goes without a core.
    expect(client.sent).toEqual([]);
    client.start();
    const gen = await config.whenServing();
    expect(config.generation(8453)).toBe(1);
    chains = { 1: chains[1] };
    await config.configure();
    expect(methods(client).slice(-1)).toEqual(['1:chain.configure']);
    expect(client.sent.at(-1)[2].chains.map((c) => c.chain_id)).toEqual([1]);
    expect(config.generation(1)).toBe(4);
    expect(config.generation(8453)).toBe(Infinity);
    // Fencing: a reply made under a generation main has moved past was
    // overtaken; one made without the chain (0) was not.
    expect(config.overtaken(gen, 1, 1)).toBe(true);
    expect(config.overtaken(gen, 1, 4)).toBe(false);
    expect(config.overtaken(gen, 1, 5)).toBe(false);
    expect(config.overtaken(gen, 8453, 1)).toBe(true);
    expect(config.overtaken(gen, 8453, 0)).toBe(false);
    expect(config.overtaken(gen, 137, 0)).toBe(false);
    expect(config.overtaken(gen, 1, undefined)).toBe(false);
    expect(config.overtaken({}, 1, 1)).toBe(false);
  });

  test('a Myotis transition sends readiness as it stands when sent', async () => {
    const ready = { 1: true, 100: false };
    const client = fakeClient();
    const config = make(client, { myotis: myotis(ready) });
    client.start();
    await config.whenServing();
    ready[100] = true;
    await config.availability();
    expect(client.sent.slice(-2).map(([, , p]) => p)).toEqual([
      { chain_id: 1, ready: true },
      { chain_id: 100, ready: true },
    ]);
  });

  test('a control in flight makes the process busy until it settles', async () => {
    let release;
    const client = fakeClient((method, params) => {
      if (method === 'chain.configure' && client.sent.length > 3) {
        return new Promise((resolve) => {
          release = () => resolve(configured(params, 2));
        });
      }
      return method === 'chain.configure' ? configured(params) : {};
    });
    const config = make(client);
    client.start();
    const gen = await config.whenServing();
    expect(config.idle(gen)).toBe(true);
    const change = config.configure();
    expect(config.idle(gen)).toBe(false);
    await new Promise(setImmediate);
    release();
    await change;
    expect(config.idle(gen)).toBe(true);
    expect(config.generation(1)).toBe(2);
    // Another process's generation is never idle here.
    expect(config.idle({})).toBe(false);
  });

  test('a failed control is owed: nothing is served until it goes', async () => {
    let fail = false;
    const client = fakeClient((method, params) => {
      if (fail && method === 'chain.configure') {
        throw Object.assign(new Error('x'), { code: 'invalid_argument' });
      }
      return method === 'chain.configure' ? configured(params) : {};
    });
    const config = make(client);
    client.start();
    const gen = await config.whenServing();
    fail = true;
    await expect(config.configure()).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(config.idle(gen)).toBe(false);
    // Still failing: no process to serve.
    expect(await config.whenServing()).toBeNull();
    fail = false;
    expect(await config.whenServing()).toBe(gen);
    expect(config.idle(gen)).toBe(true);
    expect(methods(client).slice(-1)).toEqual(['1:chain.configure']);
  });

  test('a failed initialization is retried by the next waiter', async () => {
    let fail = true;
    const client = fakeClient((method, params) => {
      if (fail && method === 'chain.configure') throw unavailable();
      return method === 'chain.configure' ? configured(params) : {};
    });
    const config = make(client);
    client.start();
    const waiting = [config.whenServing(), config.whenServing()];
    await Promise.resolve();
    fail = false;
    expect(await Promise.all(waiting)).toEqual([client.current, client.current]);
    expect(methods(client)).toEqual([
      '1:chain.configure',
      '1:chain.configure',
      '1:chain.availability',
      '1:chain.availability',
    ]);
  });

  test('an initialized process whose child has exited serves nothing', async () => {
    const client = fakeClient();
    const config = make(client);
    client.start();
    await config.whenServing();
    client.end();
    expect(await config.whenServing()).toBeNull();
    client.exit();
    client.start();
    expect(await config.whenServing()).toBe(client.current);
  });

  test('a generation the core reports never moves back within a process', async () => {
    const client = fakeClient();
    const config = make(client);
    client.start();
    await config.whenServing();
    config.adopt(config.core, { generations: { 1: 7, x: 3, 100: 'two' } });
    config.adopt(config.core, { generations: { 1: 2 } });
    expect(config.generation(1)).toBe(7);
    expect(config.generation(100)).toBe(Infinity);
  });
});
