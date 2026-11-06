/**
 * The content label of a `bzz:`, `ipfs:` or `ipns:` page, for the address
 * bar's trust panel (freedom-core design 0009, Labels).
 *
 * - **The labels** (`trust.content`): `verified` (every byte checked against
 *   the root the URL or the name names), `latest_asserted` (checked against
 *   an update its owner signed; that it is the latest is the node's word),
 *   `node_asserted` (the bundled nodes, which check what they retrieve) and
 *   `unverified`.
 * - **Where one is decided:** the handler's `onTrust` (dweb-handler.js) gets
 *   the trust of the response it answers with: a verified head's final
 *   label, or a fetch plan's `trust.content` once the node has answered.
 *   Main's own answers (an error plan, a refused plan, an unreachable node)
 *   carry none.
 * - **How it reaches the tab:** the protocol handlers registered on a
 *   session label their response with `X-Freedom-Content-Trust`, after
 *   dropping any copy a node sent, so no node can name its own label. The
 *   session's `onHeadersReceived` takes the header off every dweb response,
 *   so no page ever reads it, and keeps a main frame's label for its
 *   `webContents`. Only a navigation sets the tab's label: a subresource,
 *   a subframe or a page's own `fetch` keeps its label to itself.
 * - **Which navigation it belongs to:** each top-level cross-document
 *   navigation a `webContents` starts begins a new generation and forgets
 *   the label it had. A main-frame request is tied to the generation it
 *   started in (`onBeforeRequest`), and only a response to a request of the
 *   current generation is kept. So a document no dweb response answers (a
 *   service worker's, say) has no label, and a response that lands after a
 *   later navigation started is ignored.
 * - **Who reads it:** the renderer that hosts the tab, once the navigation
 *   commits (`dweb:get-content-trust`), for the committed URL. The read
 *   takes the label: a later document at the same URL can't read it again.
 *   A response without a label (main's error page, say) leaves the tab with
 *   none.
 *
 * An in-process caller that calls a handler directly
 * (`permission-manifests.js`) gets no header.
 */

const { registerWebRequestHandler } = require('../webrequest-dispatcher');

const CONTENT_TRUST_HEADER = 'X-Freedom-Content-Trust';
const CONTENT_LABELS = new Set(['verified', 'latest_asserted', 'node_asserted', 'unverified']);
const DWEB_URL = /^(?:bzz|ipfs|ipns):/i;

/**
 * Per `webContents`, its current top-level navigation:
 * - `generation`: counts the cross-document navigations it has started;
 * - `requests`: each main-frame dweb request still open, by request id, with
 *   the generation it started in;
 * - `label`: the label of the current generation's response,
 *   `{ url, content }`, until the chrome reads it.
 */
const navigationByWebContentsId = new Map();

/** The known label `trust` carries, or null. */
function contentLabel(trust) {
  const content = trust?.content;
  return typeof content === 'string' && CONTENT_LABELS.has(content) ? content : null;
}

/** The URL a document is known by: without its fragment. */
function documentUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Labels a dweb response with `trust`'s content label, or with none. Any
 * copy of the header already on it (a node's) is dropped first.
 *
 * @param {Response} response
 * @param {{content: string}|null} trust - what `onTrust` was given, if
 *   anything
 * @returns {Response}
 */
function labelResponse(response, trust) {
  const content = contentLabel(trust);
  try {
    response.headers.delete(CONTENT_TRUST_HEADER);
    if (content) response.headers.set(CONTENT_TRUST_HEADER, content);
    return response;
  } catch {
    // Headers that can't be changed (a response `fetch` made): the same
    // response, rebuilt over the same body.
    const headers = new Headers(response.headers);
    headers.delete(CONTENT_TRUST_HEADER);
    if (content) headers.set(CONTENT_TRUST_HEADER, content);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Serves a request and labels its response: `serve(onTrust)` runs the
 * handler with `onTrust` as its hook.
 *
 * @param {(onTrust: (trust: object) => void) => Promise<Response>} serve
 * @returns {Promise<Response>}
 */
async function serveLabelled(serve) {
  let trust = null;
  const response = await serve((given) => {
    trust = given;
  });
  return labelResponse(response, trust);
}

/** Electron's response headers without `name`: the value it had (its
 * only one, or null) and the rest, or null when it wasn't there. */
function takeHeader(responseHeaders, name) {
  const wanted = name.toLowerCase();
  let value = null;
  let found = false;
  const rest = {};
  for (const [key, given] of Object.entries(responseHeaders || {})) {
    if (key.toLowerCase() !== wanted) {
      rest[key] = given;
      continue;
    }
    const values = Array.isArray(given) ? given : [given];
    // Two copies, or two values, are no label.
    value = !found && values.length === 1 ? String(values[0]) : null;
    found = true;
  }
  return { value, rest: found ? rest : null };
}

/** `contents`' current navigation; watches its navigations from the first
 * call on. */
function navigationOf(contents) {
  const known = navigationByWebContentsId.get(contents.id);
  if (known) return known;
  const navigation = { generation: 0, requests: new Map(), label: null };
  navigationByWebContentsId.set(contents.id, navigation);
  // A new document is coming: whatever answers it, the label so far isn't
  // its. Only a navigation known to keep the document (an anchor,
  // `pushState`) or known to be a subframe's leaves the label alone.
  // Electron 45 passes `isMainFrame` and `isSameDocument` on the event; the
  // older positional arguments are the fallback.
  contents.on?.('did-start-navigation', (event, _url, isInPlace, isMainFrame) => {
    const mainFrame = typeof event?.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame;
    const sameDocument =
      typeof event?.isSameDocument === 'boolean' ? event.isSameDocument : isInPlace;
    if (mainFrame === false || sameDocument === true) return;
    navigation.generation += 1;
    navigation.label = null;
  });
  contents.once?.('destroyed', () => {
    if (navigationByWebContentsId.get(contents.id) === navigation) {
      navigationByWebContentsId.delete(contents.id);
    }
  });
  return navigation;
}

/** Whether `details` is a dweb main-frame request a tab made. */
function isTabMainFrame(details) {
  return (
    details?.resourceType === 'mainFrame' &&
    DWEB_URL.test(details.url || '') &&
    Boolean(details.webContents?.id) &&
    details.id !== undefined &&
    details.id !== null
  );
}

/**
 * The session's `onBeforeRequest` handler: ties a tab's main-frame dweb
 * request to the navigation it starts in. A redirect's next leg keeps the
 * generation its request started in.
 *
 * @param {object} details - Electron's `onBeforeRequest` details
 * @returns {null} - never changes the request
 */
function trackContentTrustRequest(details) {
  if (!isTabMainFrame(details)) return null;
  const navigation = navigationOf(details.webContents);
  if (!navigation.requests.has(details.id)) {
    navigation.requests.set(details.id, navigation.generation);
  }
  return null;
}

/** `onCompleted` / `onErrorOccurred`: a request that is over is forgotten. */
function forgetContentTrustRequest(details) {
  if (!isTabMainFrame(details)) return;
  navigationByWebContentsId.get(details.webContents.id)?.requests.delete(details.id);
}

/**
 * The session's `onHeadersReceived` handler: takes the label off every dweb
 * response, and keeps a main frame's for its `webContents`' current
 * navigation. A main frame with no label (or one that isn't a label) keeps
 * none, so a failed reload can't show the page before it.
 *
 * @param {object} details - Electron's `onHeadersReceived` details
 * @returns {{responseHeaders: object}|null}
 */
function captureContentTrust(details) {
  if (!DWEB_URL.test(details?.url || '')) return null;
  const { value, rest } = takeHeader(details.responseHeaders, CONTENT_TRUST_HEADER);
  if (isTabMainFrame(details)) {
    const navigation = navigationByWebContentsId.get(details.webContents.id);
    // Only a response to a request of the tab's current navigation: one
    // that started before it (a cancelled reload's, say) is no label of the
    // document it leads to.
    if (navigation && navigation.requests.get(details.id) === navigation.generation) {
      const content = value !== null && CONTENT_LABELS.has(value) ? value : null;
      navigation.label = { url: documentUrl(details.url), content };
    }
  }
  return rest ? { responseHeaders: rest } : null;
}

/**
 * The label of the page `webContentsId` committed at `url`, or null: the
 * label of its current navigation's response, if that response was for
 * `url`. The read takes it, so it answers once: the chrome asks at each
 * commit, and a later document at the same URL that no response answered
 * reads none.
 */
function contentTrustFor(webContentsId, url) {
  const navigation = navigationByWebContentsId.get(webContentsId);
  const label = navigation?.label;
  if (!label) return null;
  navigation.label = null;
  const wanted = documentUrl(url);
  return wanted && label.url === wanted ? label.content : null;
}

/** Registers the capture with the webRequest dispatcher: before it attaches
 * to a session, on every session (tests' stubs included). */
function installContentTrustCapture() {
  registerWebRequestHandler('onBeforeRequest', 'dweb-content-trust', trackContentTrustRequest);
  registerWebRequestHandler('onHeadersReceived', 'dweb-content-trust', captureContentTrust);
  registerWebRequestHandler('onCompleted', 'dweb-content-trust', forgetContentTrustRequest);
  registerWebRequestHandler('onErrorOccurred', 'dweb-content-trust', forgetContentTrustRequest);
}

/** `dweb:get-content-trust`: a tab's label, for the renderer that hosts it. */
function registerContentTrustIpc() {
  const { ipcMain, webContents } = require('electron');
  const IPC = require('../../shared/ipc-channels');
  ipcMain.handle(IPC.DWEB_GET_CONTENT_TRUST, (event, payload = {}) => {
    const webContentsId = Number(payload?.webContentsId);
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return null;
    const guest = webContents.fromId(webContentsId);
    // Only the chrome that hosts the tab may read it.
    if (!guest || guest.hostWebContents?.id !== event.sender?.id) return null;
    if (typeof payload.url !== 'string') return null;
    return contentTrustFor(webContentsId, payload.url);
  });
}

/** Test-only: forget every tab's label. */
function _resetContentTrust() {
  navigationByWebContentsId.clear();
}

module.exports = {
  CONTENT_TRUST_HEADER,
  CONTENT_LABELS,
  captureContentTrust,
  contentTrustFor,
  forgetContentTrustRequest,
  installContentTrustCapture,
  labelResponse,
  registerContentTrustIpc,
  serveLabelled,
  trackContentTrustRequest,
  _resetContentTrust,
};
