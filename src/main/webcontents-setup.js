const log = require('./logger');
const { BrowserWindow, app } = require('electron');
const { activeBzzBases, activeIpfsBases } = require('./state');

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
  app.on('web-contents-created', (_event, contents) => {
    contents.once('destroyed', () => {
      activeBzzBases.delete(contents.id);
      activeIpfsBases.delete(contents.id);
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
          url.startsWith('ipns://')
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
