/**
 * The safe namespace's requests under their hang watchdogs (freedom-core
 * design 0001, "Deadlines, cancellation and commit"; design 0016, D7 and
 * API, "Deadlines"; SAFE-3's base, the plan's PR 2), through the real
 * CoreClient and a scripted core that reads each `safe.*` request as
 * cored-v0.32.0 does and holds it unanswered (test/helpers/
 * fake-safe-core.js), on Jest's fake clock:
 * - a vault owner's `safe.sign_owner` or `safe.message_sign` (the sweep,
 *   or a vault owner named), and each `session` row, isn't killed before
 *   135 s and is at 135 s;
 * - a Ledger owner's, by main's own record of it, isn't killed at 135 s,
 *   nor before 7 minutes and 15 s with no `shell.ledger_apdu`, and is
 *   then;
 * - `safe.create` gets the vault queue's 45 s, the immediate rows 15 s.
 * A watchdog that fires kills the core, which fails the request
 * `core_unavailable`.
 */

const { METHOD_CLASSES } = require('./core-deadlines');
const { SESSION_ID, startSafeCore } = require('../../../test/helpers/fake-safe-core');

// The core's Safe backend: the hello declares `safe3`, which a site's
// `safe.propose` needs (SAFE-3's PR 7).
jest.mock('../wallet/safe/safe-backend-kind', () => ({
  safeBackendKind: () => 'core',
  readSafeBackendKind: () => 'core',
}));

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise(setImmediate);
};

const PAGE = {
  origin: 'https://dapp.example',
  top_origin: 'https://dapp.example',
  frame: 0,
  navigation: 1,
};
const HASH = '0x' + '1a'.repeat(32);
const TO = '0x' + '33'.repeat(20);
// Main's own records: index 2 is a Ledger's account, 0 the vault's.
const RECORDS = {
  0: { index: 0, type: 'mnemonic' },
  2: { index: 2, type: 'ledger', path: "44'/60'/0'/0/0" },
};

/** Each `safe.*` row, as the namespace sends it. */
const SENDS = {
  'safe.create': (s) => s.create({ name: 'Team', owners: [0, 2], threshold: 2 }),
  'safe.status': (s) => s.status({ safe: 7 }),
  'safe.deploy': (s) => s.deploy({ safe: 7 }),
  'safe.deployed': (s) => s.deployed({ safe: 7, hash: HASH }),
  'safe.pending': (s) => s.pending(),
  'safe.discard': (s) => s.discard({ safe: 7 }),
  'safe.prepare': (s) =>
    s.prepare({ safe: 7, chain_id: 100, tx: { to: TO, value: '0', data: '0x' } }, PAGE),
  'safe.propose': (s) =>
    s.propose({ safe: 7, safe_tx_hash: HASH, authorization: { token: 't', handle: 'h' } }, PAGE),
  'safe.execute': (s) => s.execute({ safe: 7 }),
  'safe.executed': (s) => s.executed({ safe: 7, safe_tx_hash: HASH, hash: HASH }),
  'safe.message_start': (s) =>
    s.messageStart(
      {
        safe: 7,
        request: { method: 'personal_sign', params: ['0x00', TO] },
        authorization: { token: 't', handle: 'h' },
      },
      PAGE
    ),
  'safe.message_state': (s) => s.messageState({ safe: 7, session: SESSION_ID }),
  'safe.message_cancel': (s) => s.messageCancel({ safe: 7, session: SESSION_ID }),
  'safe.message_complete': (s) => s.messageComplete({ safe: 7, session: SESSION_ID }),
};

/** The vault backend on a real CoreClient against cores that hold every `safe.*`. */
async function setup() {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const made = await startSafeCore({
    log,
    script: (message) => (message.method.startsWith('safe.') ? undefined : {}),
  });
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
  return { ...made, ...mod, log };
}

/** Moves the fake clock on by `ms`, then lets the pipes and the exits run. */
async function advance(ms) {
  jest.advanceTimersByTime(ms);
  await ticks();
}

/**
 * Sends `send(safe)` and holds it: not killed at `ms` − 1, killed at `ms`,
 * the request failed `core_unavailable`, and the hang logged.
 */
async function killedAt(made, send, method, ms) {
  const { cores, log, vaultBackend } = made;
  const sending = send(vaultBackend.safe).catch((e) => e);
  await ticks();
  expect(cores[0].sent(method)).toHaveLength(1);
  expect(cores[0].refused).toEqual([]);
  await advance(ms - 1);
  expect(cores[0].killed).toBeNull();
  await advance(1);
  expect(cores[0].killed).toBe('SIGKILL');
  expect(await sending).toMatchObject({ name: 'VaultBackendError', code: 'core_unavailable' });
  expect(log.error).toHaveBeenCalledWith('[Core] request hung; restarting the core', { method });
}

describe("the safe namespace's hang watchdogs", () => {
  let made = null;

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    made = await setup();
  });

  afterEach(async () => {
    const stopped = made?.client.stop();
    await ticks();
    jest.advanceTimersByTime(3_000);
    await stopped;
    made = null;
    jest.useRealTimers();
  });

  const OWNER_SIGNATURES = [
    [
      "safe.sign_owner, the vault owners' sweep",
      'safe.sign_owner',
      (s) => s.signOwner({ safe: 7 }),
    ],
    [
      'safe.sign_owner, a vault owner',
      'safe.sign_owner',
      (s) => s.signOwner({ safe: 7, owner: 0, safe_tx_hash: HASH }),
    ],
    [
      "safe.message_sign, the vault owners' sweep",
      'safe.message_sign',
      (s) => s.messageSign({ safe: 7, session: SESSION_ID }),
    ],
    [
      'safe.message_sign, a vault owner',
      'safe.message_sign',
      (s) => s.messageSign({ safe: 7, session: SESSION_ID, owner: 0 }),
    ],
  ];

  test.each(OWNER_SIGNATURES)(
    '%s: not killed before 135 s, killed at 135 s',
    async (_name, method, send) => {
      await killedAt(made, send, method, 135_000);
    }
  );

  const SESSIONS = Object.keys(METHOD_CLASSES).filter(
    (m) => m.startsWith('safe.') && METHOD_CLASSES[m] === 'session'
  );

  test('the session rows are the seven that read the chain', () => {
    expect(SESSIONS).toEqual([
      'safe.status',
      'safe.deploy',
      'safe.deployed',
      'safe.prepare',
      'safe.propose',
      'safe.execute',
      'safe.message_start',
    ]);
  });

  test.each(SESSIONS)('%s: not killed before 135 s, killed at 135 s', async (method) => {
    await killedAt(made, SENDS[method], method, 135_000);
  });

  const LEDGER_OWNERS = [
    ['safe.sign_owner', (s) => s.signOwner({ safe: 7, owner: 2 })],
    ['safe.message_sign', (s) => s.messageSign({ safe: 7, session: SESSION_ID, owner: 2 })],
  ];

  test.each(LEDGER_OWNERS)(
    "%s, a Ledger owner's: not killed at 135 s, nor before 7 minutes and 15 s with no APDU; killed then",
    async (method, send) => {
      const { cores, vaultBackend } = made;
      const sending = send(vaultBackend.safe).catch((e) => e);
      await ticks();
      expect(cores[0].sent(method)).toHaveLength(1);
      await advance(135_000);
      expect(cores[0].killed).toBeNull();
      await advance(7 * 60_000 + 15_000 - 135_000 - 1);
      expect(cores[0].killed).toBeNull();
      await advance(1);
      expect(cores[0].killed).toBe('SIGKILL');
      expect(await sending).toMatchObject({ code: 'core_unavailable' });
    }
  );

  test('safe.create: the vault queue’s 45 s', async () => {
    await killedAt(made, SENDS['safe.create'], 'safe.create', 45_000);
  });

  const IMMEDIATE = Object.keys(METHOD_CLASSES).filter(
    (m) => m.startsWith('safe.') && METHOD_CLASSES[m] === 'immediate'
  );

  test.each(IMMEDIATE)('%s: 15 s', async (method) => {
    await killedAt(made, SENDS[method], method, 15_000);
  });

  test('every row is covered: the owner signatures, the sessions, the vault and the immediate ones', () => {
    const covered = new Set([
      ...OWNER_SIGNATURES.map(([, method]) => method),
      ...SESSIONS,
      'safe.create',
      ...IMMEDIATE,
    ]);
    expect(covered).toEqual(
      new Set(Object.keys(METHOD_CLASSES).filter((m) => m.startsWith('safe.')))
    );
  });
});
