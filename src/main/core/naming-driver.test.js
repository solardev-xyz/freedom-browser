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
function setUp(answer, { generations = GEN, core = {}, now } = {}) {
  const gen = { id: 'process' };
  const urls = new Map([
    ['e1', 'https://a.rpc.example/v1/key'],
    ['e2', 'https://b.rpc.example'],
    ['p1', 'https://prover.example:8443/x'],
    ['t1', 'https://t1.tez.example/'],
  ]);
  const config = {
    core,
    generations: { ...generations },
    whenServing: jest.fn(async () => gen),
    servingNow: jest.fn(() => gen),
    endpointUrl: (ref) => urls.get(ref),
  };
  const client = {
    whenReady: jest.fn(async () => ({})),
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
      ['naming.resolve_content', { name: 'vitalik.eth', private: false }],
      ['naming.resolve_address', { name: 'nick.eth', chain_id: 10, private: true }],
      ['naming.resolve_reverse', { address: '0x' + 'ab'.repeat(20), chain_id: 1, private: false }],
      ['naming.resolve_tezos', { name: 'alice.tez', private: false }],
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
    expect(sent[0]).toEqual({ name: 'x.eth', private: false });
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
    const stale = (generations) => setUp(() => ok({}, { generations, attempts: 0 }));
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

  test('invalidations go at once to the serving process, or nowhere', async () => {
    const { driver, client, config } = setUp((method) =>
      method === 'naming.invalidate_content' ? { evicted: true } : {}
    );
    const evicted = driver.invalidateContent('vitalik.eth');
    // Sent before anything that follows.
    expect(client.requestTo).toHaveBeenCalledWith(expect.anything(), 'naming.invalidate_content', {
      name: 'vitalik.eth',
    });
    expect(await evicted).toBe(true);
    await driver.invalidateTezos('alice.tez');
    await driver.invalidateTezos(undefined);
    expect(client.requestTo.mock.calls.slice(1).map(([, m, p]) => [m, p])).toEqual([
      ['naming.invalidate_tezos', { name: 'alice.tez' }],
      ['naming.invalidate_tezos', {}],
    ]);
    config.servingNow.mockReturnValue(null);
    expect(await driver.invalidateContent('vitalik.eth')).toBe(false);
    await driver.invalidateTezos('alice.tez');
    expect(client.requestTo).toHaveBeenCalledTimes(3);
  });
});
