const log = require('./logger');
const { BrowserWindow, app, session } = require('electron');
const { activeBzzBases, activeIpfsBases, activeRadBases } = require('./state');
const tonManager = require('./ton-manager');
const { buildPacScript } = require('./ton-pac');
const { isTonHost } = require('../shared/ton-suffixes');

function registerTonCertHandler() {
  if (registerTonCertHandler._registered) return;
  registerTonCertHandler._registered = true;
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    try {
      const { hostname } = new URL(url);
      if (isTonHost(hostname)) {
        event.preventDefault();
        callback(true);
        return;
      }
    } catch {
      // fall through: non-parseable URL is not a TON host
    }
    // Do NOT call callback(false) here: Electron's default handler takes over
    // when we don't preventDefault(), and calling callback(false) would
    // incorrectly reject clearnet certs that Chromium would otherwise accept.
  });
}

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
      rawUrl.startsWith('freedom://')
    ) {
      return `${rawUrl.split('://')[0]}://<redacted>`;
    }
    return 'unknown';
  }
};

function registerWebContentsHandlers() {
  if (!registerWebContentsHandlers._tonEventsBound) {
    registerWebContentsHandlers._tonEventsBound = true;
    tonManager.events.on('started', ({ proxyPort }) => {
      session.defaultSession
        .setProxy({
          mode: 'pac_script',
          pacScript: buildPacScript({ proxyHost: '127.0.0.1', proxyPort }),
        })
        .then(() => log.info('[TON] session proxy applied, port=' + proxyPort))
        .catch((err) => log.error('[TON] setProxy failed', err));
    });

    tonManager.events.on('stopped', () => {
      session.defaultSession
        .setProxy({ mode: 'direct' })
        .then(() => log.info('[TON] session proxy cleared'))
        .catch((err) => log.error('[TON] setProxy(direct) failed', err));
    });
  }

  registerTonCertHandler();

  app.on('web-contents-created', (_event, contents) => {
    contents.once('destroyed', () => {
      activeBzzBases.delete(contents.id);
      activeIpfsBases.delete(contents.id);
      activeRadBases.delete(contents.id);
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

      contents.setWindowOpenHandler(({ url, frameName }) => {
        log.info(
          `${tag} intercepted new window request: ${sanitizeUrlForLog(url)} (target: ${frameName || 'none'})`
        );
        // Send message to the parent BrowserWindow to open URL in new tab
        const parentWindow = BrowserWindow.getAllWindows().find((win) => {
          return win.webContents.id !== contents.id;
        });
        if (parentWindow) {
          // Pass targetName for named link targets (e.g. target="mywindow")
          // Skip special targets (_blank, _self, _parent, _top) - they should use default behavior
          const isNamedTarget = frameName && !frameName.startsWith('_');
          parentWindow.webContents.send('tab:new-with-url', url, isNamedTarget ? frameName : null);
        }
        return { action: 'deny' };
      });

      // Intercept navigation to custom protocols (freedom://, bzz://, ipfs://, ipns://)
      contents.on('will-navigate', (event, url) => {
        if (
          url.startsWith('freedom://') ||
          url.startsWith('bzz://') ||
          url.startsWith('ipfs://') ||
          url.startsWith('ipns://') ||
          url.startsWith('rad:')
        ) {
          log.info(`${tag} intercepted custom protocol navigation: ${sanitizeUrlForLog(url)}`);
          event.preventDefault();
          // Send to parent window to handle via the browser's navigation system
          const parentWindow = BrowserWindow.getAllWindows().find((win) => {
            return win.webContents.id !== contents.id;
          });
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
