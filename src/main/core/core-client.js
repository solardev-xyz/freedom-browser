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
 *   the core reads them there at its checks. The pinned core (0.29.0)
 *   requires it, as every core from 0.14.0 (APR-3) does, and answers a hello
 *   without it, or with a relative path, with `invalid_argument` and exits
 *   76, so a client can't be made without one.
 * - **`user_data_dir`** (design 0013, PRF-8b-lite) is the profile's own
 *   directory (`app.getPath('userData')`), as an absolute, normalized path,
 *   when the client is given one: where the legacy `x402-receipts.json`
 *   is. In the old layout it is also the Freedom root (`grant_root`), and
 *   the core imports the file there once and renames it there. After 0013's
 *   move the receipts stay at the profile's root, and the core (from
 *   0.27.0, design 0017 C5) copies them into the Freedom root, imports the
 *   copy, and drops the original at a later start once the copy's
 *   `.migrated` shows the import committed. Cores from 0.24.0 (PRF-8-lite)
 *   take it; an older core ignores it, as it ignores every hello member it
 *   doesn't know, and reads the receipts under `grant_root`. The pinned
 *   core (0.29.0, freedom-core design 0015 D10) copies a moved profile's
 *   legacy `publish-history.json` into the Freedom root the same way, and
 *   imports the copy only once a hello names `swarm_stores` in
 *   `store_moved`; until then main's own history (publish-history.js)
 *   imports the profile's file, as before.
 * - **The grant's arguments** (design 0017, C1): for a `serve` command the
 *   client appends `--grant-root <grant_root>` and, with `user_data_dir`,
 *   `--user-data-dir <user_data_dir>` to the spawn's arguments itself,
 *   from the same normalized values the hello sends, so the two can't
 *   disagree. The pinned core (0.29.0) requires `--grant-root`, confines
 *   itself to it before it reads the hello, and answers a hello whose
 *   `grant_root` or `user_data_dir` differs from them (one given on only
 *   one side included) with `invalid_argument`, then exits 76. 0.27.0 took
 *   them as optional; a core before that (0.22.0, the previous release
 *   some compatibility tests run) doesn't know them, and its callers turn
 *   them off (`grantArgs: false`). The node roots
 *   (`--node-root`) are the caller's to pass (core-process.js).
 * - **`confinement`** (design 0017): the confinement the core got, as
 *   freedom-core design 0010 reports it for the services
 *   (service-client.js's `validConfinement`), or null from a core that sends
 *   none (before 0.28.0). A report that isn't one fails the hello.
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
 *   property of the build: `vault_meta` from PRF-6(a), `intents`
 *   (PRF-6(b2)), whose every write main sends to the core's `intents.*`
 *   (wallet/intent-store.js), `payments` (PRF-6(c)), whose every read and
 *   write main sends to the core's `payments.*` (payment-history.js),
 *   `safe_pending` (PRF-6(d)), whose every write main sends to the core's
 *   `safe_pending.*` (wallet/safe/pending-store.js), and `rpc_api_keys`
 *   (PRF-6(e)), whose every read and write main sends to the core's
 *   `secrets.*` RPC-key methods (wallet/rpc-manager.js). The core's answer echoes
 *   the names it took, each once (cored 0.23.0); a core before 0.23.0
 *   (0.22.0) ignores the field, and its answer has none, which reads as
 *   none taken. A store's requests go with `requires: requiresStore(name)`,
 *   so on a core that didn't take the store they fail `requirement_unmet`
 *   in main and are never written to it. An echo naming a store main
 *   didn't send, or one twice, fails the hello.
 * - **The protocol** is 2 (design 0009), the only one the client speaks.
 *   Main and the core ship pinned together (0001), and the pinned core
 *   (0.29.0) speaks only 2: it answers a hello at any other protocol,
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
 * - **Idle methods** (design 0015, D5: `swarm.body`, `swarm.publish`) go
 *   only with their idle watchdog (`idleWatchdogMs`, core-deadlines.js).
 *   `swarm.body`'s head, `{ bytes }`, opens its body with no `body: true`.
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
  validConfinement,
  NO_RESTART_EXIT_CODES,
  RESTART_DELAYS_MS,
  MAX_PENDING,
  MAX_WRITE_BYTES,
  POOL_BYTES,
  POOL_EXEMPT_BYTES,
} = require('./service-client');
const { isIdleMethod } = require('./core-deadlines');
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
 * main's writer for it, in `STORES` order. `vault_meta` from PRF-6(a):
 * identity-manager.js writes `vault-meta.json` nowhere. `intents` from
 * PRF-6(b2): the intent journal's every write goes to the core. `payments`
 * from PRF-6(c): main opens `payment-history.sqlite` nowhere, and reads and
 * writes it only through the core. `safe_pending` from PRF-6(d): main keeps
 * a copy of `safe-pending.json` and writes it nowhere. `rpc_api_keys` from
 * PRF-6(e): the RPC API keys are the core's (wallet/rpc-manager.js). With
 * it, every set-A store is the core's.
 */
const STORE_MOVED = Object.freeze([
  'vault_meta',
  'intents',
  'payments',
  'safe_pending',
  'rpc_api_keys',
]);

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
 * core's capabilities say `streams`, its `store_moved` echo names only
 * stores in `sent` (the hello's own `store_moved`), each once, and its
 * `confinement`, when it sends one, is a report. */
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
  const confinement = validCoreConfinement(result.confinement);
  if (confinement === undefined) return null;
  return {
    protocol: PROTOCOL_VERSION,
    core_version: result.core_version,
    capabilities,
    node_recovery: nodeRecovery,
    store_moved: Object.freeze([...storeMoved]),
    confinement,
  };
}

/**
 * hello's `confinement` (design 0017): its public part
 * (`validConfinement`), or null from a core that sends none (before
 * 0.28.0); undefined for one that isn't a report.
 */
function validCoreConfinement(value) {
  if (value === undefined || value === null) return null;
  return validConfinement(value) ?? undefined;
}

/**
 * `args` with the grant's arguments (design 0017, C1) for a `serve`
 * command: `--grant-root grantRoot` and, when `userDataDir` isn't null,
 * `--user-data-dir userDataDir`, each the hello's own value. Any other
 * command's are returned as given. Throws a TypeError for `serve`
 * arguments that name either already: the client passes them itself.
 */
function withGrantArgs(args, grantRoot, userDataDir) {
  if (!Array.isArray(args) || args[0] !== 'serve') return args;
  if (args.includes('--grant-root') || args.includes('--user-data-dir')) {
    throw new TypeError('the core client passes --grant-root and --user-data-dir itself');
  }
  return [
    ...args,
    '--grant-root',
    grantRoot,
    ...(userDataDir === null ? [] : ['--user-data-dir', userDataDir]),
  ];
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
      // The profile's directory, where the legacy x402 receipts are (design
      // 0013, PRF-8b-lite): only when the client was given one.
      ...(client.userDataDir === null ? {} : { user_data_dir: client.userDataDir }),
      grant_moved: ['dapp', 'swarm', 'radicle', 'x402'],
      // The set-A stores the core writes from then on (design 0013):
      // vault-meta.json (PRF-6(a)), the intent journal (PRF-6(b2)), the
      // payment history (PRF-6(c)), safe-pending.json (PRF-6(d)) and the RPC
      // API keys (PRF-6(e)). The core echoes those it took; 0.22.0 ignores
      // the field.
      store_moved: [...storeMoved],
    }),
    validHello: (result) => validHello(result, storeMoved),
    shutdownMethod: 'core.shutdown',
    fragments: (hello) => hello.capabilities.includes('fragments'),
    // Streams both ways once the hello is valid, which says `streams`
    // (validHello).
    duplex: () => true,
    // `swarm.body` and `swarm.publish` (design 0015, D5): sent only with
    // their idle watchdog (core-deadlines.js `idleWatchdogMs`).
    idleMethod: isIdleMethod,
    // `swarm.body`'s head is `{ bytes }`, and its body always follows
    // (design 0015, Methods main calls; freedom-cored's `swarm/stream.rs`,
    // `body_head`).
    headOpens: (method) => method === 'swarm.body',
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
   * @param {string} [options.userDataDir] - the profile's directory, sent
   *   as the hello's `user_data_dir`: when given, an absolute path, sent
   *   normalized as `grantRoot` is; when not, the hello names none
   * @param {boolean} [options.grantArgs] - false to leave a `serve`
   *   command's arguments as given, for a core that doesn't know the
   *   grant's (0.22.0); by default `--grant-root` and `--user-data-dir`
   *   are appended, with the hello's values (`withGrantArgs`)
   * @param {number} [options.protocol] - the protocol main asks for: only
   *   2 (the default), so a caller still asking for 1 fails here rather
   *   than at the core's `protocol_mismatch`
   */
  constructor(options) {
    const protocol = options.protocol ?? PROTOCOL_VERSION;
    if (protocol !== PROTOCOL_VERSION) throw new TypeError(`unknown core protocol ${protocol}`);
    const { grantRoot, userDataDir } = options;
    if (typeof grantRoot !== 'string' || !path.isAbsolute(grantRoot)) {
      throw new TypeError('the core client needs grantRoot, an absolute path');
    }
    if (
      userDataDir !== undefined &&
      (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir))
    ) {
      throw new TypeError('the core client takes userDataDir only as an absolute path');
    }
    const root = path.resolve(grantRoot);
    const userData = userDataDir === undefined ? null : path.resolve(userDataDir);
    const grantArgs = options.grantArgs !== false;
    const args = grantArgs ? withGrantArgs(options.args, root, userData) : options.args;
    super({ ...options, args, service: CORE_SERVICE });
    this.autoLockMs = options.autoLockMs ?? 15 * 60 * 1000;
    this.grantRoot = root;
    this.userDataDir = userData;
    this.grantArgs = grantArgs;
  }

  /**
   * Sets the arguments of the next spawn, a restart's too, with the grant's
   * appended as the constructor appends them (unless `grantArgs` is
   * false). Only while no process runs: from a `deferSpawn` wait, say.
   */
  setArgs(args) {
    if (this.current) throw new Error('a freedom-cored process is running');
    this.args = this.grantArgs ? withGrantArgs(args, this.grantRoot, this.userDataDir) : args;
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
  _internal: { coreService, validHello, withGrantArgs },
};
