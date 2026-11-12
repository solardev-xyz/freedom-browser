/**
 * The import on freedom-radicled's one-shot import process (freedom-core
 * design 0010, D5 and its Tests; design 0008, Writes "Import"; the radicled
 * step-5 plan's B14), main's side: radicled-import.js over an in-process
 * fake process (`test/helpers/fake-radicled.js`) and a manual clock, with
 * the core's seal and vault state faked, and main's checks before the spawn
 * stubbed (service-grant.test.js checks them on real directories).
 *
 * - the process, its arguments and its steps, in order, and the answer;
 * - each refusal the service gives, mapped as it gave it, and nothing sent
 *   again;
 * - a kill, an exit 70 or main's watchdog with the import sent:
 *   `outcome_unknown`, and no second process;
 * - an end before the import is sent: definitive, nothing imported;
 * - the vault: a wait for the unlock, no throwaway key, a lock before the
 *   key's release;
 * - main's checks before the spawn, and a stop at each point.
 *
 * radicle-service-import.test.js runs it under the manager and the GitHub
 * bridge; the contract suite runs it on the real binary.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-grant', () => ({
  radicleGrantRefusal: jest.fn(() => null),
  radicleImportRoots: jest.fn(() => []),
  radicleSourceRefusal: jest.fn(() => null),
}));

const {
  runRadicledImport,
  importParams,
  IMPORT_OUTCOME_UNKNOWN,
  IMPORT_STOPPED,
  IMPORT_NEEDS_VAULT,
  IDENTITY_MISMATCH,
  SOURCE_REFUSED,
} = require('./radicled-import');
const { WATCHDOG_MS, SHUTDOWN_GRACE_MS } = require('./radicled-client');
const { GRANT_REFUSED, KEY_UNAVAILABLE, LOCK_HELD, EXITED, REPAIRING } = require('./radicled-node');
const { radicleGrantRefusal } = require('../service-grant');
const { fakeRadicled, RECIPIENT, IMPORT_RID } = require('../../../test/helpers/fake-radicled');

const HOME = path.join('app-data', 'Freedom', 'R', '1');
const LOCK_DIR = path.join('app-data', 'Freedom', 'locks');
const SOURCE = path.join(os.tmpdir(), 'freedom-github-bridge-AbC123', 'freedom-browser');
const PROTECTED = [
  path.join('app-data', 'Freedom', 'locks'),
  path.join('app-data', 'Freedom', 'Profiles'),
];
const SEALED = Object.freeze({
  enc: Buffer.alloc(32, 0xa5).toString('base64'),
  ciphertext: Buffer.alloc(48, 0x5a).toString('base64'),
});
const IDENTITY = { did: 'did:key:z6MkImport', nid: 'z6MkImport', ephemeral: false };
const REQUEST = Object.freeze({
  name: 'freedom-browser',
  description: 'A browser.',
  defaultBranch: 'main',
});
const PARAMS = {
  path: SOURCE,
  name: 'freedom-browser',
  description: 'A browser.',
  default_branch: 'main',
};

/** Timers that run only when the test advances the clock. */
function manualClock() {
  let now = 1_000_000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn, ms };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    pending: () => [...timers],
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, turns = 400) {
  for (let i = 0; i < turns && !predicate(); i++) await settle(1);
  if (!predicate()) throw new Error('timed out waiting');
}

/** The core, as the import uses it: its vault's state and events, and the
 * seal, each scripted. */
function fakeKeys({ unlocked = true, exists = true } = {}) {
  const listeners = new Set();
  const keys = {
    state: { exists, unlocked },
    seals: [],
    sealAnswers: [],
    status: jest.fn(async () => ({ ...keys.state })),
    seal: jest.fn(async (recipient) => {
      keys.seals.push(recipient);
      const answer = keys.sealAnswers.shift();
      if (answer) return answer();
      return { ...SEALED };
    }),
    onVaultEvent: jest.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event = 'vault.unlocked') {
      for (const listener of [...listeners]) listener(event);
    },
    listeners,
  };
  return keys;
}

let root;
let ownHome;
let clock;
let log;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicled-import-'));
  ownHome = path.join(root, 'radicled-home');
  clock = manualClock();
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  radicleGrantRefusal.mockReset();
  radicleGrantRefusal.mockReturnValue(null);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** `runRadicledImport` over `service`, with `keys` and main's checks
 * (`checks`), as the manager runs it. */
function run(service, { keys = fakeKeys(), checks = null, signal = null, onWaiting = null } = {}) {
  const checked = checks ?? {
    roots: jest.fn(() => PROTECTED),
    source: jest.fn(() => null),
  };
  const promise = runRadicledImport({
    home: HOME,
    lockDir: LOCK_DIR,
    ownHome,
    source: SOURCE,
    ...REQUEST,
    keys,
    checks: checked,
    signal,
    onWaiting,
    command: 'freedom-radicled',
    spawn: service.spawn,
    serviceVersion: null,
    log,
    shellVersion: '0.0.0-test',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  // Observed, so a rejection the test awaits later isn't reported unhandled.
  promise.catch(() => {});
  return { promise, keys, checks: checked };
}

/** What a process received, by method, but the connection's own
 * `rad.shutdown`: main's stop sends it once the import is answered, unless
 * the process has exited by then. */
const methods = (child) =>
  child.requests.map((message) => message.method).filter((method) => method !== 'rad.shutdown');

describe('the import process and its steps', () => {
  test('spawns import with the source and the protected roots, runs its steps in order, and answers { rid }', async () => {
    const service = fakeRadicled();
    const { promise, keys, checks } = run(service);
    await expect(promise).resolves.toEqual({ rid: IMPORT_RID });

    expect(service.spawned).toHaveLength(1);
    const { command, args, options } = service.spawned[0];
    expect(command).toBe('freedom-radicled');
    expect(args).toEqual([
      'import',
      '--home',
      HOME,
      '--lock-dir',
      LOCK_DIR,
      '--source',
      SOURCE,
      '--protected',
      PROTECTED[0],
      '--protected',
      PROTECTED[1],
      '--parent-pid',
      String(process.pid),
    ]);
    // No network: the process takes none.
    expect(args).not.toContain('--network');
    expect(options.env.HOME).toBe(ownHome);
    // Main's checks ran before the spawn: the working copy against the
    // roots, the home and the service's HOME.
    expect(checks.source).toHaveBeenCalledWith(SOURCE, { home: HOME, ownHome });
    expect(radicleGrantRefusal).toHaveBeenCalledWith(HOME, ownHome);

    const [child] = service.children;
    expect(methods(child)).toEqual([
      'rad.hello',
      'rad.identity',
      'rad.reconcile',
      'rad.import_repo',
    ]);
    // The key sealed to this process's recipient, never a throwaway one.
    expect(keys.seals).toEqual([RECIPIENT]);
    expect(child.sent('rad.identity')[0].params).toEqual({ sealed: SEALED });
    // Today's arguments by name; `path` is `--source`, exactly.
    expect(child.sent('rad.import_repo')[0].params).toEqual(PARAMS);
    expect(importParams(SOURCE, 'freedom-browser', 'A browser.', 'main')).toEqual(PARAMS);
    // It exited after the answer, and nothing restarted it.
    expect(child.exited).toBe(true);
  });

  test('a hello that reports a network is a fault: nothing more is sent, and nothing is imported', async () => {
    const service = fakeRadicled({
      hello: (message, child) =>
        child.result(message.id, {
          ...require('../../../test/helpers/fake-radicled').HELLO,
          network: { mode: 'direct' },
        }),
    });
    const { promise } = run(service);
    await expect(promise).rejects.toMatchObject({ code: 'failed', message: EXITED });
    expect(service.children).toHaveLength(1);
    expect(methods(service.children[0])).toEqual(['rad.hello']);
  });

  test('an identity other than the sealed one is refused before the import', async () => {
    const service = fakeRadicled({
      identity: (message, child) => child.result(message.id, { ...IDENTITY, ephemeral: true }),
    });
    const { promise } = run(service);
    await expect(promise).rejects.toMatchObject({ code: 'failed', message: IDENTITY_MISMATCH });
    expect(service.children[0].sent('rad.import_repo')).toEqual([]);
  });
});

// Every refusal the service gives an import before its start, with the
// texts freedom-core's radicle-import.json pins: definitive, answered as
// given, and the process ends (0008, Writes "Import").
const REFUSALS = [
  ['failed', 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 already exists in storage'],
  ['needs_vault', 'the node runs with a throwaway key: publishing needs a vault'],
  [
    'unsupported_layout',
    "the repository is, contains, or lies inside a directory of Freedom's own",
  ],
  ['invalid_argument', 'the working copy has no branch main'],
  ['invalid_argument', 'rad.import_repo takes { path, name, description, default_branch }'],
  ['invalid_argument', "path isn't the --source this import process was started with"],
  ['invalid_argument', 'rad.import_repo was already called'],
  ['stopped', 'rad.import_repo is admitted only after rad.reconcile has succeeded'],
  ['stopped', 'the import process is ending'],
  ['not_found', "could not find repository at '/x'; class=Repository (6); code=NotFound (-3)"],
  ['outcome_unknown', 'the import was cut off past its start: it may have been recorded'],
];

describe("the service's answers", () => {
  test.each(REFUSALS)('%s (%s): answered as the service gave it, once', async (code, message) => {
    const service = fakeRadicled({
      import_repo: (request, child) => child.error(request.id, code, message),
    });
    const { promise } = run(service);
    await expect(promise).rejects.toMatchObject({ code, message });
    expect(service.children).toHaveLength(1);
    expect(service.children[0].sent('rad.import_repo')).toHaveLength(1);
    expect(service.children[0].exited).toBe(true);
  });

  test("a result main can't read is handed on for the bridge to refuse", async () => {
    const service = fakeRadicled({
      import_repo: (request, child) =>
        child.result(request.id, 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5'),
    });
    await expect(run(service).promise).resolves.toEqual({});
  });
});

describe('an end with the import sent: outcome_unknown, never sent again', () => {
  test('a kill during the import', async () => {
    const service = fakeRadicled({ import_repo: () => {} });
    const { promise } = run(service);
    await waitFor(() => service.children[0]?.sent('rad.import_repo').length === 1);
    service.children[0].exit(null, 'SIGKILL');
    await expect(promise).rejects.toMatchObject({
      code: 'outcome_unknown',
      message: IMPORT_OUTCOME_UNKNOWN,
    });
    await settle();
    expect(service.children).toHaveLength(1);
  });

  test("the process's own deadline: exit 70", async () => {
    const service = fakeRadicled({
      import_repo: (request, child) => setImmediate(() => child.exit(70)),
    });
    await expect(run(service).promise).rejects.toMatchObject({
      code: 'outcome_unknown',
      message: IMPORT_OUTCOME_UNKNOWN,
    });
    await settle();
    expect(service.children).toHaveLength(1);
  });

  test("main's watchdog, 300 s + 15 s after the send: the hung process is killed", async () => {
    const service = fakeRadicled({ import_repo: () => {} });
    const { promise } = run(service);
    await waitFor(() => service.children[0]?.sent('rad.import_repo').length === 1);
    expect(clock.pending().some((t) => t.ms === WATCHDOG_MS['rad.import_repo'])).toBe(true);
    expect(WATCHDOG_MS['rad.import_repo']).toBe(315_000);
    await clock.advance(WATCHDOG_MS['rad.import_repo'] - 1);
    expect(service.children[0].exited).toBe(false);
    await clock.advance(1);
    await expect(promise).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(service.children[0].exited).toBe(true);
    expect(service.children).toHaveLength(1);
  });

  test('a stop once the import is sent waits for its answer', async () => {
    let answer;
    const service = fakeRadicled({
      import_repo: (request, child) => {
        answer = () => child.result(request.id, { rid: IMPORT_RID });
      },
    });
    const controller = new AbortController();
    const { promise } = run(service, { signal: controller.signal });
    await waitFor(() => Boolean(answer));
    controller.abort();
    await settle();
    expect(service.children[0].exited).toBe(false);
    expect(service.children[0].sent('rad.shutdown')).toEqual([]);
    answer();
    await expect(promise).resolves.toEqual({ rid: IMPORT_RID });
  });
});

describe('an end before the import is sent: definitive, nothing imported', () => {
  test('a crash during reconciliation', async () => {
    const service = fakeRadicled({
      reconcile: (request, child) => setImmediate(() => child.exit(1)),
    });
    await expect(run(service).promise).rejects.toMatchObject({ code: 'failed', message: EXITED });
    expect(service.children).toHaveLength(1);
    expect(service.children[0].sent('rad.import_repo')).toEqual([]);
  });

  test('the home held by another process: exit 75', async () => {
    const service = fakeRadicled({ hello: (request, child) => setImmediate(() => child.exit(75)) });
    await expect(run(service).promise).rejects.toMatchObject({
      code: 'failed',
      message: LOCK_HELD,
    });
    expect(service.children).toHaveLength(1);
  });

  test('reconciliation past its deadline: still repairing', async () => {
    const service = fakeRadicled({
      reconcile: (request, child) =>
        child.error(request.id, 'deadline', 'reconciliation is still running'),
    });
    await expect(run(service).promise).rejects.toMatchObject({
      code: 'deadline',
      message: REPAIRING,
    });
    expect(service.children[0].sent('rad.import_repo')).toEqual([]);
  });

  test("reconciliation's recovery_failed: its message", async () => {
    const service = fakeRadicled({
      reconcile: (request, child) =>
        child.error(request.id, 'recovery_failed', 'the storage is damaged'),
    });
    await expect(run(service).promise).rejects.toMatchObject({
      code: 'recovery_failed',
      message: 'the storage is damaged',
    });
  });

  test('a stop during reconciliation shuts the process down, and nothing is imported', async () => {
    const service = fakeRadicled({ reconcile: () => {} });
    const controller = new AbortController();
    const { promise } = run(service, { signal: controller.signal });
    await waitFor(() => service.children[0]?.sent('rad.reconcile').length === 1);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'stopped', message: IMPORT_STOPPED });
    expect(service.children[0].sent('rad.shutdown')).toHaveLength(1);
    expect(service.children[0].sent('rad.import_repo')).toEqual([]);
    expect(service.children[0].exited).toBe(true);
  });

  test('a process that ignores the stop is killed after the grace', async () => {
    const service = fakeRadicled({ reconcile: () => {}, shutdown: () => {} });
    const controller = new AbortController();
    const { promise } = run(service, { signal: controller.signal });
    await waitFor(() => service.children[0]?.sent('rad.reconcile').length === 1);
    controller.abort();
    await settle();
    expect(service.children[0].exited).toBe(false);
    await clock.advance(SHUTDOWN_GRACE_MS);
    await expect(promise).rejects.toMatchObject({ code: 'stopped' });
    expect(service.children[0].exited).toBe(true);
  });
});

describe("main's checks before the spawn (design 0010, step 7)", () => {
  test('a working copy main refuses: unsupported_layout, and nothing is spawned', async () => {
    const service = fakeRadicled();
    const checks = {
      roots: jest.fn(() => PROTECTED),
      source: jest.fn(() => "the working copy lies inside this profile's data"),
    };
    const { promise, keys } = run(service, { checks });
    await expect(promise).rejects.toMatchObject({
      code: 'unsupported_layout',
      message: `${SOURCE_REFUSED}: the working copy lies inside this profile's data`,
    });
    expect(service.spawned).toEqual([]);
    expect(keys.seal).not.toHaveBeenCalled();
  });

  test('roots that cannot be listed refuse too', async () => {
    const service = fakeRadicled();
    const checks = {
      roots: jest.fn(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }),
      source: jest.fn(() => null),
    };
    await expect(run(service, { checks }).promise).rejects.toMatchObject({
      code: 'unsupported_layout',
      message: `${SOURCE_REFUSED}: the check failed: EACCES`,
    });
    expect(service.spawned).toEqual([]);
  });

  test("the home's grant refused: nothing is spawned", async () => {
    radicleGrantRefusal.mockReturnValue("the grant lies inside this profile's data");
    const service = fakeRadicled();
    await expect(run(service).promise).rejects.toMatchObject({
      code: 'failed',
      message: GRANT_REFUSED,
    });
    expect(service.spawned).toEqual([]);
  });
});

describe("the vault (0008, 'When the node can start', 'Profiles without a vault')", () => {
  test('a locked vault: nothing is spawned until its unlock, which the manager is told of once', async () => {
    const service = fakeRadicled();
    const keys = fakeKeys({ unlocked: false });
    const onWaiting = jest.fn();
    const { promise } = run(service, { keys, onWaiting });
    await waitFor(() => onWaiting.mock.calls.length === 1);
    expect(service.spawned).toEqual([]);
    // Another event that leaves it locked: still waiting, told once.
    keys.emit('vault.locked');
    await settle();
    expect(service.spawned).toEqual([]);
    keys.state.unlocked = true;
    keys.emit();
    await expect(promise).resolves.toEqual({ rid: IMPORT_RID });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(keys.listeners.size).toBe(0);
  });

  test('a stop while waiting: stopped, and nothing is spawned', async () => {
    const service = fakeRadicled();
    const keys = fakeKeys({ unlocked: false });
    const controller = new AbortController();
    const onWaiting = jest.fn();
    const { promise } = run(service, { keys, signal: controller.signal, onWaiting });
    await waitFor(() => onWaiting.mock.calls.length === 1);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'stopped', message: IMPORT_STOPPED });
    expect(service.spawned).toEqual([]);
    expect(keys.listeners.size).toBe(0);
  });

  test('no vault: needs_vault, and the process gets no throwaway key', async () => {
    const service = fakeRadicled();
    const keys = fakeKeys({ exists: false, unlocked: false });
    keys.sealAnswers.push(() => {
      throw Object.assign(new Error('no vault'), { code: 'no_vault' });
    });
    await expect(run(service, { keys }).promise).rejects.toMatchObject({
      code: 'needs_vault',
      message: IMPORT_NEEDS_VAULT,
    });
    expect(methods(service.children[0])).toEqual(['rad.hello']);
    expect(service.children[0].sent('rad.shutdown')).toHaveLength(1);
    expect(service.children[0].exited).toBe(true);
  });

  test('a lock before the key is released: the process goes, and a new one imports after the unlock', async () => {
    const service = fakeRadicled();
    const keys = fakeKeys();
    keys.sealAnswers.push(() => {
      keys.state.unlocked = false;
      throw Object.assign(new Error('locked'), { code: 'vault_locked' });
    });
    const { promise } = run(service, { keys });
    await waitFor(() => service.children[0]?.exited === true);
    await settle();
    expect(service.children).toHaveLength(1);
    keys.state.unlocked = true;
    keys.emit();
    await expect(promise).resolves.toEqual({ rid: IMPORT_RID });
    expect(service.children).toHaveLength(2);
    expect(service.children[0].sent('rad.identity')).toEqual([]);
    expect(methods(service.children[1])).toEqual([
      'rad.hello',
      'rad.identity',
      'rad.reconcile',
      'rad.import_repo',
    ]);
  });

  test("the core's other errors: the key is unavailable", async () => {
    const service = fakeRadicled();
    const keys = fakeKeys();
    keys.sealAnswers.push(() => {
      throw Object.assign(new Error('down'), { code: 'core_unavailable' });
    });
    await expect(run(service, { keys }).promise).rejects.toMatchObject({
      code: 'failed',
      message: KEY_UNAVAILABLE,
    });
  });
});
