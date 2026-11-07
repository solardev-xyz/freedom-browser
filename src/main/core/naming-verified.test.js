const { ShellError } = require('./core-client');
const {
  registerNamingVerified,
  runVerified,
  MAX_PER_VERIFIER,
  MAX_REPLY_BYTES,
  ENVELOPE_BYTES,
} = require('./naming-verified');
const { encodeJsonFrame } = require('./frame');

const ADDRESS = '0x' + 'ab'.repeat(20);
const GEN = { generations: { lifecycle: 3 } };

function setUp(adapters = {}) {
  const handlers = new Map();
  const client = { handle: (method, fn) => handlers.set(method, fn) };
  const config = { generations: { ens: 1, tezos: 1, lifecycle: 3 } };
  const all = {
    myotisRecord: jest.fn(async () => ({ verified: false, blockNumber: null, status: 'ok' })),
    myotisCall: jest.fn(async () => ({ status: 'ok', resultHex: '0x01' })),
    myotisStatus: jest.fn(() => ({ optimisticBlockNumber: 21_000_000 })),
    ...adapters,
  };
  const { running } = registerNamingVerified(client, config, { adapters: all });
  const call = (params, signal = new AbortController().signal) =>
    Promise.resolve().then(() => handlers.get('shell.verified')({ ...GEN, ...params }, { signal }));
  return { call, adapters: all, running, config };
}

/** A Myotis reverse record: the operation the tests below run their
 * adapter's outcomes through. */
const REVERSE = { myotis: 'record', method: 'reverse', name: null, address: ADDRESS, coin_type: 60 };

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

  // Colibri 3.0.3 runs a lookup's eth_call on contract code from a public
  // RPC, unchecked against the proven code hash, so one of those RPCs could
  // choose the answer (#1076). A core that still asks for a Colibri
  // operation is refused, as for anything malformed, and no adapter runs.
  test('Colibri operations are refused: Colibri verifies no name (#1076)', async () => {
    const forged = {
      colibriResolve: jest.fn(async () => ({ resolvedData: '0x02', resolverAddress: ADDRESS })),
      colibriReverse: jest.fn(async () => ({ name: 'forged.eth' })),
    };
    const { call, adapters, running } = setUp(forged);
    for (const op of [
      ...['ur', 'name_nft', 'name_nft_reverse'].map((resolver) => ({
        colibri: 'resolve',
        name: 'alice.wei',
        call_data: '0xabcd',
        resolver,
      })),
      { colibri: 'reverse', address: ADDRESS, coin_type: 60 },
    ]) {
      await expect(call(op)).rejects.toMatchObject({ code: 'refused' });
    }
    expect(forged.colibriResolve).not.toHaveBeenCalled();
    expect(forged.colibriReverse).not.toHaveBeenCalled();
    expect(adapters.myotisRecord).not.toHaveBeenCalled();
    expect(running).toEqual({ myotis: 0, colibri: 0 });
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
      // Bytes as the core reads them, in either case of digit; an odd digit
      // or a capital 0X has no byte form, so it is a failure, never a reply
      // the core would refuse.
      [Object.assign(new Error('r'), { data: '0xABcd' }), { revert: '0xABcd' }],
      [Object.assign(new Error('r'), { data: '0x123' }), { failure: 'error' }],
      [{ info: { error: { code: -32000, data: '0x123' } } }, { failure: 'error' }],
      [Object.assign(new Error('r'), { data: '0X12' }), { failure: 'error' }],
      ['a string', { failure: 'error' }],
    ];
    for (const [err, expected] of cases) {
      const { call } = setUp({ myotisRecord: thrown(err) });
      expect(await call(REVERSE)).toEqual(expected);
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
    // Colibri's count, which chain data's operations use, is its own.
    expect(running.colibri).toBe(0);
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

  test('a reply whose response would not fit a frame is too_large, a revert too', async () => {
    // {"name":"…"} is 11 bytes besides the name; the response's envelope,
    // with the largest ID, counts too.
    const fits = 'a'.repeat(MAX_REPLY_BYTES - ENVELOPE_BYTES - 11);
    const framed = (result) =>
      encodeJsonFrame(JSON.stringify({ type: 'response', id: Number.MAX_SAFE_INTEGER, result }));
    expect(() => framed({ name: fits })).not.toThrow();
    expect(() => framed({ name: `${fits}a` })).toThrow();
    for (const [name, expected] of [
      [fits, { name: fits }],
      [`${fits}a`, { failure: 'too_large' }],
      // Escaped as it is sent: 6 bytes each.
      ['\u0001'.repeat(MAX_REPLY_BYTES / 6), { failure: 'too_large' }],
      // In UTF-8 bytes: 2 each.
      ['é'.repeat(MAX_REPLY_BYTES / 2), { failure: 'too_large' }],
    ]) {
      const { call } = setUp({ myotisRecord: jest.fn(async () => ({ name })) });
      expect(await call(REVERSE)).toEqual(expected);
    }
    const revert = `0x${'00'.repeat(MAX_REPLY_BYTES / 2)}`;
    const { call } = setUp({
      myotisRecord: jest.fn(async () =>
        Promise.reject(Object.assign(new Error('r'), { data: revert }))
      ),
    });
    expect(await call(REVERSE)).toEqual({
      failure: 'too_large',
    });
  });

  test('a large revert is checked in constant stack, even on the slow regexp path', () => {
    // V8's unoptimized regexp tier backtracks on the stack: run the executor
    // there with a 2 MB revert, which must come out too_large, not throw.
    const { execFileSync } = require('child_process');
    const script = `
      const { registerNamingVerified } = require(${JSON.stringify(require.resolve('./naming-verified'))});
      const handlers = new Map();
      registerNamingVerified({ handle: (m, fn) => handlers.set(m, fn) }, { generations: { lifecycle: 0 } }, {
        adapters: {
          myotisRecord: async () => {
            throw Object.assign(new Error('r'), { data: '0x' + 'ab'.repeat(2_000_000) });
          },
        },
      });
      handlers.get('shell.verified')(
        { myotis: 'record', method: 'reverse', address: '0x' + 'ab'.repeat(20), coin_type: 60, generations: { lifecycle: 0 } },
        { signal: new AbortController().signal }
      ).then((r) => process.stdout.write(JSON.stringify(r)), (e) => process.stdout.write('threw ' + e.name));
    `;
    const out = execFileSync(process.execPath, ['--no-regexp-optimization', '-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(JSON.parse(out)).toEqual({ failure: 'too_large' });
  });

  test('a result JSON cannot carry is an error', async () => {
    const { call } = setUp({ myotisRecord: jest.fn(async () => ({ name: 1n })) });
    expect(await call(REVERSE)).toEqual({
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
    for (const fn of ['myotisRecord', 'myotisCall']) {
      expect(adapters[fn]).not.toHaveBeenCalled();
    }
  });

  test("the deadline is timeout, the operation runs on; a cancel is the core's", async () => {
    const myotis = held();
    const { call, running } = setUp({ myotisRecord: myotis.fn });
    const op = REVERSE;
    const timedOut = await call({ ...op, deadline_ms: 5 }).catch((e) => e);
    expect(timedOut).toBeInstanceOf(ShellError);
    expect(timedOut.code).toBe('timeout');
    expect(running.myotis).toBe(1);
    myotis.releases[0].reject(new Error('late'));
    await tick();
    expect(running.myotis).toBe(0);
    const cancel = new AbortController();
    cancel.abort();
    const cancelled = await call(op, cancel.signal).catch((e) => e);
    expect(cancelled).not.toBeInstanceOf(ShellError);
  });
});

// PRIVATE MODE GUARD (Colibri store, #1058): Colibri keeps a private window's
// reads in memory when its async context says private. The core's request
// names no window; the client's `private` (service-client.js forPrivate)
// does, and `runVerified` sets the context from it. Naming has no Colibri
// operation (#1076): chain data's executor is the one that runs Colibri reads
// through `runVerified` (chain-verified.test.js drives it end to end).
describe('private windows', () => {
  const logContext = require('../private/private-log-context');
  const { isPrivateLogContext, runWithPrivateLogContext } = logContext;

  // A verifier step that records the context it ran in.
  function observed() {
    const seen = [];
    const live = [];
    const run = jest.fn(async () => {
      seen.push(isPrivateLogContext());
      live.push(logContext.privateSessionLive());
      return 'answer';
    });
    return { seen, live, run };
  }

  test('a Colibri read runs in the context the request may serve', async () => {
    const { seen, run } = observed();
    await expect(runVerified('colibri', run, { private: true })).resolves.toBe('answer');
    await runVerified('colibri', run, { private: false });
    // A handler running in a private context (the one the core process was
    // started from) still runs a normal request's read as normal.
    await runWithPrivateLogContext(true, () => runVerified('colibri', run, { private: false }));
    expect(seen).toEqual([true, false, false]);
  });

  test('a request whose private-ness is unknown counts as private', async () => {
    const { seen, run } = observed();
    await runVerified('colibri', run, {});
    await runVerified('colibri', run, undefined);
    expect(seen).toEqual([true, true]);
  });

  // Codex review of #1071, finding 2: the read carries the private session
  // the request was sent in, so Colibri can refuse an ended one.
  test('a Colibri read carries the private session it was sent in', async () => {
    const { live, run } = observed();
    logContext.openPrivateSession();
    const session = runWithPrivateLogContext(true, () => logContext.privateContextSession());
    await runVerified('colibri', run, { private: true, privateSession: session });
    await runVerified('colibri', run, { private: true, privateSession: null });
    await runVerified('colibri', run, { private: true });
    logContext.endPrivateSession();
    await runVerified('colibri', run, { private: true, privateSession: session });
    expect(live).toEqual([true, false, false, false]);
  });

  test('a Myotis step is left as it was', async () => {
    const { seen, run } = observed();
    await runVerified('myotis', run, { private: true });
    expect(seen).toEqual([false]);
  });

  function setUpSeen() {
    const seen = [];
    const record = (answer) => jest.fn(async () => {
      seen.push(isPrivateLogContext());
      return answer;
    });
    const forged = {
      colibriResolve: record({ resolvedData: '0x02', resolverAddress: ADDRESS }),
      colibriReverse: record({ name: 'forged.eth' }),
    };
    const handlers = new Map();
    const client = { handle: (method, fn) => handlers.set(method, fn) };
    const config = { generations: { ens: 1, tezos: 1, lifecycle: 3 } };
    const { running } = registerNamingVerified(client, config, {
      adapters: {
        myotisRecord: record({ verified: false, blockNumber: null, status: 'ok' }),
        myotisCall: jest.fn(),
        myotisStatus: jest.fn(() => ({})),
        ...forged,
        callResolver: () => 'ur',
      },
    });
    const call = (params, extra) =>
      Promise.resolve().then(() =>
        handlers.get('shell.verified')(
          { ...GEN, ...params },
          { signal: new AbortController().signal, ...extra }
        )
      );
    return { seen, call, forged, running };
  }

  // #1076 in a private window too: the old Colibri operations are refused
  // before any adapter runs, whatever the request's private-ness.
  test.each([
    ['resolve', { colibri: 'resolve', name: 'secret.eth', call_data: '0x', resolver: 'ur' }],
    ['reverse', { colibri: 'reverse', address: ADDRESS, coin_type: 60 }],
  ])('a Colibri %s is refused, private or not', async (_label, params) => {
    const { seen, call, forged, running } = setUpSeen();
    logContext.openPrivateSession();
    const session = runWithPrivateLogContext(true, () => logContext.privateContextSession());
    for (const extra of [{ private: true, privateSession: session }, { private: false }, {}]) {
      await expect(call(params, extra)).rejects.toMatchObject({ code: 'refused' });
    }
    logContext.endPrivateSession();
    expect(forged.colibriResolve).not.toHaveBeenCalled();
    expect(forged.colibriReverse).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(running).toEqual({ myotis: 0, colibri: 0 });
  });

  test('a Myotis operation is left as it was', async () => {
    const { seen, call } = setUpSeen();
    await call({ myotis: 'record', method: 'contenthash', name: 'a.eth', coin_type: 60 }, {
      private: true,
    });
    expect(seen).toEqual([false]);
  });
});
