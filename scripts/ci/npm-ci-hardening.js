#!/usr/bin/env node

/**
 * Deterministic `npm ci` for CI runners.
 *
 * Why this exists
 * ---------------
 * `npm ci` intermittently hangs forever on GitHub-hosted runners and the only
 * thing that ends it is the job's `timeout-minutes` (#379: seven jobs across
 * four PRs in one week, plus main's own run and an 82-minute arm64 nightly).
 * The step logs nothing before hanging and the runner's cleanup reports
 * `Terminate orphan process: pid (…) (npm ci)`; a rerun always passes, so it
 * is a network stall rather than a dependency problem. `npm ci` has no
 * wall-clock bound of its own: `fetch-timeout` is per-request, and the
 * lifecycle scripts it runs (this repo's `postinstall`, which ends in
 * `electron-builder install-app-deps`) have no timeout at all. Note that the
 * `electron` package itself has no postinstall: it fetches its ~100 MB binary
 * lazily on the first `require('electron')`, in whichever later step of the
 * job launches Electron — not here.
 *
 * A timeout-minutes cancellation is the worst possible shape for this: the job
 * burns its whole budget, the conclusion reads "cancelled" rather than
 * "failed", and on `main` it turns the branch red without saying why.
 * `scripts/ci/apt-hardening.sh` solved exactly this for apt; this is the npm
 * equivalent, and it is a Node script rather than a shell one because it has
 * to run identically on the Linux, macOS and Windows legs (`timeout(1)` ships
 * on none of the latter two by default).
 *
 * What this does about it
 * -----------------------
 *   * Runs `npm ci` under a per-attempt wall-clock bound and retries it, up to
 *     3 attempts, removing `node_modules` between attempts so a retry is a
 *     clean install rather than a resume of a half-written tree.
 *   * Bounds the *whole* step as well as each attempt. Three unbounded-length
 *     attempts would add up to more than the 15 minutes most jobs in
 *     `.github/workflows/ci.yml` allow themselves, which would put us straight
 *     back to a cancellation; the total budget is what guarantees the step
 *     fails as a real failure, with a message, inside the job's cap.
 *   * Kills the whole process tree on a timeout, not just `npm` itself — the
 *     stall can sit inside a grandchild (a registry fetch, or a `postinstall`
 *     lifecycle script), which would otherwise survive and keep holding the
 *     runner.
 *
 * Sizing (measured, not round numbers)
 * ------------------------------------
 * Windows gets its own, larger numbers because its measured distribution is a
 * different animal, not because the platform feels slow. Healthy `npm ci`
 * durations observed across CI runs 35154835232, 35150253743 and 35205465778:
 *
 *   Linux    7-44s      macOS   10-77s      Windows   30-337s
 *
 * The Windows tail is real rather than a one-off — 251s before this change and
 * 337s after it, on a run where three sibling Windows jobs finished the same
 * install in 106-122s (and where no leg fetches Electron: see above). So a
 * bound generous enough for Windows would be ~7x the whole healthy range
 * everywhere else, and one tight enough elsewhere would false-kill a healthy
 * Windows install. Hence:
 *
 *                 per attempt   step budget   headroom over the slowest
 *   Windows       540s          660s          1.6x (337s)
 *   Linux/macOS   300s          600s          3.9x (77s)
 *
 * Both budgets have to leave the job's own `timeout-minutes` room to report a
 * real failure rather than cancelling: the tightest cap on any job that
 * installs is 15 minutes (`.github/workflows/ci.yml`), and the slowest observed
 * checkout + setup-node preflight is 102s — 660 + 102 is 12.7 minutes, inside
 * it. Do not raise the step budget without re-checking that sum.
 *
 * Usage:
 *   node scripts/ci/npm-ci-hardening.js [--ignore-scripts]
 *
 * Tunables (environment):
 *   FREEDOM_CI_NPM_ATTEMPTS          attempts                (default 3)
 *   FREEDOM_CI_NPM_ATTEMPT_TIMEOUT   seconds per attempt     (default 540/300)
 *   FREEDOM_CI_NPM_TOTAL_TIMEOUT     seconds for all of them (default 660/600)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const DEFAULT_ATTEMPTS = 3;

/**
 * Per-platform wall-clock defaults. See the "Sizing" section of the header for
 * where each number comes from; the short version is that a healthy Windows
 * install has been measured at up to 337s and a healthy install anywhere else
 * at up to 77s, so one bound cannot serve both without either false-killing
 * Windows or letting a Linux stall run for minutes it does not need.
 */
const PLATFORM_DEFAULTS = {
  win32: { attemptTimeoutMs: 540_000, totalBudgetMs: 660_000 },
  default: { attemptTimeoutMs: 300_000, totalBudgetMs: 600_000 },
};

/**
 * @param {NodeJS.Platform} [platform]
 * @returns {{ attemptTimeoutMs: number, totalBudgetMs: number }}
 */
function defaultBudget(platform = process.platform) {
  return PLATFORM_DEFAULTS[platform] || PLATFORM_DEFAULTS.default;
}

/**
 * Grace between SIGTERM and SIGKILL for a timed-out attempt.
 *
 * POSIX only in practice: Windows has no SIGTERM for a console process, so the
 * Windows kill is forceful in one stage and never spends this grace. See
 * `killTree`.
 */
const KILL_GRACE_MS = 30_000;

/** A retry that starts with less than this left in the budget cannot finish. */
const MIN_ATTEMPT_MS = 30_000;

const log = (message) => {
  process.stdout.write(`[npm-ci-hardening] ${message}\n`);
};

const warn = (message) => {
  process.stdout.write(`::warning::[npm-ci-hardening] ${message}\n`);
};

const fail = (message) => {
  process.stdout.write(`::error::[npm-ci-hardening] ${message}\n`);
};

/**
 * Read a positive-integer tunable from the environment.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readPositiveInt(env, name, fallback) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    warn(`ignoring ${name}=${raw} (expected a positive integer); using ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * Resolve the attempt/timeout budget from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {{ attempts: number, attemptTimeoutMs: number, totalBudgetMs: number }}
 */
function resolveBudget(env = process.env, platform = process.platform) {
  const defaults = defaultBudget(platform);
  const attempts = readPositiveInt(env, 'FREEDOM_CI_NPM_ATTEMPTS', DEFAULT_ATTEMPTS);
  const attemptTimeoutMs =
    readPositiveInt(env, 'FREEDOM_CI_NPM_ATTEMPT_TIMEOUT', defaults.attemptTimeoutMs / 1000) * 1000;
  const totalBudgetMs =
    readPositiveInt(env, 'FREEDOM_CI_NPM_TOTAL_TIMEOUT', defaults.totalBudgetMs / 1000) * 1000;
  return { attempts, attemptTimeoutMs, totalBudgetMs };
}

/**
 * Kill a child and everything it started.
 *
 * `npm ci` is a process tree — the stall we are bounding can live in a
 * grandchild (a registry fetch, or a `postinstall` lifecycle script), so
 * signalling `npm` alone leaves the stalled fetch running and holding the
 * runner. On POSIX the child is spawned detached, which puts it in its own
 * process group we can signal as a unit; on Windows `taskkill /T` walks the
 * tree instead.
 *
 * Windows always gets `/F`, on the soft stage too. `taskkill` without it asks
 * politely by posting `WM_CLOSE` to the tree's *windows*, which a console
 * process (cmd, npm, node, a lifecycle script) has none of, so it refuses
 * with "could not be terminated" and nothing dies — the soft stage
 * would be pure decoration that spends the whole `KILL_GRACE_MS` before the
 * forceful stage did the actual work, while the warning claiming we killed it
 * printed 30s earlier. There is no Windows equivalent of SIGTERM here to wait
 * for, so the graceful stage is skipped rather than faked.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @param {{ platform?: NodeJS.Platform, spawnFn?: typeof spawn }} [deps]
 */
function killTree(child, signal, { platform = process.platform, spawnFn = spawn } = {}) {
  if (!child.pid) {
    return;
  }
  if (platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T', '/F'];
    spawnFn('taskkill', args, { stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone; nothing to signal.
  }
}

/**
 * Shape the `spawn` call for the platform we are on.
 *
 * Windows has to go through a shell, because `npm` is really `npm.cmd` and
 * Node refuses to spawn a `.cmd` directly (CVE-2024-27980). Under `shell: true`
 * an args *array* is deprecated — Node 24, which this repo's CI pins, prints
 * `DEP0190 DeprecationWarning` on every Windows install — because the shell
 * concatenates the array without escaping it. So the Windows leg does the
 * concatenation itself and passes one command string: every argument this
 * script spawns is a fixed literal (`ci`, `--ignore-scripts`), so there is
 * nothing to escape and nothing to inject.
 *
 * `detached` is the POSIX half of the same story: it puts the child in its own
 * process group `killTree` can signal as a unit. The two are mutually
 * exclusive — Windows kills through `taskkill /T /F` instead.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, args: string[], shell: boolean, detached: boolean }}
 */
function spawnShape(command, args, platform = process.platform) {
  if (platform === 'win32') {
    return { command: [command, ...args].join(' '), args: [], shell: true, detached: false };
  }
  return { command, args, shell: false, detached: true };
}

/**
 * Run a command under a wall-clock bound.
 *
 * @param {{ command: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ code: number|null, timedOut: boolean }>}
 */
function spawnBounded({ command, args, cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    const shape = spawnShape(command, args);
    const child = spawn(shape.command, shape.args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: shape.shell,
      detached: shape.detached,
    });

    let timedOut = false;
    let settled = false;

    const softKill = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
    }, timeoutMs);
    const hardKill = setTimeout(() => {
      if (timedOut) {
        killTree(child, 'SIGKILL');
      }
    }, timeoutMs + KILL_GRACE_MS);

    const settle = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(softKill);
      clearTimeout(hardKill);
      resolve({ code, timedOut });
    };

    child.on('error', (err) => {
      warn(`could not start ${command}: ${err.message}`);
      settle(null);
    });
    child.on('close', (code) => settle(code));
  });
}

/**
 * Remove `node_modules` so the next attempt installs into a clean tree.
 *
 * A killed `npm ci` leaves a partially written tree behind. `npm ci` does
 * remove `node_modules` itself before installing, but doing it here means the
 * removal is bounded by nothing more than the filesystem, and it keeps the
 * retry honest if the previous attempt died mid-write.
 *
 * @param {string} cwd
 */
function removeNodeModules(cwd) {
  const dir = path.join(cwd, 'node_modules');
  if (!fs.existsSync(dir)) {
    return;
  }
  log('removing the partially installed node_modules before retrying');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Where `@electron/get` keeps the Electron zip it downloads.
 *
 * This is the single largest thing a job pulls (~100 MB from GitHub releases,
 * no timeout of its own), so it is the stall source worth caching away
 * entirely. It is not pulled by `npm ci`: the `electron` package has no
 * postinstall script, and `node_modules/electron/index.js` downloads the
 * binary on the first `require('electron')` — a Playwright launch, a build —
 * so a warm cache spares that later step rather than the install itself. The
 * path is not configurable in this repo — `@electron/get` v5 defaults its
 * cache root to `env-paths('electron', { suffix: '' }).cache`
 * (`node_modules/@electron/get/dist/Cache.js`) — so this mirrors `env-paths`'
 * own rule rather than guessing, and is what the composite action hands to
 * `actions/cache`.
 *
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, homedir?: string }} [options]
 * @returns {string}
 */
function electronCacheDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Caches', 'electron');
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    return path.join(localAppData, 'electron', 'Cache');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(homedir, '.cache'), 'electron');
}

/**
 * Run `npm ci` with a per-attempt wall-clock bound, retries and a total budget.
 *
 * @param {object} [options]
 * @param {boolean} [options.ignoreScripts] pass `--ignore-scripts` to npm
 * @param {number} [options.attempts]
 * @param {number} [options.attemptTimeoutMs]
 * @param {number} [options.totalBudgetMs]
 * @param {string} [options.cwd]
 * @param {(options: object) => Promise<{ code: number|null, timedOut: boolean }>} [options.run]
 * @param {(cwd: string) => void} [options.clean]
 * @param {() => number} [options.now]
 * @returns {Promise<{ ok: boolean, attemptsUsed: number, reason: string }>}
 */
async function installWithRetries({
  ignoreScripts = false,
  attempts = DEFAULT_ATTEMPTS,
  attemptTimeoutMs = defaultBudget().attemptTimeoutMs,
  totalBudgetMs = defaultBudget().totalBudgetMs,
  cwd = REPO_ROOT,
  run = spawnBounded,
  clean = removeNodeModules,
  now = Date.now,
} = {}) {
  const args = ignoreScripts ? ['ci', '--ignore-scripts'] : ['ci'];
  const label = `npm ${args.join(' ')}`;
  const startedAt = now();

  log(
    `${label}: up to ${attempts} attempts, ${Math.round(attemptTimeoutMs / 1000)}s per attempt, ` +
      `${Math.round(totalBudgetMs / 1000)}s for the step`
  );

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingMs = totalBudgetMs - (now() - startedAt);
    if (remainingMs < MIN_ATTEMPT_MS) {
      const reason =
        `${label} ran out of its ${Math.round(totalBudgetMs / 1000)}s budget after ` +
        `${attempt - 1} attempts`;
      fail(reason);
      return { ok: false, attemptsUsed: attempt - 1, reason };
    }

    // An attempt never outlives the step's own budget: the point of the bound
    // is that the failure is reported by this script, not by the job's
    // timeout-minutes cancelling everything.
    const boundMs = Math.min(attemptTimeoutMs, remainingMs);
    log(
      `${label}: attempt ${attempt}/${attempts} (bound ${Math.round(boundMs / 1000)}s, ` +
        `${Math.round(remainingMs / 1000)}s left in the step budget)`
    );

    const attemptStartedAt = now();
    const { code, timedOut } = await run({
      command: 'npm',
      args,
      cwd,
      timeoutMs: boundMs,
    });
    const elapsedSeconds = Math.round((now() - attemptStartedAt) / 1000);

    if (!timedOut && code === 0) {
      log(`${label}: succeeded in ${elapsedSeconds}s on attempt ${attempt}`);
      return { ok: true, attemptsUsed: attempt, reason: '' };
    }

    if (timedOut) {
      warn(
        `${label}: no completion within ${Math.round(boundMs / 1000)}s on attempt ${attempt} — ` +
          `the registry or a lifecycle script is stalled; killed it and retrying`
      );
    } else {
      warn(`${label}: exited ${code} after ${elapsedSeconds}s on attempt ${attempt}`);
    }

    if (attempt < attempts) {
      clean(cwd);
    }
  }

  const reason = `${label} failed after ${attempts} attempts`;
  fail(
    `${reason}. This is a real failure, not a cancelled job: each attempt was bounded at ` +
      `${Math.round(attemptTimeoutMs / 1000)}s and the step at ${Math.round(totalBudgetMs / 1000)}s. ` +
      `A run of timeouts points at the npm registry or a stalled lifecycle script; a run of ` +
      `non-zero exits points at the lockfile or a lifecycle script's own failure.`
  );
  return { ok: false, attemptsUsed: attempts, reason };
}

module.exports = {
  DEFAULT_ATTEMPTS,
  PLATFORM_DEFAULTS,
  defaultBudget,
  MIN_ATTEMPT_MS,
  electronCacheDir,
  installWithRetries,
  killTree,
  removeNodeModules,
  resolveBudget,
  spawnBounded,
  spawnShape,
};

if (require.main === module) {
  // The composite action asks for the cache directory before it installs
  // anything, so the path lives here next to the reason it is that path.
  if (process.argv.includes('--print-electron-cache-dir')) {
    process.stdout.write(`${electronCacheDir()}\n`);
  } else {
    const ignoreScripts = process.argv.includes('--ignore-scripts');
    installWithRetries({ ignoreScripts, ...resolveBudget() })
      .then(({ ok }) => {
        process.exitCode = ok ? 0 : 1;
      })
      .catch((err) => {
        fail(`unexpected error: ${err && err.stack ? err.stack : err}`);
        process.exitCode = 1;
      });
  }
}
