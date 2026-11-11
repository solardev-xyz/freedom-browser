'use strict';

/**
 * Page documents and the attested requester (freedom-core design 0011, "The
 * attested requester" and "Documents"; step PRQ-1).
 *
 * Main decides who asked from Chromium's own record of the sending frame,
 * never from a string a renderer sends. For each tab guest it numbers every
 * committed main-frame document, and binds the random nonce the document's
 * preload sends with its first message (`hello`). A request is then
 * attested (`attest`) in the design's order, refused at the first step that
 * fails:
 *
 *   1. a tab: a live `webview` whose host is a chrome window (`not-a-tab`);
 *   2. not in a private window (`private`);
 *   3. not a `freedom-preview:` commit (`preview`);
 *   4. the top frame: `senderFrame` present, not detached (`detached`), and
 *      the guest's main frame (`sub-frame`);
 *   5. the current document: one committed (`no-document`), its hello
 *      received (`no-hello`), and the request's nonce its own (`navigated`
 *      for an earlier document's nonce, `wrong-nonce` for any other);
 *   6. the transport key: `senderFrame.url`'s key, with no name binding,
 *      equals the document's `transportKey` (`off-key`).
 *
 * The permission key the request acts under is the document's `key`, which
 * differs from `transportKey` only for a DNS name over IPNS whose binding
 * main verified (`bindName`).
 *
 * Nothing here reads the record's `agent`: custody is read live, where a
 * standing rule would answer (design 0011, "Agent custody").
 *
 * Not yet used: no IPC channel calls this module. PRQ-2 wires `track` to the
 * tab guests and `hello`/`attest` to `page:hello`, `page:reserve` and
 * `page:request`.
 */

const { getPermissionKey, isDwebNameHost, isPotentialEnsName } = require('../../shared/origin-utils');
const { ipnsMhToCidV1Base36 } = require('../../shared/cid-utils');

// One counter for the whole main process, never reused while main runs.
let lastNavigation = 0;

// The nonce: 16 random bytes from the preload, as lowercase hex.
const NONCE = /^[0-9a-f]{32}$/;

// How many ended documents' nonces a guest remembers, to tell a late request
// from a replaced document (`navigated`) from a nonce it never had.
const ENDED_NONCES_KEPT = 8;

const PREVIEW_SCHEME = 'freedom-preview:';

// net::ERR_ABORTED: a load cancelled (a stop, a superseding navigation, a
// download, a 204), which never installs an error page.
const ERR_ABORTED = -3;

// The schemes whose URLs have a key, and the shape today's rule gives it.
// http(s), and a blob: URL an http(s) page made, are keyed on their origin.
// Every other URL is opaque to main (`data:`, `about:`, `view-source:`,
// `file:` and so Freedom's own pages, `chrome-error:`, `freedom-preview:`, …)
// and gets no key.
const ORIGIN_KEYED = new Set(['http:', 'https:', 'blob:']);
const KEY_SHAPES = new Map([
  ['bzz:', /^(?:bzz:\/\/[^/?#]+|[^/?#:]+)$/],
  ['ipfs:', /^(?:ipfs:\/\/[^/?#]+|[^/?#:]+)$/],
  ['ipns:', /^(?:ipns:\/\/[^/?#]+|[^/?#:]+)$/],
  ['rad:', /^rad:\/\/[^/?#]+$/],
  ['web3:', /^web3:\/\/0x[0-9a-f]{40}(?::[1-9][0-9]*)?$/],
]);

/**
 * A URL's key by today's rules (`getPermissionKey`), with no name binding,
 * or null. The design's change from today: an opaque URL, one whose rule
 * falls back to the whole URL, gets no key.
 */
function transportKeyOf(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (!ORIGIN_KEYED.has(scheme) && !KEY_SHAPES.has(scheme)) return null;
  const key = getPermissionKey(url);
  if (typeof key !== 'string' || !key) return null;
  if (ORIGIN_KEYED.has(scheme)) {
    return /^https?:\/\//.test(parsed.origin) && key === parsed.origin ? key : null;
  }
  return KEY_SHAPES.get(scheme).test(key) ? key : null;
}

/** An onchain app's own chain, from its key, or null. */
function chainOfKey(key) {
  const match = /^web3:\/\/0x[0-9a-f]{40}(?::([1-9][0-9]*))?$/.exec(key || '');
  if (!match) return null;
  const chain = match[1] ? Number(match[1]) : 1;
  return Number.isSafeInteger(chain) ? chain : null;
}

/** True when `name`'s ENS contenthash answers exactly `ipnsKey`. */
async function nameServesIpnsKey(resolveEnsContent, name, ipnsKey) {
  let result;
  try {
    result = await resolveEnsContent(name);
  } catch {
    return false;
  }
  if (result?.type !== 'ok' || result.protocol !== 'ipns' || !result.decoded) return false;
  if (ipnsKey === result.decoded) return true;
  try {
    return ipnsKey === ipnsMhToCidV1Base36(result.decoded);
  } catch {
    return false;
  }
}

function defaultDependencies() {
  return {
    isPrivateWebContents: (contents) =>
      require('../private/private-windows').isPrivateWebContents(contents),
    isChromeIndexUrl: (url) => require('../ipc-sender-policy').isChromeIndexUrl(url),
    isAgentPage: (contents) => require('../wallet/agent-tab-custody').isAgentPage(contents),
    windowIdOf: (contents) => {
      const host = contents.hostWebContents;
      if (!host) return null;
      return require('electron').BrowserWindow.fromWebContents(host)?.id ?? null;
    },
    resolveEnsContent: (name) => require('../ens-resolver').resolveEnsContent(name),
  };
}

function isLive(contents) {
  try {
    return Boolean(contents) && contents.isDestroyed() === false;
  } catch {
    return false;
  }
}

// What `read` returns, or `fallback` when it throws or gives nothing (a
// webContents or frame torn down mid-check).
function safely(read, fallback = null) {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

function urlOf(read) {
  const url = safely(read, '');
  return typeof url === 'string' ? url : '';
}

/**
 * True when a main-frame `did-fail-provisional-load` means an error page
 * replaced the document: not a cancelled load, the event names the frame the
 * error page committed in, and that frame is now the main frame, showing the
 * failed URL. A load that failed without committing leaves the old document,
 * which still shows its own URL.
 */
function replacedByErrorPage(contents, code, url, processId, routingId) {
  if (code === ERR_ABORTED) return false;
  return safely(() => {
    const frame = contents.mainFrame;
    return Boolean(frame) && !frame.detached && Number.isInteger(processId) && processId >= 0 &&
      frame.processId === processId && frame.routingId === routingId && frame.url === url;
  }, false);
}

const refuse = (reason) => ({ ok: false, reason });

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 */
function createPageDocuments(deps = {}) {
  const {
    isPrivateWebContents,
    isChromeIndexUrl,
    isAgentPage,
    windowIdOf,
    resolveEnsContent,
  } = { ...defaultDependencies(), ...deps };

  // guest id -> { current, endedNonces, pendingBind, binding, nameRunning, nameWaiting }
  const guests = new Map();

  // A document's name check is over: requests waiting on it go on, and are
  // checked again.
  function settleNaming(doc) {
    const naming = doc.naming;
    if (!naming?.pending) return;
    naming.pending = false;
    naming.finish();
  }

  function endCurrent(state) {
    const doc = state.current;
    if (!doc) return;
    doc.ended = true;
    if (doc.nonce) {
      state.endedNonces.push(doc.nonce);
      if (state.endedNonces.length > ENDED_NONCES_KEPT) state.endedNonces.shift();
    }
    if (state.nameWaiting === doc) state.nameWaiting = null;
    settleNaming(doc);
    state.current = null;
  }

  // Name checks run one at a time per guest. A document committed while one
  // runs waits for a check of its own, started once the running one settles,
  // so each document is checked after its commit. Only the guest's current
  // document can wait, so a page that reloads faster than its name resolves
  // holds at most one check and two documents.
  function queueNameCheck(state, doc, binding) {
    let finish;
    const settled = new Promise((resolve) => {
      finish = resolve;
    });
    doc.naming = { pending: true, settled, finish, binding };
    state.nameWaiting = doc;
    if (!state.nameRunning) runNameCheck(state);
  }

  function runNameCheck(state) {
    const doc = state.nameWaiting;
    state.nameWaiting = null;
    if (!doc) return;
    const { binding } = doc.naming;
    state.nameRunning = true;
    nameServesIpnsKey(resolveEnsContent, binding.name, binding.key).then((serves) => {
      state.nameRunning = false;
      // A check answers only for its own document: one that has ended
      // decides nothing, not even the binding.
      if (!doc.ended) {
        if (serves) {
          doc.key = binding.name;
        } else {
          // The document keeps its transport key, and the binding ends: a
          // later commit binds again only through a fresh `bindName`.
          doc.key = doc.transportKey;
          if (state.binding === binding) state.binding = null;
        }
        doc.topKey = doc.key;
      }
      settleNaming(doc);
      runNameCheck(state);
    });
  }

  function commit(contents, state, url) {
    endCurrent(state);
    const transportKey = transportKeyOf(url);
    // A held binding applies to the next commit only; an active one lasts
    // while the guest's commits stay on its IPNS key.
    const binding =
      [state.pendingBind, state.binding].find(
        (candidate) => candidate && transportKey === `ipns://${candidate.key}`
      ) || null;
    state.pendingBind = null;
    state.binding = binding;
    const doc = {
      guest: contents.id,
      window: safely(() => windowIdOf(contents)),
      frame: safely(() => contents.mainFrame?.frameTreeNodeId),
      navigation: ++lastNavigation,
      nonce: null,
      url,
      transportKey,
      key: binding ? null : transportKey,
      topKey: binding ? null : transportKey,
      agent: null,
      chain: chainOfKey(transportKey),
      naming: null,
      ended: false,
    };
    state.current = doc;
    if (binding) queueNameCheck(state, doc, binding);
  }

  /**
   * Start numbering a tab guest's documents. Idempotent. Main-frame commits
   * start a document; same-document navigations (`did-navigate-in-page`: a
   * fragment, `pushState`) keep it. An error page that replaces the document
   * commits with `did-fail-provisional-load` instead of
   * `did-frame-navigate`; it ends the document and starts none, so the error
   * page's hello finds no document. A cancelled or uncommitted load keeps
   * the document.
   */
  function track(contents) {
    if (!contents || !Number.isInteger(contents.id) || guests.has(contents.id)) return;
    const state = {
      current: null,
      endedNonces: [],
      pendingBind: null,
      binding: null,
      nameRunning: false,
      nameWaiting: null,
    };
    guests.set(contents.id, state);
    contents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame) => {
      if (isMainFrame === true && guests.get(contents.id) === state) commit(contents, state, url);
    });
    contents.on(
      'did-fail-provisional-load',
      (_event, code, _description, url, isMainFrame, processId, routingId) => {
        if (isMainFrame !== true || guests.get(contents.id) !== state) return;
        if (replacedByErrorPage(contents, code, url, processId, routingId)) endCurrent(state);
      }
    );
    contents.once('destroyed', () => {
      endCurrent(state);
      if (guests.get(contents.id) === state) guests.delete(contents.id);
    });
  }

  /**
   * Hold a DNS name for the guest's next main-frame commit (the design's
   * `page:bind-name { guest, name, key }`). The commit takes it only when
   * its URL is `ipns://<key>` with exactly that key, and the name's own
   * resolution answers that key.
   */
  function bindName({ guest, name, key } = {}) {
    const state = guests.get(guest);
    if (!state) return false;
    if (typeof name !== 'string' || typeof key !== 'string') return false;
    const lower = name.toLowerCase();
    if (lower.includes('://') || isDwebNameHost(lower) || !isPotentialEnsName(lower)) return false;
    if (!/^[A-Za-z0-9]+$/.test(key)) return false;
    state.pendingBind = { name: lower, key };
    return true;
  }

  // Steps 1 to 4: the sender is a tab's top frame, outside a private window
  // and a preview.
  function checkFrame(event) {
    const sender = event?.sender;
    if (!isLive(sender)) return refuse('not-a-tab');
    try {
      if (sender.getType() !== 'webview') return refuse('not-a-tab');
      const host = sender.hostWebContents;
      if (!isLive(host) || !isChromeIndexUrl(host.mainFrame?.url)) return refuse('not-a-tab');
    } catch {
      return refuse('not-a-tab');
    }
    // A check that throws (a window mid-teardown) counts as private.
    if (safely(() => isPrivateWebContents(sender) !== false, true)) return refuse('private');
    const state = guests.get(sender.id) || null;
    const doc = state?.current || null;
    const committed = [doc?.url, urlOf(() => sender.getURL())];
    if (committed.some((url) => typeof url === 'string' && url.startsWith(PREVIEW_SCHEME))) {
      return refuse('preview');
    }
    let frame;
    try {
      frame = event.senderFrame;
      if (!frame || frame.detached) return refuse('detached');
      if (frame !== sender.mainFrame) return refuse('sub-frame');
    } catch {
      return refuse('detached');
    }
    if (!doc || doc.frame !== safely(() => frame.frameTreeNodeId)) return refuse('no-document');
    return { ok: true, sender, frame, state, doc };
  }

  // Step 6: the live frame URL keys to the document's transport key.
  function onTransportKey(frame, doc) {
    return transportKeyOf(urlOf(() => frame.url)) === doc.transportKey;
  }

  // Steps 1 to 6, synchronously.
  function check(event, nonce) {
    const step = checkFrame(event);
    if (!step.ok) return step;
    const { frame, state, doc } = step;
    if (typeof nonce === 'string' && state.endedNonces.includes(nonce)) return refuse('navigated');
    if (!doc.nonce) return refuse('no-hello');
    if (typeof nonce !== 'string' || nonce !== doc.nonce) return refuse('wrong-nonce');
    if (!onTransportKey(frame, doc)) return refuse('off-key');
    return { ok: true, doc };
  }

  /**
   * Bind the hello's nonce to the sender's current document: the first
   * hello for the current number, from the main frame, and no later one.
   * The hello passes the steps a request does, in the same order, but step
   * 5, which it sets up: the document must have no nonce yet, and the
   * hello's must be well formed.
   *
   * @returns {{ok: true, navigation: number} | {ok: false, reason: string}}
   */
  function hello(event, payload) {
    const step = checkFrame(event);
    if (!step.ok) return step;
    const { sender, frame, doc } = step;
    if (doc.nonce) return refuse('already-bound');
    const nonce = payload?.nonce;
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return refuse('bad-nonce');
    if (!onTransportKey(frame, doc)) return refuse('off-key');
    doc.nonce = nonce;
    doc.agent = safely(() => isAgentPage(sender) === true);
    return { ok: true, navigation: doc.navigation };
  }

  function snapshot(doc) {
    return Object.freeze({
      guest: doc.guest,
      window: doc.window,
      frame: doc.frame,
      navigation: doc.navigation,
      nonce: doc.nonce,
      url: doc.url,
      transportKey: doc.transportKey,
      key: doc.key,
      topKey: doc.topKey,
      agent: doc.agent,
      chain: doc.chain,
    });
  }

  /**
   * The attested requester of an IPC event that carries `nonce`, or why
   * not. A document whose name binding is still being checked waits for
   * it, and is then checked again in full: the guest may have navigated
   * meanwhile.
   *
   * @returns {Promise<{ok: true, requester: object} | {ok: false, reason: string}>}
   */
  async function attest(event, nonce) {
    let result = check(event, nonce);
    if (!result.ok) return result;
    const naming = result.doc.naming;
    if (naming?.pending) {
      await naming.settled;
      result = check(event, nonce);
      if (!result.ok) return result;
    }
    return { ok: true, requester: snapshot(result.doc) };
  }

  /** True while `requester`'s document is still its guest's current one. */
  function isCurrent(requester) {
    const doc = guests.get(requester?.guest)?.current;
    return Boolean(doc) && !doc.ended && doc.navigation === requester.navigation &&
      doc.nonce === requester.nonce;
  }

  return { track, bindName, hello, attest, isCurrent };
}

module.exports = {
  createPageDocuments,
  transportKeyOf,
  chainOfKey,
};
