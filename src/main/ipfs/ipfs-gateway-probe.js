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

// The trustless probe (freedom-core design 0009, Modes): once a gateway has
// answered the probe above, two more requests for the same identity CID,
// which needs no retrieval, so each answers at once.
//
//   - `?format=raw` with the raw `Accept`: a 200 of type
//     `application/vnd.ipld.raw` means the gateway serves raw blocks, so what
//     it serves can be verified at all;
//   - `?format=car&dag-scope=entity` with the CAR `Accept`: a 200 of type
//     `application/vnd.ipld.car` with `order=dfs` and `dups=y` means ordered
//     CARs are worth asking for. Without it, every block is fetched raw.
//
// The probe's result is fixed for the gateway's activation (ipfs-manager.js).
const IPFS_RAW_ACCEPT = 'application/vnd.ipld.raw';
const IPFS_CAR_ACCEPT = 'application/vnd.ipld.car; version=1; order=dfs; dups=y';
const IPFS_RAW_PROBE_PATH = `${IPFS_GATEWAY_PROBE_PATH}?format=raw`;
const IPFS_CAR_PROBE_PATH = `${IPFS_GATEWAY_PROBE_PATH}?format=car&dag-scope=entity`;

// Accepts either a `fetch` Headers object or Node's plain (lower-cased)
// `res.headers` bag.
function headerReader(headers) {
  return typeof headers.get === 'function' ? (name) => headers.get(name) : (name) => headers[name];
}

function hasIpfsGatewayHeader(headers) {
  if (!headers) return false;
  const read = headerReader(headers);
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

// A `Content-Type` value as its media type and parameters, each lowercased
// (a parameter's value without its quotes), or null when it can't be read:
// not a string, a parameter without `=`, or a parameter named twice.
function parseMediaType(value) {
  if (typeof value !== 'string') return null;
  const [type, ...parts] = value.split(';');
  const params = new Map();
  for (const part of parts) {
    if (part.trim() === '') continue;
    const at = part.indexOf('=');
    if (at < 0) return null;
    const name = part.slice(0, at).trim().toLowerCase();
    let param = part.slice(at + 1).trim();
    if (param.length >= 2 && param.startsWith('"') && param.endsWith('"')) {
      param = param.slice(1, -1);
    }
    if (!name || params.has(name)) return null;
    params.set(name, param.toLowerCase());
  }
  return { type: type.trim().toLowerCase(), params };
}

function contentType(headers) {
  return headers ? parseMediaType(headerReader(headers)('content-type')) : null;
}

/** Whether a gateway's answer to `IPFS_RAW_PROBE_PATH` says it serves raw blocks. */
function isRawProbeResponse({ status, headers }) {
  return status === 200 && contentType(headers)?.type === 'application/vnd.ipld.raw';
}

/** Whether a gateway's answer to `IPFS_CAR_PROBE_PATH` says it serves
 * ordered CARs with duplicates. */
function isCarProbeResponse({ status, headers }) {
  const media = contentType(headers);
  return (
    status === 200 &&
    media?.type === 'application/vnd.ipld.car' &&
    media.params.get('order') === 'dfs' &&
    media.params.get('dups') === 'y'
  );
}

module.exports = {
  IPFS_CAR_ACCEPT,
  IPFS_CAR_PROBE_PATH,
  IPFS_GATEWAY_HEADERS,
  IPFS_GATEWAY_PROBE_CID,
  IPFS_GATEWAY_PROBE_PATH,
  IPFS_RAW_ACCEPT,
  IPFS_RAW_PROBE_PATH,
  hasIpfsGatewayHeader,
  isCarProbeResponse,
  isIpfsGatewayProbeResponse,
  isRawProbeResponse,
  parseMediaType,
};
