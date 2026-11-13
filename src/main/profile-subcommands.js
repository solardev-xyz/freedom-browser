/**
 * freedom-cored's profile subcommands, run from main (freedom-core design
 * 0013, 5.1 and "API", step PRF-4). Each is one short run on main's own
 * arguments, in the core's cleared environment (0001's Spawn), that reads
 * nothing a page or the network sent:
 *
 * - `profile open`, with `spawnSync` (5 s at most) before `app.setPath`, and
 *   `profile migrate --finish-only`, with `spawnSync` before the profile
 *   lock: main holds no lease while either blocks;
 * - the catalog's other operations (`list`, `create`, `rename`, `import`,
 *   `delete`, `update-nodes`, `reserved-ports`, `status`), with an
 *   asynchronous `spawn`, so main's own lock keeps refreshing while one runs.
 *
 * **Results** are one JSON line on stdout (`migrate`'s, one word). **Exits:**
 * 0 with the result; 64 for usage; 65 for a request the reference refuses,
 * `{ error: "refused", message }`, whose message is the reference's own;
 * 74 for storage, `{ error: <kind> }`; 75 when the catalog's write lock stays
 * held (`{ error: "busy" }`) or, for `delete`, a gate is held
 * (`{ error: "lock_held", gate }`) or the forget file is full
 * (`{ error: "forget_backlog" }`); 77 when confinement refuses the process.
 */

const { spawn: spawnProcess, spawnSync: spawnSyncProcess } = require('child_process');
const { scrubbedEnv } = require('./core/service-client');

/** `profile open`'s and `migrate`'s bound (0013, 5.1, "How main calls it"). */
const SYNC_TIMEOUT_MS = 5_000;
/** The catalog operations' bound. A delete removes a profile's data, which
 * can take long, so it has none of its own. */
const ASYNC_TIMEOUT_MS = 30_000;
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 16 * 1024;

const EXIT_CODES = new Map([
  [64, 'usage'],
  [65, 'refused'],
  [74, 'storage'],
  [75, 'busy'],
  [77, 'confinement'],
]);

const MESSAGES = {
  usage: 'freedom-cored refused the profile command',
  busy: 'Another Freedom window is changing the profiles. Try again in a moment.',
  lock_held: 'This profile is open. Close its window and try again.',
  forget_backlog:
    "Freedom couldn't clear a deleted profile's saved keys yet. Try again in a moment.",
  storage: "Freedom can't use the profile data on this storage",
  confinement: "freedom-cored couldn't confine itself on this system",
  timeout: 'freedom-cored took too long with the profile command',
  missing: 'freedom-cored is missing from this installation. Reinstall Freedom.',
  failed: "freedom-cored couldn't run the profile command",
};

const STORAGE_MESSAGES = {
  unreadable: "The profile catalog can't be read",
  unsupported: 'The profile catalog was written by a newer Freedom',
  malformed: 'The profile catalog is damaged',
  network_filesystem: "Freedom's profiles can't live on a network filesystem",
  unqualified: "Freedom can't tell whether this storage is local",
  symlink: "A link below Freedom's data directory isn't allowed",
  lock_lost: 'Another Freedom took over the profile catalog meanwhile. Try again.',
  not_owned: "Freedom's data directory doesn't belong to this user",
};

/**
 * A subcommand that didn't give its result. `code` is `refused` (its
 * message the reference's), `busy`, `lock_held` (`gate` names which),
 * `forget_backlog`, `storage` (`kind` names which), `usage`, `confinement`,
 * `timeout`, `missing` or `failed`.
 */
class ProfileSubcommandError extends Error {
  constructor(code, message, { kind = null, gate = null, exit = null, raw = '' } = {}) {
    super(message || MESSAGES[code] || MESSAGES.failed);
    this.name = 'ProfileSubcommandError';
    this.code = code;
    this.kind = kind;
    this.gate = gate;
    this.exit = exit;
    // stdout's text: `migrate`'s one word (`busy`, `lock_lost`, `corrupt`).
    this.raw = raw;
  }
}

/** The last JSON line of `stdout`, or undefined. */
function lastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return undefined;
  }
}

/** The last stderr line's `kind`, from the core's JSON log lines. */
function stderrKind(stderr) {
  const lines = String(stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.kind) return String(entry.kind);
    } catch {
      // Not one of its JSON lines.
    }
  }
  return null;
}

/**
 * The outcome of one run: the parsed result for exit 0, a
 * ProfileSubcommandError otherwise. `raw` keeps stdout's text for `migrate`,
 * whose answer is one word.
 */
function settle({ status, signal, stdout, stderr, error, timedOut }) {
  if (error?.code === 'ENOENT') throw new ProfileSubcommandError('missing');
  if (timedOut || error?.code === 'ETIMEDOUT') throw new ProfileSubcommandError('timeout');
  if (error) throw new ProfileSubcommandError('failed', null);
  const parsed = lastJsonLine(stdout);
  const raw = String(stdout || '').trim();
  if (status === 0) {
    return { result: parsed, raw };
  }
  const code = EXIT_CODES.get(status) || 'failed';
  const answer = parsed && typeof parsed === 'object' ? parsed : {};
  if (code === 'refused') {
    throw new ProfileSubcommandError('refused', answer.message || MESSAGES.failed, {
      exit: status,
      raw,
    });
  }
  if (code === 'busy' && (answer.error === 'lock_held' || answer.error === 'forget_backlog')) {
    throw new ProfileSubcommandError(answer.error, null, {
      gate: answer.gate ?? null,
      exit: status,
      raw,
    });
  }
  if (code === 'storage') {
    const kind = (typeof answer.error === 'string' && answer.error) || stderrKind(stderr);
    throw new ProfileSubcommandError('storage', STORAGE_MESSAGES[kind] || MESSAGES.storage, {
      kind,
      exit: status,
      raw,
    });
  }
  throw new ProfileSubcommandError(code, null, { exit: status ?? signal ?? null, raw });
}

/**
 * Runs `command args…` and waits for it, blocking main: `profile open` and
 * `profile migrate`, before main holds a lease. Returns `{ result, raw, ms }`
 * (`ms`, the wall time 0013's latency gate measures) or throws a
 * ProfileSubcommandError.
 */
function runSync(command, args, { timeoutMs = SYNC_TIMEOUT_MS, spawnSync = spawnSyncProcess } = {}) {
  const started = process.hrtime.bigint();
  const run = spawnSync(command, args, {
    env: scrubbedEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_STDOUT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const outcome = settle({
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
    error: run.error,
    timedOut: run.error?.code === 'ETIMEDOUT',
  });
  return { ...outcome, ms };
}

/**
 * Runs `command args…` without blocking main: the catalog's operations.
 * Resolves to `{ result, raw, ms }` or rejects with a ProfileSubcommandError.
 * `timeoutMs: 0` sets no bound (a delete).
 */
function run(command, args, { timeoutMs = ASYNC_TIMEOUT_MS, spawn = spawnProcess } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let child;
    try {
      child = spawn(command, args, {
        env: scrubbedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new ProfileSubcommandError(error?.code === 'ENOENT' ? 'missing' : 'failed'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let done = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR);
    });
    child.on('error', (error) => {
      spawnError = error;
      // A binary that never started gives no 'close' to wait for.
      if (child.pid === undefined && !done) {
        done = true;
        if (timer) clearTimeout(timer);
        reject(new ProfileSubcommandError(error?.code === 'ENOENT' ? 'missing' : 'failed'));
      }
    });
    child.on('close', (status, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      try {
        resolve({
          ...settle({ status, signal, stdout, stderr, error: spawnError, timedOut }),
          ms,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = {
  ASYNC_TIMEOUT_MS,
  ProfileSubcommandError,
  SYNC_TIMEOUT_MS,
  run,
  runSync,
  settle,
};
