const { keccak256 } = require('ethers');
const {
  ChainDriver,
  TruncatedLogsError,
  SourceUnavailableError,
  rebuilt,
  wireChainId,
  endpointHost,
  DEADLINE_MS,
  WATCHDOG_MARGIN_MS,
  RESTARTED,
  UNAVAILABLE,
  DEADLINE,
  RECONFIGURED,
  TOO_LARGE,
} = require('./chain-driver');
const { BroadcastRecords } = require('./chain-broadcasts');
const { MAX_PAYLOAD } = require('./frame');

const RAW =
  '0xf85f8001825208941111111111111111111111111111111111111111018026a045df4733a45ed06c5628f22221a73e0b2faa3959f649cc47e6c2a15c9792ae07a00ea422e4923de6e5b4c52d7fbd39046e96acf73b2037a5f11918ec6c2a64b40a';
const HASH = '0xdff97f6d2d938656e056527357e2ee12f38c03923ab1d11bc556fb5cc123e578';

/** The core's reply to a chain request, under `generation`. */
const read = (result, extra = {}) => ({
  result,
  source: 'quorum',
  verified: true,
  undefined_keys: [],
  generation: 3,
  ...extra,
});
/** The core's error for a chain request. */
const coreError = (code, message, data) => Object.assign(new Error(message), { code, data });
const chainError = (data) =>
  coreError('chain_error', 'Chain request failed', {
    kind: 'node',
    constructor: 'Error',
    props: {},
    undefined_keys: [],
    generation: 3,
    ...data,
  });
const unavailable = () => coreError('core_unavailable', 'The core is not running');

/**
 * A driver over a fake client whose replies come from `answer`, and a fake
 * configuration: chain 1 at generation 3, chain 100 at 2; `controls` are
 * those in flight, each settled (and free to change generations) by the
 * barrier.
 */
function setUp(answer, { now = () => 0 } = {}) {
  const gen = { id: 'process' };
  const urls = new Map([
    ['c1', 'https://a.rpc.example:8545/v1/key'],
    ['c2', 'https://b.rpc.example'],
    ['c3', 'not a url'],
    ['p1', 'https://prover.example'],
  ]);
  const config = {
    core: { gen },
    generations: new Map([
      [1, 3],
      [100, 2],
    ]),
    controls: [],
    idle: jest.fn((of) => of === gen && config.controls.length === 0),
    whenServing: jest.fn(async () => {
      for (const settle of config.controls.splice(0)) settle();
      return config.core ? gen : null;
    }),
    overtaken: jest.fn((of, chainId, generation) => {
      const current = config.generations.get(chainId);
      return current === undefined ? generation !== 0 : generation < current;
    }),
    endpointUrl: jest.fn((ref, of) => (of === gen ? urls.get(ref) : undefined)),
  };
  const client = {
    whenReady: jest.fn(async () => ({})),
    serves: jest.fn((of) => of === gen && config.core !== null),
    requestTo: jest.fn(async (to, method, params, context, options) => {
      expect(to).toBe(gen);
      return answer(method, params, client.requestTo.mock.calls.length, options);
    }),
  };
  const broadcasts = new BroadcastRecords();
  const driver = new ChainDriver({ client, config, broadcasts, now });
  const sent = () => client.requestTo.mock.calls.map(([, method, params]) => [method, params]);
  return { driver, client, config, gen, broadcasts, sent };
}

describe('reads', () => {
  test("a read goes to the serving process with the router's options, by name", async () => {
    const { driver, client, sent } = setUp(() => read('0x1'));
    await driver.request(1, 'eth_call', [{ to: '0xabc', data: '0x12' }, 'latest'], {
      includeTrust: true,
      routingContext: { origin: ' https://swap.example ' },
      background: false,
    });
    await driver.request('100', 'eth_getLogs', [{}], { background: true, profile: 'ant_scan' });
    await driver.request(1, 'eth_blockNumber');
    // Not a string: no routing origin, as the router had none.
    await driver.request(1, 'eth_blockNumber', [], {
      routingContext: { origin: 7 },
      profile: 'other',
    });
    expect(sent()).toEqual([
      [
        'chain.request',
        {
          chain_id: 1,
          method: 'eth_call',
          params: [{ to: '0xabc', data: '0x12' }, 'latest'],
          include_trust: true,
          // As it is: the core normalizes it as the router did.
          origin: ' https://swap.example ',
          background: false,
          profile: 'default',
          deadline_ms: DEADLINE_MS,
        },
      ],
      [
        'chain.request',
        {
          chain_id: 100,
          method: 'eth_getLogs',
          params: [{}],
          include_trust: false,
          background: true,
          profile: 'ant_scan',
          deadline_ms: DEADLINE_MS,
        },
      ],
      [
        'chain.request',
        {
          chain_id: 1,
          method: 'eth_blockNumber',
          params: [],
          include_trust: false,
          background: false,
          profile: 'default',
          deadline_ms: DEADLINE_MS,
        },
      ],
      [
        'chain.request',
        {
          chain_id: 1,
          method: 'eth_blockNumber',
          params: [],
          include_trust: false,
          background: false,
          profile: 'default',
          deadline_ms: DEADLINE_MS,
        },
      ],
    ]);
    // The core's deadline and the watchdog's agree; chrome's context.
    const [, , , context, options] = client.requestTo.mock.calls[0];
    expect(context).toBeUndefined();
    expect(options).toEqual({ watchdogMs: DEADLINE_MS + WATCHDOG_MARGIN_MS, signal: undefined });
  });

  test('the result as the router returned it: an undefined `result` comes back first', async () => {
    const { driver } = setUp(() =>
      read(undefined, { source: 'direct', verified: false, undefined_keys: ['result'] })
    );
    const result = await driver.request(1, 'eth_call', [{}]);
    expect(Object.keys(result)).toEqual(['result', 'source', 'verified']);
    expect(Object.hasOwn(result, 'result')).toBe(true);
    expect(result.result).toBeUndefined();
    expect(result).not.toHaveProperty('generation');
  });

  test("trust labels name hosts where the router named them; '' dropped but for the prover", async () => {
    const { driver } = setUp((method, params, n) =>
      n === 1
        ? read('0x1', {
            trust: {
              level: 'verified',
              method: 'quorum',
              block: null,
              agreed: [{ ref: 'c1' }, { ref: 'c3' }, 'myotis-p2p'],
              dissented: [{ ref: 'c2' }, { ref: 'gone' }],
              queried: [{ ref: 'c1' }, { ref: 'c2' }, { ref: 'c3' }],
              quorum: { k: 3, m: 2, achieved: true },
              // Not where endpoints are named: data, left as it is.
              data: { ref: 'c1' },
            },
          })
        : read('0x1', {
            source: 'colibri',
            trust: {
              method: 'colibri',
              prover: { ref: n === 2 ? 'p1' : 'c3' },
              agreed: [{ ref: 'p1' }],
            },
          })
    );
    expect((await driver.request(1, 'eth_call', [{}], { includeTrust: true })).trust).toEqual({
      level: 'verified',
      method: 'quorum',
      block: null,
      agreed: ['a.rpc.example:8545', 'myotis-p2p'],
      dissented: ['b.rpc.example'],
      queried: ['a.rpc.example:8545', 'b.rpc.example'],
      quorum: { k: 3, m: 2, achieved: true },
      data: { ref: 'c1' },
    });
    expect((await driver.request(1, 'eth_call', [{}], { includeTrust: true })).trust).toEqual({
      method: 'colibri',
      prover: 'prover.example',
      agreed: ['prover.example'],
    });
    // A prover URL that doesn't parse keeps the router's ''.
    expect((await driver.request(1, 'eth_call', [{}], { includeTrust: true })).trust.prover).toBe(
      ''
    );
    expect(endpointHost('https://x.example:1/y')).toBe('x.example:1');
    expect(endpointHost(undefined)).toBe('');
  });

  test("the core's errors are thrown as the router threw them", async () => {
    const errors = [
      // A node's error: code and data own properties, an absent data
      // restored as undefined.
      chainError({
        message: 'execution reverted',
        props: { code: 3, data: '0x08c379a0' },
      }),
      chainError({
        message: 'nonce too low',
        props: { code: -32000, data: null },
        undefined_keys: ['data'],
      }),
      chainError({
        kind: 'core',
        constructor: 'TruncatedLogsError',
        message: 'query matched too many logs',
        props: { name: 'TruncatedLogsError', code: -32005 },
      }),
      chainError({
        kind: 'core',
        constructor: 'TypeError',
        message: "Cannot read properties of null (reading 'result')",
      }),
      coreError('deadline', "The chain request's deadline passed", { generation: 3 }),
      coreError('busy', 'Too many chain requests', { generation: 3 }),
    ];
    const { driver } = setUp((method, params, n) => {
      throw errors[n - 1];
    });
    const thrown = [];
    for (let i = 0; i < errors.length; i++) {
      thrown.push(await driver.request(1, 'eth_call', [{}]).catch((err) => err));
    }
    expect(thrown[0]).toBeInstanceOf(Error);
    expect(thrown[0].constructor).toBe(Error);
    expect(thrown[0].message).toBe('execution reverted');
    expect(Object.entries(thrown[0])).toEqual([
      ['code', 3],
      ['data', '0x08c379a0'],
    ]);
    expect(Object.entries(thrown[1])).toEqual([
      ['code', -32000],
      ['data', undefined],
    ]);
    expect(thrown[2]).toBeInstanceOf(TruncatedLogsError);
    expect(thrown[2].name).toBe('TruncatedLogsError');
    expect(Object.keys(thrown[2])).toEqual(['name', 'code']);
    expect(thrown[3]).toBeInstanceOf(TypeError);
    // 0001's codes: the core's text, no code a dApp would take for a node's.
    for (const [i, message] of [
      [4, DEADLINE],
      [5, 'Too many chain requests'],
    ]) {
      expect(thrown[i].constructor).toBe(Error);
      expect(thrown[i].message).toBe(message);
      expect(thrown[i]).not.toHaveProperty('code');
    }
  });

  test('a chain_error rebuilds its constructor, and an unknown one as Error', () => {
    const unavailable = rebuilt({
      constructor: 'SourceUnavailableError',
      message: 'Myotis is not ready',
      props: { name: 'SourceUnavailableError', failureKind: null },
      undefined_keys: [],
    });
    expect(unavailable).toBeInstanceOf(SourceUnavailableError);
    expect(Object.entries(unavailable)).toEqual([
      ['name', 'SourceUnavailableError'],
      ['failureKind', null],
    ]);
    expect(rebuilt({ constructor: 'Function', message: 'x' }).constructor).toBe(Error);
    expect(rebuilt({ message: 'x' }).constructor).toBe(Error);
    // A property that would be a setter is an own data property instead.
    const odd = rebuilt({ message: 'x', props: JSON.parse('{"__proto__":{"polluted":1}}') });
    expect(Object.getPrototypeOf(odd)).toBe(Error.prototype);
    expect(Object.hasOwn(odd, '__proto__')).toBe(true);
  });

  test('a chain ID is sent as the number the router looked up; anything else fails at once', async () => {
    const { driver, sent } = setUp(() => read('0x1'));
    expect([1, '100', 100.0, '0x64', 'abc', -1, 1.5, null].map(wireChainId)).toEqual([
      1,
      100,
      100,
      null,
      null,
      null,
      null,
      null,
    ]);
    await expect(driver.request('0x64', 'eth_blockNumber')).rejects.toThrow(
      'Unsupported chain ID: 0x64'
    );
    await expect(driver.feeQuote('abc')).rejects.toThrow('Unsupported chain ID: abc');
    await expect(driver.broadcast(null, RAW)).rejects.toMatchObject({
      message: 'Unsupported chain ID: null',
      outcome: 'not_sent',
    });
    expect(sent()).toEqual([]);
  });

  test('a request over one frame fails too_large before anything is sent', async () => {
    const { driver, sent } = setUp(() => read('0x1'));
    const data = `0x${'ab'.repeat(MAX_PAYLOAD / 2)}`;
    await expect(driver.request(1, 'eth_call', [{ to: '0xabc', data }])).rejects.toThrow(TOO_LARGE);
    await expect(driver.broadcast(1, data)).rejects.toMatchObject({
      message: TOO_LARGE,
      outcome: 'not_sent',
    });
    expect(sent()).toEqual([]);
    // Just under: sent.
    const fits = `0x${'ab'.repeat((MAX_PAYLOAD - 512) / 2)}`;
    await driver.request(1, 'eth_call', [{ to: '0xabc', data: fits }]);
    expect(sent()).toHaveLength(1);
  });
});

describe('fencing', () => {
  test('a read the configuration ended is sent again, once', async () => {
    const reconfigured = () => coreError('reconfigured', RECONFIGURED, { generation: 3 });
    const { driver, sent } = setUp((method, params, n) => {
      if (n === 1) throw reconfigured();
      return read('0x2', { generation: 4 });
    });
    expect((await driver.request(1, 'eth_blockNumber')).result).toBe('0x2');
    expect(sent()).toHaveLength(2);

    const twice = setUp(() => {
      throw reconfigured();
    });
    await expect(twice.driver.request(1, 'eth_blockNumber')).rejects.toThrow(RECONFIGURED);
    await expect(twice.driver.feeQuote(1)).rejects.toThrow(RECONFIGURED);
    expect(twice.sent()).toHaveLength(4);
  });

  test('a reply overtaken by a change main asked for meanwhile is judged after it, and sent again', async () => {
    let setUpResult;
    const answer = (method, params, n) => {
      const { config } = setUpResult;
      if (n === 1) {
        // A registry change while the read runs: the core reconfigures
        // after this reply was made.
        config.controls.push(() => config.generations.set(1, 4));
        return read('0xold', { generation: 3 });
      }
      return read('0xnew', { generation: 4 });
    };
    setUpResult = setUp(answer);
    const { driver, config, sent } = setUpResult;
    expect((await driver.request(1, 'eth_blockNumber')).result).toBe('0xnew');
    expect(sent()).toHaveLength(2);
    // Judged only with nothing in flight.
    expect(config.whenServing).toHaveBeenCalledTimes(3);
    expect(config.overtaken).toHaveBeenCalledWith(expect.anything(), 1, 3);
  });

  test("a change that leaves the reply's chain alone costs nothing", async () => {
    let setUpResult;
    setUpResult = setUp(() => {
      const { config } = setUpResult;
      config.controls.push(() => config.generations.set(100, 9));
      return read('0x1', { generation: 3 });
    });
    expect((await setUpResult.driver.request(1, 'eth_blockNumber')).result).toBe('0x1');
    expect(setUpResult.sent()).toHaveLength(1);
  });

  test('nothing is sent while a control is in flight: it goes first', async () => {
    let setUpResult;
    const order = [];
    setUpResult = setUp(() => {
      order.push('read');
      return read('0x1');
    });
    const { driver, config } = setUpResult;
    config.controls.push(() => order.push('control'));
    await driver.request(1, 'eth_blockNumber');
    expect(order).toEqual(['control', 'read']);
  });

  test('a fee quote is fenced too, and loses only its generation', async () => {
    const { driver } = setUp(() => ({
      type: 'eip1559',
      baseFee: '98',
      maxPriorityFeePerGas: '2',
      maxFeePerGas: '198',
      effectiveGasPrice: '100',
      source: 'myotis',
      verified: true,
      generation: 3,
    }));
    const quote = await driver.feeQuote(1);
    expect(Object.keys(quote)).toEqual([
      'type',
      'baseFee',
      'maxPriorityFeePerGas',
      'maxFeePerGas',
      'effectiveGasPrice',
      'source',
      'verified',
    ]);
  });
});

describe('deadlines and cancellation', () => {
  test("what is left of the caller's deadline goes with each attempt; none left, nothing goes", async () => {
    let clock = 0;
    let setUpResult;
    setUpResult = setUp(
      (method, params, n) => {
        clock += 50_000;
        if (n === 1) throw coreError('reconfigured', RECONFIGURED, { generation: 3 });
        return read('0x1');
      },
      { now: () => clock }
    );
    const { driver, sent } = setUpResult;
    await driver.request(1, 'eth_blockNumber');
    expect(sent().map(([, params]) => params.deadline_ms)).toEqual([
      DEADLINE_MS,
      DEADLINE_MS - 50_000,
    ]);

    clock = 0;
    const late = setUp(
      () => {
        clock += DEADLINE_MS;
        throw coreError('reconfigured', RECONFIGURED, { generation: 3 });
      },
      { now: () => clock }
    );
    await expect(late.driver.request(1, 'eth_blockNumber')).rejects.toThrow(DEADLINE);
    expect(late.sent()).toHaveLength(1);
  });

  test("a caller's abort throws its reason, before or after the request goes", async () => {
    const before = new AbortController();
    before.abort();
    const { driver, client, sent } = setUp((method, params, n, { signal }) => {
      // The client answers the caller at once on an abort.
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(coreError('cancelled', 'Cancelled')));
      });
    });
    await expect(driver.request(1, 'eth_blockNumber', [], { signal: before.signal })).rejects.toBe(
      before.signal.reason
    );
    expect(sent()).toEqual([]);
    const during = new AbortController();
    const pending = driver.request(1, 'eth_blockNumber', [], { signal: during.signal });
    await new Promise(setImmediate);
    expect(client.requestTo.mock.calls[0][4].signal).toBe(during.signal);
    during.abort();
    await expect(pending).rejects.toBe(during.signal.reason);
  });

  test('no core: unavailable; the core ending under a request: restarted, never resent', async () => {
    const { driver, config, sent } = setUp(() => {
      config.core = null;
      throw unavailable();
    });
    await expect(driver.request(1, 'eth_blockNumber')).rejects.toThrow(RESTARTED);
    expect(sent()).toHaveLength(1);
    await expect(driver.request(1, 'eth_blockNumber')).rejects.toThrow(UNAVAILABLE);
  });
});

describe('broadcasts', () => {
  test("sent is today's result; uncertain is too, marked; neither is fenced", async () => {
    let setUpResult;
    setUpResult = setUp((method, params, n, options) => {
      expect(method).toBe('chain.broadcast');
      expect(params).toEqual({ chain_id: 100, raw: RAW, deadline_ms: DEADLINE_MS });
      // A cancel waits for the outcome.
      expect(options.untilResponse).toBe(true);
      // A configuration change during the broadcast changes nothing.
      setUpResult.config.controls.push(() => setUpResult.config.generations.set(100, 9));
      return n === 1
        ? { hash: HASH, source: 'myotis', outcome: 'sent', generation: 2 }
        : { hash: HASH, source: 'direct', outcome: 'uncertain', generation: 2 };
    });
    const { driver, sent, broadcasts } = setUpResult;
    expect(await driver.broadcast(100, RAW)).toEqual({ result: HASH, source: 'myotis' });
    expect(await driver.broadcast(100, RAW)).toEqual({
      result: HASH,
      source: 'direct',
      outcome: 'uncertain',
    });
    expect(sent()).toHaveLength(2);
    expect(broadcasts.open.size).toBe(0);
  });

  test("rejected and not_sent throw today's error, tagged; never rejected without the core", async () => {
    const replies = [
      chainError({
        message: 'nonce too low',
        props: { code: -32000, data: null },
        outcome: 'rejected',
      }),
      chainError({
        kind: 'core',
        message: 'All transaction broadcasters failed (direct: No RPC endpoint configured)',
        outcome: 'not_sent',
      }),
      coreError('reconfigured', RECONFIGURED, { outcome: 'not_sent', generation: 2 }),
    ];
    const { driver, sent } = setUp((method, params, n) => {
      throw replies[n - 1];
    });
    const rejected = await driver.broadcast(100, RAW).catch((err) => err);
    expect(rejected).toMatchObject({ message: 'nonce too low', code: -32000, outcome: 'rejected' });
    const notSent = await driver.broadcast(100, RAW).catch((err) => err);
    expect(notSent).toMatchObject({ outcome: 'not_sent' });
    expect(notSent.message).toMatch(/^All transaction broadcasters failed/);
    // Not sent again.
    await expect(driver.broadcast(100, RAW)).rejects.toMatchObject({
      message: RECONFIGURED,
      outcome: 'not_sent',
    });
    expect(sent()).toHaveLength(3);
  });

  test('no reply from the core: uncertain once an executor started sending, not_sent otherwise', async () => {
    let setUpResult;
    setUpResult = setUp((method, params, n) => {
      // The executors saw the core's request for these bytes (any hex
      // case), then the core died.
      if (n === 1)
        setUpResult.broadcasts.sending(100, RAW.toUpperCase().replace('0X', '0x'), 'myotis');
      throw unavailable();
    });
    const { driver, broadcasts } = setUpResult;
    expect(await driver.broadcast(100, RAW)).toEqual({
      result: HASH,
      source: 'myotis',
      outcome: 'uncertain',
    });
    expect(keccak256(RAW)).toBe(HASH);
    await expect(driver.broadcast(100, RAW)).rejects.toMatchObject({
      message: RESTARTED,
      outcome: 'not_sent',
    });
    // A mark on another chain is no mark.
    expect(broadcasts.open.size).toBe(0);
  });

  test('a cancelled broadcast gives the outcome the core still answers', async () => {
    const controller = new AbortController();
    const outcomes = [
      { hash: HASH, source: 'direct', outcome: 'uncertain', generation: 2 },
      coreError('cancelled', 'Cancelled', { outcome: 'not_sent', generation: 2 }),
    ];
    const { driver } = setUp((method, params, n, { signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      if (n === 2) throw outcomes[1];
      return outcomes[0];
    });
    expect(await driver.broadcast(100, RAW, { signal: controller.signal })).toMatchObject({
      outcome: 'uncertain',
    });
    // Nothing sent: today's AbortError.
    await expect(driver.broadcast(100, RAW, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason
    );
  });

  test('a broadcast with no core is not sent', async () => {
    const { driver, config, sent } = setUp(() => ({}));
    config.core = null;
    await expect(driver.broadcast(100, RAW)).rejects.toMatchObject({
      message: UNAVAILABLE,
      outcome: 'not_sent',
    });
    expect(sent()).toEqual([]);
  });
});
