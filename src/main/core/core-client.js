/**
 * Client for the freedom-cored child process (freedom-core design 0001,
 * "Process model" and "Messages"): `ServiceClient` (service-client.js),
 * configured for the core.
 *
 * - **The handshake** is `core.hello`: the protocol, the shell's version,
 *   the vault's auto-lock and `frames: ["fragment", "stream"]` (`fragment`:
 *   main takes fragmented responses, so the handshake grants the core main's
 *   bulk credit; `stream`: see Streams below). A
 *   valid result has protocol 2, and names the core's version, its
 *   capabilities (with `streams`) and any node identity write its startup
 *   recovery couldn't finish.
 * - **The protocol** is 2 (design 0009), the only one the client speaks.
 *   Main and the core ship pinned together (0001), and the pinned core
 *   (0.12.0) speaks only 2: it answers a hello at any other protocol,
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

// Protocol 2, streams in both directions (design 0009): the only one the
// core speaks from 0.11.0, which refuses protocol 1 (design 0001's). Both
// names are the same number; `PROTOCOL_VERSION_STREAMS` is kept for the
// modules that check a client speaks streams.
const PROTOCOL_VERSION = 2;
const PROTOCOL_VERSION_STREAMS = PROTOCOL_VERSION;
const CORE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/** The public part of a valid hello result, or null: protocol 2, and the
 * core's capabilities say `streams`. */
function validHello(result) {
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
  return {
    protocol: PROTOCOL_VERSION,
    core_version: result.core_version,
    capabilities,
    node_recovery: nodeRecovery,
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

/** freedom-cored, as the shared client supervises it. */
const CORE_SERVICE = Object.freeze({
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
  }),
  validHello,
  shutdownMethod: 'core.shutdown',
  fragments: (hello) => hello.capabilities.includes('fragments'),
  // Streams both ways once the hello is valid, which says `streams`
  // (validHello).
  duplex: () => true,
});

class CoreClient extends ServiceClient {
  /**
   * @param {object} options - ServiceClient's, without `service`, and:
   * @param {number} [options.autoLockMs] - the vault's auto-lock, sent in
   *   the handshake (15 minutes)
   * @param {number} [options.protocol] - the protocol main asks for: only
   *   2 (the default), so a caller still asking for 1 fails here rather
   *   than at the core's `protocol_mismatch`
   */
  constructor(options) {
    const protocol = options.protocol ?? PROTOCOL_VERSION;
    if (protocol !== PROTOCOL_VERSION) throw new TypeError(`unknown core protocol ${protocol}`);
    super({ ...options, service: CORE_SERVICE });
    this.autoLockMs = options.autoLockMs ?? 15 * 60 * 1000;
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
};
