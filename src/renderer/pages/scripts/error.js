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
// Why a Swarm probe failed (swarm-probe.js outcome); absent on older links.
const swarmReason = params.get('reason');
const swarmStatus = params.get('status');
const swarmPeers = params.get('peers') === null ? null : Number(params.get('peers'));
// Set by the chrome only when this failure follows straight on from an
// error page for the same URL. Without it the content loaded in between (or
// this is a fresh visit), so an old count must not carry over.
const continuesRetryStreak = params.get('streak') === '1';

const detailsEl = document.getElementById('details');
const descriptionEl = document.getElementById('description');
const titleEl = document.getElementById('title');
const autoRetryEl = document.getElementById('auto-retry');
const autoRetryStopBtn = document.getElementById('auto-retry-stop');

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

// Below this many connected peers a node is still warming up, so a miss
// says more about the node than about the content.
const LOW_PEER_COUNT = 10;

function describeLastAnswer(status) {
  if (status === 'no_response') return 'no answer within 30 seconds';
  return status ? `HTTP ${status}` : 'none';
}

function describeSwarmFailure() {
  switch (swarmReason) {
    case 'path_not_found':
      return {
        title: 'Page not found',
        description:
          'This Swarm site exists, but it has no page at this path. Check the address for a typo.',
        detail: "HTTP 404: the path isn't in the site's manifest",
        recoverable: false,
      };
    case 'invalid_hash':
      return {
        title: 'Not a valid Swarm address',
        description: 'A Swarm reference is 64 or 128 hexadecimal characters.',
        detail: 'Invalid Swarm reference',
        recoverable: false,
      };
    case 'other':
      return {
        title: "Couldn't load this content",
        description: `The Swarm node refused the request (HTTP ${swarmStatus || 'error'}).`,
        detail: `HTTP ${swarmStatus || 'error'} from the Swarm node`,
        recoverable: false,
      };
    case 'probe_failed':
      return {
        title: "Couldn't check this content",
        description: "Freedom couldn't ask the Swarm node for this content.",
        detail: 'Content check failed',
        recoverable: true,
      };
    default: {
      // 'not_found': the probe's 5-minute budget ran out.
      const fewPeers = Number.isFinite(swarmPeers) && swarmPeers < LOW_PEER_COUNT;
      const peerNote = Number.isFinite(swarmPeers)
        ? `, ${swarmPeers} peer${swarmPeers === 1 ? '' : 's'} connected`
        : '';
      return {
        title: 'Content not found yet',
        description: fewPeers
          ? `Your Swarm node is connected to only ${swarmPeers} peer${swarmPeers === 1 ? '' : 's'}, too few to find this content. It keeps connecting in the background.`
          : "Your Swarm node couldn't find this content on the network. It may not have spread through the network yet, or it may no longer be stored.",
        detail: swarmReason
          ? `Not found within 5 minutes (last answer: ${describeLastAnswer(swarmStatus)}${peerNote})`
          : 'Not found',
        recoverable: true,
      };
    }
  }
}

// Recoverable failures retry on their own: content can still spread to
// the network and a node can still gain peers. Each retry runs a fresh
// probe (up to 5 minutes), so the waits between them stay short; the
// count lives in sessionStorage because every retry lands on a new copy
// of this page. A manual "Try Again", or a load that reached the content in
// between (no `streak` param), starts the count over.
const AUTO_RETRY_DELAYS_S = [30, 60, 120, 300, 300, 300];
// A count older than this belongs to an earlier visit, not this streak.
const AUTO_RETRY_STREAK_MS = 30 * 60_000;
const autoRetryKey = `freedom:auto-retry:${retryUrl || url || ''}`;
let autoRetryTimer = null;

function readAutoRetryCount() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(autoRetryKey) || 'null');
    if (!saved || Date.now() - saved.at > AUTO_RETRY_STREAK_MS) return 0;
    return saved.count;
  } catch {
    return 0;
  }
}

function writeAutoRetryCount(count) {
  try {
    if (count === 0) sessionStorage.removeItem(autoRetryKey);
    else sessionStorage.setItem(autoRetryKey, JSON.stringify({ count, at: Date.now() }));
  } catch {
    // Storage unavailable: retries still happen, just without the cap.
  }
}

function stopAutoRetry(message) {
  clearInterval(autoRetryTimer);
  autoRetryTimer = null;
  autoRetryStopBtn.hidden = true;
  autoRetryEl.textContent = message;
}

// Back/Forward onto this page is the user reading history, not a fresh
// failure: a countdown started then would retry unasked, and its retry
// (replayed by the chrome as a new navigation) drops the forward entry the
// user came back from. So no countdown on a history traversal; Try Again
// still retries.
const RETRY_PAUSED_TEXT = 'Not trying again automatically. Use Try Again to retry.';

function reachedByHistoryTraversal() {
  try {
    return performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
  } catch {
    return false;
  }
}

function scheduleAutoRetry() {
  if (!retryUrl) return;
  if (reachedByHistoryTraversal()) {
    autoRetryEl.hidden = false;
    autoRetryEl.textContent = RETRY_PAUSED_TEXT;
    return;
  }
  if (!continuesRetryStreak) writeAutoRetryCount(0);
  const count = readAutoRetryCount();
  autoRetryEl.hidden = false;
  if (count >= AUTO_RETRY_DELAYS_S.length) {
    autoRetryEl.textContent = 'Stopped trying again automatically.';
    return;
  }
  let remaining = AUTO_RETRY_DELAYS_S[count];
  const render = () => {
    autoRetryEl.textContent = `Trying again automatically in ${remaining} s.`;
  };
  render();
  autoRetryStopBtn.hidden = false;
  autoRetryTimer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      render();
      return;
    }
    stopAutoRetry('Trying again…');
    writeAutoRetryCount(count + 1);
    window.location.href = retryUrl;
  }, 1000);
}

// Addresses the address bar refused (navigation.js `showAddressError`).
// Retrying can't help, so the button goes.
const ADDRESS_ERRORS = {
  invalid_address: {
    title: 'Not a valid address',
    description: "Freedom can't open this address. Check it for typos.",
  },
  unloadable_swarm_hash: {
    title: "Can't open this address",
    description:
      'This Swarm reference is made only of digits, which the browser reads as a network ' +
      "address, so it can't be opened as a bzz:// page.",
  },
};

async function displayError() {
  const addressError = ADDRESS_ERRORS[error];
  if (addressError) {
    setErrorTitle(addressError.title);
    descriptionEl.textContent = addressError.description;
    detailsEl.textContent = url || '';
    document.getElementById('retry-btn').hidden = true;
    return;
  }

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
    // The Ant API is reachable but the probe didn't get the content. Say
    // which way it failed: the old copy blamed peers and a timeout for
    // every failure, including ones that were neither (#618).
    const failure = describeSwarmFailure();
    setErrorTitle(failure.title);
    descriptionEl.textContent = failure.description;
    parts.push('');
    parts.push(failure.detail);
    if (failure.recoverable) scheduleAutoRetry();
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
  writeAutoRetryCount(0);
  if (retryUrl) {
    window.location.href = retryUrl;
  } else {
    window.location.reload();
  }
};

autoRetryStopBtn.onclick = () => {
  stopAutoRetry('Stopped trying again automatically.');
};

// The same applies if Chromium keeps this page in its back/forward cache:
// a restored page resumes its timers, so stop the countdown on the way out
// and don't restart it on the way back.
window.addEventListener('pagehide', () => {
  if (autoRetryTimer) stopAutoRetry(RETRY_PAUSED_TEXT);
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && autoRetryTimer) stopAutoRetry(RETRY_PAUSED_TEXT);
});
