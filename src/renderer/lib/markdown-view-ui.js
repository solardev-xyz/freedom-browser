/**
 * Markdown button in the address bar (#1035).
 *
 * A tab showing a Markdown file shows it as a formatted page: the tab preload
 * renders it in place (src/main/webview-preload.js, "Markdown documents") and
 * reports `markdown:state` with the view on screen. While the active tab's
 * page has reported in, the address bar shows the Markdown mark; clicking it
 * shows the file's source, and the button then reads "Source"; clicking again
 * goes back to the formatted page. The page does the switch itself, on
 * `markdown:toggle`, and reports the new view.
 *
 * The view belongs to the page: a committed main-frame navigation forgets it,
 * and a Markdown page reports in again once it has rendered.
 */

import { getActiveTab, onWebviewCreated } from './tabs.js';
import { pushDebug } from './debug.js';

const VIEWS = new Set(['formatted', 'source']);

// The view each tab's page last reported, by <webview>.
let viewByWebview = new WeakMap();
let toggleBtn;

const activeWebview = () => getActiveTab()?.webview || null;

/**
 * The Markdown view the tab's page reported ('formatted' | 'source'), or
 * null when its page is not a rendered Markdown file.
 * @param {object|null} webview
 */
export const getMarkdownView = (webview) => (webview && viewByWebview.get(webview)) || null;

/** Show, hide and label the button for the active tab. */
export const refresh = () => {
  if (!toggleBtn) return;
  const view = getMarkdownView(activeWebview());
  toggleBtn.classList.toggle('hidden', !view);
  if (!view) return;
  const showingSource = view === 'source';
  toggleBtn.setAttribute('aria-pressed', showingSource ? 'true' : 'false');
  toggleBtn.title = showingSource ? 'Show formatted page' : 'Show Markdown source';
};

const forget = (webview) => {
  if (!viewByWebview.delete(webview)) return;
  if (activeWebview() === webview) refresh();
};

const watchWebview = (webview) => {
  if (!webview?.addEventListener) return;
  webview.addEventListener('ipc-message', (event) => {
    if (event.channel !== 'markdown:state') return;
    const view = event.args?.[0]?.view;
    if (!VIEWS.has(view)) return;
    viewByWebview.set(webview, view);
    if (activeWebview() === webview) refresh();
  });
  // A new document, or none: its own report (if any) brings the button back.
  webview.addEventListener('did-navigate', () => forget(webview));
  webview.addEventListener('render-process-gone', () => forget(webview));
};

export const initMarkdownViewUi = () => {
  toggleBtn = document.getElementById('markdown-toggle-btn');
  if (!toggleBtn) {
    pushDebug('[markdown] Markdown button unavailable (missing DOM)');
    return;
  }
  onWebviewCreated(watchWebview);
  toggleBtn.addEventListener('click', () => {
    const webview = activeWebview();
    if (!getMarkdownView(webview)) return;
    webview.send('markdown:toggle');
  });
  document.addEventListener('active-tab-changed', refresh);
  refresh();
};

// Test-only: reset module state between cases.
export const _resetForTests = () => {
  viewByWebview = new WeakMap();
  toggleBtn = undefined;
};
