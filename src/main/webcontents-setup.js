const log = require('./logger');
const { BrowserWindow, app } = require('electron');
const { activeBzzBases } = require('./state');
const { cleanupWebContents: cleanupX402WebContents } = require('./x402/intercept');
const { cleanupAdblockWebContents } = require('./adblock/service');
const { isPrivateWebContents } = require('./private/private-windows');

const sanitizeUrlForLog = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return 'unknown';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'file:') {
      return 'file://<redacted>';
    }
    if (
      parsed.protocol === 'bzz:' ||
      parsed.protocol === 'ipfs:' ||
      parsed.protocol === 'ipns:' ||
      parsed.protocol === 'web3:' ||
      parsed.protocol === 'freedom:'
    ) {
      return `${parsed.protocol}//<redacted>`;
    }
    return parsed.origin;
  } catch {
    if (
      rawUrl.startsWith('bzz://') ||
      rawUrl.startsWith('ipfs://') ||
      rawUrl.startsWith('ipns://') ||
      rawUrl.startsWith('web3://') ||
      rawUrl.startsWith('freedom://')
    ) {
      return `${rawUrl.split('://')[0]}://<redacted>`;
    }
    return 'unknown';
  }
};

// PRIVATE MODE GUARD (navigation logging): `log.info` lands in the persistent
// <userData>/logs/main.log, which outlives the private window and the app.
// Even the sanitised form leaks where a private tab went (an http origin, or
// the whole `rad:`/`ethereum:` URI, which has no origin to strip back to), so
// private-window navigations log nothing beyond the fact that one happened.
// Fails closed for the same reason ownerWindowOf does: if privacy cannot be
// determined, redact. It also keeps the throw out of the will-navigate /
// setWindowOpenHandler callbacks, where it would escape unhandled.
const isPrivateSender = (contents) => {
  try {
    return isPrivateWebContents(contents);
  } catch {
    return true;
  }
};

const navUrlForLog = (contents, rawUrl) =>
  isPrivateSender(contents) ? '<private>' : sanitizeUrlForLog(rawUrl);

// Resolve the BrowserWindow that hosts a webview's contents. Webviews carry
// their chrome renderer as hostWebContents; routing through it (instead of
// picking an arbitrary window) keeps tab-open requests in the window the
// user clicked in — load-bearing for private windows, where a link opened
// from a private page must never materialise as a tab in a normal window
// (and vice versa). Returns null when no window can be resolved safely —
// callers must treat that as "drop the action".
function ownerWindowOf(contents) {
  try {
    const host = contents.hostWebContents || contents;
    const win = BrowserWindow.fromWebContents(host);
    if (win && !win.isDestroyed()) return win;
  } catch {
    // contents may be tearing down
  }

  // PRIVATE MODE GUARD (cross-privacy routing): the fallback below picks an
  // *arbitrary* other window, which for a private sender can hand the private
  // page's URL to a normal window on the default persistent session — a
  // history row, persistent cookies and injected providers for a link the
  // user opened privately. There is no safe arbitrary window for a private
  // action, so an unresolvable private owner drops the action instead. The
  // check fails closed: if privacy cannot be determined we assume private.
  if (isPrivateSender(contents)) return null;

  // Fallback: previous behaviour (any other window) so a race during window
  // teardown degrades to the old routing instead of dropping the action.
  //
  // Every dereference below is guarded: a window that is mid-teardown stays
  // in getAllWindows() while its webContents is ALREADY destroyed, so a bare
  // `win.webContents.id` throws `Object has been destroyed` synchronously
  // inside the setWindowOpenHandler / will-navigate callback and escapes as
  // an unhandled main-process exception. (Same hazard bc5fbaa fixed in the
  // e2e sweeps; this is the product-code sibling.)
  try {
    const senderId = contents?.id;
    return (
      BrowserWindow.getAllWindows().find((win) => {
        try {
          if (!win || win.isDestroyed?.()) return false;
          const wc = win.webContents;
          if (!wc || wc.isDestroyed?.()) return false;
          return wc.id !== senderId;
        } catch {
          // This window went away between the guard and the read.
          return false;
        }
      }) || null
    );
  } catch {
    // getAllWindows() itself failed (app shutting down) — drop the action.
    return null;
  }
}

function registerWebContentsHandlers() {
  app.on('web-contents-created', (_event, contents) => {
    contents.once('destroyed', () => {
      activeBzzBases.delete(contents.id);
      cleanupX402WebContents(contents.id);
      cleanupAdblockWebContents(contents.id);
    });

    const id = contents.id;
    const type = contents.getType?.() || 'unknown';
    const tag = `[webcontents:${id}:${type}]`;

    // For webview contents, fix dark defaults and intercept navigation
    if (type === 'webview') {
      // Electron applies dark system colors (Canvas, CanvasText) to ALL pages when
      // nativeTheme is dark, even pages that don't opt in via color-scheme. This
      // makes pages without dark mode support unreadable (dark bg + unchanged text).
      // Inject light defaults at user-origin so pages with their own author-origin
      // CSS (including @media prefers-color-scheme: dark) override this naturally.
      contents.on('dom-ready', () => {
        const url = contents.getURL();
        const isInternal = url.startsWith('file:') && url.includes('/pages/');
        if (!isInternal) {
          contents
            .insertCSS('html, body { background-color: #fff; color: #000; color-scheme: light; }', {
              cssOrigin: 'user',
            })
            .catch(() => {});
        }
      });

      contents.setWindowOpenHandler(({ url, frameName, disposition }) => {
        log.info(
          `${tag} intercepted new window request: ${navUrlForLog(contents, url)} ` +
            `(target: ${frameName || 'none'}, disposition: ${disposition || 'default'})`
        );
        // Contract-hosted pages are not allowed to create windows themselves.
        // Trusted anchor activations are intercepted in webview-preload and
        // handed to the host renderer before this callback; anything reaching
        // here from a web3: document is therefore denied without navigation.
        if (contents.getURL().startsWith('web3://')) {
          return { action: 'deny' };
        }
        // Send message to the owning BrowserWindow to open URL in new tab
        const parentWindow = ownerWindowOf(contents);
        if (parentWindow) {
          // Pass targetName for named link targets (e.g. target="mywindow")
          // Skip special targets (_blank, _self, _parent, _top) - they should use default behavior
          const isNamedTarget = frameName && !frameName.startsWith('_');
          // Chromium already resolved the activation's modifiers into a
          // disposition: Ctrl/Cmd+click (and middle-click) give
          // `background-tab`, Shift+click and sized `window.open` popups give
          // `new-window`, a plain `target="_blank"` gives `foreground-tab`.
          // Forward it instead of collapsing everything into a foreground tab
          // the way this handler used to — that switched the user off the page
          // they were reading on every Ctrl+click. See #303. The renderer turns
          // `newWindow` back into the existing `window:new-with-url` request,
          // which is where the private-window guard lives.
          parentWindow.webContents.send('tab:new-with-url', url, isNamedTarget ? frameName : null, {
            background: disposition === 'background-tab',
            newWindow: disposition === 'new-window',
          });
        }
        return { action: 'deny' };
      });

      // Intercept navigation to custom protocols (freedom://, bzz://, ipfs://,
      // ipns://, web3://, rad:, ethereum:, ens://). `ens://` is included so legacy
      // links inside pages route through the renderer's ENS resolver instead
      // of failing as an unknown scheme — bookmarks created before the
      // transport-aware migration still carry the legacy prefix.
      contents.on('will-navigate', (event, url) => {
        // A CSP sandbox is the primary boundary for contract-hosted HTML. This
        // main-process guard is defence in depth: scripted location changes
        // cannot replace the isolated app with a mutable web origin. Genuine
        // link clicks are already routed through `link:navigate` by preload.
        if (contents.getURL().startsWith('web3://')) {
          log.info(`${tag} blocked onchain app navigation: ${navUrlForLog(contents, url)}`);
          event.preventDefault();
          return;
        }
        if (
          url.startsWith('freedom://') ||
          url.startsWith('bzz://') ||
          url.startsWith('ipfs://') ||
          url.startsWith('ipns://') ||
          url.startsWith('web3://') ||
          url.startsWith('ens://') ||
          url.startsWith('rad:') ||
          url.startsWith('ethereum:')
        ) {
          log.info(`${tag} intercepted custom protocol navigation: ${navUrlForLog(contents, url)}`);
          event.preventDefault();
          // Send to the owning window to handle via the browser's navigation system
          const parentWindow = ownerWindowOf(contents);
          if (parentWindow) {
            parentWindow.webContents.send('navigate-to-url', url);
          }
        }
      });
    }

    contents.on('render-process-gone', (_evt, details) => {
      log.error(`${tag} render-process-gone`, details);
    });

    contents.on('crashed', () => {
      log.error(`${tag} crashed event (legacy)`);
    });

    contents.on('unresponsive', () => {
      log.warn(`${tag} became unresponsive`);
    });

    contents.on('responsive', () => {
      log.warn(`${tag} responsive again`);
    });
  });

  app.on('child-process-gone', (_event, details) => {
    log.error('[child-process-gone]', details);
  });

  app.on('render-process-gone', (_event, details) => {
    log.error('[render-process-gone-global]', details);
  });
}

module.exports = {
  registerWebContentsHandlers,
};
