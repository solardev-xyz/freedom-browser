#!/usr/bin/env electron
/**
 * Open the UI catalog (src/renderer/pages/ui-catalog.html, #1198) in its own
 * window: every shared block in both themes, side by side.
 *
 *   npm run ui:catalog
 *
 * The page is plain HTML and CSS, so any browser shows it just as well; this
 * only saves looking for the file. It is a development page, not one of the
 * app's internal pages, and packaged builds leave it out (package.json).
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');

const CATALOG = path.join(__dirname, '..', 'src', 'renderer', 'pages', 'ui-catalog.html');

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'UI catalog',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.loadFile(CATALOG);
});

app.on('window-all-closed', () => app.quit());
