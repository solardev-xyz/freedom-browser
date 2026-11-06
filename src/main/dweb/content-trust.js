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
 * - **Who reads it:** the renderer that hosts the tab, once the navigation
 *   commits (`dweb:get-content-trust`), for the committed URL. A response
 *   without a label (main's error page, say) leaves the tab with none.
 *
 * An in-process caller that calls a handler directly
 * (`permission-manifests.js`) gets no header.
 */

const { registerWebRequestHandler } = require('../webrequest-dispatcher');

const CONTENT_TRUST_HEADER = 'X-Freedom-Content-Trust';
const CONTENT_LABELS = new Set(['verified', 'latest_asserted', 'node_asserted', 'unverified']);
const DWEB_URL = /^(?:bzz|ipfs|ipns):/i;

/** The latest main-frame label per `webContents`: `{ url, content }`. */
const labelByWebContentsId = new Map();
const observedWebContentsIds = new Set();

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

function remember(contents, url, content) {
  labelByWebContentsId.set(contents.id, { url, content });
  if (observedWebContentsIds.has(contents.id)) return;
  observedWebContentsIds.add(contents.id);
  contents.once?.('destroyed', () => {
    labelByWebContentsId.delete(contents.id);
    observedWebContentsIds.delete(contents.id);
  });
}

/**
 * The session's `onHeadersReceived` handler: takes the label off every dweb
 * response, and keeps a main frame's for its `webContents`. A main frame
 * with no label (or one that isn't a label) keeps none, so a failed reload
 * can't show the page before it.
 *
 * @param {object} details - Electron's `onHeadersReceived` details
 * @returns {{responseHeaders: object}|null}
 */
function captureContentTrust(details) {
  if (!DWEB_URL.test(details?.url || '')) return null;
  const { value, rest } = takeHeader(details.responseHeaders, CONTENT_TRUST_HEADER);
  const contents = details.webContents;
  if (details.resourceType === 'mainFrame' && contents?.id) {
    const content = value !== null && CONTENT_LABELS.has(value) ? value : null;
    remember(contents, documentUrl(details.url), content);
  }
  return rest ? { responseHeaders: rest } : null;
}

/**
 * The label of the page `webContentsId` committed at `url`, or null: one
 * only while it is still that `webContents`' latest main frame.
 */
function contentTrustFor(webContentsId, url) {
  const record = labelByWebContentsId.get(webContentsId);
  const wanted = documentUrl(url);
  if (!record || !wanted || record.url !== wanted) return null;
  return record.content;
}

/** Registers the capture with the webRequest dispatcher: before it attaches
 * to a session, on every session (tests' stubs included). */
function installContentTrustCapture() {
  registerWebRequestHandler('onHeadersReceived', 'dweb-content-trust', captureContentTrust);
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
  labelByWebContentsId.clear();
  observedWebContentsIds.clear();
}

module.exports = {
  CONTENT_TRUST_HEADER,
  CONTENT_LABELS,
  captureContentTrust,
  contentTrustFor,
  installContentTrustCapture,
  labelResponse,
  registerContentTrustIpc,
  serveLabelled,
  _resetContentTrust,
};
