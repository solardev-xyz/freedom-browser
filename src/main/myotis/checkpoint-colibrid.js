/**
 * A checkpoint check through freedom-colibrid's one-shot process (freedom-core
 * design 0014): `freedom-colibrid checkpoint --chain <id>`, which took the
 * WASM worker's place in COL-6, with the same interface and the same
 * results. `acquireCheckpoint` (checkpoint-verifier.js) runs it.
 *
 * - **At most 2 checks at once** (design 0014, How many): a third fails at
 *   once with `CHECKPOINT_UNAVAILABLE`, and spawns nothing. A check holds its
 *   place until it settles, after its process has exited.
 * - **One process per check** (`ColibridClient`, kind `checkpoint`: memory
 *   store, no directory, no lock), sent `colibri.checkpoint
 *   { min_latest_block_ts, deadline_ms }` once its handshake is done: the
 *   freshness bound is now − 60 s (the worker's `max_latest_age_seconds`),
 *   and the deadline what is left of the check's 90 s (`DEADLINE_MS`).
 * - **Its fetches are main's** (colibri-fetch.js, the contract's
 *   `colibri.checkpoint` row): the proof (`checkpoint_proof`) once, which
 *   main POSTs to the chain's prover itself (`eth_getBlockByNumber
 *   ["latest", false]`, the pinned client version, `zk_proof: true`; 4 MiB
 *   at most, HTTP 200 only), through the session as every Colibri fetch;
 *   and the checkpointz root lookups (at most 8), which main answers
 *   `{"data":{"root"}}` from its quorum (`checkpointQuorum`, memoized per
 *   slot), recording each observation, as the worker's interception did.
 *   The quorum's own requests go through the session too (`netGatewayFetch`:
 *   the proxy and Tor's PAC, no cookies, no cache), bounded as the worker's
 *   (`fetchBytes`), and are cut short when the check ends. Everything else
 *   the process asks for is refused. A lookup that fails keeps its reason
 *   (the worker's "transport error"); so does a checkpointz fetch the
 *   contract refuses: a ninth root lookup is `CHECKPOINT_UNAVAILABLE`, any
 *   other `CHECKPOINT_MISMATCH`, as the worker's interception recorded them.
 * - **The outcome,** as the worker mapped its own:
 *   - `{ decoded, result }`: the proof verified; a recorded transport error
 *     still decides, then the evidence checks (checkpoint-evidence.js's
 *     `verifiedCheckpoint`: the decoded proof's checkpoint, its quorum
 *     observation, its age, and `validateCheckpoint`). A `decoded` that
 *     isn't an object is a proof that didn't decode;
 *   - stage `decode` (no proof, or one that doesn't decode):
 *     `CHECKPOINT_UNAVAILABLE`;
 *   - stage `verify`: the recorded transport error, else `CHECKPOINT_STALE`
 *     for `proof for latest too old`, else `CHECKPOINT_MISMATCH`
 *     (`verifyFailure`);
 *   - a death, a refusal, a handshake that fails, the deadline, or any other
 *     reply: `CHECKPOINT_UNAVAILABLE`.
 *   Errors carry their class alone (`checkpointError(code)`), never a text
 *   from the service.
 * - **Settling:** a check settles once its process has exited and the
 *   quorum's requests have ended, as the worker's settle waited for its
 *   termination. A process that answered exits by itself (one check, then
 *   exit 0), and is stopped only if it hasn't within the shutdown grace;
 *   any other end (an abort, the 90 s deadline, a refusal, a handshake that
 *   failed) stops it at once (`colibri.shutdown`, its stdin closed, killed
 *   after 5 s). An abort rejects with `AbortError` (`CHECKPOINT_UNAVAILABLE`).
 * - **Diagnostics:** the quorum's per-source diagnostics, validated as the
 *   worker's were (`validateDiagnostic`), at most 64, none after the check
 *   settles.
 */

const defaultLog = require('../logger');
const { ColibridClient } = require('../ens/colibrid-client');
const {
  checkpointError,
  networkFor,
  validateDiagnostic,
  DEADLINE_MS,
} = require('./checkpoint-verifier');
const {
  checkpointQuorum,
  uint,
  verifiedCheckpoint,
  verifyFailure,
} = require('./checkpoint-evidence');

/** Checkpoint processes at once, browser-wide (design 0014, How many). */
const MAX_CHECKS = 2;
/** The freshness bound: the latest block at most this old, as the worker's
 * `max_latest_age_seconds`. */
const FRESHNESS_S = 60;
/** Diagnostics a check forwards, as the worker path bounded them. */
const MAX_DIAGNOSTICS = 64;

let active = 0;

function electronApp() {
  try {
    return require('electron').app;
  } catch {
    return undefined;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function abortError() {
  const error = checkpointError('CHECKPOINT_UNAVAILABLE');
  error.name = 'AbortError';
  return error;
}

/** What a check runs with; a test's `dependencies` replace any of it. */
function defaultDependencies() {
  return {
    // The process: its binary, the release its hello must name, and how it
    // is spawned (colibri-service.js's choices).
    spawn: undefined,
    command: undefined,
    serviceVersion: undefined,
    shellVersion: undefined,
    parentPid: process.pid,
    // The quorum's transport (fetchBytes' `fetchImpl`), the executor's hop
    // and its pool (colibri-fetch.js's defaults when undefined).
    fetch: undefined,
    hop: undefined,
    fetchPool: undefined,
    // The evidence's clock: the freshness bound, the quorum's and the age.
    now: Date.now,
    log: defaultLog,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  };
}

function processOptions(deps, chainId) {
  return {
    kind: 'checkpoint',
    chain: chainId,
    parentPid: deps.parentPid,
    command: deps.command ?? require('../ens/colibrid-binary').getColibridBinaryPath(),
    serviceVersion:
      deps.serviceVersion === undefined
        ? require('../ens/colibri-service').expectedColibridVersion()
        : deps.serviceVersion,
    shellVersion: deps.shellVersion ?? electronApp()?.getVersion?.() ?? 'unknown',
    ...(deps.spawn ? { spawn: deps.spawn } : { spawn: require('child_process').spawn }),
    log: deps.log,
    fetchPool: deps.fetchPool,
    hop: deps.hop,
  };
}

/**
 * The checkpoint for `chainId` (1 or 100), verified through a one-shot
 * freedom-colibrid process: `acquireCheckpoint`'s interface and results (see
 * the header). `dependencies` is a test seam.
 * @param {number} chainId
 * @param {{ signal?: AbortSignal, onDiagnostic?: Function }} [options]
 * @param {object} [dependencies]
 * @returns {Promise<object>} the validated checkpoint record
 */
function acquireColibridCheckpoint(chainId, { signal, onDiagnostic } = {}, dependencies = {}) {
  return new Promise((resolve, reject) => {
    let config;
    try {
      config = networkFor(chainId);
    } catch (error) {
      reject(error);
      return;
    }
    if (
      signal &&
      (typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    ) {
      reject(checkpointError('CHECKPOINT_MISMATCH'));
      return;
    }
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (active >= MAX_CHECKS) {
      reject(checkpointError('CHECKPOINT_UNAVAILABLE'));
      return;
    }
    active += 1;
    const deps = { ...defaultDependencies(), ...dependencies };
    const now = deps.now;
    const started = Date.now();
    // Ends the quorum's requests with the check.
    const check = new AbortController();
    const baseFetch = deps.fetch ?? require('../ipfs/gateway-transport').netGatewayFetch;
    const quorumFetch = (url, init = {}) =>
      baseFetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, check.signal]) : check.signal,
      });
    const quorums = new Map();
    const observations = [];
    let transportError = null;
    let client = null;
    let timer = null;
    let finishing = false;
    // The process answered its check: it exits by itself.
    let answered = false;
    let diagnostics = 0;

    const finish = (error, result) => {
      if (finishing) return;
      finishing = true;
      if (timer) deps.clearTimer(timer);
      signal?.removeEventListener('abort', abort);
      check.abort();
      // Settled once the process is gone and the quorum's requests have
      // ended: whoever awaits this (the lifecycle's shutdown) must not go on
      // while the check still holds a process or sockets.
      // One that answered exits by itself (`checkpointDone`); any other is
      // stopped now.
      const stopped = client
        ? Promise.resolve().then(() =>
            answered && error?.name !== 'AbortError' ? client.checkpointDone() : client.stop()
          )
        : Promise.resolve();
      Promise.allSettled([stopped, ...quorums.values()]).then(([stop]) => {
        active -= 1;
        // A stop that failed never publishes a verified checkpoint.
        if (error || stop.status === 'rejected') {
          reject(error || checkpointError('CHECKPOINT_UNAVAILABLE'));
        } else {
          resolve(result);
        }
      });
    };
    const abort = () => finish(abortError());

    // The quorum's diagnostics, as the worker path forwarded its own.
    const diagnostic = (value) => {
      if (finishing || ++diagnostics > MAX_DIAGNOSTICS) return;
      const safe = validateDiagnostic(value, chainId);
      if (!safe || typeof onDiagnostic !== 'function') return;
      try {
        onDiagnostic(safe);
      } catch {
        /* diagnostics cannot affect verification */
      }
    };

    // A checkpointz root lookup, answered from the quorum (the worker's
    // interception): the observation recorded, a failure's reason kept.
    const answerRoot = async (slotText) => {
      try {
        if (finishing) throw checkpointError('CHECKPOINT_UNAVAILABLE');
        const slot = uint(slotText);
        if (!quorums.has(slot)) {
          quorums.set(slot, checkpointQuorum(slot, config, quorumFetch, now, diagnostic));
        }
        const observation = await quorums.get(slot);
        observations.push(observation);
        return observation.root;
      } catch (error) {
        transportError ||= error?.code ? error : checkpointError('CHECKPOINT_UNAVAILABLE');
        throw error;
      }
    };
    // A checkpointz fetch the contract refused: the worker's interception
    // records a ninth lookup as unavailable, anything else as a mismatch.
    const onRefused = (rule, type) => {
      if (type !== 'checkpointz') return;
      transportError ||= checkpointError(
        rule === 'count' ? 'CHECKPOINT_UNAVAILABLE' : 'CHECKPOINT_MISMATCH'
      );
    };

    const outcome = (reply) => {
      if (isObject(reply) && Object.hasOwn(reply, 'decoded') && !Object.hasOwn(reply, 'status')) {
        // Decoding grants no trust; one that gave no object is no proof.
        if (!isObject(reply.decoded)) throw checkpointError('CHECKPOINT_UNAVAILABLE');
        if (transportError) throw transportError;
        return verifiedCheckpoint(chainId, config, reply.decoded, observations, now);
      }
      if (isObject(reply) && reply.status === 'error') {
        if (reply.stage === 'decode') throw checkpointError('CHECKPOINT_UNAVAILABLE');
        if (reply.stage === 'verify') {
          throw verifyFailure(typeof reply.error === 'string' ? reply.error : '', transportError);
        }
      }
      throw checkpointError('CHECKPOINT_UNAVAILABLE');
    };

    const run = async () => {
      await client.start();
      if (finishing) return null;
      const reply = await client.checkpoint(
        { minLatestBlockTs: Math.floor(now() / 1000) - FRESHNESS_S, answerRoot, onRefused },
        { deadlineMs: Math.max(1, DEADLINE_MS - (Date.now() - started)) }
      );
      answered = true;
      return outcome(reply);
    };

    try {
      client = new ColibridClient(processOptions(deps, chainId));
    } catch {
      finish(checkpointError('CHECKPOINT_UNAVAILABLE'));
      return;
    }
    timer = deps.setTimer(() => finish(checkpointError('CHECKPOINT_UNAVAILABLE')), DEADLINE_MS);
    signal?.addEventListener('abort', abort, { once: true });
    run().then(
      (result) => finish(null, result),
      // Only the class crosses: never a text from the service or the network.
      (error) => finish(checkpointError(error?.code))
    );
  });
}

/** Checks running now (a test's view of the bound). */
function activeChecks() {
  return active;
}

module.exports = {
  acquireColibridCheckpoint,
  activeChecks,
  MAX_CHECKS,
  FRESHNESS_S,
};
