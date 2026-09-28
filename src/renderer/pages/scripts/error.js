// Nodes menu icon (same as toolbar)
const NODES_ICON =
  '<svg class="nodes-icon" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><style>.net-line{stroke:currentColor;stroke-width:8;stroke-linecap:round}.net-node{fill:none;stroke:currentColor;stroke-width:8}</style><line x1="44.5" y1="33.5" x2="25.5" y2="66.5" class="net-line"/><line x1="55.5" y1="33.5" x2="74.5" y2="66.5" class="net-line"/><line x1="31" y1="76" x2="69" y2="76" class="net-line"/><circle cx="50" cy="24" r="11" class="net-node"/><circle cx="20" cy="76" r="11" class="net-node"/><circle cx="80" cy="76" r="11" class="net-node"/></svg>';

// Detect protocol type from URL. Accepts both the internal gateway URL
// form (…/bzz/<hash>…) and the user-facing display URL form (bzz://…).
function detectProtocol(url) {
  if (!url) return null;
  if (url.match(/^bzz:\/\//i) || url.match(/\/bzz\//i)) return 'swarm';
  if (url.match(/^ipfs:\/\//i) || url.match(/\/ipfs\//i)) return 'ipfs';
  if (url.match(/^ipns:\/\//i) || url.match(/\/ipns\//i)) return 'ipns';
  return null;
}

// Convert gateway URL to protocol URL format
function toProtocolUrl(url) {
  if (!url) return null;

  // Swarm: /bzz/hash -> bzz://hash
  const bzzMatch = url.match(/\/bzz\/([a-fA-F0-9]{64,128})(\/.*)?/);
  if (bzzMatch) {
    return 'bzz://' + bzzMatch[1] + (bzzMatch[2] || '');
  }

  // IPFS: /ipfs/CID -> ipfs://CID
  const ipfsMatch = url.match(/\/ipfs\/([a-zA-Z0-9]+)(\/.*)?/);
  if (ipfsMatch) {
    return 'ipfs://' + ipfsMatch[1] + (ipfsMatch[2] || '');
  }

  // IPNS: /ipns/name -> ipns://name
  const ipnsMatch = url.match(/\/ipns\/([a-zA-Z0-9.-]+)(\/.*)?/);
  if (ipnsMatch) {
    return 'ipns://' + ipnsMatch[1] + (ipnsMatch[2] || '');
  }

  return url;
}

const params = new URLSearchParams(window.location.search);
const error = params.get('error');
const url = params.get('url');
const explicitProtocol = params.get('protocol');
// `retry` is an optional param carrying a URL that Chromium can
// actually navigate to (bzz://, http(s)://, …). Needed when `url` is
// a user-facing scheme like ens:// that isn't registered as a
// navigable protocol.
//
// We accept only an allowlist of schemes here. Both `retry` and `url`
// come straight from the query string, so a `javascript:` value would
// be evaluated by `window.location.href = ...`. Cross-origin navs to
// `file://` are blocked by Chromium so the practical surface is
// limited, but allowlisting keeps paste / bookmark social-engineering
// off the table.
const ALLOWED_RETRY_SCHEMES = ['bzz:', 'ens:', 'ipfs:', 'ipns:', 'rad:', 'http:', 'https:'];
const sanitizeRetryUrl = (candidate) => {
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate, window.location.href);
    return ALLOWED_RETRY_SCHEMES.includes(parsed.protocol) ? candidate : null;
  } catch {
    return null;
  }
};
const retryUrl = sanitizeRetryUrl(params.get('retry')) || sanitizeRetryUrl(url);
const protocolUrl = toProtocolUrl(url);
const protocol = explicitProtocol || detectProtocol(url);

const detailsEl = document.getElementById('details');
const descriptionEl = document.getElementById('description');
const titleEl = document.getElementById('title');

// Headline and document title move together: the tab, the window title
// and the history entry all read `document.title`, and a stale one is
// exactly the bug in #236. The static <title> above covers the case
// where this script never runs (CSP failure, parse error).
function setErrorTitle(text) {
  titleEl.textContent = text;
  document.title = text;
}

// This page runs in a tab <webview>, so the chrome's
// `window.serviceRegistry` is not here; internal pages get the same
// read-only snapshot through `freedomAPI.getServiceRegistry`. `null`
// means "unknown" — the caller then keeps the generic copy rather than
// claiming a node is down.
async function getRegistry() {
  try {
    return (await window.freedomAPI?.getServiceRegistry?.()) || null;
  } catch {
    return null;
  }
}

// The registry is the source of truth: ant-manager publishes `ant.api`
// only once the node is healthy (bundled), adopted (reused) or
// connected (external), and clears it when the node stops. A node that
// stops answering afterwards keeps `api` published (the health check
// recovers in place) but raises `errorState`, so that counts as not
// running too. The page
// no longer fetches the node's /health itself — web content (this page
// included, since the node config dropped its CORS origins) cannot
// read the Ant API (#428).
async function checkSwarmStatus() {
  const registry = await getRegistry();
  if (!registry) return { running: true };
  const ant = registry.ant || {};
  return { running: Boolean(ant.api) && !ant.errorState };
}

async function checkIpfsStatus() {
  const registry = await getRegistry();
  if (!registry) return { running: true };
  const ipfs = registry.ipfs || {};
  // External mode publishes `gateway` only once the gateway serves; a
  // gateway (or bundled node) that stops answering raises `errorState`.
  return {
    running: (ipfs.mode === 'bundled' || Boolean(ipfs.gateway)) && !ipfs.errorState,
  };
}

// Format a host for display in the generic title (truncate very long
// ad-tech / tracking hosts).
function hostFor(rawUrl) {
  try {
    const parsed = new URL(rawUrl, window.location.href);
    return parsed.host || null;
  } catch {
    return null;
  }
}

async function displayError() {
  const parts = [];
  if (protocolUrl) parts.push(protocolUrl);

  // Generic copy for non-dweb URLs (http/https, file:, anything we
  // don't recognize as a content-addressed scheme). The default
  // "Content unavailable / decentralized network" copy is misleading
  // when a plain HTTPS request fails — it implies the user is on a
  // peer-to-peer page when they aren't.
  if (!protocol) {
    const host = hostFor(url);
    setErrorTitle("Couldn't load this page");
    descriptionEl.textContent = host
      ? `${host} didn't respond, or the response was blocked. Check the URL and try again.`
      : "The server didn't respond, or the response was blocked. Check the URL and try again.";
  }

  if (error === 'swarm_content_not_found') {
    // The Bee HTTP API is reachable, but the requested content didn't
    // resolve within the probe timeout. Typically means the node is
    // still connecting to enough peers to locate the manifest.
    setErrorTitle('Content not ready yet');
    descriptionEl.innerHTML =
      "Couldn't find this content on the Swarm network yet. The node is " +
      'still connecting to peers &mdash; try again in a moment.';
    if (protocolUrl) {
      parts.push('');
      parts.push('Swarm content not found (timeout)');
    }
  } else if (error && error.includes('ERR_CONNECTION_REFUSED')) {
    if (protocol === 'swarm') {
      const status = await checkSwarmStatus();
      if (!status.running) {
        descriptionEl.innerHTML = `The Swarm node is not running. Open the Nodes menu ${NODES_ICON} in the toolbar to start it.`;
      }
    } else if (protocol === 'ipfs' || protocol === 'ipns') {
      const status = await checkIpfsStatus();
      if (!status.running) {
        descriptionEl.innerHTML = `The IPFS node is not running. Open the Nodes menu ${NODES_ICON} in the toolbar to start it.`;
      }
    }
    parts.push('');
    parts.push(error);
  } else if (error) {
    parts.push('');
    parts.push(error);
  }

  detailsEl.textContent = parts.join('\n') || 'Unknown error';
}

displayError();

// Retry the original URL
document.getElementById('retry-btn').onclick = () => {
  if (retryUrl) {
    window.location.href = retryUrl;
  } else {
    window.location.reload();
  }
};
