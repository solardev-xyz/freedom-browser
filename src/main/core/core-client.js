/**
 * Client for the freedom-cored child process (freedom-core design 0001,
 * "Process model" and "Messages"): `ServiceClient` (service-client.js),
 * configured for the core.
 *
 * - **The handshake** is `core.hello`: protocol 1, the shell's version, the
 *   vault's auto-lock and `frames: ["fragment"]` (main takes fragmented
 *   responses, so the handshake grants the core main's bulk credit). A
 *   valid result names the core's version, its capabilities and any node
 *   identity write its startup recovery couldn't finish.
 * - **Fragmented replies:** a core that offers `fragments` takes main's.
 * - **Shutdown** is `core.shutdown`; logs say `[Core]`, and errors that the
 *   core isn't running are `core_unavailable`.
 *
 * Everything else (generations, restarts, cancels, the pool, the frames,
 * which are design 0005's and never design 0007's streams) is the shared
 * client's, unchanged.
 */

const {
  ServiceClient,
  CoreError,
  JsonParams,
  JsonText,
  ShellError,
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

const PROTOCOL_VERSION = 1;
const CORE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/** The public part of a valid hello result, or null. */
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
    // Main takes fragmented responses: the handshake grants the core
    // main's bulk credit.
    frames: ['fragment'],
  }),
  validHello,
  shutdownMethod: 'core.shutdown',
  fragments: (hello) => hello.capabilities.includes('fragments'),
});

class CoreClient extends ServiceClient {
  /**
   * @param {object} options - ServiceClient's, without `service`, and:
   * @param {number} [options.autoLockMs] - the vault's auto-lock, sent in
   *   the handshake (15 minutes)
   */
  constructor(options) {
    super({ ...options, service: CORE_SERVICE });
    this.autoLockMs = options.autoLockMs ?? 15 * 60 * 1000;
  }
}

module.exports = {
  CoreClient,
  CoreError,
  JsonParams,
  JsonText,
  ShellError,
  SHELL_ERRORS,
  MAX_INCOMING,
  scrubbedEnv,
  PROTOCOL_VERSION,
  NO_RESTART_EXIT_CODES,
  RESTART_DELAYS_MS,
  MAX_PENDING,
  MAX_WRITE_BYTES,
  POOL_BYTES,
  POOL_EXEMPT_BYTES,
};
