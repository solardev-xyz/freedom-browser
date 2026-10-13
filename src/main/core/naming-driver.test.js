const {
  NamingDriver,
  MAX_ATTEMPTS,
  DEADLINE_MS,
  WATCHDOG_MARGIN_MS,
  RESTARTED,
  UNAVAILABLE,
} = require('./naming-driver');
const { runWithPrivateLogContext } = require('../private/private-log-context');

const GEN = { ens: 2, tezos: 1, lifecycle: 3 };
const resolutionFailed = (message, generations = GEN, attempts = 1) =>
  Object.assign(new Error('Resolution failed'), {
    code: 'resolution_failed',
    data: { message, generations, attempts },
  });

/** A driver over a fake client whose replies come from `answer`. */
function setUp(answer, { generations = GEN, core, now = () => 0 } = {}) {
  const gen = { id: 'process' };
  if (core === undefined) core = { gen };
  const urls = new Map([
    ['e1', 'https://a.rpc.example/v1/key'],
    ['e2', 'https://b.rpc.example'],
    ['p1', 'https://prover.example:8443/x'],
    ['t1', 'https://t1.tez.example/'],
  ]);
  const config = {
    core,
    generations: { ...generations },
    generationsOf: jest.fn((of) => {
      expect(of).toBe(gen);
      return config.generations;
    }),
    // Controls in flight: each, once settled by the barrier, may change
    // generations.
    controls: [],
    idle: jest.fn(() => config.controls.length === 0),
    whenServing: jest.fn(async () => {
      for (const settle of config.controls.splice(0)) settle(config.generations);
      return gen;
    }),
    // An invalidation goes at once here, to the process.
    invalidate: jest.fn(async (method, params) =>
      config.core ? client.requestTo(gen, method, params) : undefined
    ),
    // Mapped by the process that answered.
    endpointUrl: jest.fn((ref, of) => (of === gen ? urls.get(ref) : undefined)),
  };
  const client = {
    whenReady: jest.fn(async () => ({})),
    serves: jest.fn((of) => of === gen),
    requestTo: jest.fn(async (to, method, params) => {
      expect(to).toBe(gen);
      return answer(method, params, client.requestTo.mock.calls.length);
    }),
  };
  const driver = new NamingDriver({
    client,
    config,
    normalize: (name) => name.toLowerCase(),
    now,
  });
  return { driver, client, config, gen };
}

const ok = (result, extra = {}) => ({
  result,
  undefined_keys: [],
  generations: GEN,
  attempts: 1,
  ...extra,
});

describe('NamingDriver', () => {
  test('a lookup goes to the serving process with its subject and privacy', async () => {
    const { driver, client } = setUp(() => ok({ type: 'ok' }));
    await driver.resolveContent('vitalik.eth');
    await runWithPrivateLogContext(true, () => driver.resolveAddress('nick.eth', 10));
    await driver.resolveReverse('0x' + 'ab'.repeat(20), 1);
    await driver.resolveTezos('alice.tez');
    expect(client.requestTo.mock.calls.map(([, method, params]) => [method, params])).toEqual([
      // Each carries the caller's deadline: the core's and the watchdog's agree.
      ['naming.resolve_content', { name: 'vitalik.eth', private: false, deadline_ms: DEADLINE_MS }],
      [
        'naming.resolve_address',
        { name: 'nick.eth', chain_id: 10, private: true, deadline_ms: DEADLINE_MS },
      ],
      [
        'naming.resolve_reverse',
        { address: '0x' + 'ab'.repeat(20), chain_id: 1, private: false, deadline_ms: DEADLINE_MS },
      ],
      ['naming.resolve_tezos', { name: 'alice.tez', private: false, deadline_ms: DEADLINE_MS }],
    ]);
  });

  test('ENS references become hosts exactly where results name endpoints', async () => {
    const { driver } = setUp(() =>
      ok({
        type: 'conflict',
        data: { ref: 'e1' },
        trust: {
          level: 'conflict',
          agreed: [{ ref: 'e1' }, 'myotis-p2p'],
          dissented: [{ ref: 'e2' }],
          queried: [{ ref: 'e1' }, { ref: 'e9' }],
          prover: { ref: 'p1' },
        },
        groups: [{ resolvedData: '0x01', urls: [{ ref: 'e1' }, { ref: 'e2' }] }],
      })
    );
    expect(await driver.resolveContent('vitalik.eth')).toEqual({
      type: 'conflict',
      // Not where endpoints are named: data, left as it is.
      data: { ref: 'e1' },
      trust: {
        level: 'conflict',
        agreed: ['a.rpc.example', 'myotis-p2p'],
        dissented: ['b.rpc.example'],
        // A reference main no longer maps stays as it is.
        queried: ['a.rpc.example', 'e9'],
        prover: 'prover.example:8443',
      },
      groups: [{ resolvedData: '0x01', urls: ['a.rpc.example', 'b.rpc.example'] }],
    });
  });

  test("Tezos' agreed endpoints are URLs, its groups hosts; its records are data", async () => {
    const { driver } = setUp(() =>
      ok(
        {
          type: 'ok',
          records: { ref: 't1' },
          ttl: null,
          trust: { agreed: [{ ref: 't1' }], queried: [{ ref: 't1' }] },
          groups: [{ value: 'x', urls: [{ ref: 't1' }] }],
        },
        { undefined_keys: ['ttl', 'absent'] }
      )
    );
    const result = await driver.resolveTezos('alice.tez');
    expect(result.trust).toEqual({
      agreed: ['https://t1.tez.example/'],
      queried: [{ ref: 't1' }],
    });
    expect(result.groups).toEqual([{ value: 'x', urls: ['t1.tez.example'] }]);
    expect(result.records).toEqual({ ref: 't1' });
    // A present-undefined key is back; one the result lacks isn't added.
    expect(Object.hasOwn(result, 'ttl')).toBe(true);
    expect(result.ttl).toBeUndefined();
    expect(Object.hasOwn(result, 'absent')).toBe(false);
  });

  test("a thrown resolution throws its message; the core's other errors theirs", async () => {
    const thrown = (err) => setUp(() => Promise.reject(err)).driver;
    await expect(
      thrown(
        resolutionFailed('No enabled name-resolution method could resolve x.eth')
      ).resolveContent('x.eth')
    ).rejects.toThrow(/^No enabled name-resolution method could resolve x\.eth$/);
    await expect(
      thrown(Object.assign(new Error('Too many naming requests'), { code: 'busy' })).resolveContent(
        'x.eth'
      )
    ).rejects.toThrow('Too many naming requests');
    await expect(
      thrown(
        Object.assign(new Error('The core exited'), { code: 'core_unavailable' })
      ).resolveTezos('a.tez')
    ).rejects.toThrow(RESTARTED);
  });

  test('an overtaken reply is sent again with the attempts and time it has left', async () => {
    let t = 1_000;
    const replies = [
      ok({ type: 'stale' }, { generations: { ...GEN, ens: 1 }, attempts: 1 }),
      Promise.reject(
        resolutionFailed(
          'Name resolution configuration changed while resolving x.eth',
          { ...GEN, lifecycle: 2 },
          2
        )
      ),
      ok({ type: 'ok' }, { attempts: 3 }),
    ];
    const { driver, client } = setUp(
      (_method, _params, n) => {
        t += 10_000;
        return replies[n - 1];
      },
      { now: () => t }
    );
    expect(await driver.resolveContent('x.eth')).toEqual({ type: 'ok' });
    const sent = client.requestTo.mock.calls.map(([, , params]) => params);
    expect(sent[0]).toEqual({ name: 'x.eth', private: false, deadline_ms: DEADLINE_MS });
    expect(sent[1]).toEqual({
      name: 'x.eth',
      private: false,
      attempts_used: 1,
      deadline_ms: DEADLINE_MS - 10_000,
    });
    expect(sent[2]).toMatchObject({ attempts_used: 2, deadline_ms: DEADLINE_MS - 20_000 });
    // Each is watched for the time it has left, plus the hang margin.
    expect(client.requestTo.mock.calls.map(([, , , , options]) => options.watchdogMs)).toEqual([
      DEADLINE_MS + WATCHDOG_MARGIN_MS,
      DEADLINE_MS - 10_000 + WATCHDOG_MARGIN_MS,
      DEADLINE_MS - 20_000 + WATCHDOG_MARGIN_MS,
    ]);
  });

  test('a reply is overtaken only in the scopes its result depends on', async () => {
    const tezosMoved = { ...GEN, tezos: 0 };
    const ensMoved = { ...GEN, ens: 1, lifecycle: 0 };
    const { driver, client } = setUp((method) =>
      ok(
        { type: method },
        { generations: method === 'naming.resolve_tezos' ? ensMoved : tezosMoved }
      )
    );
    await driver.resolveContent('x.eth');
    await driver.resolveTezos('a.tez');
    expect(client.requestTo).toHaveBeenCalledTimes(2);
  });

  test('three overtaken attempts are today\'s "changed repeatedly", by today\'s subject', async () => {
    // Each reply ran an attempt: one more than the caller had used.
    const stale = (generations) =>
      setUp((_method, params) =>
        ok({}, { generations, attempts: (params.attempts_used ?? 0) + 1 })
      );
    const ens = stale({ ...GEN, lifecycle: 2 });
    await expect(ens.driver.resolveContent('  Vitalik.ETH ')).rejects.toThrow(
      /^Myotis availability changed repeatedly while resolving vitalik\.eth$/
    );
    expect(ens.client.requestTo).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const tezos = stale({ ...GEN, tezos: 0 });
    await expect(tezos.driver.resolveTezos(' Alice.TEZ')).rejects.toThrow(
      /^Tezos configuration changed repeatedly while resolving alice\.tez$/
    );
    // A reply that used its attempts already is the last.
    const spent = setUp(() => ok({}, { generations: { ...GEN, ens: 1 }, attempts: 3 }));
    await expect(spent.driver.resolveContent('x.eth')).rejects.toThrow(/changed repeatedly/);
    expect(spent.client.requestTo).toHaveBeenCalledTimes(1);
  });

  test('an overtaken immediate reply costs no attempt', async () => {
    // Cache hits under an old generation, three times, then a current one:
    // they ran no attempt, so the caller keeps its allowance.
    const { driver, client } = setUp((_method, params, n) =>
      ok(
        { type: 'ok', n },
        {
          generations: n <= 3 ? { ...GEN, ens: 1 } : GEN,
          attempts: params.attempts_used ?? 0,
        }
      )
    );
    expect(await driver.resolveContent('cached.eth')).toEqual({ type: 'ok', n: 4 });
    expect(client.requestTo.mock.calls.map(([, , params]) => params.attempts_used)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('the first request carries what waiting for the core left of the deadline', async () => {
    let t = 0;
    const { driver, client, config, gen } = setUp(() => ok({ type: 'ok' }), { now: () => t });
    config.whenServing.mockImplementation(async () => {
      t += 30_000;
      return gen;
    });
    await driver.resolveContent('x.eth');
    const [, , params, , options] = client.requestTo.mock.calls[0];
    expect(params.deadline_ms).toBe(DEADLINE_MS - 30_000);
    expect(options.watchdogMs).toBe(DEADLINE_MS - 30_000 + WATCHDOG_MARGIN_MS);
  });

  test('a Tezos conflict gains no trust key it lacked', async () => {
    const { driver } = setUp(() =>
      ok({
        type: 'conflict',
        system: 'tezos',
        groups: [{ value: 'chain head #1000', urls: [{ ref: 't1' }] }],
        trust: { level: 'conflict', system: 'tezos', block: null, k: 2, m: 0 },
      })
    );
    const result = await driver.resolveTezos('alice.tez');
    expect(Object.keys(result.trust)).toEqual(['level', 'system', 'block', 'k', 'm']);
    expect(result.groups[0].urls).toEqual(['t1.tez.example']);
  });

  test('without a core it is unavailable; one starting is waited for', async () => {
    const none = setUp(() => ok({}), { core: null });
    none.client.whenReady.mockRejectedValue(new Error('not running'));
    await expect(none.driver.resolveContent('x.eth')).rejects.toThrow(UNAVAILABLE);
    expect(none.client.requestTo).not.toHaveBeenCalled();
    const starting = setUp(() => ok({ type: 'ok' }), { core: null });
    expect(await starting.driver.resolveContent('x.eth')).toEqual({ type: 'ok' });
    expect(starting.client.whenReady).toHaveBeenCalled();
    const gone = setUp(() => ok({}));
    gone.config.whenServing.mockResolvedValue(null);
    await expect(gone.driver.resolveContent('x.eth')).rejects.toThrow(UNAVAILABLE);
  });

  test("past the caller's deadline nothing more is sent", async () => {
    let t = 0;
    const { driver, client } = setUp(
      () => {
        t += DEADLINE_MS;
        return ok({}, { generations: { ...GEN, ens: 1 } });
      },
      { now: () => t }
    );
    await expect(driver.resolveContent('x.eth')).rejects.toThrow(
      "The resolution's deadline passed"
    );
    expect(client.requestTo).toHaveBeenCalledTimes(1);
  });

  test("invalidations go in order with the core's controls, or nowhere", async () => {
    const { driver, client, config } = setUp((method) =>
      method === 'naming.invalidate_content' ? { evicted: true } : {}
    );
    expect(await driver.invalidateContent('vitalik.eth')).toBe(true);
    expect(config.invalidate).toHaveBeenCalledWith('naming.invalidate_content', {
      name: 'vitalik.eth',
    });
    await driver.invalidateTezos('alice.tez');
    await driver.invalidateTezos(undefined);
    expect(client.requestTo.mock.calls.slice(1).map(([, m, p]) => [m, p])).toEqual([
      ['naming.invalidate_tezos', { name: 'alice.tez' }],
      ['naming.invalidate_tezos', {}],
    ]);
    config.core = null;
    expect(await driver.invalidateContent('vitalik.eth')).toBe(false);
    await driver.invalidateTezos('alice.tez');
    expect(client.requestTo).toHaveBeenCalledTimes(3);
  });

  test('a control asked for while the lookup ran is waited for, then judged', async () => {
    // An availability goes after the lookup went out: its answer, though
    // current for the core then, is from before the transition.
    const crossed = setUp((_method, _params, n) => {
      if (n === 1) crossed.config.controls.push((generations) => (generations.lifecycle += 1));
      // Made under the core's generations of the moment.
      return ok({ type: 'ok', n }, { attempts: n, generations: { ...crossed.config.generations } });
    });
    expect(await crossed.driver.resolveContent('x.eth')).toEqual({ type: 'ok', n: 2 });
    expect(crossed.client.requestTo.mock.calls.map(([, , params]) => params.attempts_used)).toEqual(
      [undefined, 1]
    );
    // One that leaves the lookup's generations alone costs nothing: the
    // answer is published, no attempt spent.
    const unrelated = setUp((_method, _params, n) => {
      if (n === 1) unrelated.config.controls.push((generations) => (generations.ens += 1));
      return ok({ type: 'ok', n }, { generations: { ...unrelated.config.generations } });
    });
    expect(await unrelated.driver.resolveTezos('a.tez')).toEqual({ type: 'ok', n: 1 });
    expect(unrelated.client.requestTo).toHaveBeenCalledTimes(1);
    expect(unrelated.config.whenServing).toHaveBeenCalledTimes(2);
  });

  test('a reply is judged only with no control in flight, however late one comes', async () => {
    const { driver, client, config } = setUp((_method, _params, n) => {
      // One control lands while the lookup runs and moves nothing.
      if (n === 1) config.controls.push(() => {});
      return ok({ type: 'ok', n }, { attempts: n, generations: { ...config.generations } });
    });
    // Another lands after the first has settled, just before the judgment,
    // and moves the lifecycle: the reply is judged after it, and retried.
    let calls = 0;
    const idle = config.idle.getMockImplementation();
    config.idle.mockImplementation(() => {
      calls += 1;
      if (calls === 5) {
        config.controls.push((generations) => (generations.lifecycle += 1));
        return false;
      }
      return idle();
    });
    expect(await driver.resolveContent('x.eth')).toEqual({ type: 'ok', n: 2 });
    expect(client.requestTo).toHaveBeenCalledTimes(2);
  });

  test('a lookup is sent only while no control is in flight', async () => {
    // A control queued while the barrier ran: the barrier is passed again.
    const during = setUp(() => ok({ type: 'ok' }));
    let settled = false;
    during.config.whenServing.mockImplementationOnce(async () => {
      during.config.controls.push(() => (settled = true));
      return during.gen;
    });
    during.client.requestTo.mockImplementationOnce(async () => {
      expect(settled).toBe(true);
      return ok({ type: 'ok' });
    });
    expect(await during.driver.resolveContent('x.eth')).toEqual({ type: 'ok' });
    expect(during.client.requestTo).toHaveBeenCalledTimes(1);
    expect(during.config.whenServing).toHaveBeenCalledTimes(2);

    // One queued after the barrier, just before the send: it goes first too.
    const after = setUp(() => ok({ type: 'ok' }));
    let first = false;
    after.config.idle.mockImplementationOnce(() => true);
    after.config.idle.mockImplementationOnce(() => {
      after.config.controls.push(() => (first = true));
      return false;
    });
    after.client.requestTo.mockImplementationOnce(async () => {
      expect(first).toBe(true);
      return ok({ type: 'ok' });
    });
    expect(await after.driver.resolveContent('x.eth')).toEqual({ type: 'ok' });
    expect(after.client.requestTo).toHaveBeenCalledTimes(1);
  });

  test('a lookup stays with its process: a restart sends nothing again', async () => {
    // A retry would be answered, and current.
    const { driver, client, config, gen } = setUp(() => ok({ type: 'ok' }, { attempts: 1 }));
    // Overtaken, then its process is gone before the retry.
    client.requestTo.mockImplementationOnce(async (to) => {
      expect(to).toBe(gen);
      config.core = { gen: { id: 'replacement' } };
      return ok({ type: 'stale' }, { generations: { ...GEN, ens: 1 }, attempts: 1 });
    });
    await expect(driver.resolveContent('x.eth')).rejects.toThrow(RESTARTED);
    expect(client.requestTo).toHaveBeenCalledTimes(1);

    // Gone with no replacement yet, while it waits for the retry's controls.
    const exited = setUp(() => ok({ type: 'ok' }, { attempts: 1 }));
    exited.client.requestTo.mockImplementationOnce(async () => {
      exited.config.whenServing.mockResolvedValue(null);
      exited.client.serves.mockReturnValue(false);
      return ok({ type: 'stale' }, { generations: { ...GEN, ens: 1 }, attempts: 1 });
    });
    await expect(exited.driver.resolveContent('x.eth')).rejects.toThrow(RESTARTED);
    expect(exited.client.requestTo).toHaveBeenCalledTimes(1);
  });
});

describe('NamingDriver.open (dweb.open, freedom-core design 0006)', () => {
  const HASH = 'ab'.repeat(32);
  const params = (url) => ({
    url,
    method: 'GET',
    headers: [['accept', '*/*']],
    backend: { ant: 'bundled', up: true },
  });
  const FETCH = { fetch: { node: 'ant' } };
  const planned = (plan = FETCH, extra = {}) => ({ plan, generations: GEN, attempts: 0, ...extra });

  test("a plan is asked of the serving process as main's own, with its privacy and deadline", async () => {
    const { driver, client } = setUp(() => planned());
    const signal = new AbortController().signal;
    expect(await driver.open(params(`bzz://${HASH}/`), { signal })).toEqual(planned());
    await runWithPrivateLogContext(true, () => driver.open(params('bzz://x.eth/')));
    const [first, second] = client.requestTo.mock.calls;
    expect(first.slice(1)).toEqual([
      'dweb.open',
      { ...params(`bzz://${HASH}/`), private: false, deadline_ms: DEADLINE_MS },
      // Caller kind `shell`: pages never reach the core, and it refuses them.
      { caller: 'shell' },
      // The page's abort reaches the core as 0001's `cancel`.
      { watchdogMs: DEADLINE_MS + WATCHDOG_MARGIN_MS, signal },
    ]);
    expect(second[2]).toEqual({
      ...params('bzz://x.eth/'),
      private: true,
      deadline_ms: DEADLINE_MS,
    });
  });

  test('an overtaken plan is planned again with attempts_used, within the remaining deadline', async () => {
    let t = 1_000;
    const replies = [
      planned({ error: { status: 502 } }, { generations: { ...GEN, lifecycle: 2 }, attempts: 1 }),
      planned(FETCH, { attempts: 1 }),
    ];
    const { driver, client } = setUp(
      (_method, _params, n) => {
        t += 10_000;
        return replies[n - 1];
      },
      { now: () => t }
    );
    expect((await driver.open(params('bzz://x.eth/'))).plan).toEqual(FETCH);
    const sent = client.requestTo.mock.calls.map(([, , sentParams]) => sentParams);
    expect(sent[0].attempts_used).toBeUndefined();
    expect(sent[1]).toMatchObject({ attempts_used: 1, deadline_ms: DEADLINE_MS - 10_000 });
  });

  test("a .tez host's plan is fenced by Tezos' generation, any other host's by ENS's", async () => {
    const tezosMoved = { ...GEN, tezos: 0 };
    const ensMoved = { ...GEN, ens: 1 };
    const tez = setUp(() => planned(FETCH, { generations: ensMoved }));
    await tez.driver.open(params('bzz://site.tez/'));
    expect(tez.client.requestTo).toHaveBeenCalledTimes(1);
    const hash = setUp(() => planned(FETCH, { generations: tezosMoved }));
    await hash.driver.open(params(`bzz://${HASH}/`));
    expect(hash.client.requestTo).toHaveBeenCalledTimes(1);
    // A plan made with no lookup depends on nothing: overtaken, it is only
    // planned again, and costs no attempt.
    const replanned = setUp((_method, _params, n) =>
      planned(FETCH, { generations: n === 1 ? ensMoved : GEN })
    );
    await replanned.driver.open(params(`bzz://${HASH}/`));
    expect(replanned.client.requestTo.mock.calls.map(([, , p]) => p.attempts_used)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test('three overtaken plans are today\'s "changed repeatedly", by today\'s subject', async () => {
    const stale = setUp((_method, sentParams) =>
      planned(FETCH, {
        generations: { ...GEN, lifecycle: 2 },
        attempts: (sentParams.attempts_used ?? 0) + 1,
      })
    );
    const failure = await stale.driver.open(params('bzz://Vitalik.ETH/')).catch((err) => err);
    expect(failure.code).toBe('repeated');
    expect(failure.message).toBe(
      'Myotis availability changed repeatedly while resolving vitalik.eth'
    );
    expect(stale.client.requestTo).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  test('a plan that waited for admission is judged again after the wait', async () => {
    const { driver, client, config } = setUp((_method, _params, n) =>
      planned({ fetch: { n } }, { attempts: 1, generations: { ...config.generations } })
    );
    const ready = jest.fn(async (reply) => {
      // A control lands while the first plan waits for its slot.
      if (reply.plan.fetch.n === 1) {
        config.controls.push((generations) => (generations.lifecycle += 1));
      }
    });
    expect((await driver.open(params('ipfs://x.eth/'), { ready })).plan).toEqual({
      fetch: { n: 2 },
    });
    expect(ready.mock.calls.map(([reply]) => reply.plan.fetch.n)).toEqual([1, 2]);
    expect(client.requestTo.mock.calls[1][2].attempts_used).toBe(1);
  });

  test("the core's errors keep their codes; a lost process is core_unavailable", async () => {
    const coreError = (code) => Object.assign(new Error(code), { code });
    for (const code of ['busy', 'deadline', 'invalid_argument', 'forbidden', 'internal']) {
      const { driver } = setUp(() => Promise.reject(coreError(code)));
      await expect(driver.open(params(`bzz://${HASH}/`))).rejects.toMatchObject({ code });
    }
    const lost = setUp(() => Promise.reject(coreError('core_unavailable')));
    await expect(lost.driver.open(params(`bzz://${HASH}/`))).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    const none = setUp(() => planned(), { core: null });
    none.client.whenReady.mockRejectedValue(new Error('not running'));
    await expect(none.driver.open(params(`bzz://${HASH}/`))).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    expect(none.client.requestTo).not.toHaveBeenCalled();
  });

  test('a plan stays with its process: a restart plans nothing again', async () => {
    const { driver, client, config, gen } = setUp(() => planned());
    client.requestTo.mockImplementationOnce(async (to) => {
      expect(to).toBe(gen);
      config.core = { gen: { id: 'replacement' } };
      return planned(FETCH, { generations: { ...GEN, ens: 1 } });
    });
    await expect(driver.open(params('bzz://x.eth/'))).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    expect(client.requestTo).toHaveBeenCalledTimes(1);
  });

  test('a request already cancelled asks nothing', async () => {
    const { driver, client } = setUp(() => planned());
    const controller = new AbortController();
    controller.abort();
    await expect(
      driver.open(params(`bzz://${HASH}/`), { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.requestTo).not.toHaveBeenCalled();
  });
});

describe('NamingDriver.open: every wait in the request lifetime', () => {
  const params = {
    url: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/',
    method: 'GET',
    headers: [],
    backend: { ipfs: 'native', up: true },
  };
  const never = new Promise(() => {});
  const planned = () => ({ plan: { fetch: {} }, generations: GEN, attempts: 0 });

  afterEach(() => jest.useRealTimers());

  test('an abort settles a wait for a quiet configuration at once, with nothing sent', async () => {
    const { driver, client, config } = setUp(() => planned());
    // Initializing, a control queued: the configuration never goes quiet.
    config.idle.mockReturnValue(false);
    config.whenServing.mockReturnValue(never);
    client.whenReady.mockReturnValue(never);
    const page = new AbortController();
    const opened = driver.open(params, { signal: page.signal }).catch((err) => err);
    await new Promise(setImmediate);
    page.abort();
    expect(await opened).toMatchObject({ code: 'cancelled' });
    expect(client.requestTo).not.toHaveBeenCalled();
  });

  test('the deadline settles a wait on `ready`, whose signal aborts with it', async () => {
    jest.useFakeTimers();
    const { driver } = setUp(() => planned());
    let readySignal = null;
    const ready = jest.fn((_reply, signal) => {
      readySignal = signal;
      return never;
    });
    const opened = driver.open(params, { ready }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(readySignal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await opened).toMatchObject({ code: 'deadline' });
    expect(readySignal.aborted).toBe(true);
  });

  test('an abort during `ready` aborts its signal and settles at once', async () => {
    const { driver } = setUp(() => planned());
    let readySignal = null;
    const page = new AbortController();
    const opened = driver
      .open(params, {
        signal: page.signal,
        ready: (_reply, signal) => {
          readySignal = signal;
          return never;
        },
      })
      .catch((err) => err);
    await new Promise(setImmediate);
    page.abort();
    expect(await opened).toMatchObject({ code: 'cancelled' });
    expect(readySignal.aborted).toBe(true);
  });

  test("the plan's use follows the final judgment in the same turn, and is its result", async () => {
    const { driver, config } = setUp(() => planned());
    const order = [];
    const idle = config.idle.getMockImplementation();
    config.idle.mockImplementation((gen) => {
      order.push('judged');
      queueMicrotask(() => order.push('next turn'));
      return idle(gen);
    });
    const use = jest.fn(() => {
      order.push('used');
      return 'response';
    });
    expect(await driver.open(params, { ready: async () => {}, use })).toBe('response');
    expect(order.slice(-3)).toEqual(['judged', 'used', 'next turn']);
  });

  test('a process that stops serving before the plan is used is core_unavailable', async () => {
    const { driver, client } = setUp(() => planned());
    const use = jest.fn();
    const ready = async () => {
      // Fenced off, its exit not yet delivered: the configuration is idle.
      client.serves.mockReturnValue(false);
    };
    await expect(driver.open(params, { ready, use })).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    expect(use).not.toHaveBeenCalled();
  });
});

// A wait can settle after the deadline but before its timeout runs: the
// lifetime is read again after every wait, and in the final step.
describe('NamingDriver.open: the deadline read after each wait', () => {
  const params = {
    url: 'bzz://site.eth/index.html',
    method: 'GET',
    headers: [],
    backend: { ant: 'bundled', up: true },
  };
  const planned = () => ({ plan: { fetch: {} }, generations: GEN, attempts: 1 });

  test('admission that completes past the deadline, its timer still pending, is never used', async () => {
    let t = 0;
    const { driver } = setUp(() => planned(), { now: () => t });
    const use = jest.fn();
    const ready = jest.fn(async () => {
      // Granted late: the clock has passed the deadline, the timeout
      // callback hasn't run yet.
      t = DEADLINE_MS + 1;
    });
    await expect(driver.open(params, { ready, use })).rejects.toMatchObject({
      code: 'deadline',
    });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(use).not.toHaveBeenCalled();
  });

  test('a plan answered past the deadline goes no further', async () => {
    let t = 0;
    const { driver } = setUp(
      () => {
        t = DEADLINE_MS;
        return planned();
      },
      { now: () => t }
    );
    const ready = jest.fn();
    const use = jest.fn();
    await expect(driver.open(params, { ready, use })).rejects.toMatchObject({
      code: 'deadline',
    });
    expect(ready).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
  });
});
