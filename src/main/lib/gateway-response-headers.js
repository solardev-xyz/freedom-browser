/**
 * Response headers of a proxied content gateway: the ones it must never set
 * on a dweb page, and the content type a Markdown file is given.
 *
 * The bzz: and ipfs:/ipns: handlers stream an upstream gateway's response to
 * the page under the `bzz://` / `ipfs://` origin. When that gateway is a
 * user-configured external Ant or IPFS node — possibly remote, possibly
 * shared — its headers are not content: `Set-Cookie` would plant cookies in
 * the content's origin, and `Service-Worker-Allowed` would let a service
 * worker claim a wider scope than its script path. Content served by Swarm or
 * IPFS has no business setting either, so they are dropped whichever node
 * answered (docs/security-audit-electron.md, O-12; #439).
 */
const PAGE_STATE_RESPONSE_HEADERS = ['set-cookie', 'set-cookie2', 'service-worker-allowed'];

function stripPageStateHeaders(headers) {
  for (const name of PAGE_STATE_RESPONSE_HEADERS) headers.delete(name);
  return headers;
}

// Is this request a document load (top-level or frame navigation) rather
// than a subresource fetch? `protocol.handle` gives us no `Sec-Fetch-Dest`
// (Chromium does not send the Sec-Fetch-* family for custom schemes) and
// both `Request.destination` and `Request.mode` are useless here —
// empirically, on the Electron we ship, `destination` is always `''` and
// `mode` is always `'cors'`, for navigations and subresources alike. What
// does survive is Chromium's fixed navigation `Accept` header, whose first
// media type is `text/html`; every subresource sends its own type-specific
// Accept instead (`*/*` for scripts and fetch/XHR, `text/css,*/*;q=0.1`
// for stylesheets, `image/…` for images). So Accept is the navigation
// signal available, and it is the one used here.
function isDocumentRequest(request) {
  const accept = request?.headers?.get('accept') || '';
  return accept.split(',')[0].trim().toLowerCase() === 'text/html';
}

const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const UNTYPED = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const MARKDOWN_TEXT_TYPES = new Set(['text/markdown', 'text/x-markdown', 'text/plain']);

// How the file is Markdown by name: 'path' when the URL ends in .md, 'filename'
// when only the node's Content-Disposition says so (a site root serving its
// `index.md`), '' when neither does.
function markdownName(request, response) {
  let pathname = '';
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // Unparseable URL: fall through to the reported filename.
  }
  if (MARKDOWN_FILE.test(pathname)) return 'path';
  const disposition = response.headers.get('content-disposition') || '';
  const filename = /filename\*?\s*=\s*(?:utf-8'[^']*')?"?([^";]+)"?/i.exec(disposition)?.[1] || '';
  return MARKDOWN_FILE.test(filename.trim()) ? 'filename' : '';
}

/**
 * Give a Markdown file on Swarm or IPFS a type the tab can render (#1035).
 *
 * Which type a file gets depends on whatever uploaded it: bee-js types any
 * file whose extension its MIME table lacks, `.md` among them, as
 * `application/octet-stream`, which Chromium downloads instead of showing.
 * So a navigation to a Markdown file is relabelled:
 *
 * - no usable type: `text/markdown`;
 * - `text/plain` at a site root whose node names the file `index.md`:
 *   `text/markdown` too, since the tab only recognises `text/plain` as
 *   Markdown at a `.md` path;
 * - no charset: UTF-8, which Markdown files almost always are, rather than
 *   Chromium's locale default. A declared charset is kept.
 *
 * Everything else passes through untouched: subresources (a page's own
 * `fetch()` of a file decides its MIME itself, as in renderSmallTextResponse),
 * other types, non-2xx answers, and a file its node explicitly serves as a
 * download.
 */
function labelMarkdownDocument(response, request) {
  if (!response?.body || response.status < 200 || response.status > 299) return response;
  if (!isDocumentRequest(request)) return response;
  if (/^\s*attachment\b/i.test(response.headers.get('content-disposition') || '')) return response;
  const contentType = response.headers.get('content-type') || '';
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!UNTYPED.has(type) && !MARKDOWN_TEXT_TYPES.has(type)) return response;
  const name = markdownName(request, response);
  if (!name) return response;
  // An untyped answer's charset (octet-stream's `binary`, say) says nothing
  // about text, so it gets UTF-8 like one with none.
  const declared = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] || '';
  const charset = UNTYPED.has(type) ? '' : declared;
  const promote = UNTYPED.has(type) || (type === 'text/plain' && name === 'filename');
  if (!promote && charset) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', `${promote ? 'text/markdown' : type}; charset=${charset || 'utf-8'}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

module.exports = {
  PAGE_STATE_RESPONSE_HEADERS,
  stripPageStateHeaders,
  isDocumentRequest,
  labelMarkdownDocument,
};
