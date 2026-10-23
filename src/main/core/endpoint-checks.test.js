// Design 0005, "Endpoints serve their chain" (decided, #93): an RPC endpoint
// takes part in chain C's reads only once eth_chainId from it answered C.
// On a fake clock.

const { EventEmitter } = require('events');
const {
  EndpointChecks,
  askChainId,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  RECHECK_MS,
} = require('./endpoint-checks');
const { ChainConfig, STARTUP_CHECKS_MS, CHECKED_CONFIGURE_MS } = require('./chain-config');

const ETH = 1;
const GNO = 100;

/** An ask whose answers a test sets per URL: a chain ID, null (a failed
 * check), or a promise. */
function scriptedAsk(answers) {
  const ask = jest.fn((url) => {
    const answer = answers[url];
    return typeof answer === 'function' ? answer() : Promise.resolve(answer ?? null);
  });
  return ask;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('askChainId, over the executors’ transport', () => {
  const reply = (status, body) => ({ status, headers: {}, body: Buffer.from(body) });
  const hop = (response) => jest.fn(async () => response);

  test("the chain ID an endpoint answers, from eth_chainId's result", async () => {
    const h = hop(reply(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x64' })));
    await expect(askChainId('https://rpc.example', { hop: h })).resolves.toBe(100);
    const [url, options] = h.mock.calls[0];
    expect(url).toBe('https://rpc.example');
    expect(JSON.parse(options.body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    });
  });

  test.each([
    ['an error status', reply(500, 'oops')],
    ['an error answer', reply(200, JSON.stringify({ error: { code: -32601 } }))],
    ['a malformed result', reply(200, JSON.stringify({ result: '100' }))],
    ['an unreadable body', reply(200, 'not json')],
  ])('%s is a failed check', async (_name, response) => {
    await expect(askChainId('https://rpc.example', { hop: hop(response) })).resolves.toBeNull();
  });

  test('a URL main would never dial is a failed check, and nothing is sent', async () => {
    const h = hop(reply(200, '{}'));
    await expect(askChainId('http://10.0.0.1:8545', { hop: h })).resolves.toBeNull();
    expect(h).not.toHaveBeenCalled();
  });

  test('an endpoint that never answers fails the check at its deadline', async () => {
    const h = jest.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason))
        )
    );
    const asked = askChainId('https://rpc.example', { hop: h, timeoutMs: 5000 });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(asked).resolves.toBeNull();
  });
});

describe('EndpointChecks', () => {
  const pairs = [
    { chainId: ETH, url: 'https://a.example' },
    { chainId: ETH, url: 'https://gnosis-by-mistake.example' },
    { chainId: GNO, url: 'https://down.example' },
  ];

  test('only an endpoint that answered its own chain is let in', async () => {
    const ask = scriptedAsk({
      'https://a.example': ETH,
      'https://gnosis-by-mistake.example': GNO,
      'https://down.example': null,
    });
    const checks = new EndpointChecks({ ask, log: { warn: jest.fn() } });
    checks.sync(pairs);
    await jest.advanceTimersByTimeAsync(0);
    expect(checks.allows(ETH, 'https://a.example')).toBe(true);
    expect(checks.allows(ETH, 'https://gnosis-by-mistake.example')).toBe(false);
    expect(checks.answer(ETH, 'https://gnosis-by-mistake.example')).toBe(GNO);
    expect(checks.allows(GNO, 'https://down.example')).toBe(false);
    checks.reset();
  });

  test('a failed check is retried from 30 s, doubling to 10 min, and joins once it answers', async () => {
    const answers = { 'https://down.example': null };
    const ask = scriptedAsk(answers);
    const onChange = jest.fn();
    const checks = new EndpointChecks({ ask, onChange });
    checks.sync([{ chainId: GNO, url: 'https://down.example' }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);

    const delays = [];
    for (let i = 0; i < 7; i += 1) {
      delays.push(Math.min(RETRY_FIRST_MS * 2 ** i, RETRY_MAX_MS));
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    for (const [i, delay] of delays.entries()) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(ask).toHaveBeenCalledTimes(i + 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(ask).toHaveBeenCalledTimes(i + 2);
    }
    expect(onChange).not.toHaveBeenCalled();

    answers['https://down.example'] = GNO;
    await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(checks.allows(GNO, 'https://down.example')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Answered: no more retries (the hourly re-check is next, at 60 min).
    const asked = ask.mock.calls.length;
    await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(ask).toHaveBeenCalledTimes(asked);
    checks.reset();
  });

  test('an answer holds for the process: the same pairs are not asked again; a new process asks', async () => {
    const ask = scriptedAsk({ 'https://a.example': ETH });
    const checks = new EndpointChecks({ ask });
    checks.sync([{ chainId: ETH, url: 'https://a.example' }]);
    await jest.advanceTimersByTimeAsync(0);
    checks.sync([{ chainId: ETH, url: 'https://a.example' }]);
    checks.sync([{ chainId: ETH, url: 'https://a.example' }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);

    checks.reset();
    expect(checks.allows(ETH, 'https://a.example')).toBe(false);
    checks.sync([{ chainId: ETH, url: 'https://a.example' }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
    checks.reset();
  });

  test('a pair no longer configured is forgotten, its retries with it', async () => {
    const ask = scriptedAsk({});
    const checks = new EndpointChecks({ ask });
    checks.sync([{ chainId: ETH, url: 'https://down.example' }]);
    await jest.advanceTimersByTimeAsync(0);
    checks.sync([]);
    await jest.advanceTimersByTimeAsync(RETRY_MAX_MS * 3);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test('the hourly re-check: an unchanged answer does nothing, a changed one is reported', async () => {
    const answers = { 'https://a.example': ETH };
    const ask = scriptedAsk(answers);
    const onChange = jest.fn();
    const checks = new EndpointChecks({ ask, onChange });
    checks.sync([{ chainId: ETH, url: 'https://a.example' }]);
    await jest.advanceTimersByTimeAsync(0);
    onChange.mockClear();

    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();

    // Repointed (a load balancer, say): it now serves another chain.
    answers['https://a.example'] = GNO;
    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(checks.allows(ETH, 'https://a.example')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A re-check that merely fails changes nothing.
    answers['https://a.example'] = null;
    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    expect(checks.answer(ETH, 'https://a.example')).toBe(GNO);
    expect(onChange).toHaveBeenCalledTimes(1);
    checks.reset();
  });

  test("a source being saved is asked; its answer stands for the pair once it's configured", async () => {
    const ask = scriptedAsk({ 'https://new.example': ETH });
    const checks = new EndpointChecks({ ask });
    await expect(checks.check(ETH, 'https://new.example')).resolves.toBe(ETH);
    checks.sync([{ chainId: ETH, url: 'https://new.example' }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(checks.allows(ETH, 'https://new.example')).toBe(true);

    // Editing it asks it again.
    await expect(checks.check(ETH, 'https://new.example')).resolves.toBe(ETH);
    expect(ask).toHaveBeenCalledTimes(2);
    checks.reset();
  });

  test('settled() waits for the first answers, up to its bound', async () => {
    let answer;
    const ask = scriptedAsk({
      'https://fast.example': ETH,
      'https://slow.example': () => new Promise((resolve) => (answer = resolve)),
    });
    const checks = new EndpointChecks({ ask });
    const all = [
      { chainId: ETH, url: 'https://fast.example' },
      { chainId: ETH, url: 'https://slow.example' },
    ];
    checks.sync(all);
    let done = false;
    checks.settled(all, 3000).then(() => (done = true));
    await jest.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(checks.allows(ETH, 'https://fast.example')).toBe(true);
    expect(checks.allows(ETH, 'https://slow.example')).toBe(false);
    answer(ETH);
    await jest.advanceTimersByTimeAsync(0);
    expect(checks.allows(ETH, 'https://slow.example')).toBe(true);
    checks.reset();
  });
});

describe('ChainConfig lists only endpoints that answered their chain', () => {
  const ENDPOINTS = {
    [ETH]: ['https://a.eth.example', 'https://b.eth.example', 'https://wrong.example'],
    [GNO]: ['https://slow.gno.example'],
  };
  const registry = (endpoints = ENDPOINTS) => ({
    getAllNetworks: () => ({ [ETH]: { name: 'Ethereum' }, [GNO]: { name: 'Gnosis' } }),
    getEndpoints: (chainId, role) => (role === 'rpc' ? (endpoints[chainId] ?? []) : []),
    getEndpointSources: () => [],
    getEndpointSourceList: () => [],
  });

  function fakeClient() {
    const client = new EventEmitter();
    client.snapshots = [];
    client.start = () => {
      client.current = { ended: false };
      client.hello = {};
      client.emit('ready', client.hello);
    };
    client.serves = (gen) => Boolean(gen) && gen === client.current;
    client.requestTo = jest.fn(async (_gen, method, params) => {
      if (method !== 'chain.configure') return {};
      client.snapshots.push({ at: Date.now(), params });
      return { generations: Object.fromEntries(params.chains.map((c) => [c.chain_id, 1])) };
    });
    return client;
  }

  /** The URLs each snapshot listed, by chain. */
  const listed = (config, client, index = -1) => {
    const { params } = client.snapshots.at(index);
    return Object.fromEntries(
      params.chains.map((chain) => [
        chain.chain_id,
        chain.rpc.map((entry) => config.endpoint(entry.endpoint)?.url),
      ])
    );
  };

  function setup(answers, endpoints) {
    const ask = scriptedAsk(answers);
    const checks = new EndpointChecks({ ask, log: { warn: jest.fn() } });
    const client = fakeClient();
    const sources = { registry: registry(endpoints), myotis: { NETWORKS: new Map() } };
    const config = new ChainConfig({ client, sources, log: { warn: jest.fn() }, checks });
    return { ask, checks, client, config, sources };
  }

  test('the first snapshot waits for the checks, up to 3 s, and lists only those that answered', async () => {
    let slow;
    const { client, config, checks } = setup({
      'https://a.eth.example': ETH,
      'https://b.eth.example': null, // down
      'https://wrong.example': GNO, // a builtin that serves another chain
      'https://slow.gno.example': () => new Promise((resolve) => (slow = resolve)),
    });
    const t0 = Date.now();
    client.start();
    await jest.advanceTimersByTimeAsync(STARTUP_CHECKS_MS - 1);
    expect(client.snapshots).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(client.snapshots).toHaveLength(1);
    expect(client.snapshots[0].at - t0).toBe(STARTUP_CHECKS_MS);
    expect(listed(config, client)).toEqual({ [ETH]: ['https://a.eth.example'], [GNO]: [] });

    // The slow endpoint answers: it joins, but not before a minute after
    // the last snapshot.
    slow(GNO);
    await jest.advanceTimersByTimeAsync(CHECKED_CONFIGURE_MS - 1);
    expect(client.snapshots).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(client.snapshots).toHaveLength(2);
    expect(listed(config, client)).toEqual({
      [ETH]: ['https://a.eth.example'],
      [GNO]: ['https://slow.gno.example'],
    });
    checks.reset();
  });

  test('when every check answers at once, the first snapshot goes at once', async () => {
    const { client, checks } = setup({
      'https://a.eth.example': ETH,
      'https://b.eth.example': ETH,
      'https://wrong.example': ETH,
      'https://slow.gno.example': GNO,
    });
    const t0 = Date.now();
    client.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.snapshots).toHaveLength(1);
    expect(client.snapshots[0].at).toBe(t0);
    checks.reset();
  });

  test('results join at most one chain.configure a minute', async () => {
    const answers = {
      'https://a.eth.example': ETH,
      'https://b.eth.example': null,
      'https://wrong.example': null,
      'https://slow.gno.example': null,
    };
    const { client, config, checks } = setup(answers);
    client.start();
    await jest.advanceTimersByTimeAsync(STARTUP_CHECKS_MS);
    expect(client.snapshots).toHaveLength(1);

    // Three endpoints answer at their 30 s retries: one configure, at 60 s.
    answers['https://b.eth.example'] = ETH;
    answers['https://wrong.example'] = ETH;
    answers['https://slow.gno.example'] = GNO;
    await jest.advanceTimersByTimeAsync(RETRY_FIRST_MS);
    expect(client.snapshots).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(CHECKED_CONFIGURE_MS - RETRY_FIRST_MS);
    expect(client.snapshots).toHaveLength(2);
    expect(listed(config, client)).toEqual({
      [ETH]: ['https://a.eth.example', 'https://b.eth.example', 'https://wrong.example'],
      [GNO]: ['https://slow.gno.example'],
    });
    await jest.advanceTimersByTimeAsync(CHECKED_CONFIGURE_MS * 5);
    expect(client.snapshots).toHaveLength(2);
    checks.reset();
  });

  test('a registry change that keeps a URL does not ask it again; one that adds a URL asks it', async () => {
    const endpoints = { [ETH]: ['https://a.eth.example'], [GNO]: [] };
    const answers = { 'https://a.eth.example': ETH, 'https://new.eth.example': ETH };
    const { ask, client, config, checks } = setup(answers, endpoints);
    client.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);

    await config.configure();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(listed(config, client)).toEqual({ [ETH]: ['https://a.eth.example'], [GNO]: [] });

    // A source added: it is out of the change's snapshot until it answers,
    // then joins.
    endpoints[ETH] = ['https://a.eth.example', 'https://new.eth.example'];
    await config.configure();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(listed(config, client)).toEqual({ [ETH]: ['https://a.eth.example'], [GNO]: [] });
    await jest.advanceTimersByTimeAsync(CHECKED_CONFIGURE_MS);
    expect(listed(config, client)).toEqual({
      [ETH]: ['https://a.eth.example', 'https://new.eth.example'],
      [GNO]: [],
    });
    checks.reset();
  });

  test('the hourly re-check: unchanged does nothing; a repointed endpoint leaves the next snapshot', async () => {
    const endpoints = { [ETH]: ['https://a.eth.example', 'https://b.eth.example'], [GNO]: [] };
    const answers = { 'https://a.eth.example': ETH, 'https://b.eth.example': ETH };
    const { ask, client, config, checks } = setup(answers, endpoints);
    client.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.snapshots).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    expect(ask).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(CHECKED_CONFIGURE_MS);
    expect(client.snapshots).toHaveLength(1);

    answers['https://b.eth.example'] = GNO;
    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    expect(ask).toHaveBeenCalledTimes(6);
    await jest.advanceTimersByTimeAsync(0);
    expect(client.snapshots).toHaveLength(2);
    expect(listed(config, client)).toEqual({ [ETH]: ['https://a.eth.example'], [GNO]: [] });
    checks.reset();
  });

  test('a new core process asks every endpoint again', async () => {
    const endpoints = { [ETH]: ['https://a.eth.example'], [GNO]: [] };
    const { ask, client, checks } = setup({ 'https://a.eth.example': ETH }, endpoints);
    client.start();
    await jest.advanceTimersByTimeAsync(0);
    client.emit('exit', {});
    client.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(client.snapshots).toHaveLength(2);
    checks.reset();
  });

  test("a source checked as it was saved joins the change's own snapshot", async () => {
    const endpoints = { [ETH]: ['https://a.eth.example'], [GNO]: [] };
    const answers = { 'https://a.eth.example': ETH, 'https://mine.example': ETH };
    const { ask, client, config, checks } = setup(answers, endpoints);
    client.start();
    await jest.advanceTimersByTimeAsync(0);

    await expect(config.checkEndpoint(ETH, 'https://mine.example')).resolves.toBe(ETH);
    endpoints[ETH] = ['https://mine.example', 'https://a.eth.example'];
    await config.configure();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(listed(config, client)).toEqual({
      [ETH]: ['https://mine.example', 'https://a.eth.example'],
      [GNO]: [],
    });
    checks.reset();
  });
});
