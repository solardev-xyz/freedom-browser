// Shared "is this actually an IPFS gateway?" test, used by the launch-time
// external-node detection (profile-external-candidates.js) and by the external
// mode health probe (ipfs-manager.js) so both agree on what counts as a
// gateway.
//
// A bare HTTP 200 is not enough: :8080 is the most common local dev-server
// port, and Vite/webpack-dev-server/CRA answer any path with 200 + index.html.
// Accepting that would offer to route every `ipfs://` load through a server
// that has never heard of IPFS. A response qualifies only when it carries an
// IPFS-specific signal:
//
//   - `X-Ipfs-Path` / `X-Ipfs-Roots`, which gateways set on every response, or
//   - an exactly-empty 200 body for the identity CID `bafkqaaa` (the empty
//     file), which any gateway resolves locally without network access.
//
// Redirects are never a pass: the probe does not follow them (see the
// `redirect: 'manual'` callers), so a 3xx is treated as "not a gateway here".
const IPFS_GATEWAY_PROBE_CID = 'bafkqaaa';
const IPFS_GATEWAY_PROBE_PATH = `/ipfs/${IPFS_GATEWAY_PROBE_CID}`;
const IPFS_GATEWAY_HEADERS = ['x-ipfs-path', 'x-ipfs-roots'];

// Accepts either a `fetch` Headers object or Node's plain (lower-cased)
// `res.headers` bag.
function hasIpfsGatewayHeader(headers) {
  if (!headers) return false;
  const read =
    typeof headers.get === 'function' ? (name) => headers.get(name) : (name) => headers[name];
  return IPFS_GATEWAY_HEADERS.some((name) => {
    const value = read(name);
    return typeof value === 'string' && value.trim() !== '';
  });
}

function isIpfsGatewayProbeResponse({ status, headers, bodyBytes }) {
  if (status !== 200) return false;
  if (hasIpfsGatewayHeader(headers)) return true;
  return bodyBytes === 0;
}

module.exports = {
  IPFS_GATEWAY_HEADERS,
  IPFS_GATEWAY_PROBE_CID,
  IPFS_GATEWAY_PROBE_PATH,
  hasIpfsGatewayHeader,
  isIpfsGatewayProbeResponse,
};
