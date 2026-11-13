/**
 * The import on freedom-radicled's one-shot import process (freedom-core
 * design 0010, D5; design 0008, Writes "Import"; the radicled step-5 plan's
 * B14), for radicle-manager.js under `FREEDOM_RADICLE_BACKEND=service`. The
 * manager stops the service before it and starts it again after it: the
 * process takes the Radicle home's gate the service let go.
 *
 * - **Before the spawn:** a wait for the vault's unlock, as a start waits
 *   (0008, "When the node can start"): nothing is spawned while the vault
 *   is locked, and the manager's `onWaiting` says so once. Then main's check
 *   (design 0010, step 7), before the spawn: the Radicle home and the
 *   service's `HOME` as the service's grants (radicled-client.js's), and the
 *   working copy against the protected roots, the home and that `HOME`
 *   (`radicleSourceRefusal`, refused as `unsupported_layout`). The process
 *   is handed the protected roots, resolved (`radicleImportRoots`), and
 *   checks the working copy's other roots itself.
 * - **The process:** `freedom-radicled import --home … --lock-dir …
 *   --source <path> --protected <root>… --parent-pid <pid>`
 *   (radicled-client.js), offline. It is never restarted: it exits after
 *   the import's answer, and any other end of it ends the import.
 * - **The steps,** as at a start: `rad.hello`; the node key, sealed by the
 *   core to hello's recipient; `rad.identity { sealed }`, never `{
 *   ephemeral: true }`: on the core's `no_vault` the import is refused
 *   (`needs_vault`), and the process makes no throwaway key; `rad.reconcile`,
 *   watched for 300 s + 15 s (`deadline` is "Radicle is still repairing its
 *   data", for which the Retry is another import; `recovery_failed` its
 *   message); then `rad.import_repo { path, name, description,
 *   default_branch }`, watched for 300 s + 15 s, `path` being `--source`
 *   exactly.
 * - **The answer:** `{ rid }`, as the add-on's `importRepo` answers it; the
 *   service's refusal, as it answered it (`code` and `message`; before its
 *   start every refusal is definitive, and "already exists in storage" is a
 *   repository already imported); or `outcome_unknown` when the process
 *   ends with the import sent and unanswered (a crash, a kill, main's
 *   watchdog, or its own deadline's exit 70): the repository may have been
 *   imported, and the service's next start reconciles the home. The service
 *   answers its own `outcome_unknown` for a libradicle error past the start.
 * - **A stop** (`signal`, the manager's) before the import is sent ends the
 *   process with nothing imported (`stopped`); once it is sent, its answer
 *   is waited for, so its outcome is known.
 *
 * Main's texts name no path.
 */

const { spawn: spawnProcess } = require('child_process');
const { CoreError, isObject } = require('../core/service-client');
const defaultLog = require('../logger');
const { confinementLog } = require('../ipfs/ipfsd-client');
const { radicleImportRoots, radicleSourceRefusal } = require('../service-grant');
const { RadicledClient } = require('./radicled-client');
const {
  coreKeys,
  clientFailure,
  GRANT_REFUSED,
  KEY_UNAVAILABLE,
  REPAIRING,
} = require('./radicled-node');

const UNAVAILABLE = 'radicle_unavailable';
const OUTCOME_UNKNOWN = 'outcome_unknown';

const IMPORT_OUTCOME_UNKNOWN =
  'The Radicle import stopped before it was confirmed; the repository may have been imported.';
const IMPORT_STOPPED = 'Radicle was stopped before the import started; nothing was imported.';
const IMPORT_NEEDS_VAULT =
  "Radicle has no vault identity to publish with, so it can't import. Set up your identity first.";
const IMPORT_START_FAILED = "The Radicle import process couldn't start";
const IDENTITY_MISMATCH =
  'freedom-radicled answered the import with an identity main did not ask for';
const SOURCE_REFUSED = "The repository can't be imported from where it is";

// A start step's codes whose message main shows (0008, Errors).
const STEP_MESSAGES = new Set([
  'recovery_failed',
  'bad_sealed_key',
  'no_identity',
  'invalid_argument',
  'key_file_present',
]);

// The sealed key's wait ended with the vault locked again: wait, then spawn
// anew.
const AGAIN = Symbol('again');

/** `rad.import_repo`'s params: today's `importRepo` arguments, by name. */
function importParams(source, name, description, defaultBranch) {
  return { path: source, name, description, default_branch: defaultBranch };
}

const stopped = () => new CoreError('stopped', IMPORT_STOPPED);

/** Main's own checks before the spawn (design 0010, step 7). */
const CHECKS = Object.freeze({
  roots: () => radicleImportRoots(),
  source: (source, grants) => radicleSourceRefusal(source, grants),
});

/**
 * The next vault event, or `signal`'s abort: `{ promise, cancel }`. Idempotent.
 */
function nextVaultEvent(keys, signal) {
  let wake;
  const promise = new Promise((resolve) => {
    wake = resolve;
  });
  let unsubscribe = () => {};
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    signal?.removeEventListener('abort', finish);
    try {
      unsubscribe();
    } catch {
      // Gone already.
    }
    wake();
  };
  try {
    unsubscribe = keys.onVaultEvent(() => finish()) ?? (() => {});
  } catch {
    unsubscribe = () => {};
  }
  signal?.addEventListener('abort', finish, { once: true });
  return { promise, cancel: finish };
}

/**
 * Resolves true once a spawn may go ahead: the vault is unlocked, or there
 * is none (the seal then answers `no_vault`). While it is locked, waits for
 * the core's next vault event, then asks again; `onWaiting()` once. False
 * once `signal` aborts. A vault whose state can't be read fails the import.
 */
async function untilVaultUsable(keys, { signal, onWaiting, log }) {
  let told = false;
  for (;;) {
    if (signal?.aborted) return false;
    // Subscribed before asking, so an unlock meanwhile isn't missed.
    const woken = nextVaultEvent(keys, signal);
    let status;
    try {
      status = await keys.status();
    } catch (err) {
      woken.cancel();
      log.error("[Radicle] The vault's state couldn't be read for the import", {
        code: err?.code || 'error',
      });
      throw new CoreError('failed', KEY_UNAVAILABLE);
    }
    if (signal?.aborted) {
      woken.cancel();
      return false;
    }
    if (!status?.exists || status.unlocked) {
      woken.cancel();
      return true;
    }
    if (!told) {
      told = true;
      log.info('[Radicle] The vault is locked: the import starts once it is unlocked');
      try {
        onWaiting?.();
      } catch {
        // The status line only.
      }
    }
    await woken.promise;
  }
}

/** What a start step's error `err` fails the import with (0008, Errors). */
function stepError(err) {
  const code = typeof err?.code === 'string' ? err.code : 'failed';
  if (code === 'deadline') return new CoreError('deadline', REPAIRING);
  if (STEP_MESSAGES.has(code) && typeof err.message === 'string' && err.message) {
    return new CoreError(code, err.message);
  }
  return new CoreError(code, IMPORT_START_FAILED);
}

/**
 * Runs one import on a fresh import process (see the module's doc).
 *
 * @param {object} options
 * @param {string} options.home - the profile's Radicle home
 * @param {string} options.lockDir - the core's lock directory
 * @param {string} options.ownHome - the service's own `HOME`
 * @param {string} options.source - the working copy, absolute, as
 *   `--source` and `path` both name it
 * @param {string} options.name - the repository's name
 * @param {string} options.description
 * @param {string} options.defaultBranch
 * @param {AbortSignal} [options.signal] - the manager's stop
 * @param {Function} [options.onWaiting] - () once the import waits for the
 *   vault's unlock
 * @param {object} [options.keys] - the core (radicled-node.js's `coreKeys()`)
 * @param {object} [options.checks] - main's checks (`CHECKS`; a test seam)
 * @param {string} [options.command] - the binary
 * @param {Function} [options.spawn] - child_process.spawn (injectable)
 * @param {string|null} [options.serviceVersion] - the release hello must
 *   report (the client's default)
 * @param {object} [options.log]
 * @param {string} [options.shellVersion]
 * @returns {Promise<object>} the service's `{ rid }`
 */
async function runRadicledImport(options) {
  const { signal = null, onWaiting = null, log = defaultLog } = options;
  const keys = options.keys ?? coreKeys();
  for (;;) {
    if (signal?.aborted) throw stopped();
    if (!(await untilVaultUsable(keys, { signal, onWaiting, log }))) throw stopped();
    const answer = await importOnce({ ...options, keys, log });
    if (answer !== AGAIN) return answer;
  }
}

async function importOnce({
  home,
  lockDir,
  ownHome,
  source,
  name,
  description,
  defaultBranch,
  signal = null,
  keys,
  checks = CHECKS,
  command,
  spawn = spawnProcess,
  serviceVersion,
  log,
  shellVersion,
  now,
  setTimer,
  clearTimer,
}) {
  // Main's check of the working copy, and the roots the process checks the
  // rest against: before anything is spawned. A check that throws refuses.
  let sourceRefusal = null;
  let protectedRoots;
  try {
    protectedRoots = checks.roots();
  } catch (err) {
    sourceRefusal = `the check failed: ${err?.code || err?.name || 'error'}`;
  }
  const refuseSource = () => {
    if (sourceRefusal) return sourceRefusal;
    try {
      sourceRefusal = checks.source(source, { home, ownHome }) ?? null;
    } catch (err) {
      sourceRefusal = `the check failed: ${err?.code || err?.name || 'error'}`;
    }
    if (sourceRefusal)
      log.error('[Radicle] The working copy to import was refused', { reason: sourceRefusal });
    return sourceRefusal;
  };

  const client = new RadicledClient({
    home,
    lockDir,
    ownHome,
    source,
    protectedRoots: protectedRoots ?? [],
    ...(command ? { command } : {}),
    spawn,
    ...(serviceVersion !== undefined ? { serviceVersion } : {}),
    log,
    shellVersion,
    ...(now ? { now } : {}),
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
    beforeSpawn: () => refuseSource(),
  });
  // One process: any end of it is the import's, never a restart.
  let exited = null;
  let failed = null;
  client.on('exit', (info) => {
    exited = info;
    void client.stop();
  });
  client.on('failed', (reason) => {
    failed = reason;
  });
  // Once the import is on its way, a stop waits for its answer.
  let sent = false;
  const onAbort = () => {
    if (!sent) void client.stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  /** Why the process ended, or can't run, before the import was sent. */
  const ended = () => {
    if (signal?.aborted) return stopped();
    if (sourceRefusal) {
      return new CoreError('unsupported_layout', `${SOURCE_REFUSED}: ${sourceRefusal}`);
    }
    if (client.grantRefusal) return new CoreError('failed', GRANT_REFUSED);
    if (failed) return new CoreError('failed', clientFailure(failed));
    if (exited) {
      const code = Number.isInteger(exited.code) ? exited.code : null;
      return new CoreError('failed', clientFailure(code === null ? 'exited' : `exit code ${code}`));
    }
    return new CoreError('failed', IMPORT_START_FAILED);
  };

  try {
    let hello;
    try {
      hello = await client.start();
    } catch {
      throw ended();
    }
    const gen = client.current;
    log.info('[Radicle] freedom-radicled import confinement', confinementLog(hello.confinement));

    // The node key, sealed to this process (0008, "The sealed release").
    let params;
    try {
      const sealed = await keys.seal(hello.recipient);
      params = { sealed: { enc: sealed?.enc, ciphertext: sealed?.ciphertext } };
    } catch (err) {
      if (signal?.aborted) throw stopped();
      if (err?.code === 'vault_locked') {
        log.info('[Radicle] The vault locked before the import got its key');
        return AGAIN;
      }
      if (err?.code === 'no_vault') throw new CoreError('needs_vault', IMPORT_NEEDS_VAULT);
      log.error("[Radicle] The core didn't release the node key for the import", {
        code: err?.code || 'error',
      });
      throw new CoreError('failed', KEY_UNAVAILABLE);
    }
    if (signal?.aborted || !client.serves(gen)) throw ended();

    let identity;
    try {
      identity = await client.identity(gen, params);
    } catch (err) {
      throw err?.code === UNAVAILABLE ? ended() : stepError(err);
    }
    if (
      !isObject(identity) ||
      typeof identity.did !== 'string' ||
      typeof identity.nid !== 'string' ||
      identity.ephemeral !== false
    ) {
      log.error('[Radicle] freedom-radicled answered the import with another identity');
      throw new CoreError('failed', IDENTITY_MISMATCH);
    }

    let report;
    try {
      report = await client.reconcile(gen);
    } catch (err) {
      throw err?.code === UNAVAILABLE ? ended() : stepError(err);
    }
    log.info('[Radicle] The import process reconciled the Radicle data', {
      was_dirty: Boolean(report?.was_dirty),
      quarantined: Number.isInteger(report?.quarantined?.count) ? report.quarantined.count : null,
    });

    let result;
    try {
      result = await client.importRepo(
        gen,
        importParams(source, name, description, defaultBranch),
        {
          // The stop's last chance: past it, the import is on its way.
          fence: () => !signal?.aborted,
          onSent: () => {
            sent = true;
          },
        }
      );
    } catch (err) {
      if (err?.code === 'fenced') throw stopped();
      if (err?.code === UNAVAILABLE) {
        if (!sent) throw ended();
        log.error('[Radicle] The import process ended before answering the import', {
          code: Number.isInteger(exited?.code) ? exited.code : null,
          signal: typeof exited?.signal === 'string' ? exited.signal : null,
          cause: typeof exited?.cause === 'string' ? exited.cause : null,
        });
        throw new CoreError(OUTCOME_UNKNOWN, IMPORT_OUTCOME_UNKNOWN);
      }
      log.info('[Radicle] The import process answered the import', {
        code: typeof err?.code === 'string' ? err.code : 'error',
      });
      throw err;
    }
    log.info('[Radicle] The import process imported the repository');
    return isObject(result) ? result : {};
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Its exit is the proof the home's gate is free for the service again.
    await client.stop();
  }
}

module.exports = {
  runRadicledImport,
  importParams,
  CHECKS,
  IMPORT_OUTCOME_UNKNOWN,
  IMPORT_STOPPED,
  IMPORT_NEEDS_VAULT,
  IMPORT_START_FAILED,
  IDENTITY_MISMATCH,
  SOURCE_REFUSED,
};
