/**
 * Client for the freedom-radicled service process (freedom-core design 0008,
 * "Process model", "The protocol" and Bounds): `ServiceClient`
 * (core/service-client.js), configured for the Radicle service. Nothing
 * runs it yet: the node on it (`radicled-node.js`) and the switch to it
 * come next (0008, step 6 on).
 *
 * - **The binary** is the app's `<resources>/freedom-radicled/`, or in
 *   development `freedom-radicled-bin/<os>-<arch>/` (`npm run
 *   radicled:download`); `FREEDOM_RADICLED_PATH` overrides it only when the
 *   app isn't packaged (`radicled-binary.js`, which the home's gate shares).
 * - **The process** is `serve --home <Radicle home> --lock-dir <locks>
 *   --network <policy> --parent-pid <pid>`: it takes the home's `radicle-`
 *   gate in the core's lock directory for its whole life, and exits 75
 *   while another owner holds it (after 5 s of retries) or 74 on a
 *   filesystem it refuses. The policy is fixed for its life (0008, Modes).
 * - **Its environment** is the shared client's scrubbed one, with `HOME` an
 *   empty directory of the service's own (`radicledEnv`; 0008, "Spawn and
 *   lock"), made before each spawn: the user's home directory, as `HOME`
 *   or `USERPROFILE`, never reaches it, nor does anything heartwood, libgit2
 *   or an SSH agent would read (`RAD_*`, `GIT_*`, `SSH_AUTH_SOCK`, …), all of
 *   which the service refuses to start with (64).
 * - **Main's check of the grant** (design 0010, step 7) runs before every
 *   spawn, a crash's restart and a new policy's process included
 *   (`beforeSpawn`): the Radicle home and the service's `HOME`, its grants,
 *   may not be, contain or lie inside a protected root, nor hold a special
 *   file or a hard link out of them (`radicleGrantRefusal`). A refusal, or
 *   a check that throws, spawns nothing and fails the client; why is kept
 *   in `grantRefusal`, fixed text, never a path.
 * - **The handshake** is `rad.hello`: protocol 1, the shell's version and
 *   `frames: ["stream"]`, within 10 s. A valid result names the release
 *   main expects (`expectedServiceVersion`), the libradicle build it links,
 *   the X25519 recipient the service made for this start (32 bytes,
 *   base64), the policy main passed, and the confinement it got (design
 *   0010; ipfsd-client.js's `validConfinement`). Any other is a fault.
 * - **Hang watchdogs** (0008, Deadlines and Bounds): the service owns every
 *   deadline and always replies, so main only watches, each deadline + 15
 *   s: `rad.identity` until 30 s after the handshake, `rad.reconcile` 300 s,
 *   `rad.start` 30 s, reads 60 s to the head, network calls their
 *   `timeout_ms` + 30 s, writes 60 s; and `rad.stats` 20 s. A request with
 *   no reply by then means the service is hung: it is killed, and the
 *   restart rules apply.
 * - **Exit codes and restarts** are the shared client's: 0.5 s, 2 s, then
 *   10 s, three crashes in 60 s stop them, and none after 64, 74, 75, 77
 *   (confinement) or a protocol mismatch. 70 (`node_down`, a panic outside
 *   a request, a repair unit's overrun) is a crash. A start step
 *   (`rad.identity`, `rad.reconcile`, `rad.start`) answered with an error
 *   ends the process, which then exits 0: main has read the error, and
 *   doesn't restart it (0008, Errors).
 * - **Shutdown** is `rad.shutdown` and closing stdin; the service exits
 *   within 5 s, and is killed 10 s after it.
 */

const { app } = require('electron');
const { ServiceClient, CoreError, isObject, scrubbedEnv } = require('../core/service-client');
const { JSON_KINDS } = require('../core/frame');
const { ensurePrivateDir } = require('../private-files');
const { networkArg, reportsPolicy } = require('../ipfs/ipfs-network');
const { validConfinement } = require('../ipfs/ipfsd-client');
const { radicleGrantRefusal } = require('../service-grant');
const { getRadicledBinaryPath } = require('./radicled-binary');
const { PINNED_RADICLED_VERSION } = require('./radicled-pin');

const PROTOCOL_VERSION = 1;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/;
// 32 bytes in standard base64: 43 characters and one `=`.
const RECIPIENT = /^[A-Za-z0-9+/]{43}=$/;
const RECIPIENT_BYTES = 32;
const DIRECT = Object.freeze({ mode: 'direct' });
// A service's requests are main's own: no caller context reaches it.
const CONTEXT = Object.freeze({ caller: 'shell' });

/** What main adds to a deadline the service owns before calling it hung. */
const HANG_GRACE_MS = 15_000;
/** `rad.identity` must succeed within this of `rad.hello`'s reply. */
const IDENTITY_DEADLINE_MS = 30_000;
/** `rad.reconcile`'s bound in the service (0008, Reconciliation). */
const RECONCILE_DEADLINE_MS = 300_000;
/** `rad.start`'s deadline in the service. */
const START_DEADLINE_MS = 30_000;
/** A read's deadline to its head, queue and reservation waits included. */
const READ_DEADLINE_MS = 60_000;
/** A write's deadline in the service. */
const WRITE_DEADLINE_MS = 60_000;
/** What the service adds to a network call's `timeout_ms`. */
const NETWORK_EXTRA_MS = 30_000;
/** No `rad.stats` reply within this means the service is hung. */
const STATS_WATCHDOG_MS = 20_000;
/** How long after `rad.shutdown` the process is killed. */
const SHUTDOWN_GRACE_MS = 10_000;
/** Requests outstanding per process, retiring ones included (0007, Bounds). */
const MAX_OUTSTANDING = 512;
/** `timeout_ms` is the add-on's `u32`. */
const MAX_TIMEOUT_MS = 0xffff_ffff;
/** The longest timer Node keeps: a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Main's watchdog for each of the service's calls with a fixed deadline:
 * that deadline + 15 s (0008, Deadlines). A read's runs to its head.
 */
const WATCHDOG_MS = Object.freeze({
  'rad.reconcile': RECONCILE_DEADLINE_MS + HANG_GRACE_MS,
  'rad.start': START_DEADLINE_MS + HANG_GRACE_MS,
  'rad.read': READ_DEADLINE_MS + HANG_GRACE_MS,
  'rad.blob': READ_DEADLINE_MS + HANG_GRACE_MS,
  'rad.quarantine_list': READ_DEADLINE_MS + HANG_GRACE_MS,
  'rad.write': WRITE_DEADLINE_MS + HANG_GRACE_MS,
  'rad.unseed': WRITE_DEADLINE_MS + HANG_GRACE_MS,
  'rad.remove_repo': WRITE_DEADLINE_MS + HANG_GRACE_MS,
  'rad.stats': STATS_WATCHDOG_MS,
});

/**
 * The `service_version` hello must report, or null for any: the pinned
 * release's in a packaged build (`radicled-pin.js`). An unpackaged build
 * checks the release `FREEDOM_RADICLED_RELEASE_TAG` fetched instead, and
 * nothing for a binary of the developer's own (`FREEDOM_RADICLED_PATH`) or
 * `latest`.
 */
function expectedServiceVersion({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return PINNED_RADICLED_VERSION;
  if (env.FREEDOM_RADICLED_PATH) return null;
  const tag = env.FREEDOM_RADICLED_RELEASE_TAG;
  if (!tag) return PINNED_RADICLED_VERSION;
  return tag.startsWith('radicled-v') ? tag.slice('radicled-v'.length) : null;
}

/** The serve process's arguments, for the profile's Radicle home, under
 * `network`. */
function serveArgs({ home, lockDir, network = DIRECT, parentPid = process.pid }) {
  return [
    'serve',
    '--home',
    home,
    '--lock-dir',
    lockDir,
    '--network',
    networkArg(network),
    '--parent-pid',
    String(parentPid),
  ];
}

/**
 * The service's environment (0008, "Spawn and lock"): the scrubbed one,
 * without the user's home directory under either name (`HOME`,
 * `USERPROFILE`), and with `HOME` the service's own directory, `ownHome`.
 */
function radicledEnv(ownHome, env = process.env) {
  const out = scrubbedEnv(env);
  delete out.USERPROFILE;
  out.HOME = ownHome;
  return out;
}

/** Whether `recipient` is an X25519 public key as hello names it: 32 bytes
 * in canonical standard base64. */
function validRecipient(recipient) {
  if (typeof recipient !== 'string' || !RECIPIENT.test(recipient)) return false;
  const bytes = Buffer.from(recipient, 'base64');
  return bytes.length === RECIPIENT_BYTES && bytes.toString('base64') === recipient;
}

/**
 * The public part of a valid hello result from a process spawned under
 * `network`, or null: one that names another policy or, with `version`,
 * another release than main expects (`expectedServiceVersion`), or whose
 * libradicle build, recipient or confinement report isn't one, is a fault.
 */
function validHello(result, network, version = null) {
  if (!isObject(result) || result.protocol !== PROTOCOL_VERSION) return null;
  const { service_version: serviceVersion, libradicle: build, recipient } = result;
  if (typeof serviceVersion !== 'string' || !VERSION.test(serviceVersion)) return null;
  if (version !== null && serviceVersion !== version) return null;
  if (
    !isObject(build) ||
    typeof build.version !== 'string' ||
    !VERSION.test(build.version) ||
    typeof build.git_commit !== 'string' ||
    !GIT_COMMIT.test(build.git_commit)
  ) {
    return null;
  }
  if (!validRecipient(recipient)) return null;
  if (!reportsPolicy(result.network, network)) return null;
  const confinement = validConfinement(result.confinement);
  if (!confinement) return null;
  return {
    protocol: PROTOCOL_VERSION,
    service_version: serviceVersion,
    libradicle: { version: build.version, git_commit: build.git_commit },
    recipient,
    network: { ...network },
    confinement,
  };
}

/** freedom-radicled's serve process, as the shared client supervises it,
 * spawned under `network`. */
function radicledService({ network = DIRECT, serviceVersion = null } = {}) {
  return Object.freeze({
    label: '[radicled]',
    noun: 'Radicle service',
    unavailableCode: 'radicle_unavailable',
    protocol: PROTOCOL_VERSION,
    helloMethod: 'rad.hello',
    helloParams: (client) => ({
      protocol: PROTOCOL_VERSION,
      shell_version: client.shellVersion,
      frames: ['stream'],
    }),
    validHello: (result) => validHello(result, network, serviceVersion),
    shutdownMethod: 'rad.shutdown',
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    fragments: () => false,
    // The service refuses a hello that doesn't take stream frames.
    streams: () => true,
    initialKinds: JSON_KINDS,
    maxPending: MAX_OUTSTANDING,
  });
}

/** A network call's watchdog: its `timeout_ms` + 30 s + 15 s, within what a
 * timer holds. */
function networkWatchdogMs(timeoutMs) {
  return Math.min(timeoutMs + NETWORK_EXTRA_MS + HANG_GRACE_MS, MAX_TIMER_MS);
}

function validTimeout(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= MAX_TIMEOUT_MS;
}

class RadicledClient extends ServiceClient {
  /**
   * @param {object} options - ServiceClient's, without `service`, `args`
   *   and `env`, and:
   * @param {string} options.home - the profile's Radicle home
   *   (`getRadicleDataDir()`)
   * @param {string} options.lockDir - the core's lock directory
   *   (`getLockDir()`)
   * @param {string} options.ownHome - the service's own `HOME`
   *   (`getRadicledHomeDir()`), made before each spawn
   * @param {object} [options.network] - the policy the process runs under;
   *   `direct` by default
   * @param {number} [options.parentPid] - main's PID
   * @param {string} [options.command] - the binary; `getRadicledBinaryPath()`
   *   by default
   * @param {string|null} [options.serviceVersion] - the release hello must
   *   report (`expectedServiceVersion()`), or null for any
   * @param {Function} [options.beforeSpawn] - ServiceClient's, asked after
   *   the grant check passes
   */
  constructor(options) {
    const network = options.network ?? DIRECT;
    const serviceVersion =
      options.serviceVersion === undefined ? expectedServiceVersion() : options.serviceVersion;
    const { ownHome } = options;
    super({
      ...options,
      command: options.command ?? getRadicledBinaryPath(),
      args: serveArgs({
        home: options.home,
        lockDir: options.lockDir,
        network,
        parentPid: options.parentPid,
      }),
      env: () => radicledEnv(ensurePrivateDir(ownHome)),
      service: radicledService({ network, serviceVersion }),
    });
    this.network = network;
    this.serviceVersion = serviceVersion;
    this.home = options.home;
    this.ownHome = ownHome;
    // Why the last check refused the grant, or null.
    this.grantRefusal = null;
    const after = options.beforeSpawn ?? null;
    this.beforeSpawn = () => this.grantRefused() ?? after?.() ?? null;
  }

  /**
   * Main's check before a spawn (design 0010, step 7): null, or why the
   * Radicle home with the service's `HOME` may not be granted, which
   * spawns nothing and fails the client. A check that throws refuses too.
   */
  grantRefused() {
    let refused;
    try {
      refused = radicleGrantRefusal(this.home, this.ownHome) ?? null;
    } catch (err) {
      refused = `the check failed: ${err?.code || err?.name || 'error'}`;
    }
    this.grantRefusal = refused;
    if (refused) this.log.error(`${this.label} Radicle home refused`, { reason: refused });
    return refused;
  }

  /**
   * `rad.identity` on `gen`: `{ sealed: { enc, ciphertext } }`, the key the
   * core sealed to hello's recipient, or `{ ephemeral: true }` on a profile
   * without a vault. Watched until 30 s after the handshake, + 15 s: the
   * service's deadline runs from its hello reply. A start step.
   */
  identity(gen, params, { fence = null } = {}) {
    const due = (gen?.readyAt ?? this.now()) + IDENTITY_DEADLINE_MS + HANG_GRACE_MS;
    return this.requestTo(gen, 'rad.identity', params, CONTEXT, {
      watchdogMs: Math.max(0, due - this.now()),
      fence,
      endsOnError: true,
    });
  }

  /** `rad.reconcile` on `gen`, watched for 300 s + 15 s. A start step. */
  reconcile(gen, { fence = null } = {}) {
    return this.requestTo(gen, 'rad.reconcile', {}, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.reconcile'],
      fence,
      endsOnError: true,
    });
  }

  /** `rad.start { alias }` on `gen`, watched for 30 s + 15 s. A start step. */
  startNode(gen, alias, { fence = null } = {}) {
    return this.requestTo(gen, 'rad.start', { alias }, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.start'],
      fence,
      endsOnError: true,
    });
  }

  /** `rad.stats` on `gen`, watched for 20 s. */
  nodeStats(gen) {
    return this.requestTo(gen, 'rad.stats', {}, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.stats'],
    });
  }

  /** `rad.read { op, args }` on `gen`: its head and its JSON body (see
   * `callStream`), watched for 60 s + 15 s to the head. */
  read(gen, op, args, { signal = null, fence = null } = {}) {
    return this.requestStreamTo(gen, 'rad.read', { op, args }, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.read'],
      signal,
      fence,
    });
  }

  /** `rad.blob` on `gen`: its head and its bytes, watched for 60 s + 15 s
   * to the head. */
  blob(gen, params, { signal = null, fence = null } = {}) {
    return this.requestStreamTo(gen, 'rad.blob', params, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.blob'],
      signal,
      fence,
    });
  }

  /** `rad.quarantine_list { page }` on `gen`, watched for 60 s + 15 s. */
  quarantineList(gen, page, { signal = null, fence = null } = {}) {
    return this.requestTo(gen, 'rad.quarantine_list', { page }, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.quarantine_list'],
      signal,
      fence,
    });
  }

  /** `rad.connect_seeds { timeout_ms }` on `gen`, watched for its
   * `timeout_ms` + 30 s + 15 s. */
  connectSeeds(gen, timeoutMs, { signal = null, fence = null } = {}) {
    if (!validTimeout(timeoutMs)) return Promise.reject(badTimeout());
    return this.requestTo(gen, 'rad.connect_seeds', { timeout_ms: timeoutMs }, CONTEXT, {
      watchdogMs: networkWatchdogMs(timeoutMs),
      signal,
      fence,
    });
  }

  /** `rad.clone { rid, timeout_ms, progress }` on `gen`, watched for its
   * `timeout_ms` + 30 s + 15 s. `signal` is the clone's cancel. */
  clone(gen, params, { signal = null, fence = null } = {}) {
    if (!validTimeout(params?.timeout_ms)) return Promise.reject(badTimeout());
    return this.requestTo(gen, 'rad.clone', params, CONTEXT, {
      watchdogMs: networkWatchdogMs(params.timeout_ms),
      signal,
      fence,
    });
  }

  /** `rad.write { op, args }` on `gen`, watched for 60 s + 15 s. */
  write(gen, op, args, { signal = null, fence = null } = {}) {
    return this.requestTo(gen, 'rad.write', { op, args }, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.write'],
      signal,
      fence,
    });
  }

  /** `rad.unseed { rid }` on `gen`, watched for 60 s + 15 s. */
  unseed(gen, rid, { signal = null, fence = null } = {}) {
    return this.requestTo(gen, 'rad.unseed', { rid }, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.unseed'],
      signal,
      fence,
    });
  }

  /** `rad.remove_repo { rid, qid }` on `gen`, watched for 60 s + 15 s. */
  removeRepo(gen, rid, qid, { signal = null, fence = null } = {}) {
    return this.requestTo(gen, 'rad.remove_repo', { rid, qid }, CONTEXT, {
      watchdogMs: WATCHDOG_MS['rad.remove_repo'],
      signal,
      fence,
    });
  }
}

function badTimeout() {
  return new CoreError('invalid_argument', 'timeout_ms must be an integer from 0 to 4294967295');
}

module.exports = {
  RadicledClient,
  expectedServiceVersion,
  serveArgs,
  radicledEnv,
  radicledService,
  validHello,
  validRecipient,
  networkWatchdogMs,
  PROTOCOL_VERSION,
  HANG_GRACE_MS,
  IDENTITY_DEADLINE_MS,
  RECONCILE_DEADLINE_MS,
  START_DEADLINE_MS,
  READ_DEADLINE_MS,
  WRITE_DEADLINE_MS,
  NETWORK_EXTRA_MS,
  STATS_WATCHDOG_MS,
  SHUTDOWN_GRACE_MS,
  MAX_OUTSTANDING,
  MAX_TIMER_MS,
  WATCHDOG_MS,
};
