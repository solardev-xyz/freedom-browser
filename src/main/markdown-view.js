/**
 * What a tab needs to render a Markdown document (#1035).
 *
 * The tab preload (webview-preload.js) recognises a Markdown document by its
 * type and renders it in place, in its own isolated world. It is sandboxed
 * and cannot read files, so it asks here, over `markdown:get-view`, for the
 * three scripts that do the work — the vendored marked and DOMPurify, and
 * webview-preload-markdown.js — and for the Appearance theme the page should
 * open in. Ordinary pages never ask: the preload checks the content type
 * first, so they pay nothing.
 *
 * The answer is the same static text for every sender, plus a theme name, so
 * the channel is PUBLIC in ipc-sender-policy.js: any page may have it.
 * Rendering stays in the tab's renderer on purpose. A huge or hostile file
 * can only stall its own tab, never the main process every tab shares.
 *
 * Main also adjusts a Markdown response's headers before Chromium sees them:
 * UTF-8 when no charset is declared, and Freedom's reader policy in place of
 * the server's content security policy (markdownDocumentHeaders below).
 */
const fs = require('fs');
const path = require('path');
const IPC = require('../shared/ipc-channels');
const { registerWebRequestHandler } = require('./webrequest-dispatcher');

const VENDOR_DIR = path.join(__dirname, '..', 'renderer', 'vendor');

let sources = null;

// Read once; the files never change while the app runs.
function getMarkdownViewSources() {
  if (!sources) {
    sources = Object.freeze({
      marked: fs.readFileSync(path.join(VENDOR_DIR, 'marked.min.js'), 'utf-8'),
      purify: fs.readFileSync(path.join(VENDOR_DIR, 'purify.min.js'), 'utf-8'),
      view: fs.readFileSync(path.join(__dirname, 'webview-preload-markdown.js'), 'utf-8'),
    });
  }
  return sources;
}

/**
 * The `markdown:get-view` answer: the three sources and the raw Appearance
 * setting ('system' | 'light' | 'dark'), which the preload resolves the way it
 * does for internal pages.
 * @param {{ loadSettings: () => { theme?: string } }} deps
 */
function makeMarkdownViewHandler({ loadSettings }) {
  return () => {
    let theme = 'system';
    try {
      theme = loadSettings()?.theme || 'system';
    } catch {
      // Unreadable settings: follow the system scheme, like internal pages.
    }
    return { ...getMarkdownViewSources(), theme };
  };
}

const MARKDOWN_PATH = /\.(?:md|markdown)$/i;

const pathnameOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

// Freedom's policy for a Markdown page it renders, in place of the server's
// (markdownDocumentHeaders below). Nothing in the page may run, embed,
// frame, submit, connect or rewrite its base URL. Images load from wherever
// the file points, as on any web page, and inline styles stay allowed for
// Chromium's own text page, which styles its <pre> inline. The rendered page
// adds no styles of its own: Freedom's reading style is injected outside the
// page's policy, and the page's HTML has no style attributes.
const READER_POLICY = [
  "default-src 'none'",
  'img-src * data: bzz: ipfs: ipns: web3:',
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Whether any policy in these CSP header values has the named directive. A
// value may hold several policies (comma-separated), each several
// directives (semicolon-separated).
const hasDirective = (values, name) =>
  values.some((value) =>
    String(value)
      .split(/[,;]/)
      .some((directive) => directive.trim().split(/\s+/)[0].toLowerCase() === name)
  );

/**
 * `onHeadersReceived` for a top-level Markdown document (`text/markdown`,
 * `text/x-markdown`, or `text/plain` at a .md / .markdown path, the same
 * test the tab uses), before Chromium sees the response:
 *
 * - No declared charset: UTF-8. Without one Chromium decodes in its locale
 *   default, Windows-1252 in Western-language locales, so a UTF-8 file's
 *   `Café` would render as `CafÃ©`. Markdown files are UTF-8 almost without
 *   exception (RFC 7763 makes the charset parameter required, and servers
 *   leave it off anyway). A declared charset is the server's word and is kept.
 *
 * - A Content-Security-Policy, in any number of headers: replaced by
 *   READER_POLICY. Freedom renders the page itself, from text, so the rules
 *   that matter are the reader's: the server's were written for the file as
 *   plain text and get in the way of the page. GitHub's raw files are the
 *   case in point, with `default-src 'none'; style-src 'unsafe-inline';
 *   sandbox`: `default-src 'none'` blocks every image in a README, and a
 *   `sandbox` that forbids script stops Electron from setting up the page's
 *   script context, which is what starts the tab preload that renders the
 *   Markdown. The file stayed plain text until something else created one,
 *   such as opening DevTools. A server's sandbox is kept, as `sandbox
 *   allow-scripts`: the page keeps its opaque origin and loses any other
 *   allowance the server gave it, while READER_POLICY keeps any page script
 *   from running. A server's `upgrade-insecure-requests` is kept too, so the
 *   images it now lets through still go over HTTPS; the rendered page sends
 *   them no referrer beyond its own site (webview-preload-markdown.js).
 *   Report-only policies only report, and are left alone.
 *
 * Everything else passes through untouched, a page with no policy included.
 * Swarm and IPFS answers are labelled in their protocol handlers
 * (gateway-response-headers.js), which webRequest never sees; local files
 * need nothing, as Chromium detects their encoding itself and they carry no
 * policy.
 */
function markdownDocumentHeaders(details) {
  const headers = details?.responseHeaders;
  if (details?.resourceType !== 'mainFrame' || !headers) return null;
  // Exactly one Content-Type, or nothing is touched: with two (one per
  // letter case, say) this could read text/plain where Chromium reads
  // text/html, and relax an HTML page's policy.
  const typeKeys = Object.keys(headers).filter((key) => key.toLowerCase() === 'content-type');
  if (typeKeys.length !== 1) return null;
  const typeKey = typeKeys[0];
  const typeValues = [].concat(headers[typeKey]);
  if (typeValues.length !== 1) return null;
  const contentType = String(typeValues[0]).trim();
  const type = contentType.split(';')[0].trim().toLowerCase();
  const markdown =
    type === 'text/markdown' ||
    type === 'text/x-markdown' ||
    (type === 'text/plain' && MARKDOWN_PATH.test(pathnameOf(details.url)));
  if (!markdown) return null;

  let next = null;
  const edit = () => (next ||= { ...headers });
  if (!/;\s*charset\s*=/i.test(contentType)) {
    edit()[typeKey] = [`${contentType.replace(/;\s*$/, '')}; charset=utf-8`];
  }
  // Every CSP header, whatever its case: a response may send it more than
  // once, and Electron keeps differently cased names apart.
  const policyKeys = Object.keys(headers).filter(
    (key) => key.toLowerCase() === 'content-security-policy'
  );
  if (policyKeys.length) {
    const served = policyKeys.flatMap((key) => [].concat(headers[key]));
    const policy = [
      READER_POLICY,
      ...(hasDirective(served, 'upgrade-insecure-requests') ? ['upgrade-insecure-requests'] : []),
      ...(hasDirective(served, 'sandbox') ? ['sandbox allow-scripts'] : []),
    ].join('; ');
    const target = edit();
    for (const key of policyKeys) delete target[key];
    target[policyKeys[0]] = [policy];
  }
  return next ? { responseHeaders: next } : null;
}

// Before attachWebRequestDispatcher(), like every other consumer.
function installMarkdownDocumentHeaders() {
  registerWebRequestHandler(
    'onHeadersReceived',
    'markdown-document-headers',
    markdownDocumentHeaders
  );
}

function registerMarkdownViewIpc() {
  const { ipcMain } = require('electron');
  const { loadSettings } = require('./settings-store');
  ipcMain.handle(IPC.MARKDOWN_GET_VIEW, makeMarkdownViewHandler({ loadSettings }));
}

module.exports = {
  READER_POLICY,
  getMarkdownViewSources,
  makeMarkdownViewHandler,
  registerMarkdownViewIpc,
  markdownDocumentHeaders,
  installMarkdownDocumentHeaders,
};
