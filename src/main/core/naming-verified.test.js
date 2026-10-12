const { ShellError } = require('./core-client');
const { registerNamingVerified, MAX_PER_VERIFIER, MAX_REPLY_BYTES } = require('./naming-verified');

const ADDRESS = '0x' + 'ab'.repeat(20);
const GEN = { generations: { lifecycle: 3 } };

function setUp(adapters = {}) {
  const handlers = new Map();
  const client = { handle: (method, fn) => handlers.set(method, fn) };
  const config = { generations: { ens: 1, tezos: 1, lifecycle: 3 } };
  const resolvers = { ur: () => 'ur', name_nft: () => 'nft', name_nft_reverse: () => 'nftr' };
  const all = {
    myotisRecord: jest.fn(async () => ({ verified: false, blockNumber: null, status: 'ok' })),
    myotisCall: jest.fn(async () => ({ status: 'ok', resultHex: '0x01' })),
    myotisStatus: jest.fn(() => ({ optimisticBlockNumber: 21_000_000 })),
    colibriResolve: jest.fn(async () => ({ resolvedData: '0x02', resolverAddress: ADDRESS })),
    colibriReverse: jest.fn(async () => ({ name: 'vitalik.eth' })),
    callResolver: (name) => resolvers[name],
    ...adapters,
  };
  const { running } = registerNamingVerified(client, config, { adapters: all });
  const call = (params, signal = new AbortController().signal) =>
    Promise.resolve().then(() => handlers.get('shell.verified')({ ...GEN, ...params }, { signal }));
  return { call, adapters: all, resolvers, running, config };
}

/** An adapter call that waits until released. */
function held() {
  const releases = [];
  const fn = jest.fn(
    () =>
      new Promise((resolve, reject) => {
        releases.push({ resolve, reject });
      })
  );
  return { fn, releases };
}

const tick = () => new Promise(setImmediate);

describe('shell.verified', () => {
  test("a Myotis record runs today's adapter, its keys in snake_case", async () => {
    const { call, adapters } = setUp({
      myotisRecord: jest.fn(async () => ({
        verified: false,
        blockNumber: null,
        status: 'ok',
        dataHex: '0xe301',
      })),
    });
    const reply = await call({
      myotis: 'record',
      method: 'contenthash',
      name: 'vitalik.eth',
      address: null,
      coin_type: 60,
    });
    expect(adapters.myotisRecord).toHaveBeenCalledWith({
      method: 'contenthash',
      name: 'vitalik.eth',
      coinType: 60n,
    });
    expect(reply).toEqual({
      verified: false,
      block_number: null,
      status: 'ok',
      data_hex: '0xe301',
    });
  });

  test('a Myotis reverse record passes the address; an undefined name is left out', async () => {
    const { call, adapters } = setUp({
      myotisRecord: jest.fn(async () => ({
        verified: false,
        blockNumber: null,
        status: 'noRecord',
        name: undefined,
      })),
    });
    const reply = await call({
      myotis: 'record',
      method: 'reverse',
      name: null,
      address: ADDRESS,
      coin_type: 2147483658,
    });
    expect(adapters.myotisRecord).toHaveBeenCalledWith({
      method: 'reverse',
      addressHex: ADDRESS,
      coinType: 2147483658n,
    });
    expect(JSON.parse(JSON.stringify(reply))).toEqual({
      verified: false,
      block_number: null,
      status: 'noRecord',
    });
  });

  test('a Myotis call answers its result and the optimistic block read after it', async () => {
    const order = [];
    const { call, adapters } = setUp({
      myotisCall: jest.fn(async () => {
        order.push('call');
        return { status: 'ok', resultHex: '0x0a' };
      }),
      myotisStatus: jest.fn(() => {
        order.push('status');
        return { optimisticBlockNumber: 7 };
      }),
    });
    expect(await call({ myotis: 'call', to: ADDRESS, data: '0x1234' })).toEqual({
      result_hex: '0x0a',
      optimistic_block_number: 7,
    });
    expect(adapters.myotisCall).toHaveBeenCalledWith({
      to: ADDRESS,
      data: '0x1234',
      block: 'latest',
    });
    expect(order).toEqual(['call', 'status']);
  });

  test("a Myotis call that isn't ok with data is an error; no status is a null block", async () => {
    for (const rec of [
      { status: 'revert', dataHex: '0x08c379a0' },
      { status: 'ok' },
      { status: 'ok', resultHex: '0x01', error: 'x' },
      { status: 'error' },
      null,
    ]) {
      const { call } = setUp({ myotisCall: jest.fn(async () => rec) });
      expect(await call({ myotis: 'call', to: ADDRESS, data: '0x' })).toEqual({ failure: 'error' });
    }
    const { call } = setUp({ myotisStatus: jest.fn(() => null) });
    expect(await call({ myotis: 'call', to: ADDRESS, data: '0x' })).toEqual({
      result_hex: '0x01',
      optimistic_block_number: null,
    });
  });

  test('a Colibri resolve takes the call resolver it names', async () => {
    const { call, adapters, resolvers } = setUp();
    for (const resolver of ['ur', 'name_nft', 'name_nft_reverse']) {
      expect(
        await call({ colibri: 'resolve', name: 'alice.wei', call_data: '0xabcd', resolver })
      ).toEqual({ resolved_data: '0x02', resolver_address: ADDRESS });
      expect(adapters.colibriResolve).toHaveBeenLastCalledWith(
        'alice.wei',
        '0xabcd',
        resolvers[resolver]
      );
    }
  });

  test('a Colibri reverse takes the address as bytes and the coin type', async () => {
    const { call, adapters } = setUp();
    expect(await call({ colibri: 'reverse', address: ADDRESS, coin_type: 60 })).toEqual({
      name: 'vitalik.eth',
    });
    const [bytes, coin] = adapters.colibriReverse.mock.calls[0];
    expect(Buffer.from(bytes).toString('hex')).toBe('ab'.repeat(20));
    expect(coin).toBe(60n);
  });

  test('an error is its revert data, or its class: never its text', async () => {
    const thrown = (err) => jest.fn(async () => Promise.reject(err));
    const cases = [
      [
        Object.assign(new Error('execution reverted'), { data: '0x7199966d' }),
        { revert: '0x7199966d' },
      ],
      [{ info: { error: { data: '0xef9c03ce' } } }, { revert: '0xef9c03ce' }],
      [
        Object.assign(new Error('Myotis state changed'), { code: 'MYOTIS_UNAVAILABLE' }),
        { failure: 'lifecycle' },
      ],
      [Object.assign(new Error('timeout'), { code: 'TIMEOUT' }), { failure: 'timeout' }],
      [
        Object.assign(new Error('label too long'), { code: 'INVALID_ARGUMENT' }),
        { failure: 'invalid_argument' },
      ],
      [new Error('https://secret@prover.example failed'), { failure: 'error' }],
      [Object.assign(new Error('not hex'), { data: 'reverted' }), { failure: 'error' }],
      ['a string', { failure: 'error' }],
    ];
    for (const [err, expected] of cases) {
      const { call } = setUp({ colibriReverse: thrown(err) });
      expect(await call({ colibri: 'reverse', address: ADDRESS, coin_type: 60 })).toEqual(expected);
    }
  });

  test('at most 8 operations run per verifier, counted until they settle', async () => {
    const myotis = held();
    const { call, running } = setUp({ myotisCall: myotis.fn });
    const op = { myotis: 'call', to: ADDRESS, data: '0x' };
    const cancels = [];
    const pending = [];
    for (let i = 0; i < MAX_PER_VERIFIER; i++) {
      const cancel = new AbortController();
      cancels.push(cancel);
      pending.push(call(op, cancel.signal).catch((e) => e));
    }
    await tick();
    expect(running.myotis).toBe(MAX_PER_VERIFIER);
    expect(await call(op)).toEqual({ failure: 'unavailable' });
    expect(myotis.fn).toHaveBeenCalledTimes(MAX_PER_VERIFIER);
    // The other verifier is its own.
    expect(await call({ colibri: 'reverse', address: ADDRESS, coin_type: 60 })).toEqual({
      name: 'vitalik.eth',
    });
    // Cancelled, they still count until the adapter settles.
    cancels.forEach((c) => c.abort());
    const errors = await Promise.all(pending);
    expect(errors.every((e) => e?.name === 'AbortError')).toBe(true);
    expect(await call(op)).toEqual({ failure: 'unavailable' });
    myotis.releases[0].resolve({ status: 'ok', resultHex: '0x' });
    await tick();
    expect(running.myotis).toBe(MAX_PER_VERIFIER - 1);
    const next = call(op);
    await tick();
    myotis.releases[MAX_PER_VERIFIER].resolve({ status: 'ok', resultHex: '0x05' });
    expect(await next).toEqual({ result_hex: '0x05', optimistic_block_number: 21_000_000 });
  });

  test('a reply over 1 MiB serialized is too_large, a revert too', async () => {
    // {"name":"…"} is 11 bytes besides the name.
    const fits = 'a'.repeat(MAX_REPLY_BYTES - 11);
    for (const [name, expected] of [
      [fits, { name: fits }],
      [`${fits}a`, { failure: 'too_large' }],
      // Escaped as it is sent: 6 bytes each.
      ['\u0001'.repeat(MAX_REPLY_BYTES / 6), { failure: 'too_large' }],
      // In UTF-8 bytes: 2 each.
      ['é'.repeat(MAX_REPLY_BYTES / 2), { failure: 'too_large' }],
    ]) {
      const { call } = setUp({ colibriReverse: jest.fn(async () => ({ name })) });
      expect(await call({ colibri: 'reverse', address: ADDRESS, coin_type: 60 })).toEqual(expected);
    }
    const revert = `0x${'00'.repeat(MAX_REPLY_BYTES / 2)}`;
    const { call } = setUp({
      colibriReverse: jest.fn(async () =>
        Promise.reject(Object.assign(new Error('r'), { data: revert }))
      ),
    });
    expect(await call({ colibri: 'reverse', address: ADDRESS, coin_type: 60 })).toEqual({
      failure: 'too_large',
    });
  });

  test('a result JSON cannot carry is an error', async () => {
    const { call } = setUp({ colibriReverse: jest.fn(async () => ({ name: 1n })) });
    expect(await call({ colibri: 'reverse', address: ADDRESS, coin_type: 60 })).toEqual({
      failure: 'error',
    });
  });

  test('an older lifecycle generation is stale; malformed operations are refused', async () => {
    const { call, adapters } = setUp();
    await expect(
      call({ myotis: 'call', to: ADDRESS, data: '0x', generations: { lifecycle: 2 } })
    ).rejects.toMatchObject({ code: 'stale_generation' });
    await expect(
      call({ myotis: 'call', to: ADDRESS, data: '0x', generations: {} })
    ).rejects.toMatchObject({ code: 'stale_generation' });
    for (const op of [
      {},
      { myotis: 'other' },
      { myotis: 'record', method: 'text', name: 'a.eth', coin_type: 60 },
      { myotis: 'record', method: 'addr', name: 5, coin_type: 60 },
      { myotis: 'record', method: 'reverse', address: '0x12', coin_type: 60 },
      { myotis: 'record', method: 'addr', name: 'a.eth', coin_type: -1 },
      { myotis: 'record', method: 'addr', name: 'a.eth', coin_type: 2 ** 53 },
      { myotis: 'record', method: 'addr', name: 'a.eth', coin_type: '60' },
      { myotis: 'call', to: ADDRESS, data: '0x123' },
      { myotis: 'call', to: 'vitalik.eth', data: '0x' },
      { colibri: 'resolve', name: 'a.eth', call_data: '0x', resolver: 'other' },
      { colibri: 'resolve', name: 'a.eth', call_data: 'zz', resolver: 'ur' },
      { colibri: 'resolve', name: null, call_data: '0x', resolver: 'ur' },
      { colibri: 'reverse', address: ADDRESS },
      { colibri: 'reverse', address: 'x', coin_type: 60 },
    ]) {
      await expect(call(op)).rejects.toMatchObject({ code: 'refused' });
    }
    for (const fn of ['myotisRecord', 'myotisCall', 'colibriResolve', 'colibriReverse']) {
      expect(adapters[fn]).not.toHaveBeenCalled();
    }
  });

  test("the deadline is timeout, the operation runs on; a cancel is the core's", async () => {
    const colibri = held();
    const { call, running } = setUp({ colibriReverse: colibri.fn });
    const op = { colibri: 'reverse', address: ADDRESS, coin_type: 60 };
    const timedOut = await call({ ...op, deadline_ms: 5 }).catch((e) => e);
    expect(timedOut).toBeInstanceOf(ShellError);
    expect(timedOut.code).toBe('timeout');
    expect(running.colibri).toBe(1);
    colibri.releases[0].reject(new Error('late'));
    await tick();
    expect(running.colibri).toBe(0);
    const cancel = new AbortController();
    cancel.abort();
    const cancelled = await call(op, cancel.signal).catch((e) => e);
    expect(cancelled).not.toBeInstanceOf(ShellError);
  });
});
