/**
 * "Open without gateway" offers for ENS/Swarm gateway URLs (#70).
 *
 * A page served through a public gateway (`vitalik.eth.limo`,
 * `vitalik.eth.link`, `vitalik.bzz.link`, `<swarm-cid>.bzz.link`) is an
 * ordinary https site to Freedom, and that is what the address bar keeps
 * showing: the gateway URL is never rewritten behind the user's back. What
 * this module works out is whether there is a native version to *offer*:
 * the `ipfs://` / `ipns://` / `bzz://` address the gateway is standing in
 * for, which the address bar's "Open without gateway" pill then proposes.
 *
 * The gateway shapes and what they stand for:
 *
 *   <name>.eth.limo, <name>.eth.link   ENS name `<name>.eth`. The native
 *                                       transport is whatever its contenthash
 *                                       says (ipfs, ipns or bzz), so it needs
 *                                       an ENS lookup; no contenthash, no
 *                                       offer.
 *   <name>.bzz.link                    ENS name `<name>.eth` — the Swarm
 *                                       gateway appends `.eth` itself (see
 *                                       ethersphere/gateway-proxy,
 *                                       src/bzz-link.ts), so the host carries
 *                                       none. Offered as `bzz://<name>.eth`
 *                                       only when the contenthash really is
 *                                       Swarm content: a typed `bzz://` is a
 *                                       transport assertion the navigation
 *                                       layer enforces, and offering one that
 *                                       is bound to fail would be a dead end.
 *   <cid>.bzz.link                     A Swarm reference as a CID (base32,
 *                                       `bah5…`, manifest or feed codec): a
 *                                       64-hex reference does not fit a 63-
 *                                       character DNS label, so the gateway
 *                                       takes the CID instead. The destination
 *                                       is in the hostname already, so no
 *                                       lookup: `bzz://<hex reference>`.
 *
 * Path, query and fragment carry over to the destination unchanged. Anything
 * else — another host, an invalid CID, a name with no (or the wrong kind of)
 * contenthash, a failed lookup — yields no offer at all, so the user simply
 * keeps the gateway page they asked for.
 *
 * Parsing lives here rather than in the renderer because the CID form is
 * decoded with bee-js's `Reference`, which only the main process can load.
 */
const { domainToUnicode } = require('url');
const { Reference } = require('@ethersphere/bee-js');
const log = require('./logger');
const IPC = require('../shared/ipc-channels');
const { runWithPrivateLogContext, redactForLog } = require('./private/private-log-context');

// Gateway suffix → how its subdomain maps onto a native address.
//   ens:   the subdomain is the whole ENS name (`vitalik.eth`).
//   bzz:   the subdomain is either a Swarm CID or an ENS name without its
//          `.eth`, which the gateway appends.
const GATEWAYS = [
  { suffix: '.eth.limo', gateway: 'eth.limo', kind: 'ens', nameSuffix: '.eth' },
  { suffix: '.eth.link', gateway: 'eth.link', kind: 'ens', nameSuffix: '.eth' },
  { suffix: '.bzz.link', gateway: 'bzz.link', kind: 'bzz' },
];

// A CID label: multibase `b` (base32 lower), then the `ah5` the CIDv1 +
// Swarm codec header always encodes to. The shape test only routes the label
// to the decoder; `decodeSwarmCid` is what decides it is real.
const SWARM_CID_LABEL = /^bah5[a-z2-7]+$/;

// Transports a native destination can use. ENS contenthashes of any other
// kind (http, onion, …) have no `<protocol>://<name>` form here to offer.
const NATIVE_PROTOCOLS = new Set(['ipfs', 'ipns', 'bzz']);

/**
 * Decode a `bah5…` Swarm CID label to its 64-hex reference, or null.
 *
 * bee-js's `Reference` decodes any `bah5` string it is given, but it does
 * not check the CID header and silently accepts a truncated or overlong one
 * (a label one character short decodes to a different, wrong reference). So
 * the decoded reference must encode back to exactly this label as a manifest
 * or a feed CID — the two codecs the Swarm gateway takes — which rejects a
 * wrong version, codec, multihash, length or trailing garbage in one check.
 *
 * @param {string} label - lower-case DNS label
 * @returns {string|null} 64-hex reference
 */
const decodeSwarmCid = (label) => {
  if (typeof label !== 'string' || !SWARM_CID_LABEL.test(label)) return null;
  let reference;
  try {
    reference = new Reference(label);
  } catch {
    return null;
  }
  if (reference.length !== Reference.LENGTH) return null;
  if (reference.toCid('manifest') !== label && reference.toCid('feed') !== label) return null;
  return reference.toHex();
};

// An ENS name taken from a hostname: every label a real DNS label (1–63
// characters — the URL parser takes longer ones, DNS never resolves them, so
// no gateway can be serving one), punycode turned back into the Unicode the
// name was registered with (Chromium hands us the ASCII form; namehashing
// that would look up a different name).
const MAX_DNS_LABEL = 63;
const nameFromHostLabels = (labels) => {
  if (!labels) return null;
  if (labels.split('.').some((label) => label.length === 0 || label.length > MAX_DNS_LABEL)) {
    return null;
  }
  const unicode = domainToUnicode(labels);
  return unicode ? unicode.toLowerCase() : null;
};

/**
 * Classify a URL as a gateway shape. Pure: no lookup.
 *
 * @param {string} url
 * @returns {null | {
 *   gateway: string,
 *   host: string,
 *   suffix: string,
 *   ensName?: string,
 *   requireProtocol?: string,
 *   reference?: string,
 * }}
 *   `ensName` when an ENS lookup decides the destination (`requireProtocol`
 *   set when only one transport fits, as for `<name>.bzz.link`), or
 *   `reference` when the host itself names the Swarm content.
 */
const parseGatewayUrl = (url) => {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // A gateway on a non-default port is not one of these public gateways.
  if (parsed.port) return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');

  for (const entry of GATEWAYS) {
    if (!host.endsWith(entry.suffix)) continue;
    const sub = host.slice(0, -entry.suffix.length);
    if (!sub) return null;

    if (entry.kind === 'ens') {
      const base = nameFromHostLabels(sub);
      if (!base) return null;
      return {
        gateway: entry.gateway,
        host,
        suffix: entry.suffix,
        ensName: base + entry.nameSuffix,
      };
    }

    // bzz.link: a single `bah5…` label is a CID and nothing else — an invalid
    // one is no offer, never an ENS name `bah5….eth`.
    if (SWARM_CID_LABEL.test(sub)) {
      const reference = decodeSwarmCid(sub);
      if (!reference) return null;
      return { gateway: entry.gateway, host, suffix: entry.suffix, reference };
    }
    const base = nameFromHostLabels(sub);
    if (!base) return null;
    return {
      gateway: entry.gateway,
      host,
      suffix: entry.suffix,
      ensName: `${base}.eth`,
      requireProtocol: 'bzz',
    };
  }
  return null;
};

/**
 * The native address for `url` on `protocol://host`, keeping the path,
 * query and fragment exactly as the gateway URL had them.
 */
const buildNativeUrl = (protocol, host, url) => {
  const parsed = new URL(url);
  return `${protocol}://${host}${parsed.pathname || '/'}${parsed.search}${parsed.hash}`;
};

/**
 * Work out the offer for a gateway URL, or null when there is none.
 *
 * @param {string} url
 * @param {{ resolveContent: (name: string) => Promise<object> }} deps
 *   `resolveContent` is the ENS contenthash lookup (`resolveEnsContent` in
 *   production, the fixture map under the e2e harness).
 * @returns {Promise<null | {
 *   gateway: string, gatewayHost: string, protocol: string,
 *   destination: string, target: string,
 * }>}
 *   `target` is the native origin without path (`ipfs://vitalik.eth`), for
 *   labels; `destination` is the full URL the open navigates to.
 */
const resolveGatewayOffer = async (url, { resolveContent } = {}) => {
  const shape = parseGatewayUrl(url);
  if (!shape) return null;

  if (shape.reference) {
    return {
      gateway: shape.gateway,
      gatewayHost: shape.host,
      protocol: 'bzz',
      target: `bzz://${shape.reference}`,
      destination: buildNativeUrl('bzz', shape.reference, url),
    };
  }

  if (typeof resolveContent !== 'function') return null;
  let result;
  try {
    result = await resolveContent(shape.ensName);
  } catch (err) {
    log.info(`[gateway-offer] lookup failed for ${redactForLog(shape.ensName)}: ${err?.message}`);
    return null;
  }
  // Only a settled answer is offered: not_found / error / unsupported have no
  // destination, and a conflict would open straight onto the conflict page.
  if (result?.type !== 'ok') return null;
  const protocol = result.protocol;
  if (!NATIVE_PROTOCOLS.has(protocol)) return null;
  if (shape.requireProtocol && protocol !== shape.requireProtocol) return null;
  return {
    gateway: shape.gateway,
    gatewayHost: shape.host,
    protocol,
    target: `${protocol}://${shape.ensName}`,
    destination: buildNativeUrl(protocol, shape.ensName, url),
  };
};

/**
 * The `gateway:offer` IPC handler. A factory so the e2e harness can serve the
 * same logic from its ENS fixtures instead of the network.
 *
 * @param {{ resolveContent: Function, isPrivateSender?: Function }} deps
 */
const makeGatewayOfferHandler =
  ({ resolveContent, isPrivateSender = () => false }) =>
  async (event, payload = {}) => {
    const url = typeof payload?.url === 'string' ? payload.url : '';
    // PRIVATE MODE GUARD (name logging): the gateway URL is the tab's
    // browsing history, and the lookup it triggers logs the name — redact
    // them for a private window exactly as `ens:resolve` does.
    return runWithPrivateLogContext(isPrivateSender(event?.sender), async () => {
      try {
        return await resolveGatewayOffer(url, { resolveContent });
      } catch (err) {
        log.warn(`[gateway-offer] failed for ${redactForLog(url)}: ${err?.message}`);
        return null;
      }
    });
  };

function registerGatewayOfferIpc() {
  // Lazy: ens-resolver pulls in the whole resolution stack, which the pure
  // helpers above (and their unit tests) do not need.
  const { ipcMain } = require('electron');
  const { resolveEnsContent } = require('./ens-resolver');
  const { isPrivateWebContents } = require('./private/private-windows');
  ipcMain.handle(
    IPC.GATEWAY_OFFER,
    makeGatewayOfferHandler({
      resolveContent: resolveEnsContent,
      isPrivateSender: isPrivateWebContents,
    })
  );
}

module.exports = {
  parseGatewayUrl,
  decodeSwarmCid,
  buildNativeUrl,
  resolveGatewayOffer,
  makeGatewayOfferHandler,
  registerGatewayOfferIpc,
};
