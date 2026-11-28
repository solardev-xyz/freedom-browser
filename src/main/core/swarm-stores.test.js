/**
 * Main's typed calls to the Swarm stores (swarm-stores.js; freedom-core
 * design 0015, D3, D5 and D7; the SWM-6 to SWM-9 plan's PR 6.1), beside
 * the vectors' replay (swarm-stores.vectors.test.js):
 * - the ops as the core defines them, each with its members and callers;
 *   an op, a member or a caller the core doesn't take is refused in main,
 *   unsent, and a member that is undefined is left out;
 * - every call goes with `requires: swarm_stores`, so on a core whose hello
 *   didn't echo the name it fails `requirement_unmet`, unsent, through the
 *   real client; the running core's client by default, `core_unavailable`
 *   without one;
 * - answers are read strictly: `{ result_typed }`, or `{ error_typed:
 *   { name, message, code? } }` thrown as that class with its code;
 *   anything else is `CoreError` `internal`; the protocol's errors pass as
 *   they came;
 * - the simulated core (test/helpers/simulated-swarm-stores-core.js) runs
 *   the ops on the reference modules, on a temporary Freedom root.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { getPath: jest.fn(), isPackaged: false } }));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('./core-process', () => ({ getCoreClient: jest.fn(() => null) }));
jest.mock('../identity-manager', () => ({
  getBeeWalletAddress: async () => '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
  getPublisherAddress: async (index) => `0x${String(index + 1).padStart(40, '0')}`,
  getDerivedWallets: () => [],
}));

const { CoreError, SWARM_STORES } = require('./core-client');
const { watchdogMs } = require('./core-deadlines');
const swarmStores = require('./swarm-stores');
const { readTyped, TypedFormError } = require('./swarm-typed');

const { createSwarmStores, storeParams, readStoreAnswer, OPS } = swarmStores;

/** A recording sender answering `answer` (a function of the request, or a value). */
function recorder(answer = { result_typed: { undefined: true } }) {
  const sent = [];
  const request = async (method, params, context, options) => {
    sent.push({ method, params, context, options });
    return typeof answer === 'function' ? answer(method, params) : answer;
  };
  return { sent, stores: createSwarmStores({ request }) };
}

async function errorOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('the ops, as the core defines them', () => {
  test('each method lists its ops, members and callers', () => {
    const shape = (method) =>
      Object.fromEntries(
        Object.entries(OPS[method]).map(([name, { members, callers }]) => [
          name,
          [members.join(','), callers.join(',')],
        ])
      );
    const both = 'chrome,shell';
    expect(shape('swarm.identities')).toEqual({
      'get-all-origins': ['', both],
      'has-feed-identity': ['origin', both],
      'get-identity-mode': ['origin', both],
      'get-origin-identities': ['origin', both],
      'create-app-scoped-identity': ['origin,options', both],
      'ensure-ant-wallet-identity': ['origin,options', both],
      'activate-feed-identity': ['origin,identity_id', both],
      'set-feed-identity': ['', both],
      'revoke-feed-access': ['origin', both],
      getOriginIdentityStateWithOwners: ['key', 'shell'],
      previewAppScopedIdentity: ['key,options', 'shell'],
      createAppScopedIdentityAt: ['key,index,options', 'shell'],
      ensureAntWalletIdentity: ['key,options', 'shell'],
      activateIdentity: ['key,identity_id', 'shell'],
      grantFeedAccess: ['key', 'shell'],
      hasFeedGrant: ['key', 'shell'],
      assertFeedGrantable: ['key', 'shell'],
      getEthereumWalletIdentityReferences: ['wallet_index', 'shell'],
    });
    expect(shape('swarm.history')).toEqual({
      list: ['', both],
      clear: ['', both],
      remove: ['id', both],
      add: ['entry', 'shell'],
      update: ['id,updates', 'shell'],
    });
    expect(shape('swarm.manifest')).toEqual({
      check: ['key,url,eager', 'shell'],
      decide: ['key,token,outcome,live', 'shell'],
      release: ['token', 'shell'],
      get: ['origin', 'shell'],
      'use-individual': ['origin,capability', 'shell'],
      disconnect: ['origin', 'shell'],
    });
  });

  test('params are the op and each member typed; an undefined member is left out', () => {
    expect(
      storeParams('swarm.identities', 'createAppScopedIdentityAt', {
        key: 'https://app.example',
        index: 0,
        options: { activate: true, label: undefined },
      })
    ).toEqual({
      op: 'createAppScopedIdentityAt',
      key: { string: 'https://app.example' },
      index: { number: '0' },
      options: {
        object: [
          ['activate', { boolean: true }],
          ['label', { undefined: true }],
        ],
      },
    });
    expect(
      storeParams('swarm.manifest', 'check', { key: 'k', url: 'bzz://a/', eager: undefined })
    ).toEqual({
      op: 'check',
      key: { string: 'k' },
      url: { string: 'bzz://a/' },
    });
    expect(storeParams('swarm.history', 'list')).toEqual({ op: 'list' });
    expect(storeParams('swarm.history', 'remove', { id: -0 }, 'chrome')).toEqual({
      op: 'remove',
      id: { number: '-0' },
    });
  });

  test.each([
    ['an unknown method', 'swarm.stamps', 'list', {}, 'shell', /no Swarm store method/],
    ['an unknown op', 'swarm.history', 'drop', {}, 'shell', /has no op drop/],
    ['an inherited name', 'swarm.history', 'toString', {}, 'shell', /has no op toString/],
    ['a member the op lacks', 'swarm.history', 'list', { id: 1 }, 'shell', /takes no member id/],
    [
      "main's own op from the chrome",
      'swarm.identities',
      'hasFeedGrant',
      { key: 'k' },
      'chrome',
      /not for the chrome/,
    ],
    [
      'history add from the chrome',
      'swarm.history',
      'add',
      { entry: {} },
      'chrome',
      /not for the chrome/,
    ],
    [
      'a manifest op from the chrome',
      'swarm.manifest',
      'get',
      { origin: 'o' },
      'chrome',
      /not for the chrome/,
    ],
    ['members not an object', 'swarm.history', 'remove', [1], 'shell', /members must be an object/],
  ])('%s is refused in main, unsent', async (_label, method, name, members, caller, message) => {
    expect(() => storeParams(method, name, members, caller)).toThrow(TypeError);
    expect(() => storeParams(method, name, members, caller)).toThrow(message);
    const { sent, stores } = recorder();
    const call = {
      'swarm.identities': stores.identities,
      'swarm.history': stores.history,
      'swarm.manifest': stores.manifest,
    }[method];
    if (call) {
      await expect(call(name, members, { caller })).rejects.toThrow(message);
      expect(sent).toEqual([]);
    }
  });

  test('a member no store holds is refused in main, unsent', async () => {
    const { sent, stores } = recorder();
    for (const options of [new Date(0), new Map(), Buffer.from('a'), () => {}, Symbol('s')]) {
      const err = await errorOf(
        stores.identities('previewAppScopedIdentity', { key: 'k', options })
      );
      expect(err).toBeInstanceOf(TypedFormError);
    }
    expect(sent).toEqual([]);
  });
});

describe('sending', () => {
  test("each call goes with its caller, requires swarm_stores and its method's watchdog", async () => {
    const { sent, stores } = recorder({ result_typed: { array: [] } });
    const controller = new AbortController();
    await stores.identities('get-all-origins', {}, { caller: 'chrome' });
    await stores.history('list', {}, { signal: controller.signal });
    await stores.manifest('release', { token: 't' });
    expect(sent.map(({ method, context }) => [method, context])).toEqual([
      ['swarm.identities', { caller: 'chrome' }],
      ['swarm.history', { caller: 'shell' }],
      ['swarm.manifest', { caller: 'shell' }],
    ]);
    for (const { method, options } of sent) {
      expect(options.watchdogMs).toBe(watchdogMs(method));
      expect(options.requires({ store_moved: [SWARM_STORES] })).toBe(true);
      expect(options.requires({ store_moved: [] })).toBe(false);
      expect(options.requires({})).toBe(false);
    }
    expect(sent[0].options.signal).toBeNull();
    expect(sent[1].options.signal).toBe(controller.signal);
  });

  test("the module's calls go to the running core's client, and fail core_unavailable without one", async () => {
    const { getCoreClient } = require('./core-process');
    const err = await errorOf(swarmStores.history('list'));
    expect(err).toBeInstanceOf(CoreError);
    expect(err.code).toBe('core_unavailable');
    const request = jest.fn(async () => ({ result_typed: { array: [] } }));
    getCoreClient.mockReturnValueOnce({ request });
    await expect(swarmStores.history('clear', {}, { caller: 'chrome' })).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith(
      'swarm.history',
      { op: 'clear' },
      { caller: 'chrome' },
      expect.objectContaining({ watchdogMs: watchdogMs('swarm.history') })
    );
  });

  test("on a real client whose hello didn't echo swarm_stores, a call fails requirement_unmet, unsent", async () => {
    const { CoreClient } = require('./core-client');
    const client = new CoreClient({
      spawn: () => {
        throw new Error('not spawned');
      },
      command: 'freedom-cored',
      args: [],
      grantRoot: os.tmpdir(),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      shellVersion: 'jest',
    });
    // A ready process whose hello echoed set A only, as every build's does.
    const written = [];
    client.state = 'ready';
    client.hello = { store_moved: ['vault_meta'] };
    client.current = { hello: client.hello };
    client.send = jest.fn(async (gen, method, params, context, options) => {
      if (options.requires && options.requires(gen.hello) !== true) {
        throw new CoreError('requirement_unmet', "The core can't take this request");
      }
      written.push(method);
      return {};
    });
    const stores = createSwarmStores({ request: (...args) => client.request(...args) });
    const err = await errorOf(stores.identities('get-all-origins', {}, { caller: 'chrome' }));
    expect(err.code).toBe('requirement_unmet');
    expect(written).toEqual([]);
  });
});

describe('answers', () => {
  test('a result is read back as JavaScript held it', () => {
    expect(readStoreAnswer('swarm.history', { result_typed: { undefined: true } })).toBeUndefined();
    expect(
      readStoreAnswer('swarm.identities', {
        result_typed: { object: [['a', { array: [{ number: '-0' }, { null: true }] }]] },
      })
    ).toEqual({ a: [-0, null] });
  });

  test.each([
    ['Error', Error, undefined],
    ['TypeError', TypeError, undefined],
    ['RangeError', RangeError, undefined],
    ['Error', Error, 'identity_taken'],
  ])('a thrown %s comes back as that class, its code %s', (name, ctor, code) => {
    const value = {
      object: [
        ['name', { string: name }],
        ['message', { string: 'no' }],
      ],
    };
    if (code) value.object.push(['code', { string: code }]);
    let err;
    try {
      readStoreAnswer('swarm.identities', { error_typed: value });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ctor);
    expect(err.constructor).toBe(ctor);
    expect(err.name).toBe(name);
    expect(err.message).toBe('no');
    expect(err.code).toBe(code);
    expect(Object.hasOwn(err, 'code')).toBe(code !== undefined);
  });

  const str = (s) => ({ string: s });
  test.each([
    ['null', null],
    ['an array', [{ result_typed: { null: true } }]],
    ['no member', {}],
    ['both members', { result_typed: { null: true }, error_typed: { null: true } }],
    ['another member', { result: true }],
    ['a member past the answer', { result_typed: { null: true }, extra: 1 }],
    ['a value outside the form', { result_typed: { date: 0 } }],
    [
      'bytes, which no store answers',
      { result_typed: { bytes_elsewhere: 1, kind: 'Buffer', base64: 'YQ==' } },
    ],
    ['a string with bytes', { result_typed: { string_bytes: 1, base64: 'YQ==' } }],
    ['a thrown non-object', { error_typed: str('no') }],
    [
      'a thrown class the core has none of',
      {
        error_typed: {
          object: [
            ['name', str('SyntaxError')],
            ['message', str('m')],
          ],
        },
      },
    ],
    [
      'a thrown message not a string',
      {
        error_typed: {
          object: [
            ['name', str('Error')],
            ['message', { number: '1' }],
          ],
        },
      },
    ],
    [
      'a thrown code not a string',
      {
        error_typed: {
          object: [
            ['name', str('Error')],
            ['message', str('m')],
            ['code', { null: true }],
          ],
        },
      },
    ],
    [
      'a thrown member past code',
      {
        error_typed: {
          object: [
            ['name', str('Error')],
            ['message', str('m')],
            ['status', { number: '1' }],
          ],
        },
      },
    ],
    ['a thrown name missing', { error_typed: { object: [['message', str('m')]] } }],
  ])('%s is malformed: CoreError internal', (_label, answer) => {
    let err;
    try {
      readStoreAnswer('swarm.manifest', answer);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CoreError);
    expect(err.code).toBe('internal');
    expect(err.message).toMatch(/^The core's swarm.manifest answer is malformed/);
  });

  test("the protocol's errors pass as they came", async () => {
    for (const [code, data] of [
      ['not_moved', { store: 'swarm_stores' }],
      ['not_moved', { store: 'swarm' }],
      ['invalid_argument', undefined],
      ['forbidden', undefined],
      ['busy', undefined],
      ['cancelled', undefined],
    ]) {
      const thrown = new CoreError(code, code, data);
      const { stores } = recorder(() => {
        throw thrown;
      });
      await expect(stores.manifest('get', { origin: 'o' })).rejects.toBe(thrown);
    }
  });
});

describe('the simulated core, on the reference modules', () => {
  let root;
  // Each case's references fresh, on its own Freedom root.
  let simulatedSwarmStores;

  beforeEach(() => {
    jest.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-stores-sim-'));
    require('electron').app.getPath.mockReturnValue(root);
    ({ simulatedSwarmStores } = require('../../../test/helpers/simulated-swarm-stores-core'));
  });

  afterEach(() => {
    jest.dontMock('../swarm/swarm-permissions');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('not moved, every call fails requirement_unmet, unrun, and nothing is written', async () => {
    const sim = simulatedSwarmStores({ moved: false });
    for (const [call, op, members] of [
      ['identities', 'get-all-origins', {}],
      ['history', 'list', {}],
      ['manifest', 'get', { origin: 'https://app.example' }],
    ]) {
      const err = await errorOf(sim.stores[call](op, members));
      expect(err.code).toBe('requirement_unmet');
    }
    expect(sim.calls).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
    // Sent without `requires`, the core answers not_moved itself.
    const raw = await errorOf(
      sim.request('swarm.history', { op: 'list' }, { caller: 'shell' }, {})
    );
    expect([raw.code, raw.data]).toEqual(['not_moved', { store: SWARM_STORES }]);
  });

  test('the identity ops write swarm-feeds.json as the reference does, and answer as its handlers do', async () => {
    const sim = simulatedSwarmStores();
    const key = 'https://app.example';
    expect(await sim.stores.identities('get-all-origins', {}, { caller: 'chrome' })).toEqual([]);
    const created = await sim.stores.identities('createAppScopedIdentityAt', {
      key,
      index: 0,
      options: { activate: true },
    });
    // createAppScopedIdentityAt's own answer: the site's entry.
    expect(created).toMatchObject({ activeIdentityId: 'app-scoped:0', publisherKeyIndex: 0 });
    expect(await sim.stores.identities('grantFeedAccess', { key })).toBeUndefined();
    expect(await sim.stores.identities('hasFeedGrant', { key })).toBe(true);
    const state = await sim.stores.identities(
      'get-origin-identities',
      { origin: key },
      { caller: 'chrome' }
    );
    expect(state).toMatchObject({
      origin: key,
      activeIdentityId: 'app-scoped:0',
      feedGranted: true,
    });
    expect(state.identities.find((i) => i.id === 'app-scoped:0').owner).toBe(
      `0x${'1'.padStart(40, '0')}`
    );
    const file = JSON.parse(fs.readFileSync(path.join(root, 'swarm-feeds.json'), 'utf8'));
    expect(file.origins[key]).toMatchObject({
      activeIdentityId: 'app-scoped:0',
      feedGranted: true,
    });
    expect(sim.references().feeds.getOriginEntry(key).feedGranted).toBe(true);
    expect(
      await sim.stores.identities('revoke-feed-access', { origin: key }, { caller: 'chrome' })
    ).toBe(true);
    expect(await sim.stores.identities('hasFeedGrant', { key })).toBe(false);

    // What the reference throws comes back thrown, with its class.
    const refused = await errorOf(
      sim.stores.identities('set-feed-identity', {}, { caller: 'chrome' })
    );
    expect([refused.constructor.name, refused.message]).toEqual([
      'Error',
      'Swarm feed access is granted only from its own prompt',
    ]);
    const missing = await errorOf(
      sim.stores.identities(
        'activate-feed-identity',
        { origin: key, identity_id: 'app-scoped:7' },
        { caller: 'chrome' }
      )
    );
    expect(missing.message).toBe('Publisher identity not found: app-scoped:7');
    expect(sim.calls.map(([, op, caller]) => [op, caller])).toEqual([
      ['get-all-origins', 'chrome'],
      ['createAppScopedIdentityAt', 'shell'],
      ['grantFeedAccess', 'shell'],
      ['hasFeedGrant', 'shell'],
      ['get-origin-identities', 'chrome'],
      ['revoke-feed-access', 'chrome'],
      ['hasFeedGrant', 'shell'],
      ['set-feed-identity', 'chrome'],
      ['activate-feed-identity', 'chrome'],
    ]);
  });

  test('the simulated core refuses as the core does: forbidden, invalid_argument', async () => {
    const sim = simulatedSwarmStores();
    const request = async (method, params, caller = 'shell') =>
      (await errorOf(sim.request(method, params, { caller }, {}))).code;
    const k = { string: 'k' };
    expect(await request('swarm.identities', { op: 'hasFeedGrant', key: k }, 'chrome')).toBe(
      'forbidden'
    );
    expect(await request('swarm.history', { op: 'add', entry: { object: [] } }, 'chrome')).toBe(
      'forbidden'
    );
    expect(await request('swarm.manifest', { op: 'get', origin: k }, 'chrome')).toBe('forbidden');
    for (const params of [
      { op: 'nope' },
      { op: 'list', id: { number: '1' } },
      { op: 'remove', id: { bigint: '1' } },
      { op: 'remove', id: { array: [{ hole: true }] } },
      { op: 'remove', id: { date: 1 } },
    ]) {
      expect(await request('swarm.history', params)).toBe('invalid_argument');
    }
    expect(await request('swarm.manifest', { op: 'get' })).toBe('invalid_argument');
    expect(await request('swarm.manifest', { op: 'get', origin: { number: '1' } })).toBe(
      'invalid_argument'
    );
    expect(sim.calls).toEqual([]);
  });

  test('the history ops run publish-history.js on publish-history.sqlite, add and update among them', async () => {
    const sim = simulatedSwarmStores();
    try {
      expect(await sim.stores.history('list', {}, { caller: 'chrome' })).toEqual([]);
      const added = await sim.stores.history('add', {
        entry: { type: 'file', name: 'notes.txt', origin: 'freedom://agent' },
      });
      expect(added).toMatchObject({
        id: 1,
        type: 'file',
        status: 'uploading',
        origin: 'freedom://agent',
      });
      const updated = await sim.stores.history('update', {
        id: added.id,
        updates: { status: 'completed', reference: 'ab'.repeat(32) },
      });
      expect(updated).toMatchObject({ id: 1, status: 'completed', reference: 'ab'.repeat(32) });
      expect(updated.completedAt).toEqual(expect.any(String));
      expect(await sim.stores.history('update', { id: 9, updates: {} })).toBeNull();
      expect(await sim.stores.history('list', {}, { caller: 'chrome' })).toEqual([updated]);
      const wrongType = await errorOf(
        sim.stores.history('remove', { id: true }, { caller: 'chrome' })
      );
      expect([wrongType.constructor.name, wrongType.message]).toEqual([
        'TypeError',
        'SQLite3 can only bind numbers, strings, bigints, buffers, and null',
      ]);
      expect(await sim.stores.history('remove', { id: 1 }, { caller: 'chrome' })).toBe(true);
      expect(await sim.stores.history('clear', {}, { caller: 'chrome' })).toBeUndefined();
      expect(await sim.stores.history('list', {}, { caller: 'chrome' })).toEqual([]);
      expect(fs.existsSync(path.join(root, 'publish-history.sqlite'))).toBe(true);
    } finally {
      sim.restart();
    }
  });

  test("a manifest check fetches through main's answer, and main's live answer decides its consent", async () => {
    jest.doMock('../swarm/swarm-permissions', () => ({
      getPermission: () => null,
      hasMessagingGrant: () => false,
      getAutoApprove: () => false,
      onManifestMutation: () => {},
    }));
    const manifest = {
      schema: 'freedom-manifest/1',
      name: 'Freedom Notes',
      description: 'Notes on Swarm',
      capabilities: { swarm: { publish: { why: 'To publish your notes' } } },
    };
    const asked = [];
    const sim = simulatedSwarmStores({
      fetchManifest: async (ask) => {
        asked.push(ask);
        return {
          status: 200,
          body_base64: Buffer.from(JSON.stringify(manifest)).toString('base64'),
        };
      },
    });
    const key = `bzz://${'5a'.repeat(32)}`;
    const url = `${key}/index.html`;
    expect(await sim.stores.manifest('check', { key, url })).toEqual({ kind: 'legacy' });
    expect(asked).toEqual([]);
    const consent = await sim.stores.manifest('check', { key, url, eager: true });
    expect(asked).toEqual([{ for: key, url: `${key}/freedom-manifest.json` }]);
    expect(consent).toMatchObject({ kind: 'consent', token: expect.any(String) });
    expect(consent.model).toMatchObject({ origin: key, name: 'Freedom Notes' });
    const refused = await sim.stores.manifest('decide', {
      key,
      token: consent.token,
      outcome: 'deny',
      live: false,
    });
    expect(refused).toEqual({ refused: true });
    const expired = await errorOf(
      sim.stores.manifest('decide', { key, token: consent.token, outcome: 'deny', live: true })
    );
    expect(expired.message).toBe('Manifest consent expired');
    expect(await sim.stores.manifest('release', { token: 'unknown' })).toBeUndefined();
    // The check kept what it observed, as the reference does; nothing is managed.
    expect(await sim.stores.manifest('get', { origin: key })).toMatchObject({
      app: { name: 'Freedom Notes', description: 'Notes on Swarm' },
      managed: {},
      acknowledged: {},
      revision: 0,
    });
  });
});

/** `items` with a hole at each index in `holes`. */
function withHoles(items, holes) {
  const out = [...items];
  for (const i of holes) delete out[i];
  return out;
}

describe('readTyped reads what the calls write', () => {
  test('the members of every op round-trip', () => {
    const members = {
      origin: 'https://app.example',
      options: { activate: true, label: 'ünïcødé \ud800', nested: withHoles([1, 0, null], [1]) },
    };
    const params = storeParams('swarm.identities', 'create-app-scoped-identity', {
      origin: members.origin,
      options: members.options,
    });
    const wire = JSON.parse(JSON.stringify(params));
    expect(readTyped(wire.origin)).toBe(members.origin);
    expect(readTyped(wire.options)).toEqual(members.options);
    expect(1 in readTyped(wire.options).nested).toBe(false);
  });
});
