/**
 * Client for the freedom-cored child process (freedom-core design 0001,
 * "Process model" and "Messages"): `ServiceClient` (service-client.js),
 * configured for the core.
 *
 * - **The handshake** is `core.hello`: the protocol, the shell's version,
 *   the vault's auto-lock and `frames: ["fragment"]` (main takes fragmented
 *   responses, so the handshake grants the core main's bulk credit). A
 *   valid result has the protocol main asked for, and names the core's
 *   version, its capabilities and any node identity write its startup
 *   recovery couldn't finish.
 * - **The protocol** is 1 unless the client is made with `protocol: 2`.
 *   Main and the core ship pinned together (0001), so main asks for the
 *   one its pinned core speaks, and a core that answers another is a
 *   mismatch: main fails, and doesn't restart it. The pinned core (0.9.1)
 *   speaks protocol 1 only; a core that speaks 2 also takes 1, without
 *   streams (design 0009, Streams in the core).
 * - **Protocol 2** (design 0009) adds streams in both directions: main's
 *   hello offers `frames: ["fragment", "stream"]`, the core's capabilities
 *   must say `streams`, and from the hello on the connection reads all
 *   four stream frames (`CORE_STREAM_KINDS`) into one `StreamDuplex`. The
 *   bodies the core sends main end only with its verified bodies' abort
 *   codes; those main sends the core (`StreamedReply`, from a handler
 *   registered with `streams: true`) end only with a piece's.
 * - **Fragmented replies:** a core that offers `fragments` takes main's.
 * - **Shutdown** is `core.shutdown`; logs say `[Core]`, and errors that the
 *   core isn't running are `core_unavailable`.
 *
 * Everything else (generations, restarts, cancels, the pool, the frames:
 * design 0005's, and at protocol 2 design 0007's stream frames as 0009
 * adopts them) is the shared client's.
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

// The protocol main speaks to the pinned core (design 0001), and the one
// that adds streams in both directions (design 0009).
const PROTOCOL_VERSION = 1;
const PROTOCOL_VERSION_STREAMS = 2;
const PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, PROTOCOL_VERSION_STREAMS]);
const CORE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/** The public part of a valid hello result at `protocol`, or null. At
 * protocol 2 the core's capabilities must say `streams`. */
function validHello(result, protocol = PROTOCOL_VERSION) {
  if (!isObject(result) || result.protocol !== protocol) return null;
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
  if (protocol === PROTOCOL_VERSION_STREAMS && !capabilities.includes('streams')) return null;
  const nodeRecovery = validNodeRecovery(result.node_recovery);
  if (nodeRecovery === undefined) return null;
  return {
    protocol,
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

/** freedom-cored at `protocol`, as the shared client supervises it. */
function coreService(protocol) {
  const streams = protocol === PROTOCOL_VERSION_STREAMS;
  return Object.freeze({
    label: '[Core]',
    noun: 'core',
    unavailableCode: 'core_unavailable',
    protocol,
    helloMethod: 'core.hello',
    helloParams: (client) => ({
      protocol,
      shell_version: client.shellVersion,
      auto_lock_ms: client.autoLockMs,
      // Main takes fragmented responses: the handshake grants the core
      // main's bulk credit. At protocol 2 it takes stream frames too.
      frames: streams ? ['fragment', 'stream'] : ['fragment'],
    }),
    validHello: (result) => validHello(result, protocol),
    shutdownMethod: 'core.shutdown',
    fragments: (hello) => hello.capabilities.includes('fragments'),
    // Streams both ways only once a protocol-2 hello is valid, which says
    // `streams` (validHello).
    duplex: () => streams,
  });
}

const CORE_SERVICES = new Map(
  [...PROTOCOL_VERSIONS].map((protocol) => [protocol, coreService(protocol)])
);

class CoreClient extends ServiceClient {
  /**
   * @param {object} options - ServiceClient's, without `service`, and:
   * @param {number} [options.autoLockMs] - the vault's auto-lock, sent in
   *   the handshake (15 minutes)
   * @param {number} [options.protocol] - the protocol main asks for: 1 (the
   *   pinned core's), or 2 for a core with streams (design 0009)
   */
  constructor(options) {
    const protocol = options.protocol ?? PROTOCOL_VERSION;
    if (!PROTOCOL_VERSIONS.has(protocol)) throw new TypeError(`unknown core protocol ${protocol}`);
    super({ ...options, service: CORE_SERVICES.get(protocol) });
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
