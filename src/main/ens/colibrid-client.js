/**
 * Client for one freedom-colibrid process (freedom-core design 0014, "The
 * process" and "The protocol"): `ServiceClient` (core/service-client.js),
 * configured for the Colibri service, with the step marker's attribution
 * (`colibri-markers.js`) and main's fetches for it (`colibri-fetch.js`).
 * colibri-service.js owns its processes, their bounds and restarts, behind
 * the development switch (colibri-backend.js).
 *
 * - **One process at a time:** `restart: false`, so an exit leaves the
 *   client stopped and the owner decides when, and whether, to start
 *   another (its lazy back-off). A recycling process's successor runs
 *   beside it, so it is another client.
 * - **The process** is one of three (`colibridArgs`; the binary path is
 *   the caller's): a chain's persistent `serve --chain <id> --data-dir <dir>
 *   --lock-dir <dir> --parent-pid <pid>`, a private session's `serve
 *   --chain <id> --parent-pid <pid>` (memory store, no lock), or a
 *   checkpoint check's one-shot `checkpoint --chain <id> --parent-pid
 *   <pid>`. Its environment is the shared client's scrubbed one. After
 *   each spawn main lowers its scheduling priority (`lowerPriority`: 10, or
 *   below normal on Windows); a failure is logged, and the process goes on.
 * - **The handshake** is `colibri.hello`: protocol 1, the shell's version
 *   and `frames: ["stream"]`, within 10 s. A valid result names the release
 *   main expects (`serviceVersion`, the pin's; null takes any, for a
 *   developer's own binary), Colibri 3.0.3 (client version 196611), the
 *   chain main spawned it for, no network (`offline`), a build without a
 *   prover, and the confinement it got (design 0010). Any other is a fault.
 * - **The connection** carries streams both ways (`SERVICE_DUPLEX`): the
 *   service's `shell.colibri_fetch` is answered by colibri-fetch.js's
 *   executor, with a head and main's body, for the open operations this
 *   client keeps (`operations`); a checkpoint's roots by the hook its
 *   caller gives (`checkpoint`'s `answerRoot`). Its events are read until
 *   its pipe closes (`eventsUntilClose`), so a marker written just before a
 *   death counts.
 * - **`request`** (`colibri.request`) and **`checkpoint`**
 *   (`colibri.checkpoint`, the checkpoint process's one call) open an
 *   operation once written, with main's request ID, and its deadline. At the
 *   deadline main cancels it, and its promise still settles only on the
 *   service's reply or the process's death (design 0014, Physical
 *   completion). No reply by the deadline + 15 s means the service is hung:
 *   it is killed. The generic `ServiceClient#request` is replaced: every
 *   `colibri.request` must be known to the markers, or its first step would
 *   kill the process.
 * - **Outcomes:** a reply's result as the service wrote it (colibri-outcome.js
 *   builds the adapter's from it), or a `ColibriWorkerError`
 *   (colibri-worker-host.js's class) with main's own text, never cut:
 *   - a death: `Colibri worker replaced: <reason>` for the request it names
 *     (`colibri-markers.js`), which the core's `isColibriFault` reads as a
 *     fault; for every other open request the same text marked
 *     `colibriBystander`, as the WASM host marks one, which its owner may
 *     send once more to another process;
 *   - the recycling refusal (`busy` with `data.recycling`): `Colibri service
 *     busy` marked `colibriRecycling`, for the owner to send to the
 *     process's successor; any other `busy`, or main's own bound:
 *     `Colibri service busy`;
 *   - `cancelled` after main's deadline cancel: `Colibri request cancelled at
 *     its deadline` (deviation `colibri-deadline`), no fault;
 *   - any other refusal (`too_large`, `invalid_argument`, an unasked
 *     `cancelled`, …): `Colibri service refused the request`;
 *   - a request never written (no process serving): `Colibri service
 *     unavailable`.
 *   None of main's texts matches the fault pattern but the death's, nor the
 *   resolver's retry pattern.
 * - **`lastDeath`:** the last process's death as the markers recorded it
 *   (`{ generation, code, signal, cause, culprit, reason }`), set before
 *   the owner's `exit` listener runs, for its restart rules (three exits
 *   naming no culprit).
 * - **Shutdown** is `colibri.shutdown` and closing stdin; the process is
 *   killed 5 s later if it hasn't exited. A checkpoint process that answered
 *   exits by itself (`checkpointDone`): main waits for that, and stops it
 *   only if it hasn't within those 5 s.
 */

const os = require('os');
const defaultLog = require('../logger');
const {
  ServiceClient,
  SERVICE_DUPLEX,
  isObject,
  validConfinement,
} = require('../core/service-client');
const { JSON_KINDS } = require('../core/frame');
const { ColibriWorkerError } = require('./colibri-worker-host');
const { COLIBRI_CLIENT_VERSION } = require('./colibri-fetch-contract');
const { colibriFetchHandler } = require('./colibri-fetch');
const { ColibriMarkers, deathRecord } = require('./colibri-markers');

const PROTOCOL_VERSION = 1;
/** The Colibri release the service links (design 0014, COL-2's pin). */
const COLIBRI_VERSION = '3.0.3';
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const KINDS = new Set(['persistent', 'private', 'checkpoint']);
// A service's requests are main's own: no caller context reaches it.
const CONTEXT = Object.freeze({ caller: 'shell' });
const UNAVAILABLE_CODE = 'colibri_unavailable';

/** A request with no caller deadline gets the WASM host's 60 s. */
const DEFAULT_DEADLINE_MS = 60_000;
/** What main adds to a deadline the service owns before calling it hung. */
const HANG_GRACE_MS = 15_000;
/** The longest deadline main passes: its hang watchdog still fits a timer. */
const MAX_DEADLINE_MS = 2 ** 31 - 1 - HANG_GRACE_MS;
/** The freshness bound main gives the service, as the JS binding computes
 * it: the latest block at most this old. */
const FRESHNESS_S = 60;
/** No `colibri.stats` or `colibri.forget` reply within this means the
 * service is hung. */
const CONTROL_WATCHDOG_MS = 20_000;
/** How long after `colibri.shutdown` the process is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
/** Requests outstanding per process, retiring ones included (0007, Bounds). */
const MAX_OUTSTANDING = 512;
/** The process's scheduling priority (design 0014, Spawn). */
const LOWER_PRIORITY = 10;

/** Main's texts for what it makes of a request itself (see the header). */
const COLIBRID_TEXTS = Object.freeze({
  replaced: 'Colibri worker replaced',
  busy: 'Colibri service busy',
  deadline: 'Colibri request cancelled at its deadline',
  refused: 'Colibri service refused the request',
  unavailable: 'Colibri service unavailable',
});

/** The process's arguments: `kind` is `persistent` (with `dataDir` and
 * `lockDir`), `private` or `checkpoint`. */
function colibridArgs(kind, { chain, dataDir, lockDir, parentPid = process.pid } = {}) {
  if (!KINDS.has(kind)) throw new TypeError(`unknown freedom-colibrid process: ${kind}`);
  if (!Number.isSafeInteger(chain) || chain <= 0) {
    throw new TypeError('freedom-colibrid needs a chain ID');
  }
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new TypeError('freedom-colibrid needs the parent PID');
  }
  const chainArgs = ['--chain', String(chain)];
  const parent = ['--parent-pid', String(parentPid)];
  if (kind === 'checkpoint') return ['checkpoint', ...chainArgs, ...parent];
  if (kind === 'private') return ['serve', ...chainArgs, ...parent];
  if (typeof dataDir !== 'string' || !dataDir || typeof lockDir !== 'string' || !lockDir) {
    throw new TypeError(
      'a persistent freedom-colibrid process needs its data and lock directories'
    );
  }
  return ['serve', ...chainArgs, '--data-dir', dataDir, '--lock-dir', lockDir, ...parent];
}

/**
 * The public part of a valid hello result from a process spawned for
 * `chain`, or null: one that names another release than `serviceVersion`
 * (when not null), another Colibri, another chain or a network, a build
 * with a prover, or reports no confinement, is a fault.
 */
function validHello(result, { chain, serviceVersion = null }) {
  if (!isObject(result) || result.protocol !== PROTOCOL_VERSION) return null;
  const { service_version: version, build } = result;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (serviceVersion !== null && version !== serviceVersion) return null;
  if (result.colibri_version !== COLIBRI_VERSION) return null;
  if (result.client_version !== COLIBRI_CLIENT_VERSION) return null;
  if (result.chain_id !== chain) return null;
  if (result.network !== 'offline') return null;
  if (
    !isObject(build) ||
    build.prover !== false ||
    typeof build.op !== 'boolean' ||
    typeof build.zk !== 'boolean' ||
    !Number.isSafeInteger(build.verify_flags) ||
    build.verify_flags < 0
  ) {
    return null;
  }
  const confinement = validConfinement(result.confinement);
  if (!confinement) return null;
  return {
    protocol: PROTOCOL_VERSION,
    service_version: version,
    colibri_version: COLIBRI_VERSION,
    client_version: COLIBRI_CLIENT_VERSION,
    chain_id: chain,
    build: { op: build.op, zk: build.zk, prover: false, verify_flags: build.verify_flags },
    network: 'offline',
    confinement,
  };
}

/** freedom-colibrid's process for `chain`, as the shared client supervises
 * it. */
function colibridService({ chain, serviceVersion = null }) {
  return Object.freeze({
    label: '[colibrid]',
    noun: 'Colibri service',
    unavailableCode: UNAVAILABLE_CODE,
    protocol: PROTOCOL_VERSION,
    helloMethod: 'colibri.hello',
    helloParams: (client) => ({
      protocol: PROTOCOL_VERSION,
      shell_version: client.shellVersion,
      frames: ['stream'],
    }),
    validHello: (result) => validHello(result, { chain, serviceVersion }),
    shutdownMethod: 'colibri.shutdown',
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    fragments: () => false,
    initialKinds: JSON_KINDS,
    maxPending: MAX_OUTSTANDING,
    // Main's bodies go to it (`shell.colibri_fetch`), with a service's
    // kinds and codes.
    duplex: () => true,
    ...SERVICE_DUPLEX,
    // A marker written just before a death still reaches the markers.
    eventsUntilClose: true,
  });
}

/**
 * Lowers a spawned process's scheduling priority (design 0014, Spawn): 10,
 * or below normal on Windows. A failure is logged with its error code, and
 * the process goes on.
 */
function lowerPriority(
  child,
  { platform = process.platform, osModule = os, log = defaultLog, label = '[colibrid]' } = {}
) {
  const priority =
    platform === 'win32' ? osModule.constants.priority.PRIORITY_BELOW_NORMAL : LOWER_PRIORITY;
  try {
    osModule.setPriority(child.pid, priority);
  } catch (err) {
    log.warn(`${label} could not lower its priority`, {
      code: typeof err?.code === 'string' ? err.code : 'error',
    });
  }
}

/** A deadline as main passes it: a positive whole number of milliseconds,
 * the host's 60 s when there is none. */
function normalDeadline(deadlineMs) {
  const ms = Number(deadlineMs);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_DEADLINE_MS;
  return Math.min(Math.ceil(ms), MAX_DEADLINE_MS);
}

function colibriError(message, marks = {}) {
  return Object.assign(new ColibriWorkerError(message), marks);
}

/** What a refusal from the service, or main's own refusal of a request it
 * never wrote, becomes (see the header). */
function refusalError(err, { sent, cancelled }) {
  const code = err?.code;
  if (code === 'busy') {
    const recycling = sent && isObject(err.data) && err.data.recycling === true;
    return colibriError(COLIBRID_TEXTS.busy, recycling ? { colibriRecycling: true } : {});
  }
  if (!sent && code === UNAVAILABLE_CODE) return colibriError(COLIBRID_TEXTS.unavailable);
  if (sent && cancelled && code === 'cancelled') return colibriError(COLIBRID_TEXTS.deadline);
  return colibriError(COLIBRID_TEXTS.refused);
}

class ColibridClient extends ServiceClient {
  /**
   * @param {object} options - ServiceClient's, without `service`, `args`,
   *   `restart` and `afterSpawn`, and:
   * @param {'persistent'|'private'|'checkpoint'} options.kind
   * @param {number} options.chain - the chain the process serves
   * @param {string} [options.dataDir] - a persistent process's directory,
   *   `<userData>/colibri/<chain>`
   * @param {string} [options.lockDir] - a persistent process's lock
   *   directory, the core's
   * @param {number} [options.parentPid] - main's PID
   * @param {string} options.command - the binary
   * @param {string|null} options.serviceVersion - the release hello must
   *   report (the pin's), or null for any
   * @param {object} [options.fetchPool] - the Colibri fetch pool; the
   *   browser's by default
   * @param {Function} [options.hop] - the fetches' transport (colibri-fetch.js);
   *   `makeHop()` over the default session by default
   * @param {string} [options.platform] - `process.platform` (a test seam)
   */
  constructor(options) {
    const { kind, chain, serviceVersion } = options;
    if (serviceVersion !== null && (typeof serviceVersion !== 'string' || !serviceVersion)) {
      throw new TypeError('freedom-colibrid needs the release it must be, or null');
    }
    const log = options.log ?? defaultLog;
    const args = colibridArgs(kind, options);
    super({
      ...options,
      log,
      args,
      service: colibridService({ chain, serviceVersion }),
      restart: false,
      afterSpawn: (child) =>
        lowerPriority(child, { platform: options.platform ?? process.platform, log }),
    });
    this.kind = kind;
    this.chain = chain;
    this.serviceVersion = serviceVersion;
    // The markers of the process that completed its handshake last, until
    // its exit.
    this.markers = null;
    this.lastDeath = null;
    // The open operations `shell.colibri_fetch` names, by main's request ID
    // in the asking process's generation.
    this.operations = Object.freeze({
      get: (id, { generation } = {}) => {
        const markers = this.markers;
        return markers && markers.generation === generation ? markers.operation(id) : undefined;
      },
    });
    this.on('ready', () => {
      const { number } = this.current;
      this.markers = new ColibriMarkers({
        generation: number,
        abandon: (cause) => this.abandon(cause, { generation: number }),
        now: this.now,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
        log,
        label: this.label,
      });
    });
    // Events reach the client only from its current process, until its
    // pipe closes.
    this.on('event', (name, data) => {
      const markers = this.markers;
      if (markers && markers.generation === this.current?.number) markers.event(name, data);
    });
    // Registered first, so the death is recorded before the owner hears of
    // it. A process that died before its handshake has no markers, and
    // names nobody.
    this.on('exit', (exit) => {
      const markers = this.markers;
      this.markers = null;
      this.lastDeath = markers ? markers.die(exit) : deathRecord(exit);
    });
    this.handle(
      'shell.colibri_fetch',
      colibriFetchHandler({
        operations: this.operations,
        pool: options.fetchPool,
        hop: options.hop,
        log,
        now: this.now,
      }),
      { streams: true }
    );
  }

  /**
   * `colibri.request` (a persistent or private process's): `params` is the
   * client's request, `{ client, zk, prover, method, params }` (`client`
   * main's ID for the Colibri client, `prover` its prover's URL, `params`
   * the caller's, sent as JSON text), within `deadlineMs` (60 s by
   * default). Resolves to the service's result (`{ status, … }`); see the
   * header for what it rejects with.
   */
  request({ client, zk, prover, method, params } = {}, { deadlineMs } = {}) {
    if (this.kind === 'checkpoint') {
      return Promise.reject(new TypeError('colibri.request is a serve process’s'));
    }
    if (typeof client !== 'string' || !client || typeof zk !== 'boolean') {
      return Promise.reject(new TypeError('colibri.request needs its client and zk'));
    }
    if (typeof method !== 'string' || !method || typeof prover !== 'string' || !prover) {
      return Promise.reject(new TypeError('colibri.request needs its method and prover'));
    }
    let text;
    try {
      text = JSON.stringify(params ?? []);
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string') {
      return Promise.reject(new TypeError('colibri.request params must be JSON'));
    }
    const ms = normalDeadline(deadlineMs);
    const now = this.now();
    const wire = {
      client,
      zk,
      method,
      params: text,
      min_latest_block_ts: Math.floor(now / 1000) - FRESHNESS_S,
      deadline_ms: ms,
    };
    const op = {
      kind: 'request',
      id: null,
      chain: this.chain,
      method,
      params: text,
      zk,
      prover,
      deadlineAt: now + ms,
      taken: {},
      ended: false,
    };
    return this.operate('colibri.request', wire, op, ms);
  }

  /**
   * `colibri.checkpoint` (the checkpoint process's one call), within
   * `deadlineMs`; `params.minLatestBlockTs` is the freshness bound, now
   * − 60 s by default. Resolves to the service's result (`{ decoded,
   * result }` or `{ status: "error", stage, error }`); rejects as `request`.
   *
   * The check's fetches (colibri-fetch.js) are main's: `params.answerRoot`
   * answers its `checkpoint_root` lookups, `(slot, { signal })` → a promise
   * of the root (`slot` as the path names it, a decimal), from main's quorum
   * (checkpoint-colibrid.js); without it they are refused. `params.onRefused`
   * hears of each fetch of it the executor refuses, `(rule, type)`.
   */
  checkpoint({ minLatestBlockTs, answerRoot, onRefused } = {}, { deadlineMs } = {}) {
    if (this.kind !== 'checkpoint') {
      return Promise.reject(new TypeError('colibri.checkpoint is the checkpoint process’s'));
    }
    const ms = normalDeadline(deadlineMs);
    const now = this.now();
    const bound = minLatestBlockTs ?? Math.floor(now / 1000) - FRESHNESS_S;
    if (!Number.isSafeInteger(bound) || bound < 0) {
      return Promise.reject(new TypeError('colibri.checkpoint needs a freshness bound'));
    }
    for (const hook of [answerRoot, onRefused]) {
      if (hook !== undefined && typeof hook !== 'function') {
        return Promise.reject(new TypeError('colibri.checkpoint hooks must be functions'));
      }
    }
    const wire = { min_latest_block_ts: bound, deadline_ms: ms };
    const op = {
      kind: 'checkpoint',
      id: null,
      chain: this.chain,
      deadlineAt: now + ms,
      taken: {},
      ended: false,
      ...(answerRoot ? { answerRoot } : {}),
      ...(onRefused ? { onRefused } : {}),
    };
    return this.operate('colibri.checkpoint', wire, op, ms);
  }

  /**
   * The checkpoint process after its answer (design 0014, Spawn: it serves
   * one `colibri.checkpoint`, then exits 0): resolves once it is gone.
   * Nothing more is written to it, and its exit is the end main expects, no
   * news (no warn, as for a stop); if it hasn't gone within the shutdown
   * grace, it is stopped (ServiceClient's `awaitExit`).
   */
  checkpointDone() {
    if (this.kind !== 'checkpoint') {
      return Promise.reject(new TypeError('checkpointDone is the checkpoint process’s'));
    }
    return this.awaitExit({ graceMs: SHUTDOWN_GRACE_MS });
  }

  /** `colibri.forget { client }`: the service drops what it keeps for one
   * Colibri client (its ZK-off flag). */
  forget(client) {
    if (typeof client !== 'string' || !client) {
      return Promise.reject(new TypeError('colibri.forget needs its client'));
    }
    return this.requestTo(this.current, 'colibri.forget', { client }, CONTEXT, {
      watchdogMs: CONTROL_WATCHDOG_MS,
    });
  }

  /** `colibri.stats`: open requests, steps run, resident memory, store size. */
  stats() {
    return this.requestTo(this.current, 'colibri.stats', {}, CONTEXT, {
      watchdogMs: CONTROL_WATCHDOG_MS,
    });
  }

  /**
   * Writes one operation's request to the current process and settles on its
   * one reply or the process's death. Its reply is read synchronously
   * (`onReply`): the operation closes before the next frame of the same read,
   * so a marker after the reply finds it ended; and a death's outcomes are
   * built in ServiceClient's retire, where the markers' record is frozen
   * from the pipe as it ended, before any promise reaction runs.
   */
  operate(method, wire, op, deadlineMs) {
    const gen = this.current;
    const markers = this.markers;
    if (!this.serves(gen) || markers?.generation !== gen.number) {
      return Promise.reject(colibriError(COLIBRID_TEXTS.unavailable));
    }
    return new Promise((resolve, reject) => {
      const deadline = new AbortController();
      let timer = null;
      let sent = false;
      const onReply = (outcome) => {
        if (timer) this.clearTimer(timer);
        timer = null;
        if (sent && outcome.error?.code === UNAVAILABLE_CODE && gen.retired) {
          // The process died with the request open.
          const death = markers.die({
            code: gen.exitCode,
            signal: gen.exitSignal,
            cause: gen.cause,
          });
          const message = `${COLIBRID_TEXTS.replaced}: ${death.reason}`;
          reject(
            death.culprit === op.id
              ? colibriError(message)
              : colibriError(message, { colibriBystander: true })
          );
          return;
        }
        if (sent) markers.closed(op.id);
        if (outcome.error) {
          reject(refusalError(outcome.error, { sent, cancelled: deadline.signal.aborted }));
        } else {
          resolve(outcome.result);
        }
      };
      this.send(gen, method, wire, CONTEXT, {
        onReply,
        signal: deadline.signal,
        // Cancelled at its deadline, it still waits for the reply.
        untilResponse: true,
        watchdogMs: deadlineMs + HANG_GRACE_MS,
        onSent: (id) => {
          sent = true;
          op.id = id;
          markers.opened(op);
          timer = this.setTimer(
            () => {
              timer = null;
              deadline.abort();
            },
            Math.max(0, op.deadlineAt - this.now())
          );
        },
      });
    });
  }
}

module.exports = {
  ColibridClient,
  colibridArgs,
  colibridService,
  validHello,
  lowerPriority,
  COLIBRID_TEXTS,
  COLIBRI_VERSION,
  PROTOCOL_VERSION,
  DEFAULT_DEADLINE_MS,
  HANG_GRACE_MS,
  CONTROL_WATCHDOG_MS,
  SHUTDOWN_GRACE_MS,
  MAX_OUTSTANDING,
};
