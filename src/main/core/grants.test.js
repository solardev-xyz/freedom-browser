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

describe('no stale grant while the core answers (review of #1252)', () => {
  test('approval.changed: the key reads as no grant at once, until its read lands; a widening shows once it does', async () => {
    const core = simulatedGrantCore();
    core.entries.swarm[SITE] = entry(SITE, { autoApprove: { publish: true, feeds: false, signing: false, messaging: false } });
    await grants._useBackendForTests(core);
    const client = fakeClient();
    grants.attachGrants(client);
    const store = grants.grantStore('swarm');
    expect(store.get(SITE).autoApprove.publish).toBe(true);
    // The core turns the rule off and reports it; its read is held.
    const reads = core.holdKeyReads();
    core.entries.swarm[SITE].autoApprove.publish = false;
    client.emit('event', 'approval.changed', { store: 'swarm', key: SITE });
    expect(store.get(SITE)).toBeNull();
    expect(store.all()).toEqual([]);
    await settle();
    expect(reads.count).toBe(1);
    expect(store.get(SITE)).toBeNull();
    reads.release();
    await settle();
    expect(store.get(SITE).autoApprove.publish).toBe(false);
    // A widening reads as no grant too until its read lands, then shows.
    const again = core.holdKeyReads();
    core.entries.swarm[SITE].messaging = { grantedAt: 2 };
    client.emit('event', 'approval.changed', { store: 'swarm', key: SITE });
    expect(store.get(SITE)).toBeNull();
    again.release();
    await settle();
    expect(store.get(SITE).messaging).toEqual({ grantedAt: 2 });
  });

  test('a read in flight before a change can\'t bring the record back; a read that fails drops the key', async () => {
    const core = simulatedGrantCore();
    core.entries.radicle[SITE] = { origin: SITE, connectedAt: 1, lastUsed: 1, signing: true, autoApprove: { node: true, signing: true } };
    await grants._useBackendForTests(core);
    const client = fakeClient();
    grants.attachGrants(client);
    const store = grants.grantStore('radicle');
    // A read asked while the grant stood, answered after the core's revoke.
    const early = core.holdKeyReads();
    client.emit('event', 'approval.changed', { store: 'radicle', key: SITE });
    delete core.entries.radicle[SITE];
    const late = core.holdKeyReads();
    client.emit('event', 'approval.changed', { store: 'radicle', key: SITE });
    early.release();
    await settle();
    expect(store.get(SITE)).toBeNull();
    late.release();
    await settle();
    expect(store.get(SITE)).toBeNull();
    // A changed key whose read fails stays dropped.
    core.entries.radicle[SITE] = { origin: SITE, connectedAt: 1, lastUsed: 1, signing: false, autoApprove: { node: false, signing: false } };
    await store.load();
    expect(store.get(SITE)).not.toBeNull();
    const grantsOf = core.grants;
    core.grants = async () => {
      throw Object.assign(new Error('busy'), { code: 'busy' });
    };
    client.emit('event', 'approval.changed', { store: 'radicle', key: SITE });
    await settle();
    expect(store.get(SITE)).toBeNull();
    core.grants = grantsOf;
  });

  test('main\'s own revoke or connect hides the key from before the core answers until the read after it; a widening and a last use don\'t', async () => {
    const core = simulatedGrantCore();
    core.entries.swarm[SITE] = entry(SITE, { messaging: { grantedAt: 1 } });
    await grants._useBackendForTests(core);
    const store = grants.grantStore('swarm');
    // The core's write is held: the key already reads as no grant.
    let answer;
    const revoke = core.revoke;
    core.revoke = (...args) =>
      new Promise((resolve) => {
        answer = () => resolve(revoke(...args));
      });
    const writing = store.revoke(SITE, 'messaging', 'chrome');
    await settle();
    expect(store.get(SITE)).toBeNull();
    // Then the core's answer, with the read after it held.
    const reads = core.holdKeyReads();
    answer();
    await settle();
    expect(store.get(SITE)).toBeNull();
    reads.release();
    await writing;
    expect(store.get(SITE)).toMatchObject({ origin: SITE });
    expect(store.get(SITE).messaging).toBeUndefined();
    // A widening keeps the narrower record while the core writes it.
    let answerGrant;
    const grant = core.grant;
    core.grant = (...args) =>
      new Promise((resolve) => {
        answerGrant = () => resolve(grant(...args));
      });
    const widening = store.grant({ op: 'flag', flag: 'publish' }, testPage(SITE));
    await settle();
    expect(store.get(SITE).autoApprove.publish).toBe(false);
    answerGrant();
    await widening;
    expect(store.get(SITE).autoApprove.publish).toBe(true);
    // A connect replaces the record and its rules: hidden while it's written.
    const connecting = store.grant({ op: 'connect' }, testPage(SITE));
    await settle();
    expect(store.get(SITE)).toBeNull();
    answerGrant();
    await connecting;
    expect(store.get(SITE).autoApprove.publish).toBe(false);
    core.grant = grant;
    // A last use: the record stays while the touch and its read are out.
    const touchReads = core.holdKeyReads();
    const touching = store.touch(testPage(SITE));
    await settle();
    expect(store.get(SITE)).toMatchObject({ origin: SITE });
    touchReads.release();
    await touching;
    expect(store.get(SITE)).toMatchObject({ origin: SITE });
  });

  test("a write resolves only once the read the core's approval.changed asked has landed", async () => {
    const core = simulatedGrantCore();
    core.entries.swarm[SITE] = entry(SITE);
    await grants._useBackendForTests(core);
    const client = fakeClient();
    grants.attachGrants(client);
    const store = grants.grantStore('swarm');
    // Each read of the key answered when the test says.
    const answers = [];
    const grantsOf = core.grants;
    core.grants = (params) => {
      const reply = grantsOf(params);
      if (params.key === undefined) return reply;
      return new Promise((resolve) => answers.push(() => resolve(reply)));
    };
    let done = false;
    const writing = store.grant({ op: 'messaging' }, testPage(SITE)).then(() => {
      done = true;
    });
    await settle();
    expect(answers).toHaveLength(1);
    // As the core does, approval.changed after the reply: the key is
    // forgotten after the write's own read was asked, and read again.
    client.emit('event', 'approval.changed', { store: 'swarm', key: SITE });
    expect(answers).toHaveLength(1);
    await settle();
    expect(answers).toHaveLength(2);
    answers[0]();
    await settle();
    expect(done).toBe(false);
    expect(store.get(SITE)).toBeNull();
    answers[1]();
    await writing;
    expect(store.get(SITE).messaging).toEqual({ grantedAt: expect.any(Number) });
  });
});

describe('one mirror per core process (review of #1252)', () => {
  test('an exit empties the mirror and a request waits; the old process\'s late load loads nothing; the next start\'s load answers', async () => {
    const core = simulatedGrantCore();
    core.entries.swarm[SITE] = entry(SITE);
    await grants._useBackendForTests(core);
    const client = fakeClient();
    grants.attachGrants(client);
    const store = grants.grantStore('swarm');
    // A load the old process was asked, answered after its exit.
    let answerLoad;
    const grantsOf = core.grants;
    core.grants = (params) => {
      const reply = grantsOf(params);
      if (params.key !== undefined) return reply;
      return new Promise((resolve) => {
        answerLoad = () => resolve(reply);
      });
    };
    const oldLoad = store.load();
    await settle();
    client.emit('exit', { code: 1 });
    expect(store.get(SITE)).toBeNull();
    let loaded = null;
    store.whenLoaded().then((ok) => {
      loaded = ok;
    });
    answerLoad();
    expect(await oldLoad).toBe(false);
    await settle();
    expect(loaded).toBeNull();
    expect(store.get(SITE)).toBeNull();
    // The next process starts, with the site's grant gone from its file.
    core.grants = grantsOf;
    delete core.entries.swarm[SITE];
    client.emit('ready');
    await settle();
    expect(loaded).toBe(true);
    expect(store.get(SITE)).toBeNull();
  });

  test('a start empties the mirror too, until its load; one that fails, or a client that gives up, answers false and holds nothing', async () => {
    const core = simulatedGrantCore();
    core.entries.radicle[SITE] = { origin: SITE, connectedAt: 1, lastUsed: 1, signing: true, autoApprove: { node: true, signing: true } };
    await grants._useBackendForTests(core);
    const client = fakeClient();
    grants.attachGrants(client);
    const store = grants.grantStore('radicle');
    expect(store.get(SITE)).not.toBeNull();
    // A start whose load fails: nothing held, and false.
    const grantsOf = core.grants;
    core.grants = async () => {
      throw Object.assign(new Error('busy'), { code: 'busy' });
    };
    client.emit('ready');
    expect(store.get(SITE)).toBeNull();
    expect(await store.whenLoaded()).toBe(false);
    // The next start loads.
    core.grants = grantsOf;
    client.emit('ready');
    expect(await store.whenLoaded()).toBe(true);
    expect(store.get(SITE)).not.toBeNull();
    // The client gives up: nothing held, and false, until a start loads.
    client.emit('failed', 'three crashes within a minute');
    expect(store.get(SITE)).toBeNull();
    expect(store.all()).toEqual([]);
    expect(await store.whenLoaded()).toBe(false);
    client.emit('ready');
    expect(await store.whenLoaded()).toBe(true);
  });
});
