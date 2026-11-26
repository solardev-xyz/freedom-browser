/**
 * One call of main's Swarm executor to the node's HTTP API, on the node's
 * transport (freedom-core design 0015, The transport and Main's Swarm I/O
 * pool; the SWM-5 plan's point 6). The executor (`core/swarm-shell.js`)
 * admits a call by the grammar and reserves its room before it calls this,
 * with the backend its parent captured (`antBackend()`, `bzz-protocol.js`):
 * loopback undici for the bundled node, the session's stack for a remote
 * one, announced to the Ant API guard with its one method.
 *
 * - **One dial per admitted call:** the backend's `request()`, once. No
 *   retry, whatever the status or the failure: the core decides what comes
 *   next, and a POST is never sent twice.
 * - **No header deadline:** a call ends at its request's deadline or cancel
 *   (`signal`), which the core and main's idle watchdog bound.
 * - **60 s idle on a body:** a read that waits 60 s with no byte fails the
 *   body with `BodyIdleError` (`dweb/plan-executor.js`). A whole body is
 *   read at once, so it fails after 60 s without a byte (`error`); a
 *   streamed one is read only as the core's credit allows, so its clock runs
 *   only with credit outstanding (0009's idle bound, abort code `stalled`).
 * - **`content-length` dropped beside a `content-encoding`:** main asks with
 *   `accept-encoding: identity`, but a node may encode anyway; both stacks
 *   then decode the body and still report the encoded length, which says
 *   nothing of the decoded bytes. So it goes, and the body is read as one
 *   without a length.
 * - **Cancel:** `signal` aborts the dial, and fails the body at once, read
 *   or not.
 *
 * Nothing here logs: a path names what a page asked for.
 */

const { idleBoundBody } = require('../dweb/plan-executor');

/** A body's idle bound (design 0015, Reading a body; 0009's for a stream). */
const ANT_BODY_IDLE_MS = 60_000;

/**
 * Dials one admitted call.
 *
 * @param {{ request: Function }} backend - the backend the call's parent
 *   captured (`antBackend()`)
 * @param {object} call
 * @param {string} call.path - the form's path and query, from the node's root
 * @param {string} call.method - GET or POST
 * @param {Headers} call.headers - exactly the form's, and main's own
 * @param {Uint8Array|ReadableStream|null} [call.body] - a POST's body: whole
 *   bytes, or a stream pulled only as the node takes it
 * @param {AbortSignal} call.signal - the call's cancel, and its request's end
 * @param {(err?: Error) => void} [call.onEnd] - once the reply's body is
 *   over: its end, its failure (the idle bound, the node, the cancel) or its
 *   cancel; never for a reply without one
 * @param {number} [call.idleMs] - a test seam for the idle bound
 * @returns {Promise<{ status: number, statusText: string, headers: Headers,
 *   body: ReadableStream|null }>} the node's answer; rejects with the
 *   transport's failure (its `code` or `cause.code` names an unreachable
 *   node) or an abort
 */
async function callAnt(
  backend,
  { path, method, headers, body = null, signal, onEnd = () => {}, idleMs = ANT_BODY_IDLE_MS }
) {
  const response = await backend.request({
    path,
    method,
    headers,
    body,
    signal,
    headersTimeoutMs: null,
  });
  const replyHeaders = new Headers(response.headers);
  if (replyHeaders.has('content-encoding')) replyHeaders.delete('content-length');
  const upstream = response.body && !response.bodyUsed ? response.body : null;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: replyHeaders,
    body: upstream && idleBoundBody(upstream, idleMs, signal, onEnd),
  };
}

module.exports = { callAnt, ANT_BODY_IDLE_MS };
