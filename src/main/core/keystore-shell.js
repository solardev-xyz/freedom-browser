/**
 * Main's `shell.keystore` executor (freedom-core design 0013, "The helper,
 * `freedom-cored keystore`", step PRF-2), and the helper runs it shares with
 * the drain of the forget file (keystore-drain.js).
 *
 * The core's desktop key store asks main `shell.keystore { op, policy, item,
 * sealed?, reply_key?, reason? }`. `serve` never calls a key store itself:
 * main checks the request's form, runs `freedom-cored keystore` for it, and
 * relays the helper's answer.
 *
 * - **The form,** as the core sends it: `op` is `create`, `open` or
 *   `forget`; `policy` `unattended` or `user_presence`; `item` 32 lowercase
 *   hex digits; `reply_key` (standard base64, padded, of 32 bytes) with
 *   `create` and `open` only; `reason` (`quick_unlock` or `export`) with an
 *   `open` only, and always with a `user_presence` one. No other member, and
 *   no `sealed`: DPAPI's blob is Windows' (PRF-7), where main has no
 *   executor yet. Anything else is `invalid_argument`, and no helper runs.
 * - **The run:** `freedom-cored keystore --op <op> --policy <policy> --item
 *   <id> [--reply-key <base64>] [--reason <kind>]`. Argv only: stdin is the
 *   null device, stderr is dropped, and the environment is the core's
 *   cleared one (scrubbedEnv). The wrapping key never passes through main:
 *   the helper seals it to `reply_key`, and main relays ciphertext.
 * - **One at a time** per main, so per profile: the executor's requests and
 *   the drain's `forget`s wait their turn in one queue.
 * - **Deadlines:** 60 s for `create` and `open`, which may wait on an
 *   unlock prompt or on Touch ID, and 10 s for `forget`. An executor
 *   request's deadline runs from its arrival, its wait in the queue
 *   included, so main always answers within the core's own wait (main's
 *   deadline and 5 s): one whose deadline passes while it waits answers
 *   `timeout` then, from a timer of its own, and leaves the queue, so no
 *   helper ever runs for it late. Past the deadline a running helper is
 *   killed, and the answer is `timeout`: the core's `Unavailable` with
 *   `reason: "timeout"`.
 * - **The answer** is the helper's one line on stdout, relayed as received,
 *   byte for byte, as the response's `result` (a JsonText). Main reads at
 *   most 4 KiB and its newline: a longer answer kills the helper at once,
 *   and is `too_large`. No line, more than one, a line cut short, or one
 *   that isn't a printable-ASCII JSON object is `internal`: the core reads
 *   any error other than `unknown_method`, `timeout` and `cancelled` as
 *   `Backend`, as 0013's "The answer" asks. The exit status isn't read.
 * - **Cancelled** (the core's cancel, or its exit): the helper is killed,
 *   or, for a call still waiting, it answers `cancelled` at once and leaves
 *   the queue.
 * - **Only where the helper has a backend:** macOS, until PRF-7 adds Linux's
 *   and Windows'. Elsewhere the core asks nothing (cored 0.17.0 answers
 *   `unsupported` without a call), and main registers no executor, so a
 *   stray request would be `unknown_method`.
 */

const { spawn: spawnProcess } = require('child_process');
const { JsonText, ShellError, scrubbedEnv } = require('./service-client');

/** The OSes whose helper has a key store (cored 0.17.0: the macOS Keychain). */
const KEYSTORE_PLATFORMS = Object.freeze(new Set(['darwin']));

/** How long main lets the helper run (0013, "Deadlines"). */
const DEADLINES_MS = Object.freeze({ create: 60_000, open: 60_000, forget: 10_000 });

/** The longest answer, without its newline (0013, "The answer"). */
const MAX_ANSWER_BYTES = 4096;

const OPS = new Set(['create', 'open', 'forget']);
const POLICIES = new Set(['unattended', 'user_presence']);
const REASONS = new Set(['quick_unlock', 'export']);
const FIELDS = new Set(['op', 'policy', 'item', 'sealed', 'reply_key', 'reason']);
const ITEM = /^[0-9a-f]{32}$/;
// 32 bytes in standard base64: 43 characters and one `=`.
const REPLY_KEY = /^[A-Za-z0-9+/]{43}=$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function hasKeystoreBackend(platform = process.platform) {
  return KEYSTORE_PLATFORMS.has(platform);
}

function refused() {
  return new ShellError('invalid_argument');
}

/** Standard base64, padded and canonical, of exactly 32 bytes. */
function isReplyKey(text) {
  if (typeof text !== 'string' || !REPLY_KEY.test(text)) return false;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === text;
}

/**
 * The request in `params`, in form: `{ op, policy, item, replyKey, reason }`
 * (the last two undefined where absent). Throws `invalid_argument` for
 * anything else.
 */
function checkRequest(params) {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw refused();
  if (!Object.keys(params).every((key) => FIELDS.has(key))) throw refused();
  const { op, policy, item, sealed, reply_key: replyKey, reason } = params;
  if (!OPS.has(op) || !POLICIES.has(policy)) throw refused();
  if (typeof item !== 'string' || !ITEM.test(item)) throw refused();
  // DPAPI's blob, Windows' alone (0013, "DPAPI's blob"): PRF-7's.
  if (sealed !== undefined) throw refused();
  if ((op !== 'forget') !== (replyKey !== undefined)) throw refused();
  if (replyKey !== undefined && !isReplyKey(replyKey)) throw refused();
  if (reason !== undefined && (op !== 'open' || !REASONS.has(reason))) throw refused();
  if (op === 'open' && policy === 'user_presence' && reason === undefined) throw refused();
  return { op, policy, item, replyKey, reason };
}

/** The helper's argv for a request in form, after the binary's name. */
function helperArgs({ op, policy, item, replyKey, reason }) {
  const args = ['keystore', '--op', op, '--policy', policy, '--item', item];
  if (replyKey !== undefined) args.push('--reply-key', replyKey);
  if (reason !== undefined) args.push('--reason', reason);
  return args;
}

/**
 * The answer line in `stdout`, without its newline, or null: exactly one
 * line, at most MAX_ANSWER_BYTES, printable ASCII, one JSON object.
 */
function answerLine(stdout) {
  const end = stdout.indexOf(0x0a);
  if (end < 1 || end !== stdout.length - 1 || end > MAX_ANSWER_BYTES) return null;
  const line = stdout.toString('latin1', 0, end);
  if (!PRINTABLE_ASCII.test(line)) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? line : null;
}

/**
 * Runs the helper one call at a time. `run(request, { signal, fromArrival })`
 * resolves to the answer line, or rejects with a ShellError: `timeout`,
 * `too_large`, `cancelled` or `internal`. With `fromArrival`, the deadline
 * runs from the call, its wait in the queue included; otherwise from the
 * helper's start. A call still waiting answers at once when it's cancelled,
 * or when a `fromArrival` deadline passes, and leaves the queue: no helper
 * runs for it.
 *
 * @param {object} options
 * @param {string|function(): string} options.command - freedom-cored
 * @param {Function} [options.spawn]
 * @param {object} [options.deadlines] - DEADLINES_MS by op
 * @param {function(): object} [options.env] - the helper's environment
 */
function createHelperRunner({
  command,
  spawn = spawnProcess,
  deadlines = DEADLINES_MS,
  env = () => scrubbedEnv(),
} = {}) {
  // The calls waiting their turn, first first, and whether a helper runs.
  const waiting = [];
  let busy = false;

  function runOne(request, signal, until) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ShellError('cancelled'));
        return;
      }
      const left = until - Date.now();
      if (left <= 0) {
        reject(new ShellError('timeout'));
        return;
      }
      let child;
      try {
        child = spawn(typeof command === 'function' ? command() : command, helperArgs(request), {
          env: env(),
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch {
        reject(new ShellError('internal'));
        return;
      }
      const chunks = [];
      let size = 0;
      let stopped = null;
      let settled = false;
      const stop = (code) => {
        if (stopped) return;
        stopped = code;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => stop('timeout'), left);
      const onAbort = () => stop('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (error, line) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(line);
      };
      child.stdout.on('data', (chunk) => {
        if (stopped) return;
        size += chunk.length;
        // The answer and its newline, and not a byte more.
        if (size > MAX_ANSWER_BYTES + 1) {
          stop('too_large');
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', () => {
        // A binary that never started gives no 'close'.
        if (child.pid === undefined) settle(new ShellError('internal'));
      });
      child.on('close', () => {
        if (stopped) {
          settle(new ShellError(stopped));
          return;
        }
        const line = answerLine(Buffer.concat(chunks));
        if (line === null) settle(new ShellError('internal'));
        else settle(null, line);
      });
    });
  }

  /** Starts the first waiting call once no helper runs. */
  function next() {
    if (busy) return;
    const call = waiting.shift();
    if (!call) return;
    call.leave();
    busy = true;
    const until = call.until ?? Date.now() + deadlines[call.request.op];
    runOne(call.request, call.signal, until)
      .then(call.resolve, call.reject)
      .finally(() => {
        busy = false;
        next();
      });
  }

  function run(request, { signal = null, fromArrival = false } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ShellError('cancelled'));
        return;
      }
      const until = fromArrival ? Date.now() + deadlines[request.op] : null;
      const call = { request, signal, until, resolve, reject };
      // A call that waits answers at once when it's cancelled, or when an
      // executor request's deadline runs out: it leaves the queue, and no
      // helper runs for it.
      const drop = (code) => {
        const at = waiting.indexOf(call);
        if (at === -1) return;
        waiting.splice(at, 1);
        call.leave();
        reject(new ShellError(code));
      };
      const onAbort = () => drop('cancelled');
      const timer = until === null ? null : setTimeout(() => drop('timeout'), until - Date.now());
      signal?.addEventListener('abort', onAbort, { once: true });
      call.leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      waiting.push(call);
      next();
    });
  }

  return { run };
}

let sharedRunner = null;

/** This main's runner, on the bundled freedom-cored: the executor and the
 * drain share it, so one helper runs at a time. */
function getHelperRunner() {
  if (!sharedRunner) {
    sharedRunner = createHelperRunner({
      command: () => require('./cored-binary').getCoredBinaryPath(),
    });
  }
  return sharedRunner;
}

/**
 * Registers `shell.keystore` on the core's client where the helper has a key
 * store. Returns whether it did.
 */
function registerKeystoreShell(
  client,
  { runner = getHelperRunner(), platform = process.platform } = {}
) {
  if (!hasKeystoreBackend(platform)) return false;
  client.handle('shell.keystore', async (params, { signal }) => {
    const request = checkRequest(params);
    const line = await runner.run(request, { signal, fromArrival: true });
    return new JsonText([line]);
  });
  return true;
}

module.exports = {
  DEADLINES_MS,
  KEYSTORE_PLATFORMS,
  MAX_ANSWER_BYTES,
  answerLine,
  checkRequest,
  createHelperRunner,
  getHelperRunner,
  hasKeystoreBackend,
  helperArgs,
  registerKeystoreShell,
};
