/**
 * A page's Safe messages on the core's Safe backend (core-messages.js,
 * routed from safe-messages.js and page-devices.js; freedom-core design
 * 0016, "Messages (EIP-1271)"; SAFE-3's PR 5), against a scripted core that
 * reads each `safe.*` request as cored-v0.32.0 does
 * (test/helpers/fake-safe-core.js) and keeps message sessions as its S5
 * does, through the real vault backend and CoreClient:
 * - a page's request opens in `safe.message_start` under `page`, with `{
 *   token, handle }` from its prompt or `{ standing }` for a site's rule;
 *   main spends nothing and holds no Safe approval;
 * - the board's calls are `safe.message_sign`, `.message_state`,
 *   `.message_cancel` and `.message_complete`, each named by main's own
 *   token for the session (the SAFE-3 plan's point 7) and checked against
 *   the session it was issued for before anything is sent;
 * - a Ledger owner is refused in main, unsent, until PR 8;
 * - the core's session ID reaches nothing the renderer or the page gets;
 * - the hello still declares no `safe3`.
 */

const crypto = require('crypto');
const { startSafeCore } = require('../../../../test/helpers/fake-safe-core');

const mockWebContentsById = new Map();
jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => require('os').tmpdir() },
  webContents: { fromId: (id) => mockWebContentsById.get(id) || null },
}));
jest.mock('./safe-backend-kind', () => ({
  safeBackendKind: () => 'core',
  readSafeBackendKind: () => 'core',
}));
const mockCore = { client: null, relay: jest.fn(() => null) };
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockCore.client,
  getLedgerRelay: () => mockCore.relay(),
}));

const SAFE = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const OTHER_SAFE = '0x43aD4887971f90BB3fE4d83eCa65177281283261';
const OWNERS = ['0x' + '0a'.repeat(20), '0x' + '0b'.repeat(20), '0x' + '0c'.repeat(20)];
const mockRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  1: { index: 1, name: 'Second', address: OWNERS[1], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[2], type: 'ledger', path: "44'/60'/0'/0/0" },
  5: { index: 5, name: 'Joint', address: SAFE, type: 'safe', owners: [0, 1, 2], threshold: 2, deployed: { 100: { verified: true } } },
  7: { index: 7, name: 'Backup', address: OTHER_SAFE, type: 'safe', owners: [0, 2], threshold: 1, deployed: { 100: { verified: true } } },
};
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockRecords[index] ?? null,
  getDerivedWallets: async () => Object.values(mockRecords),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
// Today's protocol-kit path: never on the core.
jest.mock('./signature-collection', () => {
  const never = () => {
    throw new Error("main's own Safe path ran on the core");
  };
  return { release: never, acquire: never, isBusy: never, ownersView: never, collectFreeSignatures: never, signEntryOwner: never };
});

const messages = require('./safe-messages');
const { getSession, discardSession } = require('./message-sessions');
const safeApprovals = require('./safe-approvals');
const signing = require('../signing-confirmation');
const { _internal } = require('../../core/vault-backend');
const { createDeviceSigning } = require('../../page/page-devices');
const { createSafeBoards } = require('../../approvals/safe-boards');

const SITE = 'https://dapp.example';
const PAGE = { origin: SITE, top_origin: SITE, frame: 0, navigation: 4, agent: false };
const HANDLE = 'h'.repeat(64);
const HASH = '0x' + '5a'.repeat(32);
const MESSAGE = '0x48656c6c6f';
const REQUEST = { method: 'personal_sign', params: [MESSAGE, SAFE] };
const DISPLAY = { kind: 'message', site: SITE, method: 'personal_sign' };
const TAB = { origin: SITE, webContentsId: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREATED = 1764300000000;
const signatureOf = (index) => '0x' + String(index + 1).repeat(130);

const EXISTS_TEXT = 'Another signature request is already open for this account — finish or cancel it first';
const refused = (safe, message) => ({ error: { code: 'invalid_argument', message, data: { safe } } });
const plain = (message) => ({ error: { code: 'invalid_argument', message } });
const notAuthorized = (reason) => ({ error: { code: 'not_authorized', message: `not authorized: ${reason}`, data: { reason } } });

function fakeWebContents(id) {
  const listeners = new Map();
  const contents = {
    id,
    destroyed: false,
    isDestroyed: () => contents.destroyed,
    on: (event, fn) => listeners.set(event, [...(listeners.get(event) || []), fn]),
    removeListener: (event, fn) => listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn)),
    emit: (event) => {
      for (const fn of [...(listeners.get(event) || [])]) fn();
    },
    listenerCount: (event) => (listeners.get(event) || []).length,
  };
  mockWebContentsById.set(id, contents);
  return contents;
}

/**
 * A core keeping message sessions as cored's S5 does: one per Safe, its ID
 * 16 random bytes, the vault owners signed at the start while `unlocked`,
 * the page's token spent once (`tokens`) or the site's rule (`rule`)
 * checked. `hold[method]` holds that method's requests (answered later with
 * `release`), and `answers[method]` overrides its answer.
 */
function sessionCore({ unlocked = true, rule = false, tokens = ['tok-1', 'tok-2', 'tok-3'], answers = {}, hold = {} } = {}) {
  const world = { sessions: new Map(), tokens: new Set(tokens), unlocked, rule, busy: new Set(), held: [] };
  const rows = (session) =>
    mockRecords[session.safe].owners.map((index) => ({
      index,
      address: mockRecords[index].address,
      type: mockRecords[index].type,
      signed: session.signed.includes(index),
    }));
  const stateOf = (session) => ({
    safeIndex: session.safe,
    kind: 'message',
    chainId: 100,
    hash: session.hash,
    threshold: session.threshold,
    collected: session.signed.length,
    owners: rows(session),
    display: session.display,
    createdAt: CREATED,
    complete: session.signed.length >= session.threshold,
  });
  const sweep = (session) => {
    if (!world.unlocked) return;
    for (const index of mockRecords[session.safe].owners) {
      if (session.signed.length >= session.threshold) break;
      if (mockRecords[index].type === 'mnemonic' && !session.signed.includes(index)) session.signed.push(index);
    }
  };
  // requireSession's order: none open, another's ID, ended.
  const sessionFor = (params) => {
    const session = world.sessions.get(params.safe);
    if (!session) return plain('No signature request is open for this account');
    if (session.id !== params.session) return plain('This signature request belongs to a different page');
    if (session.ended) return refused('SAFE_DISCARDED', 'This signature request has ended');
    return session;
  };
  const defaults = {
    'approval.discard': () => ({}),
    'safe.message_start': ({ params }) => {
      const open = world.sessions.get(params.safe);
      if (open && !open.ended) return refused('SAFE_MESSAGE_EXISTS', EXISTS_TEXT);
      const { authorization } = params;
      if (authorization.standing) {
        if (!world.rule) return notAuthorized('no_rule');
      } else {
        if (authorization.token === 'expired') return notAuthorized('expired');
        if (!world.tokens.delete(authorization.token)) return notAuthorized('unknown_token');
        if (authorization.handle !== HANDLE) return notAuthorized('mismatch');
      }
      const session = {
        id: crypto.randomBytes(16).toString('hex'),
        safe: params.safe,
        hash: params.safe === 5 ? HASH : '0x' + '7b'.repeat(32),
        threshold: mockRecords[params.safe].threshold,
        display: params.display,
        signed: [],
        ended: false,
      };
      sweep(session);
      world.sessions.set(params.safe, session);
      return { session: session.id, state: stateOf(session) };
    },
    'safe.message_sign': ({ params }) => {
      const session = sessionFor(params);
      if (session.error) return session;
      if (params.owner === undefined || params.owner === null) {
        sweep(session);
        return stateOf(session);
      }
      if (!mockRecords[session.safe].owners.includes(params.owner)) return plain('That account is not an owner of this Safe');
      if (session.signed.includes(params.owner)) return stateOf(session);
      if (session.signed.length >= session.threshold) {
        return refused('SAFE_APPROVAL_NEEDED', 'This request needs your confirmation again before its owners can sign');
      }
      if (!world.unlocked) return { error: { code: 'vault_locked', message: 'The vault is locked' } };
      session.signed.push(params.owner);
      return stateOf(session);
    },
    'safe.message_state': ({ params }) => {
      const session = world.sessions.get(params.safe);
      return session && session.id === params.session && !session.ended ? stateOf(session) : null;
    },
    'safe.message_cancel': ({ params }) => {
      const session = world.sessions.get(params.safe);
      if (!session) return {};
      if (session.id !== params.session) return plain('This signature request belongs to a different page');
      if (world.busy.has(params.safe) && !session.ended) {
        session.ended = true;
        return refused('SAFE_BUSY', 'Wait for the current step to finish first');
      }
      world.sessions.delete(params.safe);
      return {};
    },
    'safe.message_complete': ({ params }) => {
      if (world.busy.has(params.safe)) return refused('SAFE_BUSY', 'Wait for the current step to finish first');
      const session = sessionFor(params);
      if (session.error) return session;
      if (session.signed.length < session.threshold) {
        return plain(`Not enough signatures yet (${session.signed.length} of ${session.threshold})`);
      }
      world.sessions.delete(params.safe);
      const joined = [...session.signed].sort((a, b) => mockRecords[a].address.localeCompare(mockRecords[b].address));
      return { signature: '0x' + joined.map((index) => signatureOf(index).slice(2)).join('') };
    },
  };
  const script = (message) => {
    if (hold[message.method]) {
      world.held.push(message);
      return undefined;
    }
    const answer = Object.hasOwn(answers, message.method) ? answers[message.method] : defaults[message.method];
    if (answer === undefined) return { error: { code: 'unknown_method', message: 'not scripted' } };
    return typeof answer === 'function' ? answer(message, world) : answer;
  };
  return { world, script, defaults };
}

let made = null;
let fake = null;
let world = null;
let core = null;

async function setup(options) {
  core = sessionCore(options);
  world = core.world;
  made = await startSafeCore({ log: { info() {}, warn() {}, error() {} }, script: core.script });
  mockCore.client = made.client;
  fake = made.cores[0];
  return fake;
}

/** A held request answered now, as the core's default script would. */
function release(method) {
  const message = world.held.find((held) => held.method === method);
  world.held = world.held.filter((held) => held !== message);
  const answer = core.defaults[method](message, world);
  if (answer && Object.hasOwn(answer, 'error')) fake.fail(message.id, answer.error);
  else fake.answer(message.id, answer);
}

// A burnt token's `approval.discard` goes unawaited: given time to arrive.
const arrived = () => new Promise((resolve) => setTimeout(resolve, 20));

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error('timed out');
};

/** Main's Safe requests to the core, without the hello. */
const sent = (method) =>
  fake
    .sent(method)
    .filter((m) => m.method.startsWith('safe.') || m.method.startsWith('approval.'))
    .map((m) => ({ method: m.method, caller: m.context?.caller, params: m.params }));
const methods = () => fake.methods();
const sessionId = (safe = 5) => world.sessions.get(safe)?.id ?? null;

const startByToken = (overrides = {}) =>
  messages.startSafeMessage({
    safeIndex: 5,
    request: REQUEST,
    display: DISPLAY,
    requester: TAB,
    owner: 'main',
    authorization: { token: 'tok-1', handle: HANDLE },
    page: PAGE,
    ...overrides,
  });

beforeEach(() => {
  mockWebContentsById.clear();
  fakeWebContents(3);
  fakeWebContents(4);
  signing._reset();
  safeApprovals._reset();
  _internal.reset();
  mockCore.relay.mockClear();
  for (const index of [5, 7]) discardSession(index);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await made?.client.stop();
  made = null;
  mockCore.client = null;
});

describe('a session opened by the core', () => {
  test("from the page's prompt: safe.message_start under page with { token, handle }; the state is main's, with main's token", async () => {
    await setup();
    const state = await startByToken();
    expect(sent()).toEqual([
      {
        method: 'safe.message_start',
        caller: 'page',
        params: { safe: 5, request: REQUEST, display: DISPLAY, authorization: { token: 'tok-1', handle: HANDLE } },
      },
    ]);
    expect(fake.sent('safe.message_start')[0].context.page).toEqual(PAGE);
    expect(world.tokens.has('tok-1')).toBe(false);
    // The vault owners signed at the start, to the threshold.
    expect(state).toEqual({
      safeIndex: 5,
      kind: 'message',
      token: expect.stringMatching(UUID),
      chainId: 100,
      hash: HASH,
      threshold: 2,
      collected: 2,
      owners: [
        { index: 0, address: OWNERS[0], type: 'mnemonic', signed: true },
        { index: 1, address: OWNERS[1], type: 'mnemonic', signed: true },
        { index: 2, address: OWNERS[2], type: 'ledger', signed: false },
      ],
      display: DISPLAY,
      createdAt: CREATED,
      complete: true,
    });
    expect(JSON.stringify(state)).not.toContain(sessionId());
    // Main spent nothing, hashed nothing and holds no Safe approval.
    expect(methods()).toEqual(['safe.message_start']);
    expect(safeApprovals.held('message', 5, HASH)).toBeNull();
    // The hello still declares no `safe3` (SAFE-3's PR 7 does).
    expect(fake.hello).not.toHaveProperty('safe3');
  });

  test("from a site's standing rule: { standing }, no token", async () => {
    await setup({ rule: true });
    const state = await startByToken({ authorization: { standing: {} } });
    expect(sent('safe.message_start')[0].params.authorization).toEqual({ standing: {} });
    expect(state.token).toMatch(UUID);
    await messages.cancelSafeMessage(5, state.token);
    await startByToken({ authorization: { standing: { paused: false } } });
    expect(sent('safe.message_start')[1].params.authorization).toEqual({ standing: { paused: false } });
  });

  test("the core's refusals keep their codes, and no session opens", async () => {
    await setup({ answers: { 'safe.message_start': refused('not_deployed', 'Activate this account on Gnosis before signing for apps') } });
    await expect(startByToken()).rejects.toMatchObject({
      code: 'SAFE_NOT_DEPLOYED',
      message: 'Activate this account on Gnosis before signing for apps',
    });
    expect(getSession(5)).toBeNull();
  });

  test('an expired token opens nothing', async () => {
    await setup();
    await expect(startByToken({ authorization: { token: 'expired', handle: HANDLE } })).rejects.toMatchObject({
      code: 'not_authorized',
    });
    expect(getSession(5)).toBeNull();
    expect(world.sessions.size).toBe(0);
  });

  test('an authorization in neither form is refused, unsent', async () => {
    await setup();
    for (const authorization of [undefined, { token: 'tok-1' }, { handle: HANDLE }, { standing: true }, { standing: {}, token: 'tok-1' }]) {
      await expect(startByToken({ authorization })).rejects.toThrow('This signature request was not confirmed');
    }
    expect(methods()).toEqual([]);
  });

  test("a live page's session is never replaced: SAFE_MESSAGE_EXISTS, unsent, from any page", async () => {
    await setup();
    await startByToken();
    await expect(startByToken({ authorization: { token: 'tok-2', handle: HANDLE } })).rejects.toMatchObject({
      code: 'SAFE_MESSAGE_EXISTS',
    });
    await expect(
      startByToken({ requester: { origin: SITE, webContentsId: 4 }, authorization: { token: 'tok-2', handle: HANDLE } })
    ).rejects.toMatchObject({ code: 'SAFE_MESSAGE_EXISTS' });
    expect(methods()).toEqual(['safe.message_start']);
    expect(world.tokens.has('tok-2')).toBe(true);
  });

  test("a gone page's leftover is cancelled first, then the new one opens", async () => {
    await setup();
    const first = await startByToken();
    const firstId = sessionId();
    // Gone without its events (they would cancel it at once).
    mockWebContentsById.delete(3);
    const second = await startByToken({ requester: { origin: SITE, webContentsId: 4 }, authorization: { token: 'tok-2', handle: HANDLE } });
    expect(sent().map((m) => [m.method, m.params.session ?? null])).toEqual([
      ['safe.message_start', null],
      ['safe.message_cancel', firstId],
      ['safe.message_start', null],
    ]);
    expect(second.token).not.toBe(first.token);
  });
});

describe("the board's calls, named by main's token", () => {
  test("the owners' signatures to the threshold, then the joined signature; the session gone", async () => {
    await setup({ unlocked: false });
    const opened = await startByToken();
    expect(opened).toMatchObject({ collected: 0, complete: false });
    const { token } = opened;
    world.unlocked = true;
    const one = await messages.signSafeMessage(5, 1, token);
    expect(one).toMatchObject({ token, collected: 1, complete: false });
    const two = await messages.signSafeMessage(5, 0, token);
    expect(two).toMatchObject({ token, collected: 2, complete: true });
    const id = sessionId();
    expect(sent('safe.message_sign')).toEqual([
      { method: 'safe.message_sign', caller: 'shell', params: { safe: 5, session: id, owner: 1 } },
      { method: 'safe.message_sign', caller: 'shell', params: { safe: 5, session: id, owner: 0 } },
    ]);
    expect(await messages.getSafeMessageState(5, token)).toEqual(two);
    expect(sent('safe.message_state')).toEqual([
      { method: 'safe.message_state', caller: 'shell', params: { safe: 5, session: id } },
    ]);
    expect(await messages.completeSafeMessage(5, token)).toEqual({ signature: '0x' + signatureOf(0).slice(2) + signatureOf(1).slice(2) });
    expect(sent('safe.message_complete')).toEqual([
      { method: 'safe.message_complete', caller: 'shell', params: { safe: 5, session: id } },
    ]);
    expect(getSession(5)).toBeNull();
    expect(await messages.getSafeMessageState(5, token)).toBeNull();
    for (const value of [one, two]) expect(JSON.stringify(value)).not.toContain(id);
  });

  test('the sweep names no owner; below the threshold the join is refused in the core', async () => {
    await setup({ unlocked: false });
    const { token } = await startByToken();
    await expect(messages.completeSafeMessage(5, token)).rejects.toThrow('Not enough signatures yet (0 of 2)');
    world.unlocked = true;
    expect(await messages.signSafeMessage(5, undefined, token)).toMatchObject({ collected: 2, complete: true });
    expect(await messages.signSafeMessage(5, null, token)).toMatchObject({ collected: 2 });
    expect(sent('safe.message_sign').map((m) => m.params)).toEqual([
      { safe: 5, session: sessionId() },
      { safe: 5, session: sessionId() },
    ]);
  });

  test("a locked vault is the core's vault_locked, for the board's unlock", async () => {
    await setup({ unlocked: false });
    const { token } = await startByToken();
    await expect(messages.signSafeMessage(5, 0, token)).rejects.toMatchObject({ code: 'vault_locked' });
    expect(getSession(5)).not.toBeNull();
  });

  test('discard: safe.message_cancel, the session gone; again is fine', async () => {
    await setup();
    const { token } = await startByToken();
    const id = sessionId();
    await messages.cancelSafeMessage(5, token);
    expect(sent('safe.message_cancel')).toEqual([
      { method: 'safe.message_cancel', caller: 'shell', params: { safe: 5, session: id } },
    ]);
    expect(world.sessions.size).toBe(0);
    expect(getSession(5)).toBeNull();
    await messages.cancelSafeMessage(5, token);
    expect(sent('safe.message_cancel')).toHaveLength(1);
    expect(await messages.getSafeMessageState(5, token)).toBeNull();
    await expect(messages.signSafeMessage(5, 0, token)).rejects.toThrow('No signature request is open for this account');
  });

  test("a replaced session: the earlier token is refused before anything is sent, and can't touch its successor", async () => {
    await setup({ unlocked: false });
    const first = await startByToken();
    await messages.cancelSafeMessage(5, first.token);
    const second = await startByToken({ authorization: { token: 'tok-2', handle: HANDLE } });
    const before = methods().length;
    const OTHER = 'This signature request belongs to a different page';
    await expect(messages.signSafeMessage(5, 0, first.token)).rejects.toThrow(OTHER);
    await expect(messages.completeSafeMessage(5, first.token)).rejects.toThrow(OTHER);
    await expect(messages.cancelSafeMessage(5, first.token)).rejects.toThrow(OTHER);
    expect(await messages.getSafeMessageState(5, first.token)).toBeNull();
    for (const token of [undefined, null, '', sessionId()]) {
      await expect(messages.signSafeMessage(5, 0, token)).rejects.toThrow(OTHER);
      expect(await messages.getSafeMessageState(5, token)).toBeNull();
    }
    expect(methods().length).toBe(before);
    expect(await messages.getSafeMessageState(5, second.token)).toMatchObject({ token: second.token, collected: 0 });
  });

  test("another Safe's token is another session's: refused, unsent", async () => {
    await setup({ unlocked: false });
    const five = await startByToken();
    const seven = await startByToken({
      safeIndex: 7,
      request: { method: 'personal_sign', params: [MESSAGE, OTHER_SAFE] },
      requester: { origin: SITE, webContentsId: 4 },
      authorization: { token: 'tok-2', handle: HANDLE },
    });
    const before = methods().length;
    await expect(messages.signSafeMessage(7, 0, five.token)).rejects.toThrow('This signature request belongs to a different page');
    await expect(messages.completeSafeMessage(5, seven.token)).rejects.toThrow('This signature request belongs to a different page');
    expect(await messages.getSafeMessageState(7, five.token)).toBeNull();
    expect(methods().length).toBe(before);
  });

  test('a session the core no longer has (expired with its records, or ended): refused in its words, state null', async () => {
    await setup({ unlocked: false });
    const { token } = await startByToken();
    world.sessions.delete(5);
    expect(await messages.getSafeMessageState(5, token)).toBeNull();
    await expect(messages.signSafeMessage(5, 0, token)).rejects.toThrow('No signature request is open for this account');
    await expect(messages.completeSafeMessage(5, token)).rejects.toThrow('No signature request is open for this account');
    // Its cancel finds none open, and main's entry goes.
    await messages.cancelSafeMessage(5, token);
    expect(getSession(5)).toBeNull();
  });

  test('a core process that ended took its session: none open, and the next start is not blocked', async () => {
    await setup();
    const { token } = await startByToken();
    await made.client.stop();
    made = await startSafeCore({ log: { info() {}, warn() {}, error() {} }, script: core.script });
    mockCore.client = made.client;
    fake = made.cores[0];
    world.sessions.clear();
    await expect(messages.signSafeMessage(5, 0, token)).rejects.toThrow('No signature request is open for this account');
    expect(getSession(5)).toBeNull();
    await startByToken({ authorization: { token: 'tok-2', handle: HANDLE } });
    expect(methods()).toEqual(['safe.message_start']);
  });

  test('a Ledger owner is refused in main before any device is asked, until PR 8', async () => {
    await setup({ unlocked: false });
    const { token } = await startByToken();
    const before = methods().length;
    await expect(messages.signSafeMessage(5, 2, token)).rejects.toMatchObject({
      code: 'SAFE_UNSUPPORTED',
      message: "A Ledger can't sign for a multi-owner account here yet",
    });
    expect(methods().length).toBe(before);
    expect(mockCore.relay).not.toHaveBeenCalled();
    // A vault owner of the same session still signs.
    world.unlocked = true;
    expect(await messages.signSafeMessage(5, 0, token)).toMatchObject({ collected: 1 });
  });

  test('a cancel while a step holds the Safe: the core ends it at once, SAFE_BUSY passed on; the step lands discarded', async () => {
    await setup({ unlocked: false, hold: { 'safe.message_sign': true } });
    const { token } = await startByToken();
    world.unlocked = true;
    const signing1 = messages.signSafeMessage(5, 0, token);
    await until(() => world.held.length === 1);
    // Main's own exclusion first: the join waits.
    await expect(messages.completeSafeMessage(5, token)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    world.busy.add(5);
    await expect(messages.cancelSafeMessage(5, token)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    expect(world.sessions.get(5).ended).toBe(true);
    expect(getSession(5)).toBeNull();
    world.busy.delete(5);
    release('safe.message_sign');
    await expect(signing1).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    // The ended session gives way to the next start.
    await startByToken({ authorization: { token: 'tok-2', handle: HANDLE }, requester: { origin: SITE, webContentsId: 4 } });
  });
});

describe("the session follows its page", () => {
  test('navigating or closing the page cancels it in the core', async () => {
    await setup();
    for (const event of ['did-navigate', 'destroyed']) {
      const contents = fakeWebContents(3);
      await startByToken({ authorization: { token: event === 'did-navigate' ? 'tok-1' : 'tok-2', handle: HANDLE } });
      const id = sessionId();
      contents.emit(event);
      await until(() => getSession(5) === null);
      expect(sent('safe.message_cancel').at(-1).params).toEqual({ safe: 5, session: id });
      expect(world.sessions.size).toBe(0);
      expect(contents.listenerCount('destroyed')).toBe(0);
    }
  });

  test('a cancel the core could not answer keeps the entry, ended, for the next start to cancel again', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await setup();
    const contents = fakeWebContents(3);
    const { token } = await startByToken();
    const cancel = core.defaults['safe.message_cancel'];
    core.defaults['safe.message_cancel'] = () => ({ error: { code: 'storage', message: 'try again' } });
    contents.emit('destroyed');
    await until(() => sent('safe.message_cancel').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSession(5)).not.toBeNull();
    await expect(messages.signSafeMessage(5, 0, token)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(await messages.getSafeMessageState(5, token)).toBeNull();
    core.defaults['safe.message_cancel'] = cancel;
    await startByToken({ requester: { origin: SITE, webContentsId: 4 }, authorization: { token: 'tok-2', handle: HANDLE } });
    expect(sent().map((m) => m.method)).toEqual([
      'safe.message_start',
      'safe.message_cancel',
      'safe.message_cancel',
      'safe.message_start',
    ]);
  });

  test('a page that goes while its session opens gets none: cancelled at once', async () => {
    await setup({ hold: { 'safe.message_start': true } });
    const contents = fakeWebContents(3);
    const opening = startByToken();
    await until(() => world.held.length === 1);
    contents.emit('did-navigate');
    release('safe.message_start');
    await expect(opening).rejects.toThrow('The requesting page went away before the signature request opened');
    expect(sent().map((m) => m.method)).toEqual(['safe.message_start', 'safe.message_cancel']);
    expect(world.sessions.size).toBe(0);
    expect(getSession(5)).toBeNull();
  });
});

describe("a page's request through page-devices.js", () => {
  const WALLETS = Object.values(mockRecords);
  const device = (overrides = {}) => ({
    type: 'safe',
    kind: 'safe-message',
    account: 5,
    payload: { safe: SAFE, chain_id: '100', method: 'personal_sign', params: [MESSAGE, SAFE] },
    handle: HANDLE,
    token: 'tok-1',
    ...overrides,
  });

  /** A request's context as page-requests.js gives the steps one; `prompt` the chrome's. */
  function requestContext({ prompt, approvalsDocument = false } = {}) {
    const shown = [];
    return {
      shown,
      requester: { key: SITE, guest: 3 },
      params: [MESSAGE, SAFE],
      approvalsDocument,
      nameHolds: async () => true,
      holdsKey: () => true,
      pageContext: () => ({ agent: false }),
      traceCoreToken: () => {},
      prompt: jest.fn(async (spec) => {
        shown.push(JSON.parse(JSON.stringify({ kind: spec.kind, view: spec.view })));
        return prompt(spec);
      }),
    };
  }

  const steps = (deps = {}) =>
    createDeviceSigning({
      walletList: async () => WALLETS,
      discardToken: (token) => signing.discardConfirmation(token),
      spendSafe: jest.fn(async () => {
        throw new Error('main spent a Safe token on the core');
      }),
      safeBoards: () => null,
      safeOnCore: () => true,
      ...deps,
    });

  test("the chrome's board (approvals document off): main's token in its view, the owners signed with it, the joined signature the page's", async () => {
    await setup({ unlocked: false });
    let id = null;
    const ipc = [];
    // The chrome's board, as safe-signing.js drives wallet:safe-message-*.
    const context = requestContext({
      prompt: async ({ view }) => {
        id = sessionId();
        const { token } = view.state;
        world.unlocked = true;
        ipc.push(await messages.getSafeMessageState(view.safeIndex, token));
        ipc.push(await messages.signSafeMessage(view.safeIndex, 0, token));
        ipc.push(await messages.signSafeMessage(view.safeIndex, 1, token));
        return { approve: true };
      },
    });
    const answer = await steps().sign(context, device(), PAGE);
    await arrived();
    expect(answer).toEqual({ result: '0x' + signatureOf(0).slice(2) + signatureOf(1).slice(2) });
    expect(context.shown).toEqual([
      { kind: 'eth.safe_message', view: { safeIndex: 5, state: expect.objectContaining({ token: expect.stringMatching(UUID), collected: 0 }) } },
    ]);
    expect(sent().map((m) => m.method)).toEqual([
      'safe.message_start',
      'safe.message_state',
      'safe.message_sign',
      'safe.message_sign',
      'safe.message_complete',
      'approval.discard',
    ]);
    expect(sent('safe.message_start')[0]).toMatchObject({
      caller: 'page',
      params: { authorization: { token: 'tok-1', handle: HANDLE }, display: DISPLAY },
    });
    // The core's session ID: in nothing the renderer or the page got.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    for (const given of [context.shown, ipc, answer]) expect(JSON.stringify(given)).not.toContain(id);
    expect(getSession(5)).toBeNull();
  });

  test("the approvals document's board: main runs it over the core's session; no token or ID in its views", async () => {
    await setup({ unlocked: false });
    let id = null;
    const boards = createSafeBoards({
      getDerivedWallets: async () => WALLETS,
      sends: {},
      messages: {
        state: (safeIndex, token) => messages.getSafeMessageState(safeIndex, token),
        sign: (safeIndex, owner, token) => messages.signSafeMessage(safeIndex, owner, token),
      },
      walletPrompt: async () => ({}),
      walletUnlock: async () => ({}),
      confirmExecutorFee: async () => null,
    });
    const decisions = [
      { approve: true, choices: { action: 'sign', owner: 2 } },
      { approve: true, choices: { action: 'sign', owner: 1 } },
      { approve: true, choices: { action: 'sign', owner: 0 } },
    ];
    const context = requestContext({
      approvalsDocument: true,
      prompt: async ({ released }) => {
        id = id ?? sessionId();
        world.unlocked = true;
        void released;
        return decisions.shift();
      },
    });
    const answer = await steps({ safeBoards: () => boards }).sign(context, device(), PAGE);
    expect(answer).toEqual({ result: '0x' + signatureOf(0).slice(2) + signatureOf(1).slice(2) });
    // The Ledger owner's row noted, with nothing sent for it.
    expect(context.shown[1].view.notes).toEqual([
      { owner: 2, note: 'failed', message: "A Ledger can't sign for a multi-owner account here yet" },
    ]);
    expect(sent('safe.message_sign').map((m) => m.params.owner)).toEqual([undefined, 1, 0]);
    expect(mockCore.relay).not.toHaveBeenCalled();
    for (const { view } of context.shown) {
      expect(view).not.toHaveProperty('token');
      expect(JSON.stringify(view)).not.toContain(id);
    }
    expect(JSON.stringify(answer)).not.toContain(id);
  });

  test("a rejected board: the session cancelled in the core, the page's 4001", async () => {
    await setup({ unlocked: false });
    const context = requestContext({ prompt: async () => ({ approve: false }) });
    expect(await steps().sign(context, device(), PAGE)).toEqual({ error: { code: 4001, message: 'User rejected the request' } });
    await arrived();
    expect(sent().map((m) => m.method)).toEqual(['safe.message_start', 'safe.message_cancel', 'approval.discard']);
    expect(world.sessions.size).toBe(0);
  });

  test("complete at its start: no board, the signature the page's at once", async () => {
    await setup();
    const context = requestContext({ prompt: async () => ({ approve: false }) });
    expect(await steps().sign(context, device(), PAGE)).toEqual({
      result: '0x' + signatureOf(0).slice(2) + signatureOf(1).slice(2),
    });
    expect(context.prompt).not.toHaveBeenCalled();
  });

  test("a site's rule (`standing: true`): { standing }, no token presented", async () => {
    await setup({ rule: true });
    const context = requestContext({ prompt: async () => ({ approve: false }) });
    expect(await steps().sign(context, device({ token: undefined, standing: true }), PAGE)).toMatchObject({ result: expect.any(String) });
    expect(sent('safe.message_start')[0].params.authorization).toEqual({ standing: {} });
  });

  test("the core's refusal is the page's error, the token burnt", async () => {
    await setup();
    const context = requestContext({ prompt: async () => ({ approve: true }) });
    expect(await steps().sign(context, device({ token: 'expired' }), PAGE)).toEqual({
      error: { code: -32603, message: 'not authorized: expired' },
    });
    await arrived();
    expect(sent().map((m) => m.method)).toEqual(['safe.message_start', 'approval.discard']);
  });

  test('on js, as before: the token spent for a Safe approval, and no safe.message_start', async () => {
    const approval = { id: 'a'.repeat(32), page: PAGE };
    const spendSafe = jest.fn(async () => ({ approval }));
    const startSafeMessage = jest.fn(async () => ({ complete: true, token: 'session' }));
    const answer = await createDeviceSigning({
      walletList: async () => WALLETS,
      discardToken: () => {},
      spendSafe,
      startSafeMessage,
      completeSafeMessage: async () => ({ signature: '0xab' }),
      cancelSafeMessage: async () => {},
      safeBoards: () => null,
      safeOnCore: () => false,
    }).sign(requestContext({ prompt: async () => ({}) }), device(), PAGE);
    expect(answer).toEqual({ result: '0xab' });
    expect(spendSafe).toHaveBeenCalledTimes(1);
    expect(startSafeMessage).toHaveBeenCalledWith({
      safeIndex: 5,
      request: { method: 'personal_sign', params: [MESSAGE, SAFE] },
      display: DISPLAY,
      requester: TAB,
      owner: 'main',
      approval,
    });
  });
});
