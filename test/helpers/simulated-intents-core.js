/* global jest */
/**
 * The identity core's intent journal (`intents.*`, freedom-core design
 * 0013, "The intent journal"; PRF-6(b2)) for unit tests, simulated on the
 * reference store (reference-intent-store.js, at 9d4ea6251), so a suite's
 * file-text assertions still pin today's format. The real core is tested
 * against main in src/main/wallet/intent-store.integration.test.js.
 *
 * `simulatedIntents(options)` is a sim whose `intents` is
 * `vaultBackend.intents` as main sees it (core/vault-backend.js, after its
 * error mapping):
 *   - each request's members are checked as the core checks them (each
 *     known, of its JSON type, the required ones there, `run` in the id
 *     form), or it fails `invalid_argument` "Invalid parameters" with no
 *     code, and nothing is written;
 *   - then the reference's own method runs with the reference's arguments,
 *     and the answer holds its return value as the core's does (`{ intent }`,
 *     `{ handoff }`, `{ intents }`, …). A refusal keeps the reference's
 *     message and `INTENT_*` code; one without a code is `invalid_argument`
 *     (`storage` for `compact` and `withdraw_origin`, as the core answers a
 *     journal's own error);
 *   - the reference store loads at the first request, as the core's does,
 *     with `options.filePath` (default: wallet-intents.jsonl at the suite's
 *     Freedom root), `limits` and `now`. Its module is loaded in the
 *     suite's registry (its logger and paths), with its `RUN_ID` set to
 *     main's (intent-store.js's), so the lines carry main's run as the core
 *     writes them; a write naming another run is recorded in
 *     `foreignRuns`;
 *   - `void` and `retire` take the request's `lock` as the core does: true
 *     holds the account's lock (reference-intent-lock.js).
 *
 * The sim's own controls:
 *   - `moved: false` (a core that didn't take `intents`, as 0.22.0): every
 *     method fails `requirement_unmet`, and nothing is read or written;
 *   - `restart()`: the core restarted under the same run of main. The file
 *     is loaded again by a new store of the same module, so every held
 *     intent is recovered (design 0013, `intents-core-restart`);
 *   - `loseReply(method)`: the next request of `method` (wire name) runs,
 *     then its answer is lost (`core_unavailable`); `failBefore(method,
 *     code)`: the next one fails before the store sees it;
 *   - `calls` records `[method, params]`; `store()` is the reference store,
 *     `reference()` its module.
 *
 * `mockVaultBackend(options)` is the module a suite's
 * `jest.mock('…/core/vault-backend', …)` factory returns: the real module
 * with `vaultBackend.intents` the sim's, and the sim as `simulatedIntents`.
 */

const path = require('path');

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const TYPES = {
  str: (v) => typeof v === 'string',
  num: (v) => typeof v === 'number',
  bool: (v) => typeof v === 'boolean',
  obj: isObject,
  strs: (v) => Array.isArray(v) && v.every((e) => typeof e === 'string'),
};
const orNull = (check) => (v) => v === null || check(v);

// The core's member table (freedom-cored intents.rs): name, type, required.
const RUN = ['run', TYPES.str, true];
const ID = ['intent_id', TYPES.str, true];
const LOCK = ['lock', TYPES.bool, true];
const MEMBERS = {
  'intents.commit': [
    RUN,
    ['intent_id', TYPES.str, false],
    ['chain_id', TYPES.num, true],
    ['sender', TYPES.str, true],
    ['nonce', TYPES.num, true],
    ['hash', TYPES.str, true],
    ['raw', TYPES.str, true],
    ['via', TYPES.str, true],
    ['context', TYPES.obj, false],
  ],
  'intents.handoff': [RUN, ID, ['hash', orNull(TYPES.str), false]],
  'intents.outcome': [
    RUN,
    ID,
    ['handoff_id', TYPES.str, true],
    ['outcome', TYPES.str, true],
    ['source', orNull(TYPES.str), false],
    ['reason_class', orNull(TYPES.str), false],
  ],
  'intents.settle': [
    RUN,
    ID,
    ['label', TYPES.str, true],
    ['hash', orNull(TYPES.str), false],
    ['block', TYPES.num, true],
    ['hashes', orNull(TYPES.strs), false],
  ],
  'intents.void': [RUN, ID, LOCK],
  'intents.retire': [RUN, ID, ['block', TYPES.num, true], ['hashes', TYPES.strs, true], LOCK],
  'intents.track': [
    RUN,
    ID,
    ['bracket', orNull(TYPES.obj), false],
    ['unread_since', orNull(TYPES.num), false],
  ],
  'intents.withdraw_origin': [ID],
  'intents.compact': [],
  'intents.get': [ID],
  'intents.by_key': [['key', orNull(TYPES.str), true]],
  'intents.held': [],
  'intents.list': [],
  'intents.held_nonces': [
    ['chain_id', TYPES.num, true],
    ['sender', TYPES.str, true],
  ],
  'intents.usage': [],
  'intents.void_refusal': [ID, RUN],
};

function coded(code, message, data) {
  return Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
}

const invalidParameters = () => coded('invalid_argument', 'Invalid parameters');

function checkMembers(method, params) {
  if (!isObject(params)) throw invalidParameters();
  const spec = MEMBERS[method];
  for (const [key, value] of Object.entries(params)) {
    const member = spec.find(([name]) => name === key);
    if (!member || !member[1](value)) throw invalidParameters();
    if (key === 'run' && !ID_PATTERN.test(value)) throw invalidParameters();
  }
  if (spec.some(([name, , required]) => required && !(name in params))) {
    throw invalidParameters();
  }
}

function simulatedIntents({ filePath = null, limits = {}, now, moved = true } = {}) {
  const sim = { moved, calls: [], foreignRuns: [], lost: new Map(), failing: new Map() };
  let reference = null;
  let store = null;

  function file() {
    if (typeof filePath === 'function') return filePath();
    if (filePath) return filePath;
    const { getFreedomDataPath } = require('../../src/main/freedom-root');
    return getFreedomDataPath('wallet-intents.jsonl');
  }

  /** The reference module, its RUN_ID main's, in the suite's registry. */
  function referenceModule() {
    if (!reference) {
      const { RUN_ID } = require('../../src/main/wallet/intent-store');
      const crypto = require('crypto');
      const randomUUID = crypto.randomUUID;
      // The reference names its run once, as it loads.
      crypto.randomUUID = () => RUN_ID;
      try {
        reference = require('./reference-intent-store');
      } finally {
        crypto.randomUUID = randomUUID;
      }
    }
    return reference;
  }

  function referenceStore() {
    if (!store) {
      store = referenceModule().createIntentStore({
        filePath: file(),
        ...(now ? { now } : {}),
        limits,
      });
    }
    return store;
  }

  const RUNS = {
    'intents.commit': (s, p) =>
      s
        .commit({
          intentId: p.intent_id,
          chainId: p.chain_id,
          sender: p.sender,
          nonce: p.nonce,
          hash: p.hash,
          raw: p.raw,
          via: p.via,
          context: p.context,
        })
        .then((intent) => ({ intent })),
    'intents.handoff': (s, p) => s.handoff(p.intent_id, p.hash).then((handoff) => ({ handoff })),
    'intents.outcome': (s, p) =>
      s
        .outcome({
          intentId: p.intent_id,
          handoffId: p.handoff_id,
          outcome: p.outcome,
          source: p.source,
          reasonClass: p.reason_class,
        })
        .then((intent) => ({ intent })),
    'intents.settle': (s, p) =>
      s
        .settle({
          intentId: p.intent_id,
          label: p.label,
          hash: p.hash,
          block: p.block,
          hashes: p.hashes,
        })
        .then((intent) => ({ intent })),
    'intents.void': (s, p) => s.void(p.intent_id, p.lock).then((intent) => ({ intent })),
    'intents.retire': (s, p) =>
      s
        .retire({ intentId: p.intent_id, block: p.block, hashes: p.hashes }, p.lock)
        .then((intent) => ({ intent })),
    'intents.track': (s, p) =>
      s
        .track({ intentId: p.intent_id, bracket: p.bracket, unreadSince: p.unread_since })
        .then((intent) => ({ intent })),
    'intents.withdraw_origin': (s, p) =>
      s.withdrawOrigin(p.intent_id).then((withdrawn) => ({ withdrawn })),
    'intents.compact': (s) => s.compact().then(() => ({})),
    'intents.get': async (s, p) => ({ intent: await s.get(p.intent_id) }),
    'intents.by_key': async (s, p) => ({ intent: await s.byKey(p.key) }),
    'intents.held': async (s) => ({ intents: await s.held() }),
    'intents.list': async (s) => ({ intents: await s.list() }),
    'intents.held_nonces': async (s, p) => ({ nonces: await s.heldNonces(p.chain_id, p.sender) }),
    'intents.usage': async (s) => ({ usage: await s.usage() }),
    'intents.void_refusal': async (s, p) => ({ refusal: await s.voidRefusal(p.intent_id) }),
  };
  const JOURNAL_ERRORS_ARE_STORAGE = new Set(['intents.compact', 'intents.withdraw_origin']);

  async function request(method, params = {}) {
    sim.calls.push([method, params]);
    if (!sim.moved) throw coded('requirement_unmet', "The core can't take this request");
    const failing = sim.failing.get(method);
    if (failing) {
      sim.failing.delete(method);
      throw coded(failing, 'The identity core is not running');
    }
    checkMembers(method, params);
    if (params.run !== undefined && params.run !== referenceModule().RUN_ID) {
      // Main's run is the one the lines carry: another is a bug in main.
      sim.foreignRuns.push([method, params.run]);
    }
    let answer;
    try {
      const s = referenceStore();
      await s.load();
      answer = await RUNS[method](s, params);
    } catch (err) {
      if (typeof err.code === 'string' && err.code.startsWith('INTENT_')) {
        throw coded(err.code, err.message, { code: err.code });
      }
      if (JOURNAL_ERRORS_ARE_STORAGE.has(method)) throw coded('storage', err.message);
      throw invalidParameters();
    }
    if (sim.lost.has(method)) {
      sim.lost.delete(method);
      throw coded('core_unavailable', 'The identity core is not running');
    }
    // The wire's copy: nothing the store keeps is shared with main.
    return JSON.parse(JSON.stringify(answer));
  }

  const wire = {
    commit: 'intents.commit',
    handoff: 'intents.handoff',
    outcome: 'intents.outcome',
    settle: 'intents.settle',
    void: 'intents.void',
    retire: 'intents.retire',
    track: 'intents.track',
    withdrawOrigin: 'intents.withdraw_origin',
    compact: 'intents.compact',
    get: 'intents.get',
    byKey: 'intents.by_key',
    held: 'intents.held',
    list: 'intents.list',
    heldNonces: 'intents.held_nonces',
    usage: 'intents.usage',
    voidRefusal: 'intents.void_refusal',
  };
  sim.intents = Object.fromEntries(
    Object.entries(wire).map(([name, method]) => [name, (params) => request(method, params)])
  );
  sim.restart = () => {
    store = null;
  };
  sim.loseReply = (method) => sim.lost.set(method, true);
  sim.failBefore = (method, code = 'core_unavailable') => sim.failing.set(method, code);
  sim.store = referenceStore;
  sim.reference = referenceModule;
  sim.file = file;
  return sim;
}

/** For `jest.mock('…/core/vault-backend', () => mockVaultBackend(options))`. */
function mockVaultBackend(options) {
  const actual = jest.requireActual('../../src/main/core/vault-backend');
  const sim = simulatedIntents(options);
  return {
    ...actual,
    vaultBackend: { ...actual.vaultBackend, intents: sim.intents },
    simulatedIntents: sim,
  };
}

module.exports = {
  simulatedIntents,
  mockVaultBackend,
  VAULT_BACKEND: path.join(__dirname, '../../src/main/core/vault-backend.js'),
};
