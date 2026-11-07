/**
 * The core's deadline classes and main's hang watchdogs (freedom-core design
 * 0001, "Deadlines, cancellation and commit"). Each method's class is the
 * core's method table: `fc_protocol::methods` (crates/fc-protocol/src/
 * methods.rs), rendered as `protocol/schema.json`.
 *
 * - immediate: answered at once, with no deadline;
 * - vault: 30 s from admission, queue time included (the vault queue);
 * - session: 120 s, or the caller's shorter `deadline_ms` (designs 0004,
 *   0005);
 * - head: `dweb.verify`'s time to the head, 360 s (design 0009, Bounds).
 *
 * The core enforces its deadlines and always replies. Main runs only a hang
 * watchdog on every request: the core's deadline + 15 s, or 15 s for an
 * immediate method. When one fires, the core is hung: the client kills it,
 * which fails its pending requests `core_unavailable`, and restarts it; the
 * callers then reconcile (service-client.js, vault-backend.js). The table
 * is kept whole, but `core.hello` and `core.shutdown` are the client's own:
 * its 10 s handshake timeout and 3 s shutdown grace bound them instead.
 *
 * Main's copy, checked against the core's file when it is found
 * (core-deadlines.test.js). It holds the rows the file marks
 * `"protocol": 2` too, `dweb.verify` and `dweb.forget` (design 0009,
 * amendment 3): the core serves them only on a protocol-2 connection, which
 * is the one main asks for (core-process.js). dweb-verify.js sends those
 * two with the same watchdogs.
 */

/** The watchdog's margin past the core's deadline. */
const WATCHDOG_MARGIN_MS = 15_000;
/** An immediate method's watchdog: it has no deadline, only the margin. */
const IMMEDIATE_WATCHDOG_MS = WATCHDOG_MARGIN_MS;
/** The vault queue's deadline. */
const VAULT_DEADLINE_MS = 30_000;
/** A session's deadline, and the longest `deadline_ms` it takes. */
const SESSION_DEADLINE_MS = 120_000;
/** The time to the head (design 0009, Bounds: `dweb.verify`'s `head`
 * deadline kind). */
const HEAD_DEADLINE_MS = 360_000;

const IMMEDIATE = 'immediate';
const VAULT = 'vault';
const SESSION = 'session';
const HEAD = 'head';

/** Every method the core serves, by class, in the core's table order. */
const METHOD_CLASSES = Object.freeze({
  'core.hello': IMMEDIATE,
  'core.shutdown': IMMEDIATE,
  'vault.status': IMMEDIATE,
  'vault.lock': IMMEDIATE,
  'vault.touch': IMMEDIATE,
  'vault.unlock': VAULT,
  'vault.verify_password': VAULT,
  'vault.change_password': VAULT,
  'vault.delete': VAULT,
  'vault.export_mnemonic': VAULT,
  'vault.export_private_key': VAULT,
  'vault.create': VAULT,
  'vault.import': VAULT,
  'vault.reconcile': VAULT,
  'nodes.write_identity': VAULT,
  'nodes.op_status': VAULT,
  'nodes.seal_radicle_key': IMMEDIATE,
  'keys.generate_mnemonic': IMMEDIATE,
  'keys.validate_mnemonic': IMMEDIATE,
  'keys.addresses': IMMEDIATE,
  'keys.radicle_did': IMMEDIATE,
  'sign.transaction': IMMEDIATE,
  'sign.message': IMMEDIATE,
  'sign.typed_data': IMMEDIATE,
  'swarm.sign_soc': IMMEDIATE,
  'typed_data.hash': IMMEDIATE,
  'naming.configure': IMMEDIATE,
  'naming.availability': IMMEDIATE,
  'naming.resolve_content': SESSION,
  'naming.resolve_address': SESSION,
  'naming.resolve_reverse': SESSION,
  'naming.resolve_tezos': SESSION,
  'naming.invalidate_content': IMMEDIATE,
  'naming.invalidate_tezos': IMMEDIATE,
  'dweb.open': SESSION,
  'dweb.verify': HEAD,
  'dweb.forget': IMMEDIATE,
  'chain.configure': IMMEDIATE,
  'chain.availability': IMMEDIATE,
  'chain.request': SESSION,
  'chain.fee_quote': SESSION,
  'chain.fee_reference': SESSION,
  'chain.broadcast': SESSION,
  'chain.html': SESSION,
});

/** The methods the core serves only at protocol 2, the rows its file marks
 * `"protocol": 2` (design 0009, amendment 3), in the table's order. */
const PROTOCOL_2_METHODS = Object.freeze(['dweb.verify', 'dweb.forget']);

/**
 * A request's hang watchdog, in ms. A method the core doesn't serve is
 * refused at once (`unknown_method`), so it gets an immediate one.
 * @param {string} method
 * @param {number} [deadlineMs] - a session request's own `deadline_ms`
 */
function watchdogMs(method, deadlineMs) {
  switch (METHOD_CLASSES[method]) {
    case VAULT:
      return VAULT_DEADLINE_MS + WATCHDOG_MARGIN_MS;
    case SESSION: {
      const own = Number.isSafeInteger(deadlineMs) && deadlineMs >= 0;
      const deadline = own ? Math.min(deadlineMs, SESSION_DEADLINE_MS) : SESSION_DEADLINE_MS;
      return deadline + WATCHDOG_MARGIN_MS;
    }
    case HEAD:
      return HEAD_DEADLINE_MS + WATCHDOG_MARGIN_MS;
    default:
      return IMMEDIATE_WATCHDOG_MS;
  }
}

module.exports = {
  WATCHDOG_MARGIN_MS,
  IMMEDIATE_WATCHDOG_MS,
  VAULT_DEADLINE_MS,
  SESSION_DEADLINE_MS,
  HEAD_DEADLINE_MS,
  METHOD_CLASSES,
  PROTOCOL_2_METHODS,
  watchdogMs,
};
