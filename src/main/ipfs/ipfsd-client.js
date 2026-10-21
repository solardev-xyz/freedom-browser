/**
 * Client for the freedom-ipfsd service process (freedom-core design 0007,
 * "Process model" and "The protocol"): `ServiceClient`
 * (core/service-client.js), configured for the freedom-ipfs service.
 *
 * - **The binary** is the app's `<resources>/freedom-ipfsd/`, or in
 *   development `freedom-ipfsd-bin/<os>-<arch>/` (`npm run ipfsd:download`);
 *   `FREEDOM_IPFSD_PATH` overrides it only when the app isn't packaged, as
 *   `FREEDOM_CORED_PATH` does.
 * - **The persistent process** is `serve --data-dir <ipfs-data>/freedom-ipfs
 *   --lock-dir <locks> --parent-pid <pid>`: it takes the data directory's
 *   `ipfs-` gate in the core's lock directory for its whole life, and exits
 *   75 while another owner holds it (after 5 s of retries) or 74 on a
 *   filesystem it refuses. Its environment is the shared client's scrubbed
 *   one, so neither the proxy variables nor freedom-ipfs's `FREEDOM_IPFS_*`
 *   tuning reach it.
 * - **The ephemeral process** is `serve --ephemeral --parent-pid <pid>`, the
 *   private windows' (0007, "Private windows"): memory instances only, no
 *   data directory and no lock.
 * - **The handshake** is `ipfs.hello`: protocol 1, the shell's version and
 *   `frames: ["stream"]`. A service that answers takes main's stream frames
 *   (it refuses a hello without them), so a valid result grants `stream`.
 *   It names the service's version, the freedom-ipfs build it links and
 *   which process it is; one that isn't the process main spawned is a fault.
 * - **Restarts** are the shared client's: 0.5 s, 2 s, then 10 s, none after
 *   64, 74, 75 or a protocol mismatch, and three crashes within 60 s stop
 *   them. The node counts an instance it lost to a request panic as a crash
 *   too (`recordCrash`).
 * - **Hang watchdogs** (0007, "Crashes, hangs and restarts"): the service
 *   owns every deadline and always replies, so main only watches. A head
 *   with no reply by its `headers_ms` + 15 s, an `ipfs.stats` with no reply
 *   within 20 s, or an `ipfs.start` or `ipfs.stop` with none by its 10 s or
 *   5 s + 15 s, means the service is hung: it is killed, and the restart
 *   rules apply.
 * - **Shutdown** is `ipfs.shutdown` and closing stdin; the process is killed
 *   5 s later if it hasn't exited.
 */

const path = require('path');
const { app } = require('electron');
const { ServiceClient, isObject } = require('../core/service-client');
const { JSON_KINDS } = require('../core/frame');

const PROTOCOL_VERSION = 1;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/;
const KINDS = new Set(['persistent', 'ephemeral']);
// A service's requests are main's own: no caller context reaches it.
const CONTEXT = Object.freeze({ caller: 'shell' });

/** What main adds to a deadline the service owns before calling it hung. */
const HANG_GRACE_MS = 15_000;
/** `ipfs.start`'s deadline in the service. */
const START_DEADLINE_MS = 10_000;
/** `ipfs.stop`'s bound in the service: its teardown is proven within it, or
 * the process exits 70. */
const STOP_DEADLINE_MS = 5_000;
/** No `ipfs.stats` reply within this means the service is hung. */
const STATS_WATCHDOG_MS = 20_000;
/** How long after `ipfs.shutdown` the process is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
/** Requests outstanding per process, retiring ones included (0007, Bounds). */
const MAX_OUTSTANDING = 512;

/** Dev overrides or downloaded binaries; packaged builds always use resources.
 * Outside Electron (a script such as the native smoke), `app` is undefined,
 * and the build isn't packaged. */
function getIpfsdBinaryPath() {
  const packaged = Boolean(app?.isPackaged);
  if (!packaged && process.env.FREEDOM_IPFSD_PATH) {
    return process.env.FREEDOM_IPFSD_PATH;
  }
  const name = process.platform === 'win32' ? 'freedom-ipfsd.exe' : 'freedom-ipfsd';
  if (!packaged) {
    const os =
      { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
    return path.join(
      __dirname,
      '..',
      '..',
      '..',
      'freedom-ipfsd-bin',
      `${os}-${process.arch}`,
      name
    );
  }
  return path.join(process.resourcesPath, 'freedom-ipfsd', name);
}

/** The persistent process's arguments, for the profile's data directory. */
function persistentArgs({ dataDir, lockDir, parentPid = process.pid }) {
  return ['serve', '--data-dir', dataDir, '--lock-dir', lockDir, '--parent-pid', String(parentPid)];
}

/** The ephemeral process's arguments: no data directory, no lock. */
function ephemeralArgs({ parentPid = process.pid } = {}) {
  return ['serve', '--ephemeral', '--parent-pid', String(parentPid)];
}

/** The public part of a valid hello result from a `kind` process, or null. */
function validHello(result, kind) {
  if (!isObject(result) || result.protocol !== PROTOCOL_VERSION) return null;
  const { service_version: serviceVersion, freedom_ipfs: build } = result;
  if (typeof serviceVersion !== 'string' || !VERSION.test(serviceVersion)) return null;
  if (!isObject(build) || typeof build.version !== 'string' || !VERSION.test(build.version)) {
    return null;
  }
  const commit = build.git_commit ?? null;
  if (commit !== null && (typeof commit !== 'string' || !GIT_COMMIT.test(commit))) return null;
  if (result.kind !== kind) return null;
  return {
    protocol: PROTOCOL_VERSION,
    service_version: serviceVersion,
    freedom_ipfs: { version: build.version, git_commit: commit },
    kind,
  };
}

/** freedom-ipfsd's `kind` process, as the shared client supervises it. */
function ipfsdService(kind) {
  if (!KINDS.has(kind)) throw new Error(`unknown freedom-ipfsd process: ${kind}`);
  return Object.freeze({
    label: '[ipfsd]',
    noun: 'freedom-ipfs service',
    unavailableCode: 'ipfs_unavailable',
    protocol: PROTOCOL_VERSION,
    helloMethod: 'ipfs.hello',
    helloParams: (client) => ({
      protocol: PROTOCOL_VERSION,
      shell_version: client.shellVersion,
      frames: ['stream'],
    }),
    validHello: (result) => validHello(result, kind),
    shutdownMethod: 'ipfs.shutdown',
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    fragments: () => false,
    // The service refuses a hello that doesn't take stream frames.
    streams: () => true,
    initialKinds: JSON_KINDS,
    maxPending: MAX_OUTSTANDING,
  });
}

class IpfsdClient extends ServiceClient {
  /**
   * @param {object} options - ServiceClient's, without `service`, and:
   * @param {'persistent'|'ephemeral'} [options.kind] - the process spawned
   */
  constructor(options) {
    super({ ...options, service: ipfsdService(options.kind ?? 'persistent') });
  }

  /** `ipfs.start` on `gen`: resolves to `{ instance }` once it is live.
   * `fence` is the caller's last check before it is sent. */
  startInstance(gen, params, { fence = null } = {}) {
    return this.requestTo(gen, 'ipfs.start', params, CONTEXT, {
      watchdogMs: START_DEADLINE_MS + HANG_GRACE_MS,
      fence,
    });
  }

  /** `ipfs.stop` on `gen`: resolves once the instance's teardown is proven,
   * which covers a start still in flight; `stopped` for one that is
   * retired, unknown or stopping already. */
  stopInstance(gen, instance) {
    return this.requestTo(gen, 'ipfs.stop', { instance }, CONTEXT, {
      watchdogMs: STOP_DEADLINE_MS + HANG_GRACE_MS,
    });
  }

  /**
   * `ipfs.request` on `gen`: resolves to the head's result and its body (see
   * `callStream`), watched until its `headers_ms` + 15 s. `signal` cancels
   * it; `fence` is the caller's last check before it is sent.
   */
  gatewayRequest(gen, params, { signal = null, fence = null } = {}) {
    return this.requestStreamTo(gen, 'ipfs.request', params, CONTEXT, {
      watchdogMs: params.headers_ms + HANG_GRACE_MS,
      signal,
      fence,
    });
  }

  /** `ipfs.stats` on `gen`, watched for 20 s. */
  instanceStats(gen, instance) {
    return this.requestTo(gen, 'ipfs.stats', { instance }, CONTEXT, {
      watchdogMs: STATS_WATCHDOG_MS,
    });
  }
}

module.exports = {
  IpfsdClient,
  getIpfsdBinaryPath,
  persistentArgs,
  ephemeralArgs,
  validHello,
  ipfsdService,
  PROTOCOL_VERSION,
  HANG_GRACE_MS,
  START_DEADLINE_MS,
  STOP_DEADLINE_MS,
  STATS_WATCHDOG_MS,
  SHUTDOWN_GRACE_MS,
  MAX_OUTSTANDING,
};
