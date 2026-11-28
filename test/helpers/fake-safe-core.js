/**
 * A scripted freedom-cored for the safe namespace (src/main/core/
 * vault-backend.js `safe`; freedom-core design 0016, SAFE-3), as the child
 * a real CoreClient spawns. It answers the hello, echoing each store main
 * names that it takes (`vault_meta` and `safe_pending` unless told
 * otherwise), and the shutdown, and reads every `safe.*` request as
 * cored-v0.32.0 does before its script answers it (freedom-core 0e01b95b,
 * the release commit: `serve.rs`'s `admitted`; `safe/methods.rs`'s `start`,
 * `members`, `index_of` and `hash_param`; `safe/methods/messages.rs`'s
 * `message_start` and `board_members`; `safe/methods/owners.rs`'s
 * `sign_owner`; `safe/tx.rs`'s `Call::of`; `accounts.rs`'s
 * `create_safe_op`; `approvals.rs`'s `page_context`, `spend_safe_tx` and
 * `spend_safe_message`):
 * - **The caller,** against the row's callers (`protocol/schema.json`,
 *   `SAFE_ROWS`): another is `forbidden`, "not callable by this caller".
 * - **The stores,** in the core's order: every `safe.*` is `not_moved`
 *   (`data.store: "vault_meta"`) until the hello named `vault_meta`, before
 *   its params are read; `safe.execute`, `.executed`, `.propose` and
 *   `.sign_owner` are `not_moved` (`safe_pending`) until it named
 *   `safe_pending`, before their params are read too, and `safe.discard`
 *   after.
 * - **The params,** as each method reads them: an object holding only the
 *   method's members, and each member as the core reads it: a wallet index
 *   an integer from 0 to 2^53 − 1; a hash `0x` and 64 hex digits;
 *   `fee_ack` a boolean; an optional `owner` or `safe_tx_hash` absent or
 *   null (but `safe.discard`'s `safe_tx_hash` any string); `chain_id` a
 *   number or a quantity's text; `tx` exactly `{ to, value, data }`, an
 *   address, a quantity's text and hex of at most 64 KiB; `request`
 *   exactly `{ method, params }`, a string and an array; a board call's
 *   `session` a string; `authorization` `{ token, handle? }` (a page's
 *   with its handle, a string, and no other caller's), or for a message
 *   `{ standing: { paused? } }`; `display`, and `safe.create`'s three
 *   members at admission, any value. A page's `safe.prepare` and
 *   `safe.propose` need its page's origin. Anything else is
 *   `invalid_argument`, and the request is kept in `refused`.
 *
 * Then `script(message, core)` answers: a result, `{ error }` for an error
 * body, or undefined to hold the request unanswered (`answer()` and
 * `fail()` reply later). The default script answers each method with a
 * result of its shape (`DEFAULT_RESULTS`). What the core decides from its
 * state (the record, the chain's reads, a token's spend, the pending entry)
 * is the script's. `kill()` keeps the signal (a watchdog's SIGKILL) and
 * exits.
 *
 * `startSafeCore()` runs a real CoreClient against it, each process a new
 * FakeSafeCore with the same options.
 */

const { EventEmitter } = require('events');
const os = require('os');
const { PassThrough, Writable } = require('stream');
const { getAddress } = require('ethers');
const { CoreClient } = require('../../src/main/core/core-client');
const {
  encodeFrame,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  KIND_JSON,
} = require('../../src/main/core/frame');

const PAGE = 'page';
const CHROME = 'chrome';
const SHELL = 'shell';

/**
 * The 16 `safe.*` rows of cored-v0.32.0's method table (`protocol/
 * schema.json`), in its order: each one's callers, and the stores it
 * needs moved.
 */
const SAFE_ROWS = Object.freeze({
  'safe.create': { callers: [CHROME, SHELL] },
  'safe.status': { callers: [CHROME, SHELL] },
  'safe.deploy': { callers: [CHROME, SHELL] },
  'safe.deployed': { callers: [SHELL] },
  'safe.pending': { callers: [CHROME, SHELL] },
  'safe.discard': { callers: [CHROME, SHELL], pending: 'after' },
  'safe.prepare': { callers: [PAGE, CHROME, SHELL] },
  'safe.propose': { callers: [PAGE, CHROME, SHELL], pending: 'before' },
  'safe.execute': { callers: [CHROME, SHELL], pending: 'before' },
  'safe.executed': { callers: [SHELL], pending: 'before' },
  'safe.message_start': { callers: [PAGE] },
  'safe.message_sign': { callers: [CHROME, SHELL] },
  'safe.message_state': { callers: [CHROME, SHELL] },
  'safe.message_cancel': { callers: [CHROME, SHELL] },
  'safe.message_complete': { callers: [CHROME, SHELL] },
  'safe.sign_owner': { callers: [CHROME, SHELL], pending: 'before' },
});

const SESSION_ID = 'a1'.repeat(16);
const HASH = '0x' + '5a'.repeat(32);
const BOARD = Object.freeze({ safeIndex: 7, kind: 'send', status: 'pending', owners: [] });

/** A result of each method's shape (design 0016, API), for the default script. */
const DEFAULT_RESULTS = Object.freeze({
  'safe.create': { wallet: { index: 7, type: 'safe' } },
  'safe.status': { deployed: true, chainId: 100, setup: { state: 'unchanged' } },
  'safe.deploy': { deployed: true },
  'safe.deployed': { deployed: true },
  'safe.pending': { states: [] },
  'safe.discard': {},
  'safe.prepare': { safe_tx: {}, safe_tx_hash: HASH, view: {} },
  'safe.propose': BOARD,
  'safe.execute': { superseded: { ...BOARD, status: 'superseded' } },
  'safe.executed': {},
  'safe.message_start': { session: SESSION_ID, state: { safeIndex: 7, kind: 'message' } },
  'safe.message_sign': { safeIndex: 7, kind: 'message' },
  'safe.message_state': null,
  'safe.message_cancel': {},
  'safe.message_complete': { signature: '0x' + '11'.repeat(65) },
  'safe.sign_owner': BOARD,
});

/** The core's refusal of a request, as its error body. */
class Refused extends Error {
  constructor(code, message, data) {
    super(message);
    this.body = { code, message, ...(data ? { data } : {}) };
  }
}

const invalid = (message = 'Invalid parameters') => new Refused('invalid_argument', message);
const notMoved = (store) =>
  new Refused(
    'not_moved',
    store === 'vault_meta'
      ? "main still writes vault-meta.json (vault_meta isn't in store_moved)"
      : "main still writes the pending Safe transactions (safe_pending isn't in store_moved)",
    { store }
  );
const mismatch = () =>
  new Refused('not_authorized', 'the request is not the one confirmed', { reason: 'mismatch' });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** methods.rs `members`: an object holding only `allowed`. */
function members(params, allowed) {
  if (!isObject(params) || !Object.keys(params).every((key) => allowed.includes(key))) {
    throw invalid();
  }
  return params;
}

/** `index_of`: an integer from 0 to `Number.MAX_SAFE_INTEGER`. */
function index(params, key) {
  const value = params[key];
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

/** An optional index: absent or null is none. */
function optionalIndex(params, key) {
  return params[key] == null ? null : index(params, key);
}

/** `hash_param`: `0x` (or `0X`) and 32 bytes of hex. */
function hash(params, key) {
  const value = params[key];
  if (typeof value !== 'string' || !/^0[xX][0-9a-fA-F]{64}$/.test(value)) throw invalid();
  return value;
}

/** An optional hash: absent or null is none. */
function optionalHash(params, key) {
  return params[key] == null ? null : hash(params, key);
}

/** `fee_ack`: absent (false) or a boolean; null is refused. */
function feeAck(params) {
  if (params.fee_ack !== undefined && typeof params.fee_ack !== 'boolean') throw invalid();
}

const U256_MAX = (1n << 256n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

/** fc-evm's `parse_unsigned`: decimal, or `0x` hex, no sign, at most 2^256 − 1. */
function unsigned(text) {
  if (typeof text !== 'string' || !/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) return null;
  const value = BigInt(text.replace(/^0X/, '0x'));
  return value <= U256_MAX ? value : null;
}

/** fc-evm's `parse_address`: `0x` and 40 hex digits, mixed case only as EIP-55's. */
function address(text) {
  if (typeof text !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(text)) return false;
  const digits = text.slice(2);
  const mixed = /[a-f]/.test(digits) && /[A-F]/.test(digits);
  if (!mixed) return true;
  try {
    return getAddress(text) === text;
  } catch {
    return false;
  }
}

/** fc-evm's `parse_bytes`: `0x` (or `0X`) and an even number of hex digits; its length. */
function bytes(text) {
  if (typeof text !== 'string' || !/^0[xX]([0-9a-fA-F]{2})*$/.test(text)) return null;
  return (text.length - 2) / 2;
}

/** `safe.prepare`'s `chain_id`: a number or a quantity's text (one past a
 * u64 reads as no chain, which the core refuses as another chain's). */
function chainId(params) {
  const value = params.chain_id;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    const parsed = unsigned(value);
    return parsed !== null && parsed <= U64_MAX ? parsed : null;
  }
  throw invalid();
}

/** tx.rs `Call::of`: exactly `{ to, value, data }`, each read as `sign.transaction` reads it. */
function call(tx) {
  if (
    !isObject(tx) ||
    Object.keys(tx).length !== 3 ||
    !['to', 'value', 'data'].every((key) => Object.hasOwn(tx, key))
  ) {
    throw invalid('tx: expected { to, value, data }');
  }
  for (const key of ['to', 'value', 'data']) {
    if (typeof tx[key] !== 'string') throw invalid(`Invalid ${key}`);
  }
  const length = bytes(tx.data);
  if (length === null) throw invalid('Invalid data');
  if (length > 64 * 1024) throw invalid('SafeTx data over 65536 bytes');
  if (!address(tx.to)) throw invalid('Invalid to');
  if (unsigned(tx.value) === null) throw invalid('Invalid value');
}

/** approvals.rs `page_context`: a page's request needs its page, with an origin. */
function pageContext(context) {
  if (context?.caller !== PAGE) return null;
  if (!isObject(context.page)) throw invalid('a page request needs its page context');
  if (context.page.origin === '') throw invalid("a page request needs its page's origin");
  return context.page;
}

/** approvals.rs `object`: `required` members, and `optional` ones. */
function object(value, required, optional = []) {
  if (!isObject(value)) throw invalid();
  const unknown = Object.keys(value).find(
    (key) => !required.includes(key) && !optional.includes(key)
  );
  if (unknown !== undefined) throw invalid(`unknown field ${unknown}`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw invalid(`missing field ${missing}`);
  return value;
}

/** `{ token, handle? }`: the token a string; a page's handle a string, no other caller's. */
function tokenForm(authorization, context) {
  const fields = object(authorization, ['token'], ['handle']);
  if (typeof fields.token !== 'string') throw invalid('token: expected a string');
  const page = pageContext(context);
  if (page ? typeof fields.handle !== 'string' : fields.handle !== undefined) throw mismatch();
}

/** `spend_safe_message`'s forms: `{ standing: { paused? } }`, or the token's. */
function messageAuthorization(authorization, context) {
  if (isObject(authorization) && authorization.standing !== undefined) {
    const fields = object(authorization, ['standing']);
    const standing = object(fields.standing, [], ['paused']);
    if (standing.paused !== undefined && typeof standing.paused !== 'boolean') throw invalid();
    return;
  }
  tokenForm(authorization, context);
}

/** messages.rs `board_members`: only `allowed`, `session` a JSON string. */
function board(params, allowed) {
  const p = members(params, allowed);
  index(p, 'safe');
  if (typeof p.session !== 'string') throw invalid();
  return p;
}

/**
 * Reads `params` as cored-v0.32.0 reads a `safe.*` request from `context`,
 * with the stores in `moved`: throws the core's refusal (`Refused`).
 */
function readSafe(method, params, context, moved) {
  const row = SAFE_ROWS[method];
  if (!row.callers.includes(context?.caller)) {
    throw new Refused('forbidden', 'not callable by this caller');
  }
  if (!moved.includes('vault_meta')) throw notMoved('vault_meta');
  const pendingMoved = () => {
    if (!moved.includes('safe_pending')) throw notMoved('safe_pending');
  };
  if (row.pending === 'before' && method !== 'safe.propose') pendingMoved();
  switch (method) {
    case 'safe.create':
      members(params, ['name', 'owners', 'threshold']);
      return;
    case 'safe.status':
      index(members(params, ['safe']), 'safe');
      return;
    case 'safe.deploy': {
      const p = members(params, ['safe', 'fee_ack']);
      feeAck(p);
      index(p, 'safe');
      return;
    }
    case 'safe.deployed': {
      const p = members(params, ['safe', 'hash']);
      hash(p, 'hash');
      index(p, 'safe');
      return;
    }
    case 'safe.pending':
      members(params, []);
      return;
    case 'safe.discard': {
      const p = members(params, ['safe', 'safe_tx_hash']);
      index(p, 'safe');
      if (p.safe_tx_hash != null && typeof p.safe_tx_hash !== 'string') throw invalid();
      pendingMoved();
      return;
    }
    case 'safe.prepare': {
      pageContext(context);
      const p = members(params, ['safe', 'chain_id', 'tx']);
      index(p, 'safe');
      chainId(p);
      if (p.tx === undefined) throw invalid();
      call(p.tx);
      return;
    }
    case 'safe.propose': {
      pageContext(context);
      pendingMoved();
      const p = members(params, ['safe', 'safe_tx_hash', 'authorization', 'display']);
      index(p, 'safe');
      hash(p, 'safe_tx_hash');
      if (p.authorization === undefined) throw invalid();
      tokenForm(p.authorization, context);
      return;
    }
    case 'safe.execute': {
      const p = members(params, ['safe', 'fee_ack', 'safe_tx_hash']);
      index(p, 'safe');
      feeAck(p);
      optionalHash(p, 'safe_tx_hash');
      return;
    }
    case 'safe.executed': {
      const p = members(params, ['safe', 'safe_tx_hash', 'hash']);
      index(p, 'safe');
      hash(p, 'safe_tx_hash');
      hash(p, 'hash');
      return;
    }
    case 'safe.message_start': {
      if (!pageContext(context)) throw new Refused('forbidden', "a Safe message is a page's");
      const p = members(params, ['safe', 'request', 'display', 'authorization']);
      index(p, 'safe');
      const { request } = p;
      if (!isObject(request) || Object.keys(request).length !== 2) throw invalid();
      if (typeof request.method !== 'string' || !Array.isArray(request.params)) throw invalid();
      if (p.authorization === undefined) throw invalid();
      messageAuthorization(p.authorization, context);
      return;
    }
    case 'safe.message_sign':
      optionalIndex(board(params, ['safe', 'session', 'owner']), 'owner');
      return;
    case 'safe.message_state':
    case 'safe.message_cancel':
    case 'safe.message_complete':
      board(params, ['safe', 'session']);
      return;
    case 'safe.sign_owner': {
      const p = members(params, ['safe', 'owner', 'safe_tx_hash']);
      index(p, 'safe');
      optionalIndex(p, 'owner');
      optionalHash(p, 'safe_tx_hash');
      return;
    }
    default:
      throw new Refused('unknown_method', 'Unknown method');
  }
}

function defaultScript(message) {
  if (Object.hasOwn(DEFAULT_RESULTS, message.method)) return DEFAULT_RESULTS[message.method];
  return {};
}

class FakeSafeCore extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string[]} [options.storeMoved] - the stores it takes, of those main names
   * @param {(message: object, core: FakeSafeCore) => any} [options.script]
   */
  constructor({ storeMoved = ['vault_meta', 'safe_pending'], script = defaultScript } = {}) {
    super();
    this.pid = 5016;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.storeMoved = storeMoved;
    this.script = script;
    this.moved = [];
    this.hello = null;
    this.requests = [];
    this.refused = [];
    this.cancels = [];
    this.killed = null;
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of this.decoder.push(chunk)) {
          if (frame.kind === KIND_JSON) this.onMessage(frame.message);
        }
        callback();
      },
      final: (callback) => {
        callback();
        setImmediate(() => this.exit(0, null));
      },
    });
  }

  onMessage(message) {
    if (message?.type === 'cancel') {
      this.cancels.push(message.id);
      return;
    }
    if (message?.type !== 'request') return;
    if (message.method === 'core.hello') {
      this.hello = message.params;
      const named = Array.isArray(message.params?.store_moved) ? message.params.store_moved : [];
      this.moved = named.filter((name) => this.storeMoved.includes(name));
      this.answer(message.id, {
        protocol: 2,
        core_version: '0.32.0',
        capabilities: ['vault.status', 'streams'],
        store_moved: this.moved,
      });
      this.decoder.setKinds(CORE_STREAM_KINDS);
      return;
    }
    if (message.method === 'core.shutdown') {
      this.answer(message.id, {});
      return;
    }
    this.requests.push(message);
    if (Object.hasOwn(SAFE_ROWS, message.method)) {
      try {
        readSafe(message.method, message.params, message.context, this.moved);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        this.refused.push({ message, error: err.body });
        this.fail(message.id, err.body);
        return;
      }
    }
    const answer = this.script(message, this);
    if (answer === undefined) return;
    if (answer && Object.hasOwn(answer, 'error') && Object.keys(answer).length === 1) {
      this.fail(message.id, answer.error);
    } else {
      this.answer(message.id, answer);
    }
  }

  answer(id, result) {
    this.stdout.write(encodeFrame({ type: 'response', id, result }));
  }

  fail(id, error) {
    this.stdout.write(encodeFrame({ type: 'response', id, error }));
  }

  /** Main's requests, or those named `method`. */
  sent(method) {
    return method ? this.requests.filter((m) => m.method === method) : this.requests;
  }

  methods() {
    return this.requests.map((m) => m.method);
  }

  kill(signal) {
    this.killed = signal;
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  exit(code, signal) {
    this.emit('exit', code, signal);
    setImmediate(() => {
      this.stdout.end();
      this.emit('close', code, signal);
    });
  }
}

/**
 * A real CoreClient against FakeSafeCores (`options`, but `log`, each's),
 * started: `{ client, cores }`, `cores` every process it spawned, in
 * order. `log` is the client's.
 */
async function startSafeCore({ log, ...options } = {}) {
  const cores = [];
  const client = new CoreClient({
    spawn: () => {
      const core = new FakeSafeCore(options);
      cores.push(core);
      return core;
    },
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
    grantRoot: os.tmpdir(),
  });
  await client.start();
  return { client, cores };
}

module.exports = {
  DEFAULT_RESULTS,
  FakeSafeCore,
  SAFE_ROWS,
  SESSION_ID,
  readSafe,
  startSafeCore,
};
