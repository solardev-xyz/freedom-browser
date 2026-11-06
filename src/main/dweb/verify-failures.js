/**
 * Verification failures, counted per backend for the nodes panel
 * (freedom-core design 0009, Failures; decision 3). The panel says "Your
 * external node served content that failed verification" while any failed
 * in the last 10 minutes. The notice informs: nothing here switches a
 * backend, refuses one or changes a request. A node that fails stays in use,
 * and only its failing requests fail.
 *
 * - **What counts:** content the external node served that failed its
 *   check, as the core reports it for a `{ verify }` plan
 *   (`verify-executor.js`):
 *   - before the head, `dweb.verify`'s error plan with the 502 and the fixed
 *     text of the plan's node, "Swarm content verification failed" or "IPFS
 *     content verification failed" (an IPNS record whose key or signature
 *     fails libp2p's rules among them);
 *   - after the head, the core's `abort` with `verification_failed`, a body
 *     main's small-text sniff was still reading included.
 * - **What doesn't:** nothing else is the node's content failing its check.
 *   `unverifiable` (content the core can't check), the memory limit (the
 *   core's limit, "not the node's or the content's", whose own text, and
 *   `unverifiable` after the head, keep it apart), `malformed` (content that
 *   passes its hashes), `piece_failed` and a dial that failed (the node
 *   unreachable or stopping), a node's 404 or other status, `busy`,
 *   `cancelled`, the deadline's 504, strict mode's 403, the 414 and 431, a
 *   refused plan or answer (the core's fault), and the core being
 *   unavailable. A fetch plan is never counted, so against a core without
 *   the verifier (protocol 1) nothing is.
 * - **Per backend:** a record per external Ant (a reused one included) or
 *   external IPFS gateway, by the endpoint the failing request captured.
 *   The panel reads only the record of the endpoint serving now, so a
 *   request that was captured before a switch to another node and fails
 *   after it is never shown against the new node, and doesn't touch its
 *   record either.
 * - **The window:** 10 minutes from the last failure, on the monotonic
 *   clock. A record past it is dropped when it is next read, or at the
 *   next failure of any backend, and its node's next failure starts the
 *   count again at 1.
 * - **What a record keeps:** the backend's kind and endpoint, a count and the
 *   last failure's time. Never a page's URL, a reference or a path, and
 *   nothing that tells a private window's request from another's: a private
 *   window's failure counts as any other, since the notice is about the
 *   node. The panel is told only the count.
 * - **Profiles:** each profile runs in its own process, so its count is its
 *   own, and none survives a quit.
 */

const { backendKind } = require('./plan-validation');

/** The window after the last failure while the panel shows the notice. */
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** The core's fixed texts for a failed check before the head, by the plan's
 * node (fc-dweb's `SWARM_VERIFICATION_FAILED`, `IPFS_VERIFICATION_FAILED`). */
const VERIFICATION_FAILED = Object.freeze({
  ant: 'Swarm content verification failed',
  ipfs: 'IPFS content verification failed',
});
/** Their status (0009, Failures). */
const VERIFICATION_FAILED_STATUS = 502;
/** The core's abort code for a failed check after the head. */
const VERIFICATION_FAILED_CODE = 'verification_failed';

/** The backends with a record: an external Ant and an external gateway. */
const KINDS = new Set(['ant', 'gateway']);

/** `${kind} ${endpoint}` -> { count, last } */
const records = new Map();

const now = () => performance.now();
const keyOf = (kind, endpoint) => `${kind} ${endpoint}`;
const expired = (record) => now() - record.last >= FAILURE_WINDOW_MS;

/** Whether `error`, `dweb.verify`'s error plan for a plan on `node`, is
 * the node's content failing its check. */
function isVerificationFailure(node, error) {
  return (
    Object.hasOwn(VERIFICATION_FAILED, node) &&
    error?.status === VERIFICATION_FAILED_STATUS &&
    error.message === VERIFICATION_FAILED[node]
  );
}

/**
 * Counts one verification failure against the backend the request
 * captured. Anything but a verifying Ant or gateway (`verify: true` in its
 * reference, so an external one) with an endpoint is ignored.
 *
 * @param {{ref: object, url: string|null}} backend
 */
function noteVerificationFailure(backend) {
  const kind = backendKind(backend?.ref);
  const endpoint = typeof backend?.url === 'string' && backend.url ? backend.url : null;
  if (!KINDS.has(kind) || backend.ref.verify !== true || !endpoint) return;
  for (const [key, record] of records) {
    if (expired(record)) records.delete(key);
  }
  const key = keyOf(kind, endpoint);
  const record = records.get(key);
  if (record) {
    record.count += 1;
    record.last = now();
  } else {
    records.set(key, { count: 1, last: now() });
  }
}

/**
 * The failures of the backend `kind` serving at `endpoint` now: how many
 * since its notice came up, or 0 when none failed in the last 10 minutes.
 * 0 for no endpoint (no external node serving).
 *
 * @param {'ant'|'gateway'} kind
 * @param {string|null} endpoint
 * @returns {number}
 */
function verificationFailures(kind, endpoint) {
  if (!KINDS.has(kind) || !endpoint) return 0;
  const key = keyOf(kind, endpoint);
  const record = records.get(key);
  if (!record) return 0;
  if (expired(record)) {
    records.delete(key);
    return 0;
  }
  return record.count;
}

function _resetVerificationFailures() {
  records.clear();
}

module.exports = {
  noteVerificationFailure,
  verificationFailures,
  isVerificationFailure,
  FAILURE_WINDOW_MS,
  VERIFICATION_FAILED,
  VERIFICATION_FAILED_CODE,
  _resetVerificationFailures,
};
