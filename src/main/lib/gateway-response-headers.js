/**
 * Response headers a proxied content gateway must never set on a dweb page
 * (docs/security-audit-electron.md, O-12; #439).
 *
 * The bzz: and ipfs:/ipns: handlers stream an upstream gateway's response to
 * the page under the `bzz://` / `ipfs://` origin. When that gateway is a
 * user-configured external Ant or IPFS node — possibly remote, possibly
 * shared — its headers are not content: `Set-Cookie` would plant cookies in
 * the content's origin, and `Service-Worker-Allowed` would let a service
 * worker claim a wider scope than its script path. Content served by Swarm or
 * IPFS has no business setting either, so they are dropped whichever node
 * answered.
 */
const PAGE_STATE_RESPONSE_HEADERS = ['set-cookie', 'set-cookie2', 'service-worker-allowed'];

function stripPageStateHeaders(headers) {
  for (const name of PAGE_STATE_RESPONSE_HEADERS) headers.delete(name);
  return headers;
}

module.exports = { PAGE_STATE_RESPONSE_HEADERS, stripPageStateHeaders };
