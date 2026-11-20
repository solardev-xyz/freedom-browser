/**
 * Client for the freedom-cored child process (freedom-core design 0001,
 * "Process model" and "Messages"): `ServiceClient` (service-client.js),
 * configured for the core.
 *
 * - **The handshake** is `core.hello`: the protocol, the shell's version,
 *   the vault's auto-lock, `frames: ["fragment", "stream"]` (`fragment`:
 *   main takes fragmented responses, so the handshake grants the core main's
 *   bulk credit; `stream`: see Streams below) and `grant_root`. A
 *   valid result has protocol 2, and names the core's version, its
 *   capabilities (with `streams`) and any node identity write its startup
 *   recovery couldn't finish.
 * - **`grant_root`** (design 0012, "The files (Q10)") is the directory of
 *   the profile's four permission files, as an absolute, normalized path:
 *   the core reads them there at its checks. The pinned core (0.23.0)
 *   requires it, as every core from 0.14.0 (APR-3) does, and answers a hello
 *   without it, or with a relative path, with `invalid_argument` and exits
 *   76, so a client can't be made without one.
 * - **`grant_moved`** names the files that have moved to the core, which is
 *   their only writer from then on (design 0012, "One writer per file"):
 *   `dapp` (APB-2), whose every write main sends to the core's write methods
 *   (wallet/dapp-permissions.js), and `swarm` and `radicle` (APB-3), which
 *   main reads and changes only through the core (core/grants.js), and
 *   `x402` (X402-2), whose caps the core charges, writes and revokes as it
 *   pays (`x402.authorize`, `x402.settle`, `approval.revoke`; x402/caps.js).
 *   Main writes none of the four files. Reverting a move gives the file back
 *   to main: the core then writes nothing in it, and older builds still read
 *   it (Q10).
 * - **`store_moved`** (design 0013, "One writer per store") names the set-A
 *   stores (`STORES`) whose only writer is the core: `STORE_MOVED`, a
 *   property of the build: `vault_meta` from PRF-6(a). The core's answer echoes
 *   the names it took, each once (cored 0.23.0); a core before 0.23.0
 *   (0.22.0) ignores the field, and its answer has none, which reads as
 *   none taken. A store's requests go with `requires: requiresStore(name)`,
 *   so on a core that didn't take the store they fail `requirement_unmet`
 *   in main and are never written to it. An echo naming a store main
 *   didn't send, or one twice, fails the hello.
 * - **The protocol** is 2 (design 0009), the only one the client speaks.
 *   Main and the core ship pinned together (0001), and the pinned core
 *   (0.23.0) speaks only 2: it answers a hello at any other protocol,
 *   1 included, with `protocol_mismatch` and exits 76. A core that answers
 *   another protocol is a mismatch too: main fails, and doesn't restart it.
 *   Protocol 1 is gone (design 0009, Streams in the core), and a client
 *   made with `protocol: 1` throws.
 * - **Streams** go in both directions: main's hello offers
 *   `frames: ["fragment", "stream"]`, the core's capabilities must say
 *   `streams`, and from the hello on the connection reads all
 *   four stream frames (`CORE_STREAM_KINDS`) into one `StreamDuplex`. The
 *   bodies the core sends main end only with its verified bodies' abort
 *   codes; those main sends the core (`StreamedReply`, from a handler
 *   registered with `streams: true`) end only with a piece's.
 * - **Fragmented replies:** a core that offers `fragments` takes main's.
 * - **Shutdown** is `core.shutdown`; logs say `[Core]`, and errors that the
 *   core isn't running are `core_unavailable`.
 *
 * Everything else (generations, restarts, cancels, the pool, the frames:
 * design 0005's, and design 0007's stream frames as 0009 adopts them) is
 * the shared client's.
 */

const {
  ServiceClient,
  CoreError,
  JsonParams,
  JsonText,
  ShellError,
  StreamedReply,
  SHELL_ERRORS,
  MAX_INCOMING,
  scrubbedEnv,
  isObject,
  NO_RESTART_EXIT_CODES,
  RESTART_DELAYS_MS,
  MAX_PENDING,
  MAX_WRITE_BYTES,
  POOL_BYTES,
  POOL_EXEMPT_BYTES,
} = require('./service-client');
const path = require('path');

// Protocol 2, streams in both directions (design 0009): the only one the
// core speaks from 0.11.0, which refuses protocol 1 (design 0001's). Both
// names are the same number; `PROTOCOL_VERSION_STREAMS` is kept for the
// modules that check a client speaks streams.
const PROTOCOL_VERSION = 2;
const PROTOCOL_VERSION_STREAMS = PROTOCOL_VERSION;
const CORE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * The set-A stores (design 0013, "One writer per store: `store_moved`"),
 * each of which main hands to the core by naming it in the hello's
 * `store_moved`, in the core's order.
 */
const STORES = Object.freeze(['vault_meta', 'intents', 'payments', 'safe_pending', 'rpc_api_keys']);

/**
 * The stores this build names in every hello's `store_moved`, whose only
 * writer is then the core. It is a property of the build, never a run-time
 * switch: each PRF-6 step adds its store's name in the change that deletes
 * main's writer for it. `vault_meta` from PRF-6(a): identity-manager.js
 * writes `vault-meta.json` nowhere.
 */
const STORE_MOVED = Object.freeze(['vault_meta']);

/**
 * The hello answer's `store_moved`: the names of `sent` whose store the core
 * serves, each once. Absent (a core before 0.23.0, which ignores the field)
 * is none, `[]`; undefined for a malformed echo: not an array, longer than
 * `STORES`, or holding a non-string, a name main didn't send, or a name
 * twice.
 */
function validStoreEcho(value, sent) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > STORES.length) return undefined;
  const seen = new Set();
  for (const name of value) {
    if (typeof name !== 'string' || !sent.includes(name) || seen.has(name)) return undefined;
    seen.add(name);
  }
  return value;
}

/** The public part of a valid hello result, or null: protocol 2, the
 * core's capabilities say `streams`, and its `store_moved` echo names only
 * stores in `sent` (the hello's own `store_moved`), each once. */
function validHello(result, sent = STORE_MOVED) {
  if (!isObject(result) || result.protocol !== PROTOCOL_VERSION) return null;
  if (typeof result.core_version !== 'string' || !CORE_VERSION.test(result.core_version)) {
    return null;
  }
  const { capabilities } = result;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 256 ||
    !capabilities.every((c) => typeof c === 'string' && c.length <= 64)
  ) {
    return null;
  }
  if (!capabilities.includes('streams')) return null;
  const nodeRecovery = validNodeRecovery(result.node_recovery);
  if (nodeRecovery === undefined) return null;
  const storeMoved = validStoreEcho(result.store_moved, sent);
  if (storeMoved === undefined) return null;
  return {
    protocol: PROTOCOL_VERSION,
    core_version: result.core_version,
    capabilities,
    node_recovery: nodeRecovery,
    store_moved: Object.freeze([...storeMoved]),
  };
}

const NODE_RECOVERY_STATUS = new Set(['pending_recovery', 'corrupt']);
const OP_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * hello's `node_recovery`: a node identity write startup recovery couldn't
 * finish. `null` (or absent, from older cores) when there is none; undefined
 * for a malformed value.
 */
function validNodeRecovery(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !NODE_RECOVERY_STATUS.has(value.status)) return undefined;
  const out = { status: value.status };
  if (value.op_id !== undefined) {
    if (typeof value.op_id !== 'string' || !OP_ID.test(value.op_id)) return undefined;
    out.op_id = value.op_id;
  }
  if (value.node !== undefined) {
    if (value.node !== 'bee' && value.node !== 'radicle') return undefined;
    out.node = value.node;
  }
  return out;
}

/**
 * freedom-cored, as the shared client supervises it, with the hello naming
 * `storeMoved` (the build's `STORE_MOVED`; tests name others) and taking an
 * echo of those names only.
 */
function coreService(storeMoved = STORE_MOVED) {
  return Object.freeze({
    label: '[Core]',
    noun: 'core',
    unavailableCode: 'core_unavailable',
    protocol: PROTOCOL_VERSION,
    helloMethod: 'core.hello',
    helloParams: (client) => ({
      protocol: PROTOCOL_VERSION,
      shell_version: client.shellVersion,
      auto_lock_ms: client.autoLockMs,
      // Main takes fragmented responses (the handshake grants the core
      // main's bulk credit) and stream frames, which the core requires.
      frames: ['fragment', 'stream'],
      // Where the permission files are (design 0012, APR-3), and those that
      // have moved to the core, which writes them from then on: the dApp file
      // (APB-2), Swarm's and Radicle's (APB-3), and x402's caps (X402-2).
      grant_root: client.grantRoot,
      grant_moved: ['dapp', 'swarm', 'radicle', 'x402'],
      // The set-A stores the core writes from then on (design 0013):
      // vault-meta.json (PRF-6(a)). The core echoes those it took; 0.22.0
      // ignores the field.
      store_moved: [...storeMoved],
    }),
    validHello: (result) => validHello(result, storeMoved),
    shutdownMethod: 'core.shutdown',
    fragments: (hello) => hello.capabilities.includes('fragments'),
    // Streams both ways once the hello is valid, which says `streams`
    // (validHello).
    duplex: () => true,
  });
}

const CORE_SERVICE = coreService();

/**
 * A request's `requires` (service-client.js) for store `name`'s requests:
 * true only for a process whose hello echoed the name, so on any other,
 * an older core's included, the request fails `requirement_unmet` in main
 * and is never written. Throws a TypeError for a name not in `STORES`.
 */
function requiresStore(name) {
  if (!STORES.includes(name)) throw new TypeError(`unknown store ${name}`);
  return (hello) => Array.isArray(hello?.store_moved) && hello.store_moved.includes(name);
}

class CoreClient extends ServiceClient {
  /**
   * @param {object} options - ServiceClient's, without `service`, and:
   * @param {number} [options.autoLockMs] - the vault's auto-lock, sent in
   *   the handshake (15 minutes)
   * @param {string} options.grantRoot - the directory of the profile's
   *   permission files, sent as the hello's `grant_root`: an absolute path,
   *   sent normalized (no `.` or `..`, no trailing separator, and on Windows
   *   with its drive)
   * @param {number} [options.protocol] - the protocol main asks for: only
   *   2 (the default), so a caller still asking for 1 fails here rather
   *   than at the core's `protocol_mismatch`
   */
  constructor(options) {
    const protocol = options.protocol ?? PROTOCOL_VERSION;
    if (protocol !== PROTOCOL_VERSION) throw new TypeError(`unknown core protocol ${protocol}`);
    const { grantRoot } = options;
    if (typeof grantRoot !== 'string' || !path.isAbsolute(grantRoot)) {
      throw new TypeError('the core client needs grantRoot, an absolute path');
    }
    super({ ...options, service: CORE_SERVICE });
    this.autoLockMs = options.autoLockMs ?? 15 * 60 * 1000;
    this.grantRoot = path.resolve(grantRoot);
  }

  /** The protocol main asks for, and every ready hello settled. */
  get protocol() {
    return this.service.protocol;
  }
}

module.exports = {
  CoreClient,
  CoreError,
  JsonParams,
  JsonText,
  ShellError,
  StreamedReply,
  SHELL_ERRORS,
  MAX_INCOMING,
  scrubbedEnv,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_STREAMS,
  NO_RESTART_EXIT_CODES,
  RESTART_DELAYS_MS,
  MAX_PENDING,
  MAX_WRITE_BYTES,
  POOL_BYTES,
  POOL_EXEMPT_BYTES,
  STORES,
  STORE_MOVED,
  requiresStore,
  // For tests.
  _internal: { coreService, validHello },
};
