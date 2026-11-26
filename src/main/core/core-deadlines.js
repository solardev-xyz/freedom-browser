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
 * - head: `dweb.verify`'s time to the head, 360 s (design 0009, Bounds);
 * - swarm: 300 s, or the caller's shorter `deadline_ms` (design 0015, D5);
 * - idle: no total deadline, only idle bounds: the request runs for as long
 *   as its streams and asks make progress (design 0015, D5 and D13).
 *
 * The core enforces its deadlines and always replies. Main runs only a hang
 * watchdog on every request: the core's deadline + 15 s, or 15 s for an
 * immediate method. When one fires, the core is hung: the client kills it,
 * which fails its pending requests `core_unavailable`, and restarts it; the
 * callers then reconcile (service-client.js, vault-backend.js). An idle
 * method has no total deadline, so it gets no total watchdog (`null`): the
 * core's idle bounds end it (design 0015, D13). Main sends none yet. The
 * table is kept whole, but `core.hello` and `core.shutdown` are the
 * client's own: its 10 s handshake timeout and 3 s shutdown grace bound
 * them instead.
 *
 * Main's copy, checked against the core's file when it is found
 * (core-deadlines.test.js). It holds the rows the file marks
 * `"protocol": 2` too: `dweb.verify` and `dweb.forget` (design 0009,
 * amendment 3), and `swarm.body` and `swarm.publish` (design 0015, D5). The
 * core serves them only on a protocol-2 connection, which is the one main
 * asks for (core-process.js). dweb-verify.js sends the first two with the
 * same watchdogs.
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
/** A Swarm request's deadline (design 0015, D5: the `swarm` kind), and the
 * longest `deadline_ms` it takes. */
const SWARM_DEADLINE_MS = 300_000;

const IMMEDIATE = 'immediate';
const VAULT = 'vault';
const SESSION = 'session';
const HEAD = 'head';
const SWARM = 'swarm';
const IDLE = 'idle';

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
  // Design 0013's quick unlock (cored-v0.17.0, PRF-1c): the vault password
  // in the core's key store. `enroll` is main's own (`shell`); the rest are
  // the chrome's alone. All but `status` wait for the vault worker. Main
  // sends none of them yet (PRF-2).
  'quick_unlock.enroll': VAULT,
  'quick_unlock.unlock': VAULT,
  'quick_unlock.export_mnemonic': VAULT,
  'quick_unlock.export_private_key': VAULT,
  'quick_unlock.status': IMMEDIATE,
  'quick_unlock.disable': VAULT,
  // Design 0013's set-A stores (cored-v0.23.0, PRF-5), served once main
  // names the store in the hello's `store_moved`: the RPC API keys in the
  // core's secrets file (`rpc_api_keys`) and `vault-meta.json`'s accounts
  // (`vault_meta`). Both wait for the vault worker. Main sends none of them
  // yet (PRF-6).
  'secrets.rpc_api_keys': VAULT,
  'secrets.rpc_api_key_status': VAULT,
  'secrets.set_rpc_api_key': VAULT,
  'secrets.remove_rpc_api_key': VAULT,
  'accounts.list': VAULT,
  'accounts.meta': VAULT,
  'accounts.active': VAULT,
  'accounts.add_mnemonic': VAULT,
  'accounts.add_ledger': VAULT,
  'accounts.add_remote': VAULT,
  'accounts.record_address_check': VAULT,
  'accounts.add_safe': VAULT,
  'accounts.mark_safe_deployed': VAULT,
  'accounts.set_active': VAULT,
  'accounts.rename': VAULT,
  'accounts.remove': VAULT,
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
  // A page's SOC and main's own; the chrome's is refused at the table from
  // cored-v0.29.0 (design 0015's amendment to 0002), and the row goes at
  // SWM-9.
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
  // Design 0012's approvals (cored-v0.14.0, APR-3): main mints and spends
  // its tokens through the first four (APB-1). cored-v0.16.0 adds two
  // methods, both `page` only: `approval.radicle_write` (a page's Radicle
  // write counted in R-6) and `approval.remember` (a device send's "Always
  // allow", from `approval.spend`'s receipt).
  'approval.issue': IMMEDIATE,
  'approval.discard': IMMEDIATE,
  'approval.spend': IMMEDIATE,
  'approval.end': IMMEDIATE,
  'approval.check': IMMEDIATE,
  'approval.grant': IMMEDIATE,
  'approval.revoke': IMMEDIATE,
  'approval.touch': IMMEDIATE,
  // Asked by radicle-provider-ipc.js before a rule-answered write.
  'approval.radicle_write': IMMEDIATE,
  'approval.grants': IMMEDIATE,
  'approval.forget_account': IMMEDIATE,
  // Sent by page-core-sends.js once a device's flagged send is recorded.
  'approval.remember': IMMEDIATE,
  // cored-v0.18.0 (design 0012): the phone payment jobs (PHN-1), which every
  // caller may send; x402's authorization and settlement under the core's
  // caps (X402-1), main's own (`shell`); and a page's EIP-1193 request
  // (APR-5b), `page` only. Main sends the phone jobs (PHN-2) and x402's
  // (X402-2), and `eip1193.request` from APB-4a (page/page-eip1193.js).
  // The core's class for `eip1193.request` is `Steps`: a session's 120 s
  // outside its own prompts, none while one is open. Main gives it a
  // session's watchdog, held while main answers one of its prompts
  // (service-client.js `holdWatchdog`).
  'phone.job': IMMEDIATE,
  'phone.sent': IMMEDIATE,
  'phone.result': SESSION,
  'x402.authorize': IMMEDIATE,
  'x402.settle': IMMEDIATE,
  // cored-v0.19.0 (freedom-core #393): the narrowing of an x402 cap, from
  // the chrome and main (`shell`). Main sends it from X402-2b.
  'x402.update': IMMEDIATE,
  // cored-v0.23.0 (design 0013, PRF-5): the other three set-A stores,
  // `safe_pending`, `payments` and `intents`, under the same `store_moved`
  // names, all answered at once. Main sends none of them yet (PRF-6).
  'safe_pending.get': IMMEDIATE,
  'safe_pending.set': IMMEDIATE,
  'safe_pending.clear': IMMEDIATE,
  'safe_pending.list': IMMEDIATE,
  'payments.append': IMMEDIATE,
  'payments.update': IMMEDIATE,
  'payments.mark_confirmed': IMMEDIATE,
  'payments.mark_failed': IMMEDIATE,
  'payments.mark_dropped': IMMEDIATE,
  'payments.set_dropped_seen': IMMEDIATE,
  'payments.pending': IMMEDIATE,
  'payments.get_recent': IMMEDIATE,
  'payments.get_by_id': IMMEDIATE,
  'payments.get_count': IMMEDIATE,
  'payments.clear': IMMEDIATE,
  'intents.commit': IMMEDIATE,
  'intents.handoff': IMMEDIATE,
  'intents.outcome': IMMEDIATE,
  'intents.settle': IMMEDIATE,
  'intents.void': IMMEDIATE,
  'intents.retire': IMMEDIATE,
  'intents.track': IMMEDIATE,
  'intents.withdraw_origin': IMMEDIATE,
  'intents.compact': IMMEDIATE,
  'intents.get': IMMEDIATE,
  'intents.by_key': IMMEDIATE,
  'intents.held': IMMEDIATE,
  'intents.list': IMMEDIATE,
  'intents.held_nonces': IMMEDIATE,
  'intents.usage': IMMEDIATE,
  'intents.void_refusal': IMMEDIATE,
  'eip1193.request': SESSION,
  'dweb.open': SESSION,
  'dweb.verify': HEAD,
  'dweb.forget': IMMEDIATE,
  // cored-v0.29.0 (design 0015, SWM-4, D5): `window.swarm`'s backend.
  // `swarm.request` is a page's (`page` only) and `swarm.feed` main's,
  // `swarm.stamps` and `swarm.upload_status` the chrome's and main's, all
  // under the `swarm` deadline. `swarm.body` (the streamed body of one of
  // the core's `shell.swarm_api` calls) and `swarm.publish` (main's own
  // uploads) are main's, with idle bounds only, at protocol 2 only. The
  // stores' ops, `swarm.identities` and `swarm.history` (the chrome's and
  // main's) and `swarm.manifest` (main's), are answered at once. Main sends
  // none of them yet (SWM-5 to SWM-8).
  'swarm.request': SWARM,
  'swarm.body': IDLE,
  'swarm.publish': IDLE,
  'swarm.feed': SWARM,
  'swarm.stamps': SWARM,
  'swarm.upload_status': SWARM,
  'swarm.identities': IMMEDIATE,
  'swarm.history': IMMEDIATE,
  'swarm.manifest': IMMEDIATE,
  'chain.configure': IMMEDIATE,
  'chain.availability': IMMEDIATE,
  'chain.request': SESSION,
  'chain.fee_quote': SESSION,
  'chain.fee_reference': SESSION,
  'chain.broadcast': SESSION,
  'chain.html': SESSION,
});

/** The methods the core serves only at protocol 2, the rows its file marks
 * `"protocol": 2` (design 0009, amendment 3; design 0015, D5), in the
 * table's order. */
const PROTOCOL_2_METHODS = Object.freeze([
  'dweb.verify',
  'dweb.forget',
  'swarm.body',
  'swarm.publish',
]);

/** `longest`, or the caller's own `deadline_ms` where it is shorter. */
function ownDeadline(deadlineMs, longest) {
  const own = Number.isSafeInteger(deadlineMs) && deadlineMs >= 0;
  return own ? Math.min(deadlineMs, longest) : longest;
}

/**
 * A request's hang watchdog, in ms, or null for none (an idle method's). A
 * method the core doesn't serve is refused at once (`unknown_method`), so
 * it gets an immediate one.
 * @param {string} method
 * @param {number} [deadlineMs] - a session or Swarm request's own
 *   `deadline_ms`
 * @returns {number|null}
 */
function watchdogMs(method, deadlineMs) {
  switch (METHOD_CLASSES[method]) {
    case VAULT:
      return VAULT_DEADLINE_MS + WATCHDOG_MARGIN_MS;
    case SESSION:
      return ownDeadline(deadlineMs, SESSION_DEADLINE_MS) + WATCHDOG_MARGIN_MS;
    case HEAD:
      return HEAD_DEADLINE_MS + WATCHDOG_MARGIN_MS;
    case SWARM:
      return ownDeadline(deadlineMs, SWARM_DEADLINE_MS) + WATCHDOG_MARGIN_MS;
    case IDLE:
      return null;
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
  SWARM_DEADLINE_MS,
  METHOD_CLASSES,
  PROTOCOL_2_METHODS,
  watchdogMs,
};
