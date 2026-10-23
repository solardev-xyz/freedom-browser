const { ShellError } = require('./core-client');
const {
  registerChainVerified,
  myotisClass,
  wirePayload,
  isColibriFault,
} = require('./chain-verified');
const { registerNamingVerified, MAX_PER_VERIFIER } = require('./naming-verified');
const { NOT_SENT } = require('./chain-shell');
const { BroadcastRecords } = require('./chain-broadcasts');
const { MAX_MESSAGE } = require('./frame');

const ADDRESS = '0x' + 'ab'.repeat(20);
const RAW = '0xf86b80';
const HASH = '0x' + 'cd'.repeat(32);
const NBSP = String.fromCharCode(0xa0);
const tick = () => new Promise(setImmediate);

/** The adapters' own errors, as the replay harness makes them
 * (myotis-manager.js, myotis-process.js). */
const MYOTIS_ERRORS = {
  not_running: () => new Error('Gnosis Myotis client is not running'),
  not_ready: () => new Error('Ethereum Myotis verified reader is not ready'),
  state_changed: () => unavailable('Myotis state changed while the request was running'),
  queue_full: () => unavailable('Myotis request queue is full'),
  queue_deadline: () => unavailable('Myotis queue deadline exceeded'),
  caller_deadline: () => unavailable('Myotis caller deadline exceeded'),
};
function unavailable(message) {
  return Object.assign(new Error(message), { code: 'MYOTIS_UNAVAILABLE' });
}
function uncertain(message) {
  return Object.assign(new Error(message), { code: 'MYOTIS_BROADCAST_UNCERTAIN' });
}

/** The executor on a client that records its registration and holds the
 * core's `hello` (none by default); chain 1 at generation 4. `call` runs it
 * as the client does, `charge` standing in for main's pool. */
function setUp(adapters = {}, { charge = () => true, running, broadcasts, hello = null } = {}) {
  const routes = [];
  const client = { hello, handle: (method, fn, options) => routes.push({ method, fn, options }) };
  const config = { generation: (chainId) => (chainId === 1 ? 4 : 0) };
  const all = {
    myotisStatus: jest.fn(() => ({ optimisticBlockNumber: 21_000_000 })),
    myotisAccount: jest.fn(async () => ({ verifyMethod: 'proof', balanceWei: '5', nonce: 1 })),
    myotisCode: jest.fn(async () => ({ verifyMethod: 'proof', codeHex: '0x60' })),
    myotisStorage: jest.fn(async () => ({ verifyMethod: 'proof', valueHex: '0x1' })),
    myotisCallTx: jest.fn(async () => ({ status: 'ok', resultHex: '0x01' })),
    myotisEstimateTx: jest.fn(async () => ({ status: 'ok', gas: 21000 })),
    myotisFee: jest.fn(async () => ({ gasPriceWei: '7', maxPriorityFeePerGasWei: '1' })),
    myotisBroadcast: jest.fn(async () => ({ txHash: HASH })),
    colibriRequest: jest.fn(async () => '0x10'),
    ...adapters,
  };
  const registered = registerChainVerified(client, config, {
    adapters: all,
    running,
    broadcasts,
  });
  const route = routes.find((r) => r.method === 'shell.verified');
  const call = (params, signal = new AbortController().signal) => {
    const full = { chain_id: 1, generation: 4, ...params };
    expect(route.options.when(full)).toBe(true);
    return Promise.resolve().then(() => route.fn(full, { signal, charge }));
  };
  return { call, adapters: all, running: registered.running, routes };
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

const failure = (pending) =>
  pending.then(
    (result) => ({ result }),
    (err) => (err instanceof ShellError ? err.code : err)
  );

describe('Myotis reads', () => {
  test.each([
    ['account', { address: ADDRESS }, 'myotisAccount', [ADDRESS, 1]],
    ['code', { address: ADDRESS }, 'myotisCode', [ADDRESS, 1]],
    ['storage', { address: ADDRESS, slot: '0x0' }, 'myotisStorage', [ADDRESS, '0x0', 1]],
    [
      'call_tx',
      { tx: { to: ADDRESS } },
      'myotisCallTx',
      [{ chainId: 1, tx: { to: ADDRESS }, block: 'latest' }],
    ],
    ['estimate_tx', { tx: {} }, 'myotisEstimateTx', [{ chainId: 1, tx: {}, block: 'latest' }]],
    ['fee', {}, 'myotisFee', [1]],
  ])("%s runs today's adapter, whole", async (op, args, adapter, expected) => {
    const { call, adapters } = setUp();
    const reply = await call({ myotis: op, ...args });
    expect(adapters[adapter]).toHaveBeenCalledWith(...expected);
    expect(Object.keys(reply)).toEqual(['payload', 'block_before', 'block_after']);
    expect(reply.block_before).toBe(op === 'fee' ? null : 21_000_000);
  });

  test("the payload's own keys in snake_case, in its order; the head before and after", async () => {
    const status = jest
      .fn()
      .mockReturnValueOnce({ optimisticBlockNumber: 7 })
      .mockReturnValueOnce({ optimisticBlockNumber: 8 });
    const { call } = setUp({
      myotisStatus: status,
      myotisAccount: jest.fn(async () => ({
        status: 'ok',
        verifyMethod: 'proof',
        balanceWei: '5',
        maxPriorityFeePerGasWei: '1',
        nested: { codeHex: '0x' },
      })),
    });
    const reply = await call({ myotis: 'account', address: ADDRESS });
    expect(reply).toEqual({
      payload: {
        status: 'ok',
        verify_method: 'proof',
        balance_wei: '5',
        max_priority_fee_per_gas_wei: '1',
        nested: { codeHex: '0x' },
      },
      block_before: 7,
      block_after: 8,
    });
    expect(Object.keys(reply.payload)).toEqual([
      'status',
      'verify_method',
      'balance_wei',
      'max_priority_fee_per_gas_wei',
      'nested',
    ]);
    expect(status).toHaveBeenCalledWith(1);
  });

  test('an absent address is left out, and no status or payload is null', async () => {
    const { call, adapters } = setUp({
      myotisStatus: jest.fn(() => null),
      myotisCode: jest.fn(async () => undefined),
    });
    expect(await call({ myotis: 'code' })).toEqual({
      payload: null,
      block_before: null,
      block_after: null,
    });
    expect(adapters.myotisCode).toHaveBeenCalledWith(undefined, 1);
  });

  test('wirePayload leaves what is not an object as it is', () => {
    expect(wirePayload('0x1')).toBe('0x1');
    expect(wirePayload([{ codeHex: 1 }])).toEqual([{ codeHex: 1 }]);
    expect(wirePayload(null)).toBeNull();
    // An own __proto__ key stays a key.
    const payload = JSON.parse('{"__proto__":{"x":1},"dataHex":"0x"}');
    const wired = wirePayload(payload);
    expect(Object.keys(wired)).toEqual(['__proto__', 'data_hex']);
    expect(Object.getPrototypeOf(wired)).toBe(Object.prototype);
  });

  test.each(Object.keys(MYOTIS_ERRORS))('the adapter error %s is its class', async (name) => {
    const { call } = setUp({
      myotisAccount: jest.fn(async () => Promise.reject(MYOTIS_ERRORS[name]())),
    });
    expect(await call({ myotis: 'account', address: ADDRESS })).toEqual({ failure: name });
  });

  test.each([
    ['another MYOTIS_UNAVAILABLE', unavailable('Myotis native operation failed')],
    ['a stopped client', unavailable('Myotis stopped')],
    ['an unsupported chain', new Error('Unsupported Myotis chain ID: 5')],
    ['a near miss', new Error('Myotis client is not running')],
    [
      'a coded near miss',
      Object.assign(new Error('Ethereum Myotis client is not running'), { code: 'X' }),
    ],
    ['a TypeError', new TypeError("Cannot read properties of undefined (reading 'x')")],
    ['a string', 'boom'],
  ])('%s is error, its text not forwarded', async (_name, thrown) => {
    const { call } = setUp({ myotisFee: jest.fn(async () => Promise.reject(thrown)) });
    expect(await call({ myotis: 'fee' })).toEqual({ failure: 'error' });
  });

  test("a status sample that throws fails the read, as in the router's trust read", async () => {
    const { call, adapters } = setUp({
      myotisStatus: jest.fn(() => {
        throw new Error('native binding');
      }),
    });
    expect(await call({ myotis: 'account', address: ADDRESS })).toEqual({ failure: 'error' });
    expect(adapters.myotisAccount).not.toHaveBeenCalled();
    expect(myotisClass(undefined)).toBe('error');
  });

  // Review of #692 (parity): the router's fee quote reads the estimate
  // with no status sample around it.
  test('a fee estimate takes no status sample', async () => {
    const { call, adapters } = setUp({
      myotisStatus: jest.fn(() => {
        throw new Error('native binding');
      }),
    });
    expect(await call({ myotis: 'fee' })).toEqual({
      payload: { gas_price_wei: '7', max_priority_fee_per_gas_wei: '1' },
      block_before: null,
      block_after: null,
    });
    expect(adapters.myotisStatus).not.toHaveBeenCalled();
  });
});

describe('Myotis broadcasts', () => {
  test('a hash, as the client answered it', async () => {
    for (const answer of [{ txHash: HASH }, { result: HASH }, { txHash: HASH, result: 'other' }]) {
      const { call, adapters } = setUp({ myotisBroadcast: jest.fn(async () => answer) });
      expect(await call({ myotis: 'broadcast', raw: RAW })).toEqual({ hash: HASH });
      expect(adapters.myotisBroadcast).toHaveBeenCalledWith(RAW, 1);
    }
  });

  // Design 0005, Main's record.
  test("a broadcast marks main's record of its bytes as the adapter starts; a stale one doesn't", async () => {
    const broadcasts = new BroadcastRecords();
    const record = broadcasts.begin(1, RAW);
    const { call, adapters } = setUp(
      {
        myotisBroadcast: jest.fn(async () => {
          expect(record).toMatchObject({ sent: true, source: 'myotis' });
          return { txHash: HASH };
        }),
      },
      { broadcasts }
    );
    expect(await call({ myotis: 'broadcast', raw: RAW, generation: 3 })).toEqual(NOT_SENT);
    expect(record.sent).toBe(false);
    expect(await call({ myotis: 'broadcast', raw: RAW })).toEqual({ hash: HASH });
    expect(adapters.myotisBroadcast).toHaveBeenCalledTimes(1);
  });

  test('an answer without a hash, or one that is no answer, is uncertain', async () => {
    for (const answer of [
      {},
      null,
      { status: 'revert', txHash: HASH },
      { status: 'infeasible', txHash: HASH },
      { status: 'unavailable', txHash: HASH },
      { error: 'x', txHash: HASH },
      { txHash: null, result: undefined },
    ]) {
      const { call } = setUp({ myotisBroadcast: jest.fn(async () => answer) });
      expect(await call({ myotis: 'broadcast', raw: RAW })).toEqual({ uncertain: true });
    }
  });

  test.each([
    [
      'rejected on verified state',
      Object.assign(new Error('nonce too low: next nonce 5, tx nonce 4'), {
        code: -32000,
        myotisRefusal: 'rejected',
      }),
      { rejected: { reason: 'nonce too low: next nonce 5, tx nonce 4' } },
    ],
    [
      'refused as no transaction Myotis relays (ABI 44)',
      Object.assign(new Error('invalid raw transaction: malformed type 0x2 transaction'), {
        code: -32602,
        myotisRefusal: 'invalid-params',
      }),
      { rejected: { reason: 'invalid raw transaction: malformed type 0x2 transaction' } },
    ],
    [
      'dispatched, then lost',
      uncertain(
        'Myotis broadcast outcome uncertain; check the signed transaction hash before retrying'
      ),
      { uncertain: true },
    ],
    [
      'answered without a hash',
      uncertain('Myotis broadcast outcome uncertain; reconcile the original signed transaction'),
      { uncertain: true },
    ],
    ['not running', MYOTIS_ERRORS.not_running(), { failure: 'not_running' }],
    ['not ready', MYOTIS_ERRORS.not_ready(), { failure: 'not_ready' }],
    ['refused by a full queue', MYOTIS_ERRORS.queue_full(), { failure: 'queue_full' }],
    ['expired in the queue', MYOTIS_ERRORS.queue_deadline(), { failure: 'queue_deadline' }],
    ['refused by a client not accepting', unavailable('Myotis is unavailable'), NOT_SENT],
    ['too large to queue', unavailable('Myotis request exceeds size limit'), NOT_SENT],
    ['dropped from the queue at a stop', unavailable('Myotis stopped'), NOT_SENT],
    ['dropped from the queue at an exit', unavailable('Myotis child exited'), NOT_SENT],
    ['a caller deadline', MYOTIS_ERRORS.caller_deadline(), { failure: 'caller_deadline' }],
    [
      'another MYOTIS_UNAVAILABLE',
      unavailable('Myotis native operation failed'),
      { failure: 'error' },
    ],
    ['anything else', new Error('Unsupported Myotis chain ID: 7'), { failure: 'error' }],
  ])('%s', async (_name, thrown, expected) => {
    const { call } = setUp({ myotisBroadcast: jest.fn(async () => Promise.reject(thrown)) });
    expect(await call({ myotis: 'broadcast', raw: RAW })).toEqual(expected);
  });

  // freedom-core design 0005, The rest: ABI 44's refusal names its -32602
  // to a core that reads the code, which rebuilds the adapter's error with
  // it. Any other core gets today's `{ rejected: { reason } }`, and ABI
  // 36's refusal never names a code.
  describe('a refusal and its code', () => {
    const INVALID = 'invalid raw transaction: malformed type 0x2 transaction';
    const NONCE = 'nonce too low: next nonce 5, tx nonce 4';
    const refusal = (message, code, myotisRefusal) =>
      Object.assign(new Error(message), { code, myotisRefusal });
    const reads = {
      protocol: 1,
      capabilities: ['vault.status', 'fragments', 'myotis_refusal_codes'],
    };
    const older = { protocol: 1, capabilities: ['vault.status', 'fragments'] };
    test.each([
      [
        '-32602, to a core that reads the code',
        reads,
        refusal(INVALID, -32602, 'invalid-params'),
        { reason: INVALID, code: -32602 },
      ],
      [
        '-32602, to a core that does not',
        older,
        refusal(INVALID, -32602, 'invalid-params'),
        { reason: INVALID },
      ],
      [
        '-32602, with no core ready',
        null,
        refusal(INVALID, -32602, 'invalid-params'),
        { reason: INVALID },
      ],
      ['rejected on verified state', reads, refusal(NONCE, -32000, 'rejected'), { reason: NONCE }],
      // The code names the adapter's error only when it is that error's.
      [
        'a marker without its code',
        reads,
        refusal(INVALID, -32000, 'invalid-params'),
        { reason: INVALID },
      ],
    ])('%s', async (_name, hello, thrown, rejected) => {
      const { call, adapters } = setUp(
        { myotisBroadcast: jest.fn(async () => Promise.reject(thrown)) },
        { hello }
      );
      expect(await call({ myotis: 'broadcast', raw: RAW })).toEqual({ rejected });
      expect(adapters.myotisBroadcast).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Colibri', () => {
  test("a request runs today's adapter with its budget, and answers its result", async () => {
    const { call, adapters } = setUp({ colibriRequest: jest.fn(async () => ({ a: [1, null] })) });
    const reply = await call({
      colibri: 'request',
      method: 'eth_call',
      params: [{ to: ADDRESS }, 'latest'],
      deadline_ms: 4500,
    });
    expect(reply).toEqual({ result: { a: [1, null] } });
    expect(adapters.colibriRequest).toHaveBeenCalledWith(
      1,
      'eth_call',
      [{ to: ADDRESS }, 'latest'],
      { deadlineMs: 4500 }
    );
    // A JSON null is a result.
    const nullish = setUp({ colibriRequest: jest.fn(async () => null) });
    expect(
      await nullish.call({ colibri: 'request', method: 'eth_call', params: [], deadline_ms: 1 })
    ).toEqual({ result: null });
  });

  // Review of #692 (parity, P2-2): today's router returns an own
  // `result: undefined` from a verified success; JSON can't carry it, so
  // the reply names it (freedom-core's follow-up to #57).
  test('a successful result of undefined is named, still a success', async () => {
    const none = setUp({ colibriRequest: jest.fn(async () => undefined) });
    const reply = await none.call({
      colibri: 'request',
      method: 'eth_blockNumber',
      params: [],
      deadline_ms: 1,
    });
    expect(reply).toEqual({ undefined_keys: ['result'] });
    expect(Object.keys(reply)).toEqual(['undefined_keys']);
    expect(JSON.stringify(reply)).toBe('{"undefined_keys":["result"]}');
  });

  const colibri = (thrown) =>
    setUp({ colibriRequest: jest.fn(async () => Promise.reject(thrown)) }).call({
      colibri: 'request',
      method: 'eth_call',
      params: [],
      deadline_ms: 5000,
    });
  const worker = (message, extra = {}) => Object.assign(new Error(message), extra);

  test('a revert the prover verified is its data; any other error a failure', async () => {
    expect(await colibri(worker('execution reverted', { code: 3, data: '0x08c379a0' }))).toEqual({
      revert: { data: '0x08c379a0' },
    });
    expect(await colibri(worker('execution reverted', { code: 3, data: '0x' }))).toEqual({
      revert: { data: '0x' },
    });
    for (const extra of [
      { code: 3, data: '0x123' },
      { code: 3, data: '0X12' },
      { code: 3 },
      { code: '3', data: '0x12' },
      { code: -32000, data: '0x12' },
    ]) {
      expect(await colibri(worker('execution reverted', extra))).toEqual({ failure: 'error' });
    }
  });

  test.each([
    ['out of gas', 'capacity'],
    [`out  of${NBSP}gas`, 'capacity'],
    ['request exceeds the execution limit', 'capacity'],
    [`${'x'.repeat(490)}out of gas`, 'capacity'],
    [`${'x'.repeat(491)}out of gas`, 'error'],
    [`0x${'a'.repeat(1000)} out of gas`, 'capacity'],
    ['prover unreachable', 'error'],
  ])("the capacity bit is the router's: %#", async (message, expected) => {
    expect(await colibri(worker(message))).toEqual({ failure: expected });
  });

  test("an error's own failureKind sets capacity", async () => {
    expect(await colibri(worker('opaque', { failureKind: 'capacity' }))).toEqual({
      failure: 'capacity',
    });
  });

  // Review of #692 (parity, P2-1): the router keeps a verified revert and
  // blocks the route for its capacity failure too (freedom-core's
  // follow-up to #57).
  test('a verified revert that is also a capacity failure keeps both', async () => {
    for (const [message, extra] of [
      ['out of gas', {}],
      [`out  of${NBSP}gas`, {}],
      ['execution reverted', { failureKind: 'capacity' }],
    ]) {
      const reply = await colibri(worker(message, { code: 3, data: '0x', ...extra }));
      expect(reply).toEqual({ revert: { data: '0x' }, capacity: true });
      expect(JSON.stringify(reply)).toBe('{"revert":{"data":"0x"},"capacity":true}');
    }
    // A plain revert carries no capacity member at all, not even false.
    for (const message of ['execution reverted', `${'x'.repeat(491)}out of gas`]) {
      const reply = await colibri(worker(message, { code: 3, data: '0x08c379a0' }));
      expect(Object.keys(reply)).toEqual(['revert']);
    }
  });

  // freedom-core's #752 backoff (design 0005, The rest): `fault: true`
  // where main's router's isColibriFault held (chain-data-router.js at
  // 94b0af4e), only to a core whose hello offers `colibri_faults`.
  const FAULTS = { capabilities: ['fragments', 'colibri_faults'] };
  const faulting = (thrown, hello = FAULTS) =>
    setUp({ colibriRequest: jest.fn(async () => Promise.reject(thrown)) }, { hello }).call({
      colibri: 'request',
      method: 'eth_getTransactionReceipt',
      params: ['0xf7aa'],
      deadline_ms: 5000,
    });
  const trap = () =>
    worker('Error in rpc call eth_getTransactionReceipt["0xf7aa"] : memory access out of bounds', {
      name: 'ProviderRpcError',
      code: -32603,
    });

  test.each([
    ['a trap', trap(), true],
    ['a RuntimeError by name', worker('boom', { name: 'RuntimeError' }), true],
    ['a replaced worker', worker('Colibri worker replaced: verification still running'), true],
    [
      'a retired runtime',
      worker('Colibri WASM runtime was retired after a trap; refusing execute()'),
      true,
    ],
    ['an upper-case trap', worker('MEMORY ACCESS OUT OF BOUNDS'), true],
    ['unreachable after a colon, at the end', worker('wasm trap: unreachable'), true],
    ['unreachable executed, alone', worker('unreachable executed'), true],
    ['unreachable mid-text', worker('host unreachable: retry'), false],
    ['unreachable code', worker('unreachable code'), false],
    [
      'a transport error',
      worker('Request to https://p failed: fetch failed', { code: -32603 }),
      false,
    ],
    [
      'a bystander',
      worker('Colibri worker replaced: verification still running', { colibriBystander: true }),
      false,
    ],
    [
      "a bystander's retired runtime",
      worker('Colibri WASM runtime was retired after a trap; refusing execute()', {
        name: 'ProviderRpcError',
        colibriBystander: true,
      }),
      false,
    ],
  ])("the fault bit is the router's: %s", async (_name, thrown, fault) => {
    expect(isColibriFault(thrown)).toBe(fault);
    expect(await faulting(thrown)).toEqual(
      fault ? { failure: 'error', fault: true } : { failure: 'error' }
    );
  });

  test('a fault beside a revert or a capacity failure, members present only when true', async () => {
    const revert = await faulting(worker('memory access out of bounds', { code: 3, data: '0x12' }));
    expect(JSON.stringify(revert)).toBe('{"revert":{"data":"0x12"},"fault":true}');
    const both = await faulting(
      worker('out of gas: memory access out of bounds', { code: 3, data: '0x12' })
    );
    expect(JSON.stringify(both)).toBe('{"revert":{"data":"0x12"},"capacity":true,"fault":true}');
    const capacity = await faulting(worker('out of gas', { name: 'RuntimeError' }));
    expect(JSON.stringify(capacity)).toBe('{"failure":"capacity","fault":true}');
  });

  test('a core that offers no colibri_faults gets no fault bit', async () => {
    for (const hello of [null, { capabilities: ['fragments', 'myotis_refusal_codes'] }]) {
      expect(await faulting(trap(), hello)).toEqual({ failure: 'error' });
      expect(
        await faulting(worker('memory access out of bounds', { code: 3, data: '0x12' }), hello)
      ).toEqual({ revert: { data: '0x12' } });
    }
  });
});

describe('every operation', () => {
  test('a stale generation never runs: not_sent; a newer one runs', async () => {
    const { call, adapters } = setUp();
    for (const generation of [3, '4', undefined, 4.5]) {
      expect(await call({ myotis: 'broadcast', raw: RAW, generation })).toEqual(NOT_SENT);
    }
    expect(adapters.myotisBroadcast).not.toHaveBeenCalled();
    expect(await call({ myotis: 'broadcast', raw: RAW, generation: 5 })).toEqual({ hash: HASH });
  });

  test('one cancelled before it starts never runs: not_sent', async () => {
    const { call, adapters } = setUp();
    const cancel = new AbortController();
    cancel.abort();
    expect(await call({ myotis: 'broadcast', raw: RAW }, cancel.signal)).toEqual(NOT_SENT);
    expect(adapters.myotisBroadcast).not.toHaveBeenCalled();
  });

  test('a reply goes only once the adapter settles, whatever the core cancelled', async () => {
    const { fn, releases } = held();
    const { call, running } = setUp({ myotisBroadcast: fn });
    const cancel = new AbortController();
    let settled = false;
    const pending = call({ myotis: 'broadcast', raw: RAW }, cancel.signal).then((reply) => {
      settled = true;
      return reply;
    });
    await tick();
    cancel.abort();
    await tick();
    expect(settled).toBe(false);
    expect(running.myotis).toBe(1);
    releases[0].resolve({ txHash: HASH });
    expect(await pending).toEqual({ hash: HASH });
    expect(running.myotis).toBe(0);
  });

  test("the bound of 8 per verifier is naming's too: past it, busy", async () => {
    const running = { myotis: 0, colibri: 0 };
    const naming = held();
    const routes = new Map();
    registerNamingVerified(
      { handle: (method, fn) => routes.set(method, fn) },
      { generations: { lifecycle: 0 } },
      { running, adapters: { myotisCall: naming.fn, myotisStatus: () => ({}) } }
    );
    const { call, adapters } = setUp({}, { running });
    for (let i = 0; i < MAX_PER_VERIFIER; i++) {
      routes.get('shell.verified')(
        { myotis: 'call', to: ADDRESS, data: '0x', generations: { lifecycle: 0 } },
        { signal: new AbortController().signal }
      );
    }
    await tick();
    expect(running.myotis).toBe(MAX_PER_VERIFIER);
    expect(await call({ myotis: 'fee' })).toEqual({ failure: 'busy' });
    expect(adapters.myotisFee).not.toHaveBeenCalled();
    // Colibri has its own count.
    expect(
      await call({ colibri: 'request', method: 'eth_call', params: [], deadline_ms: 1 })
    ).toEqual({ result: '0x10' });
    naming.releases[0].resolve({ status: 'ok', resultHex: '0x' });
    await tick();
    expect(await call({ myotis: 'fee' })).toMatchObject({ payload: expect.any(Object) });
    for (const { resolve } of naming.releases) resolve({ status: 'ok', resultHex: '0x' });
    await tick();
    expect(running.myotis).toBe(0);
  });

  test("its result is charged to main's pool; past the pool, busy", async () => {
    const charged = [];
    const { call } = setUp({}, { charge: (bytes) => charged.push(bytes) > 0 });
    const reply = await call({ myotis: 'fee' });
    expect(charged).toEqual([Buffer.byteLength(JSON.stringify(reply))]);
    const full = setUp({}, { charge: () => false });
    expect(await full.call({ myotis: 'fee' })).toEqual({ failure: 'busy' });
    expect(await full.call({ myotis: 'broadcast', raw: RAW })).toEqual({ failure: 'busy' });
  });

  test('a reply over the message cap is too_large; one JSON cannot carry, error', async () => {
    const big = setUp({
      myotisCallTx: jest.fn(async () => ({ resultHex: 'x'.repeat(MAX_MESSAGE) })),
    });
    expect(await big.call({ myotis: 'call_tx', tx: {} })).toEqual({ failure: 'too_large' });
    const bigint = setUp({ myotisFee: jest.fn(async () => ({ gasPriceWei: 7n })) });
    expect(await bigint.call({ myotis: 'fee' })).toEqual({ failure: 'error' });
    const fn = setUp({ colibriRequest: jest.fn(async () => () => {}) });
    expect(
      await fn.call({ colibri: 'request', method: 'eth_call', params: [], deadline_ms: 1 })
    ).toEqual({ failure: 'error' });
  });

  test('a malformed operation is refused before it runs', async () => {
    const { call, adapters } = setUp();
    for (const params of [
      { myotis: 'fee', chain_id: -1 },
      { myotis: 'fee', chain_id: '1' },
      { myotis: 'record' },
      { myotis: 'constructor' },
      { myotis: '__proto__' },
      { myotis: 'call_tx' },
      { myotis: 'broadcast', raw: 7 },
      { colibri: 'resolve' },
      { colibri: 'request', method: 'eth_call', deadline_ms: 0 },
      { colibri: 'request', method: 7, deadline_ms: 10 },
      {},
    ]) {
      expect(await failure(call(params))).toBe('refused');
    }
    for (const fn of Object.values(adapters)) expect(fn).not.toHaveBeenCalled();
  });

  test("any other throw is one of the chain thread's codes", async () => {
    const routes = [];
    registerChainVerified(
      { handle: (method, fn, options) => routes.push({ fn, options }) },
      {
        generation: () => {
          throw new TypeError('boom');
        },
      },
      { adapters: {} }
    );
    const reply = routes[0].fn(
      { myotis: 'fee', chain_id: 1, generation: 1 },
      { signal: new AbortController().signal, charge: () => true }
    );
    expect(await failure(reply)).toBe('network');
  });
});
