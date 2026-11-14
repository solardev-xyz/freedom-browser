/**
 * Main's mirror of the grant stores the identity core writes (design 0012,
 * APB-3; core/grants.js): loaded from the core at each start, a key read
 * back after each write and at each `approval.changed`, answers applied in
 * the order they were asked, and nothing held before the first load or
 * for a key that couldn't be read back.
 */
const { EventEmitter } = require('events');
const grants = require('./grants');
const { simulatedGrantCore, testPage } = require('../../../test/helpers/simulated-grant-core');

const SITE = 'https://app.example';
const entry = (origin, extra = {}) => ({
  origin,
  connectedAt: 1,
  lastUsed: 1,
  autoApprove: { publish: false, feeds: false, signing: false, messaging: false },
  ...extra,
});

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let warn;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  grants.detachGrants();
  await grants._useBackendForTests(null);
  warn.mockRestore();
});

/** A core client as core-process.js attaches it: its events and readiness. */
function fakeClient() {
  return new EventEmitter();
}

test('nothing before the first load: no grant, and a request waits for the load', async () => {
  const core = simulatedGrantCore();
  core.entries.swarm[SITE] = entry(SITE);
  await grants._useBackendForTests(null);
  const store = grants.grantStore('swarm');
  expect(store.get(SITE)).toBeNull();
  let loaded = null;
  store.whenLoaded().then((ok) => {
    loaded = ok;
  });
  await settle();
  expect(loaded).toBeNull();
  // The core starts: its ready loads every store.
  const client = fakeClient();
  grants.attachGrants(client);
  await grants._useBackendForTests(core);
  expect(store.get(SITE)).toEqual(entry(SITE));
  expect(await store.whenLoaded()).toBe(true);
});

test('each start loads the store again; approval.changed reads its key again', async () => {
  const core = simulatedGrantCore();
  await grants._useBackendForTests(core);
  const client = fakeClient();
  grants.attachGrants(client);
  const store = grants.grantStore('radicle');
  core.entries.radicle[SITE] = { origin: SITE, connectedAt: 1, lastUsed: 1, signing: false, autoApprove: { node: false, signing: false } };
  expect(store.get(SITE)).toBeNull();
  client.emit('event', 'approval.changed', { store: 'radicle', key: SITE });
  await settle();
  expect(store.get(SITE)).toMatchObject({ origin: SITE });
  // Another store's change, or another event, reads nothing.
  delete core.entries.radicle[SITE];
  client.emit('event', 'approval.changed', { store: 'dapp', key: SITE });
  client.emit('event', 'vault.locked', { store: 'radicle', key: SITE });
  await settle();
  expect(store.get(SITE)).not.toBeNull();
  // A restart of the core: the whole store again.
  client.emit('ready');
  await settle();
  expect(store.get(SITE)).toBeNull();
});

test("an older answer never replaces a newer one: a key read after a load keeps its answer", async () => {
  const core = simulatedGrantCore();
  await grants._useBackendForTests(core);
  const store = grants.grantStore('swarm');
  // The load is asked first and answered last.
  let answerLoad;
  const grantsOf = core.grants;
  core.grants = (params) => {
    if (params.key === undefined) {
      const snapshot = grantsOf(params);
      return new Promise((resolve) => {
        answerLoad = () => resolve(snapshot);
      });
    }
    return grantsOf(params);
  };
  const loading = store.load();
  await settle();
  await store.grant({ op: 'connect' }, testPage(SITE));
  expect(store.get(SITE)).toMatchObject({ origin: SITE });
  answerLoad();
  await loading;
  expect(store.get(SITE)).toMatchObject({ origin: SITE });
});

test('a key that cannot be read back after a write is dropped until the core answers again', async () => {
  const core = simulatedGrantCore();
  core.entries.swarm[SITE] = entry(SITE);
  await grants._useBackendForTests(core);
  const store = grants.grantStore('swarm');
  const grantsOf = core.grants;
  core.grants = async () => {
    throw Object.assign(new Error('The identity core is not running'), { code: 'core_unavailable' });
  };
  await store.grant({ op: 'flag', flag: 'publish' }, testPage(SITE));
  expect(store.get(SITE)).toBeNull();
  core.grants = grantsOf;
  await store.load();
  expect(store.get(SITE).autoApprove.publish).toBe(true);
});

test("a write's outcome as the core reports it: a widening not applied rejects, a narrowing stands, a lost flush warns", async () => {
  const core = simulatedGrantCore();
  core.entries.swarm[SITE] = entry(SITE, { messaging: { grantedAt: 1 } });
  await grants._useBackendForTests(core);
  const store = grants.grantStore('swarm');
  const storage = (applied) =>
    Object.assign(new Error('The permission file could not be written'), {
      code: 'storage',
      data: { store: 'swarm', applied },
    });
  core.failNext('approval.grant', storage(false));
  await expect(store.grant({ op: 'flag', flag: 'feeds' }, testPage(SITE))).rejects.toMatchObject({ code: 'storage' });
  expect(store.get(SITE).autoApprove.feeds).toBe(false);
  core.failNext('approval.revoke', storage(true));
  expect(await store.revoke(SITE, 'messaging', 'chrome')).toEqual({ saved: false });
  expect(store.get(SITE).messaging).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
  const revoke = core.revoke;
  core.revoke = async (...args) => ({ ...(await revoke(...args)), durable: false });
  await store.revoke(SITE, 'grant', 'chrome');
  expect(store.get(SITE)).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('may not survive a power loss'));
});

test('a load that fails holds nothing, and reports none loaded', async () => {
  const core = simulatedGrantCore();
  core.entries.swarm[SITE] = entry(SITE);
  core.grants = async () => {
    throw Object.assign(new Error('busy'), { code: 'busy' });
  };
  await grants._useBackendForTests(core);
  const store = grants.grantStore('swarm');
  expect(store.get(SITE)).toBeNull();
  expect(await store.whenLoaded()).toBe(false);
});

test('a core client that fails for good settles the wait for the first load', async () => {
  await grants._useBackendForTests(null);
  const client = fakeClient();
  grants.attachGrants(client);
  const waiting = grants.grantStore('swarm').whenLoaded();
  client.emit('failed', 'no binary');
  expect(await waiting).toBe(false);
});
