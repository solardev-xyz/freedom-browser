/**
 * The safe namespace (vault-backend.js `safe`; freedom-core design 0016,
 * SAFE-3's base, the plan's PR 2) against a scripted core that reads each
 * `safe.*` request as cored-v0.32.0 does (test/helpers/fake-safe-core.js),
 * through the real CoreClient:
 * - each of the 16 methods sends exactly the members the core reads, an
 *   optional one only when given and nothing a caller adds, from a caller
 *   its row admits, and the core reads every one whole;
 * - the methods and their callers are the core's table's (`protocol/
 *   schema.json`, when it is found) and main's deadline classes';
 * - the stores' requirements: `vault_meta` for all, `safe_pending` too for
 *   the five that read or write the pending store, refused in main,
 *   unsent;
 * - a site's `safe.propose` (SAFE-3's PR 7) goes only to a core that took
 *   the hello's `safe3`, which main declares only on the core's Safe
 *   backend: on js, and to a core before 0.32.0, it is refused in main,
 *   unsent;
 * - a refusal's `data.safe` takes main's code (wallet/safe/errors.js);
 * - a Safe owner's signature goes through `ledgerCall` only, `ledgerOwner`
 *   from main's own record of the owner.
 * The scripted core's own reading is checked against the core's rules
 * first. The watchdogs are vault-backend-safe-watchdog.test.js's.
 */

const fs = require('fs');
const path = require('path');
const { METHOD_CLASSES } = require('./core-deadlines');
const { CORE_SAFE_CODES } = require('../wallet/safe/errors');
const {
  DEFAULT_RESULTS,
  SAFE_ROWS,
  SESSION_ID,
  PROXY_FACTORY,
  readSafe,
  readSafe3,
  startSafeCore,
} = require('../../../test/helpers/fake-safe-core');

// The process's Safe backend (wallet/safe/safe-backend-kind.js): the
// core's, whose hello declares `safe3`, unless a test says js.
const mockSafeBackend = { kind: 'core' };
jest.mock('../wallet/safe/safe-backend-kind', () => ({
  safeBackendKind: () => mockSafeBackend.kind,
  readSafeBackendKind: () => mockSafeBackend.kind,
}));

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise(setImmediate);
};

const PAGE = {
  origin: 'https://dapp.example',
  top_origin: 'https://dapp.example',
  frame: 0,
  navigation: 3,
};
const HASH = '0x' + '1a'.repeat(32);
const TX_HASH = '0x' + '2b'.repeat(32);
const TO = '0x' + '33'.repeat(20);
const TOKEN = 'token-' + '4c'.repeat(16);
const HANDLE = 'handle-1';
const BOTH = ['vault_meta', 'safe_pending'];
const SHELL = { caller: 'shell' };
const CHROME = { caller: 'chrome' };
const ON_PAGE = { caller: 'page', page: PAGE };

// Main's own records: index 2 is a Ledger's account, 0 and 1 the vault's.
const RECORDS = {
  0: { index: 0, type: 'mnemonic' },
  1: { index: 1, type: 'mnemonic' },
  2: { index: 2, type: 'ledger', path: "44'/60'/0'/0/0" },
};

/**
 * Each method called with every member it takes, and as little as it
 * takes: `[name, call(safe), wire method, wire context, wire params]`.
 */
const CALLS = [
  [
    'create',
    (s) => s.create({ name: 'Team', owners: [0, 2], threshold: 2 }),
    'safe.create',
    SHELL,
    { name: 'Team', owners: [0, 2], threshold: 2 },
  ],
  [
    'create, the chrome’s, without a name',
    (s) => s.create({ owners: [0, 1], threshold: 1 }, 'chrome'),
    'safe.create',
    CHROME,
    { owners: [0, 1], threshold: 1 },
  ],
  ['status', (s) => s.status({ safe: 7 }), 'safe.status', SHELL, { safe: 7 }],
  [
    'status, the chrome’s',
    (s) => s.status({ safe: 7 }, 'chrome'),
    'safe.status',
    CHROME,
    { safe: 7 },
  ],
  ['deploy', (s) => s.deploy({ safe: 7 }), 'safe.deploy', SHELL, { safe: 7 }],
  [
    'deploy with fee_ack',
    (s) => s.deploy({ safe: 7, fee_ack: true }, 'chrome'),
    'safe.deploy',
    CHROME,
    { safe: 7, fee_ack: true },
  ],
  [
    'deployed',
    (s) => s.deployed({ safe: 7, hash: HASH }),
    'safe.deployed',
    SHELL,
    { safe: 7, hash: HASH },
  ],
  ['pending', (s) => s.pending(), 'safe.pending', SHELL, {}],
  ['pending, the chrome’s', (s) => s.pending('chrome'), 'safe.pending', CHROME, {}],
  ['discard', (s) => s.discard({ safe: 7 }), 'safe.discard', SHELL, { safe: 7 }],
  [
    'discard a named SafeTx',
    (s) => s.discard({ safe: 7, safe_tx_hash: TX_HASH }, 'chrome'),
    'safe.discard',
    CHROME,
    { safe: 7, safe_tx_hash: TX_HASH },
  ],
  [
    'prepare, the wallet’s',
    (s) => s.prepare({ safe: 7, chain_id: 100, tx: { to: TO, value: '0x1', data: '0x' } }),
    'safe.prepare',
    SHELL,
    { safe: 7, chain_id: 100, tx: { to: TO, value: '0x1', data: '0x' } },
  ],
  [
    'prepare, a site’s',
    (s) =>
      s.prepare(
        { safe: 7, chain_id: '0x64', tx: { to: TO, value: '0', data: '0xa9059cbb' } },
        PAGE
      ),
    'safe.prepare',
    ON_PAGE,
    { safe: 7, chain_id: '0x64', tx: { to: TO, value: '0', data: '0xa9059cbb' } },
  ],
  [
    'propose, the wallet’s',
    (s) => s.propose({ safe: 7, safe_tx_hash: TX_HASH, authorization: { token: TOKEN } }),
    'safe.propose',
    SHELL,
    { safe: 7, safe_tx_hash: TX_HASH, authorization: { token: TOKEN } },
  ],
  [
    'propose, a site’s, with display',
    (s) =>
      s.propose(
        {
          safe: 7,
          safe_tx_hash: TX_HASH,
          authorization: { token: TOKEN, handle: HANDLE },
          display: { title: 'Send', amount: '1' },
        },
        PAGE
      ),
    'safe.propose',
    ON_PAGE,
    {
      safe: 7,
      safe_tx_hash: TX_HASH,
      authorization: { token: TOKEN, handle: HANDLE },
      display: { title: 'Send', amount: '1' },
    },
  ],
  ['execute', (s) => s.execute({ safe: 7 }), 'safe.execute', SHELL, { safe: 7 }],
  [
    'execute with fee_ack, a named SafeTx',
    (s) => s.execute({ safe: 7, fee_ack: true, safe_tx_hash: TX_HASH }, 'chrome'),
    'safe.execute',
    CHROME,
    { safe: 7, fee_ack: true, safe_tx_hash: TX_HASH },
  ],
  [
    'executed',
    (s) => s.executed({ safe: 7, safe_tx_hash: TX_HASH, hash: HASH }),
    'safe.executed',
    SHELL,
    { safe: 7, safe_tx_hash: TX_HASH, hash: HASH },
  ],
  [
    'messageStart with a token',
    (s) =>
      s.messageStart(
        {
          safe: 7,
          request: { method: 'personal_sign', params: ['0x68656c6c6f', TO] },
          authorization: { token: TOKEN, handle: HANDLE },
        },
        PAGE
      ),
    'safe.message_start',
    ON_PAGE,
    {
      safe: 7,
      request: { method: 'personal_sign', params: ['0x68656c6c6f', TO] },
      authorization: { token: TOKEN, handle: HANDLE },
    },
  ],
  [
    'messageStart by a standing rule, with display',
    (s) =>
      s.messageStart(
        {
          safe: 7,
          request: { method: 'eth_signTypedData_v4', params: [TO, '{}'] },
          display: { origin: 'dapp.example' },
          authorization: { standing: { paused: false } },
        },
        PAGE
      ),
    'safe.message_start',
    ON_PAGE,
    {
      safe: 7,
      request: { method: 'eth_signTypedData_v4', params: [TO, '{}'] },
      display: { origin: 'dapp.example' },
      authorization: { standing: { paused: false } },
    },
  ],
  [
    'messageStart by a standing rule, unpaused',
    (s) =>
      s.messageStart(
        {
          safe: 7,
          request: { method: 'personal_sign', params: ['0x00', TO] },
          authorization: { standing: {} },
        },
        PAGE
      ),
    'safe.message_start',
    ON_PAGE,
    {
      safe: 7,
      request: { method: 'personal_sign', params: ['0x00', TO] },
      authorization: { standing: {} },
    },
  ],
  [
    'messageSign, the sweep',
    (s) => s.messageSign({ safe: 7, session: SESSION_ID }),
    'safe.message_sign',
    SHELL,
    { safe: 7, session: SESSION_ID },
  ],
  [
    'messageSign, one owner, the chrome’s',
    (s) => s.messageSign({ safe: 7, session: SESSION_ID, owner: 1 }, { caller: 'chrome' }),
    'safe.message_sign',
    CHROME,
    { safe: 7, session: SESSION_ID, owner: 1 },
  ],
  [
    'messageState',
    (s) => s.messageState({ safe: 7, session: SESSION_ID }),
    'safe.message_state',
    SHELL,
    { safe: 7, session: SESSION_ID },
  ],
  [
    'messageCancel',
    (s) => s.messageCancel({ safe: 7, session: SESSION_ID }, 'chrome'),
    'safe.message_cancel',
    CHROME,
    { safe: 7, session: SESSION_ID },
  ],
  [
    'messageComplete',
    (s) => s.messageComplete({ safe: 7, session: SESSION_ID }),
    'safe.message_complete',
    SHELL,
    { safe: 7, session: SESSION_ID },
  ],
  ['signOwner, the sweep', (s) => s.signOwner({ safe: 7 }), 'safe.sign_owner', SHELL, { safe: 7 }],
  [
    'signOwner, a Ledger owner, a named SafeTx',
    (s) => s.signOwner({ safe: 7, owner: 2, safe_tx_hash: TX_HASH }, { caller: 'chrome' }),
    'safe.sign_owner',
    CHROME,
    { safe: 7, owner: 2, safe_tx_hash: TX_HASH },
  ],
];

/** The vault backend on a real CoreClient against FakeSafeCores (`options`). */
async function setup(options = {}) {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const made = await startSafeCore({ log, ...options });
  jest.resetModules();
  jest.doMock('./core-process', () => ({
    getCoreClient: () => made.client,
    getLedgerRelay: () => null,
  }));
  jest.doMock('../identity-manager', () => ({
    getWalletRecord: (index) => RECORDS[index] ?? null,
    WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', SAFE: 'safe' },
  }));
  const mod = require('./vault-backend');
  mod._internal.reset();
  return { ...made, ...mod, core: made.cores[0], log };
}

let made = null;

afterEach(async () => {
  await made?.client.stop();
  made = null;
  mockSafeBackend.kind = 'core';
  jest.restoreAllMocks();
});

describe('the scripted core reads a safe.* request as cored-v0.32.0 does', () => {
  const read = (method, params, context = SHELL, moved = BOTH) => {
    try {
      readSafe(method, params, context, moved);
      return null;
    } catch (err) {
      if (!err.body) throw err;
      return err.body;
    }
  };

  test('a caller its row lists, and no other: forbidden', () => {
    expect(read('safe.status', { safe: 7 }, ON_PAGE)).toMatchObject({ code: 'forbidden' });
    expect(read('safe.deployed', { safe: 7, hash: HASH }, CHROME)).toMatchObject({
      code: 'forbidden',
    });
    expect(
      read('safe.executed', { safe: 7, safe_tx_hash: HASH, hash: HASH }, CHROME)
    ).toMatchObject({ code: 'forbidden' });
    const start = { safe: 7, request: { method: 'personal_sign', params: [] }, authorization: {} };
    for (const context of [SHELL, CHROME]) {
      expect(read('safe.message_start', start, context)).toMatchObject({ code: 'forbidden' });
    }
    for (const method of ['safe.sign_owner', 'safe.message_sign', 'safe.execute']) {
      expect(read(method, { safe: 7 }, ON_PAGE)).toMatchObject({ code: 'forbidden' });
    }
    // Before the stores and the params.
    expect(read('safe.status', { odd: 1 }, ON_PAGE, [])).toMatchObject({ code: 'forbidden' });
  });

  test("the stores, in the core's order", () => {
    for (const method of Object.keys(SAFE_ROWS)) {
      const context = method === 'safe.message_start' ? ON_PAGE : SHELL;
      expect(read(method, { odd: 1 }, context, [])).toEqual({
        code: 'not_moved',
        message: "main still writes vault-meta.json (vault_meta isn't in store_moved)",
        data: { store: 'vault_meta' },
      });
    }
    const pendingFirst = ['safe.execute', 'safe.executed', 'safe.propose', 'safe.sign_owner'];
    for (const method of pendingFirst) {
      expect(read(method, { odd: 1 }, SHELL, ['vault_meta'])).toMatchObject({
        code: 'not_moved',
        data: { store: 'safe_pending' },
      });
    }
    // `safe.discard` reads its params first.
    expect(read('safe.discard', { odd: 1 }, SHELL, ['vault_meta'])).toMatchObject({
      code: 'invalid_argument',
    });
    expect(read('safe.discard', { safe: 7 }, SHELL, ['vault_meta'])).toMatchObject({
      code: 'not_moved',
      data: { store: 'safe_pending' },
    });
    // The rest need only vault_meta.
    for (const [, , method, context, params] of CALLS) {
      if (SAFE_ROWS[method].pending) continue;
      expect(read(method, params, context, ['vault_meta'])).toBeNull();
    }
  });

  test('only its members, each read as the core reads it', () => {
    const invalid = { code: 'invalid_argument', message: 'Invalid parameters' };
    const refusals = [
      ['safe.status', { safe: 7, chain_id: 100 }],
      ['safe.status', {}],
      ['safe.status', null],
      ['safe.status', []],
      ['safe.status', { safe: -1 }],
      ['safe.status', { safe: 1.5 }],
      ['safe.status', { safe: '7' }],
      ['safe.status', { safe: 2 ** 53 }],
      ['safe.pending', { safe: 7 }],
      ['safe.deploy', { safe: 7, fee_ack: null }],
      ['safe.deploy', { safe: 7, fee_ack: 'yes' }],
      ['safe.deployed', { safe: 7 }],
      ['safe.deployed', { safe: 7, hash: '0x1234' }],
      ['safe.deployed', { safe: 7, hash: '1a'.repeat(32) }],
      ['safe.discard', { safe: 7, safe_tx_hash: 7 }],
      ['safe.execute', { safe: 7, safe_tx_hash: 'abc' }],
      ['safe.execute', { safe: 7, fee_ack: 1 }],
      ['safe.executed', { safe: 7, safe_tx_hash: HASH }],
      ['safe.sign_owner', { safe: 7, owner: -1 }],
      ['safe.sign_owner', { safe: 7, owner: 'ledger' }],
      ['safe.sign_owner', { safe: 7, safe_tx_hash: '0x' }],
      ['safe.sign_owner', { safe: 7, ledger: true }],
      ['safe.message_sign', { safe: 7 }],
      ['safe.message_sign', { safe: 7, session: 7 }],
      ['safe.message_sign', { safe: 7, session: SESSION_ID, owner: 1.5 }],
      ['safe.message_state', { safe: 7, session: SESSION_ID, owner: 1 }],
      ['safe.message_cancel', { session: SESSION_ID }],
      ['safe.message_complete', { safe: 7, session: null }],
      ['safe.prepare', { safe: 7, tx: { to: TO, value: '0', data: '0x' } }],
      ['safe.prepare', { safe: 7, chain_id: true, tx: { to: TO, value: '0', data: '0x' } }],
      ['safe.prepare', { safe: 7, chain_id: 100 }],
      ['safe.propose', { safe: 7, safe_tx_hash: TX_HASH }],
      ['safe.propose', { safe: 7, authorization: { token: TOKEN } }],
      ['safe.create', { name: 'x', owners: [0, 1], threshold: 1, salt: '1' }],
    ];
    for (const [method, params] of refusals) {
      expect([method, read(method, params)]).toEqual([method, invalid]);
    }
    // A page's request needs its page's origin.
    expect(
      read(
        'safe.prepare',
        { safe: 7, chain_id: 100, tx: { to: TO, value: '0', data: '0x' } },
        {
          caller: 'page',
          page: { ...PAGE, origin: '' },
        }
      )
    ).toEqual({ code: 'invalid_argument', message: "a page request needs its page's origin" });
  });

  test("a SafeTx's call is exactly { to, value, data }, read as sign.transaction reads it", () => {
    const prepare = (tx) => read('safe.prepare', { safe: 7, chain_id: 100, tx });
    const message = (tx) => prepare(tx)?.message ?? null;
    expect(message({ to: TO, value: '0', data: '0x' })).toBeNull();
    expect(message({ to: TO, value: '0x0', data: '0X' + 'ab'.repeat(64 * 1024) })).toBeNull();
    expect(message({ to: TO, value: '0', data: '0x', from: TO })).toBe(
      'tx: expected { to, value, data }'
    );
    expect(message({ to: TO, value: '0' })).toBe('tx: expected { to, value, data }');
    expect(message({ to: TO, value: 0, data: '0x' })).toBe('Invalid value');
    expect(message({ to: TO, value: '-1', data: '0x' })).toBe('Invalid value');
    expect(message({ to: TO, value: '1e3', data: '0x' })).toBe('Invalid value');
    expect(message({ to: TO, value: '0', data: '0xabc' })).toBe('Invalid data');
    expect(message({ to: TO, value: '0', data: 'ab' })).toBe('Invalid data');
    expect(message({ to: TO, value: '0', data: '0x' + 'ab'.repeat(64 * 1024 + 1) })).toBe(
      'SafeTx data over 65536 bytes'
    );
    expect(message({ to: TO.slice(0, 41), value: '0', data: '0x' })).toBe('Invalid to');
    // Mixed case only as EIP-55's.
    const checksummed = '0x52908400098527886E0F7030069857D2E4169EE7';
    expect(message({ to: checksummed, value: '0', data: '0x' })).toBeNull();
    expect(message({ to: checksummed.replace('E0F', 'e0F'), value: '0', data: '0x' })).toBe(
      'Invalid to'
    );
  });

  test("authorization's forms: a page's token with its handle, the wallet's without one", () => {
    const propose = (authorization, context) =>
      read('safe.propose', { safe: 7, safe_tx_hash: TX_HASH, authorization }, context);
    expect(propose({ token: TOKEN }, SHELL)).toBeNull();
    expect(propose({ token: TOKEN, handle: HANDLE }, ON_PAGE)).toBeNull();
    expect(propose({ token: TOKEN }, ON_PAGE)).toMatchObject({
      code: 'not_authorized',
      data: { reason: 'mismatch' },
    });
    expect(propose({ token: TOKEN, handle: HANDLE }, SHELL)).toMatchObject({
      code: 'not_authorized',
      data: { reason: 'mismatch' },
    });
    expect(propose({ token: TOKEN, kind: 'safe-send' }, SHELL)).toEqual({
      code: 'invalid_argument',
      message: 'unknown field kind',
    });
    expect(propose({}, SHELL)).toEqual({
      code: 'invalid_argument',
      message: 'missing field token',
    });
    expect(propose({ standing: {} }, SHELL)).toMatchObject({ code: 'invalid_argument' });
    const start = (authorization) =>
      read(
        'safe.message_start',
        { safe: 7, request: { method: 'personal_sign', params: [] }, authorization },
        ON_PAGE
      );
    expect(start({ token: TOKEN, handle: HANDLE })).toBeNull();
    expect(start({ standing: {} })).toBeNull();
    expect(start({ standing: { paused: true } })).toBeNull();
    expect(start({ standing: { paused: 'no' } })).toMatchObject({ code: 'invalid_argument' });
    expect(start({ standing: { paused: true, agent: true } })).toMatchObject({
      code: 'invalid_argument',
    });
    expect(start({ standing: {}, token: TOKEN })).toMatchObject({ code: 'invalid_argument' });
    expect(start({ token: TOKEN })).toMatchObject({ code: 'not_authorized' });
    // The request: exactly its method, a string, and params, an array.
    const request = (r) =>
      read('safe.message_start', { safe: 7, request: r, authorization: { standing: {} } }, ON_PAGE);
    expect(request({ method: 'personal_sign', params: [] })).toBeNull();
    for (const odd of [
      { method: 'personal_sign', params: [], id: 1 },
      { method: 'personal_sign' },
      { method: 'personal_sign', params: {} },
      { method: 7, params: [] },
      ['personal_sign', []],
    ]) {
      expect(request(odd)).toMatchObject({ code: 'invalid_argument' });
    }
  });
});

describe("the scripted core reads SAFE-3's field as cored 0.32.0 does (design 0016, C1)", () => {
  const read = (method, params, context, safe3) => {
    const core = { burnt: [] };
    try {
      readSafe3(method, params, context, safe3, core);
      return { refused: null, burnt: core.burnt };
    } catch (err) {
      return { refused: err.body, burnt: core.burnt };
    }
  };
  const LEGACY = { safe: TO, chain_id: '100', tx: { to: TO, value: '0', data: '0x' } };
  const BUILT = { safe: TO, chain_id: '100', safe_tx: {}, safe_tx_hash: TX_HASH };
  const DEPLOY = { to: PROXY_FACTORY, data: '0x1688f0b9' };

  test('approval.issue under the field: no executor-send, no legacy safe-send; design 0016 form as before', () => {
    const issue = (kind, payload) => read('approval.issue', { kind, payload }, SHELL, true).refused;
    expect(issue('executor-send', {})).toMatchObject({ code: 'forbidden' });
    expect(issue('safe-send', LEGACY)).toMatchObject({ code: 'forbidden' });
    expect(issue('safe-send', BUILT)).toBeNull();
    expect(issue('wallet-send', {})).toBeNull();
    // Without the field, nothing changes.
    expect(read('approval.issue', { kind: 'executor-send', payload: {} }, SHELL, false).refused).toBeNull();
    expect(read('approval.issue', { kind: 'safe-send', payload: LEGACY }, SHELL, false).refused).toBeNull();
  });

  test('approval.spend: the legacy form under the field, and design 0016 form always, refused mismatch and burnt', () => {
    const spend = (payload, safe3) => read('approval.spend', { kind: 'safe-send', token: 't', payload }, SHELL, safe3);
    expect(spend(LEGACY, true)).toEqual({
      refused: { code: 'not_authorized', message: 'the request is not the one confirmed', data: { reason: 'mismatch' } },
      burnt: ['t'],
    });
    expect(spend(BUILT, false).refused).toMatchObject({ data: { reason: 'mismatch' } });
    expect(spend(LEGACY, false)).toEqual({ refused: null, burnt: [] });
  });

  test("sign.transaction under shell to the factory: only with { token, kind: 'executor-send' }, no intent", () => {
    const sign = (authorization, context = SHELL, safe3 = true, tx = DEPLOY) =>
      read('sign.transaction', { key: { kind: 'account', index: 0 }, tx, ...(authorization ? { authorization } : {}) }, context, safe3)
        .refused;
    expect(sign({ token: 't', kind: 'executor-send' })).toBeNull();
    for (const authorization of [
      null,
      { token: 't', kind: 'intent-replace', intent: { id: 'i' } },
      { token: 't', kind: 'executor-send', intent: { id: 'i' } },
      { token: 't', kind: 'wallet-send' },
      { standing: {} },
    ]) {
      expect(sign(authorization)).toMatchObject({ code: 'not_authorized', data: { reason: 'no_token' } });
    }
    // The factory's address in any case; another target, another caller, or
    // no field: nothing changes.
    expect(sign(null, SHELL, true, { ...DEPLOY, to: PROXY_FACTORY.toUpperCase().replace('0X', '0x') })).toMatchObject({
      data: { reason: 'no_token' },
    });
    expect(sign(null, SHELL, true, { ...DEPLOY, to: TO })).toBeNull();
    expect(sign(null, { caller: 'chrome' })).toBeNull();
    expect(sign(null, SHELL, false)).toBeNull();
  });
});

describe("the safe namespace's params are the core's", () => {
  test('the 16 methods are the safe.* rows of the core’s table, with main’s classes', () => {
    const rows = Object.keys(METHOD_CLASSES).filter((m) => m.startsWith('safe.'));
    expect(Object.keys(SAFE_ROWS)).toEqual(rows);
    expect(rows).toHaveLength(16);
    expect(new Set(CALLS.map(([, , method]) => method))).toEqual(new Set(rows));
  });

  test.each(CALLS)(
    '%s: exactly the members the core reads, read whole',
    async (_name, send, method, context, params) => {
      made = await setup();
      const { core, vaultBackend } = made;
      await expect(send(vaultBackend.safe)).resolves.toEqual(DEFAULT_RESULTS[method]);
      expect(core.refused).toEqual([]);
      const [request] = core.sent(method);
      expect(core.sent()).toHaveLength(1);
      expect(request.params).toEqual(params);
      expect(request.context).toEqual(context);
      expect(SAFE_ROWS[method].callers).toContain(context.caller);
    }
  );

  test('a member a caller adds never reaches the core', async () => {
    made = await setup();
    const { core, vaultBackend } = made;
    const extra = { chain_id: 100, owner_address: TO, kind: 'x' };
    await vaultBackend.safe.status({ safe: 7, ...extra });
    await vaultBackend.safe.deploy({ safe: 7, ...extra });
    await vaultBackend.safe.prepare({
      safe: 7,
      chain_id: 100,
      tx: { to: TO, value: '0', data: '0x', from: TO, chainId: 100, gas: '0x1' },
      ...extra,
    });
    await vaultBackend.safe.propose({
      safe: 7,
      safe_tx_hash: TX_HASH,
      authorization: { token: TOKEN, kind: 'safe-send', payload: {} },
      ...extra,
    });
    await vaultBackend.safe.messageStart(
      {
        safe: 7,
        request: { method: 'personal_sign', params: ['0x00', TO], id: 9, jsonrpc: '2.0' },
        authorization: { token: TOKEN, handle: HANDLE, kind: 'safe-message' },
        origin: 'x',
      },
      PAGE
    );
    await vaultBackend.safe.messageSign({ safe: 7, session: SESSION_ID, ...extra });
    await vaultBackend.safe.signOwner({ safe: 7, ...extra });
    expect(core.refused).toEqual([]);
    expect(core.requests.map((m) => [m.method, m.params])).toEqual([
      ['safe.status', { safe: 7 }],
      ['safe.deploy', { safe: 7 }],
      ['safe.prepare', { safe: 7, chain_id: 100, tx: { to: TO, value: '0', data: '0x' } }],
      ['safe.propose', { safe: 7, safe_tx_hash: TX_HASH, authorization: { token: TOKEN } }],
      [
        'safe.message_start',
        {
          safe: 7,
          request: { method: 'personal_sign', params: ['0x00', TO] },
          authorization: { token: TOKEN, handle: HANDLE },
        },
      ],
      ['safe.message_sign', { safe: 7, session: SESSION_ID }],
      ['safe.sign_owner', { safe: 7 }],
    ]);
  });

  test('a null owner or SafeTx hash goes as the core reads it, none', async () => {
    made = await setup();
    const { core, vaultBackend } = made;
    await vaultBackend.safe.signOwner({ safe: 7, owner: null, safe_tx_hash: null });
    await vaultBackend.safe.messageSign({ safe: 7, session: SESSION_ID, owner: null });
    await vaultBackend.safe.discard({ safe: 7, safe_tx_hash: null });
    expect(core.refused).toEqual([]);
    expect(core.requests.map((m) => m.params)).toEqual([
      { safe: 7, owner: null, safe_tx_hash: null },
      { safe: 7, session: SESSION_ID, owner: null },
      { safe: 7, safe_tx_hash: null },
    ]);
  });

  test("a Safe message is a page's: refused in main without its page, unsent", async () => {
    made = await setup();
    const { core, vaultBackend } = made;
    const params = {
      safe: 7,
      request: { method: 'personal_sign', params: [] },
      authorization: { standing: {} },
    };
    for (const page of [undefined, null, 'chrome']) {
      await expect(vaultBackend.safe.messageStart(params, page)).rejects.toMatchObject({
        name: 'VaultBackendError',
        code: 'invalid_argument',
      });
    }
    await expect(
      vaultBackend.safe.messageStart(params, { ...PAGE, origin: null })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    // Its token or the site's rule, never both: the core would refuse the two.
    for (const authorization of [
      { standing: {}, token: 'T' },
      { standing: { paused: false }, token: 'T', handle: 'h' },
      { standing: {}, handle: 'h' },
    ]) {
      await expect(
        vaultBackend.safe.messageStart({ ...params, authorization }, PAGE)
      ).rejects.toMatchObject({
        name: 'VaultBackendError',
        code: 'invalid_argument',
        message: 'A Safe message’s authorization is its token or the site’s rule, not both',
      });
    }
    expect(core.requests).toEqual([]);
    // A rule that isn't an object goes as it is, for the core to refuse.
    await expect(
      vaultBackend.safe.messageStart({ ...params, authorization: { standing: null } }, PAGE)
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(core.refused.map(({ message }) => message.params.authorization)).toEqual([
      { standing: null },
    ]);
  });

  test("main's hello declares safe3 on the core's Safe backend, and only there", async () => {
    made = await setup();
    expect(made.core.hello.safe3).toBe(true);
    expect(made.client.hello.safe3).toBe(true);
    expect(made.core.hello.store_moved).toEqual(expect.arrayContaining(BOTH));
    await made.client.stop();
    mockSafeBackend.kind = 'js';
    made = await setup();
    expect(made.core.hello).not.toHaveProperty('safe3');
    expect(made.client.hello.safe3).toBe(false);
  });

  test("a site's propose goes only to a core that took safe3: on js, and to a core before 0.32.0, refused in main, unsent", async () => {
    const site = (s) =>
      s.propose({ safe: 7, safe_tx_hash: TX_HASH, authorization: { token: TOKEN, handle: HANDLE } }, PAGE);
    const wallet = (s) => s.propose({ safe: 7, safe_tx_hash: TX_HASH, authorization: { token: TOKEN } });
    for (const options of [{ js: true }, { takesSafe3: false }]) {
      mockSafeBackend.kind = options.js ? 'js' : 'core';
      made = await setup(options.js ? {} : { takesSafe3: false });
      const { core, vaultBackend, client } = made;
      expect(client.hello.safe3).toBe(false);
      await expect(site(vaultBackend.safe)).rejects.toMatchObject({
        name: 'VaultBackendError',
        code: 'requirement_unmet',
      });
      expect(core.sent('safe.propose')).toEqual([]);
      // The wallet's own goes as before.
      await expect(wallet(vaultBackend.safe)).resolves.toEqual(DEFAULT_RESULTS['safe.propose']);
      expect(core.sent('safe.propose')).toHaveLength(1);
      await made.client.stop();
      made = null;
    }
  });
});

describe("the stores' requirements", () => {
  const NEEDS_PENDING = [
    'safe.discard',
    'safe.propose',
    'safe.execute',
    'safe.executed',
    'safe.sign_owner',
  ];

  test('the five that read or write the pending store need safe_pending too, refused in main, unsent', async () => {
    made = await setup({ storeMoved: ['vault_meta'] });
    const { core, vaultBackend } = made;
    expect(new Set(Object.keys(SAFE_ROWS).filter((m) => SAFE_ROWS[m].pending))).toEqual(
      new Set(NEEDS_PENDING)
    );
    for (const [, send, method] of CALLS) {
      const sent = core.sent().length;
      if (NEEDS_PENDING.includes(method)) {
        await expect(send(vaultBackend.safe)).rejects.toMatchObject({
          name: 'VaultBackendError',
          code: 'requirement_unmet',
        });
        expect(core.sent()).toHaveLength(sent);
      } else {
        await expect(send(vaultBackend.safe)).resolves.toEqual(DEFAULT_RESULTS[method]);
        expect(core.sent()).toHaveLength(sent + 1);
      }
    }
    expect(core.refused).toEqual([]);
  });

  test('every one needs vault_meta: a core that took neither gets none', async () => {
    made = await setup({ storeMoved: [] });
    const { core, vaultBackend } = made;
    for (const [, send] of CALLS) {
      await expect(send(vaultBackend.safe)).rejects.toMatchObject({ code: 'requirement_unmet' });
    }
    expect(core.requests).toEqual([]);
  });
});

describe("a Safe refusal takes main's code", () => {
  const refusal = (data, code = 'invalid_argument') => ({
    error: { code, message: 'The core refused it', ...(data ? { data } : {}) },
  });

  test.each(Object.entries(CORE_SAFE_CODES))('data.safe %s → %s', async (named, code) => {
    made = await setup({ script: () => refusal({ safe: named }) });
    const { vaultBackend } = made;
    for (const send of [
      (s) => s.status({ safe: 7 }),
      (s) => s.propose({ safe: 7, safe_tx_hash: TX_HASH, authorization: { token: TOKEN } }),
      (s) => s.signOwner({ safe: 7, owner: 2 }),
      (s) => s.messageSign({ safe: 7, session: SESSION_ID }),
    ]) {
      await expect(send(vaultBackend.safe)).rejects.toMatchObject({
        name: 'VaultBackendError',
        code,
        message: 'The core refused it',
        data: { safe: named },
      });
    }
  });

  test("any other error is as the core sent it; create's data.code is that code", async () => {
    let next = null;
    made = await setup({ script: () => next });
    const { vaultBackend } = made;
    const cases = [
      [refusal({ safe: 'something_new' }), 'invalid_argument'],
      [refusal({ safe: 7 }), 'invalid_argument'],
      [refusal(null), 'invalid_argument'],
      [refusal({ safe: 'changed' }, 'forbidden'), 'forbidden'],
      [refusal({ ledger: 'LEDGER_USER_REJECTED' }, 'device_failed'), 'device_failed'],
      [refusal(null, 'vault_locked'), 'vault_locked'],
    ];
    for (const [answer, code] of cases) {
      next = answer;
      await expect(vaultBackend.safe.execute({ safe: 7 })).rejects.toMatchObject({ code });
    }
    next = refusal({ code: 'SAFE_OWNERS_INVALID' });
    await expect(
      vaultBackend.safe.create({ name: 'Team', owners: [0], threshold: 1 })
    ).rejects.toMatchObject({ code: 'SAFE_OWNERS_INVALID' });
  });
});

describe("a Safe owner's signature goes through ledgerCall, ledgerOwner from main's record", () => {
  test("call refuses one unsent: its watchdog isn't the method's alone", async () => {
    made = await setup();
    const { core, _internal } = made;
    for (const method of ['safe.sign_owner', 'safe.message_sign']) {
      await expect(_internal.call(method, { safe: 7 })).rejects.toMatchObject({
        name: 'VaultBackendError',
        code: 'invalid_argument',
        message: "A Safe owner's signature goes through ledgerCall",
      });
    }
    expect(core.requests).toEqual([]);
  });

  test("a Ledger's account by main's own record; no owner, or another account, is none", async () => {
    made = await setup();
    const { _internal } = made;
    expect(_internal.ledgerOwner(2)).toBe(true);
    for (const owner of [0, 1, 9, null, undefined])
      expect(_internal.ledgerOwner(owner)).toBe(false);
  });

  test("each goes under the watchdog its owner's record gives it", async () => {
    made = await setup();
    const { client, vaultBackend } = made;
    const request = jest.spyOn(client, 'request');
    const onSent = jest.fn();
    const { signal } = new AbortController();
    await vaultBackend.safe.signOwner({ safe: 7, owner: 2 }, { onSent, signal });
    await vaultBackend.safe.signOwner({ safe: 7, owner: 0 });
    await vaultBackend.safe.signOwner({ safe: 7 });
    await vaultBackend.safe.messageSign({ safe: 7, session: SESSION_ID, owner: 2 });
    await vaultBackend.safe.messageSign({ safe: 7, session: SESSION_ID });
    await vaultBackend.safe.status({ safe: 7 });
    await vaultBackend.safe.create({ name: 'Team', owners: [0, 1], threshold: 1 });
    await vaultBackend.safe.pending();
    await ticks();
    const watchdogs = request.mock.calls.map(([method, , , options]) => [
      method,
      options.deviceWatchdogMs ?? options.watchdogMs,
      Object.hasOwn(options, 'deviceWatchdogMs') ? 'device' : 'plain',
    ]);
    expect(watchdogs).toEqual([
      ['safe.sign_owner', 435_000, 'device'],
      ['safe.sign_owner', 135_000, 'plain'],
      ['safe.sign_owner', 135_000, 'plain'],
      ['safe.message_sign', 435_000, 'device'],
      ['safe.message_sign', 135_000, 'plain'],
      ['safe.status', 135_000, 'plain'],
      ['safe.create', 45_000, 'plain'],
      ['safe.pending', 15_000, 'plain'],
    ]);
    expect(request.mock.calls[0][3]).toMatchObject({ onSent, signal });
  });
});

function schemaPath() {
  if (process.env.FREEDOM_CORE_SCHEMA) return process.env.FREEDOM_CORE_SCHEMA;
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'protocol', 'schema.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const file = schemaPath();
const schema = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

// core-deadlines.test.js checks the classes against the same file, and
// requires it when FREEDOM_CORE_SCHEMA names it.
(schema ? describe : describe.skip)("the core's table (protocol/schema.json)", () => {
  test("the scripted core's rows are its safe.* rows, with their callers, in order", () => {
    const rows = schema.methods
      .filter((m) => m.name.startsWith('safe.'))
      .map((m) => [m.name, m.callers]);
    expect(Object.entries(SAFE_ROWS).map(([name, row]) => [name, row.callers])).toEqual(rows);
  });
});
