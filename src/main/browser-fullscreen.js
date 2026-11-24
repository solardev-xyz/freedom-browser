/**
 * Browser full screen: the chrome steps aside for the page (#78).
 *
 * F11, View → Enter Full Screen and the hamburger menu's full-screen button
 * all call `BrowserWindow.setFullScreen()`. On its own that only makes the
 * *window* fill the screen, with the tab strip, toolbar, bookmarks bar and
 * sidebar still stacked above the page. Every browser instead hides its own
 * chrome and lets the active page have the screen, so the window's state is
 * reported to its chrome renderer, which hides itself (lib/browser-fullscreen.js).
 *
 * The report rides the window's own `enter-full-screen`/`leave-full-screen`
 * events rather than the three call sites, so every way into or out of full
 * screen is covered the same: the menu, F11 (accelerator or the renderer's
 * fallback), the toolbar button, macOS's green button and a page's own
 * Fullscreen API request. It is re-sent whenever the chrome finishes loading,
 * so a reloaded chrome starts in the right state.
 *
 * Escape is the page's, as in Chrome's and Firefox's F11 mode: only the
 * full-screen binding (F11), View → Exit Full Screen or macOS's green button
 * leave. Claiming Escape would take it from every web app that uses it (a
 * modal's close, an editor's normal mode, a game's pause menu), and a page in
 * its own Fullscreen API full screen already gets Chromium's Escape to leave
 * that one.
 */

const IPC = require('../shared/ipc-channels');

/*
 * Free Mode: the same chrome-hiding as full screen, but the window keeps its
 * size and place on the desktop, for showing one page in a screen recording
 * or a live stream without the tab strip, toolbar or (on macOS) the traffic
 * lights in the shot. It is per window and lasts as long as the window does;
 * nothing is saved.
 *
 * Pointing at the window's top edge reveals a thin bar (the chrome's
 * #free-mode-bar) to move the window by, with the traffic lights back in it.
 * Main folds it the moment the cursor leaves it, watching the cursor while
 * it is up: the traffic lights are native and sit over the bar, so the
 * chrome's own pointer events would call the bar left as the pointer reached
 * them.
 *
 * The bar moves the window itself rather than being a drag region. A native
 * drag reports neither its start nor its end, and mid-drag the window's
 * bounds trail the cursor (and macOS holds the window at the menu bar while
 * the cursor goes on), so the cursor read as off the bar and the bar folded
 * under the drag. Here the chrome says when a drag starts, moves and ends,
 * and the bar stays for exactly that long. Entering Free Mode with the
 * cursor already where the bar goes (the toggle is there) reveals it
 * straight away.
 */
const freeModeWindows = new WeakSet();
// win -> interval watching the cursor while the bar is revealed
const revealedBars = new Map();

// Height of the chrome's #free-mode-bar (fullscreen.css).
const FREE_MODE_BAR_HEIGHT = 28;
// How often the cursor is checked while the bar is up: a frame at 60 Hz, so
// folding reads as immediate.
const BAR_WATCH_MS = 16;
// win -> { cursor, x, y } where a drag by the bar started
const drags = new Map();

const isBeingDragged = (win) => drags.has(win);
// Where macOS draws the traffic lights: in the tab strip normally, and
// centred in the thinner Free Mode bar.
const TRAFFIC_LIGHTS = { x: 14, y: 14 };
const FREE_MODE_TRAFFIC_LIGHTS = { x: 14, y: 8 };

const isFreeMode = (win) => freeModeWindows.has(win);
const isBarRevealed = (win) => revealedBars.has(win);

function sendTo(win, channel, value) {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed?.()) return;
  contents.send(channel, value);
}

function sendFullscreenState(win) {
  if (!win || win.isDestroyed()) return;
  sendTo(win, IPC.WINDOW_FULLSCREEN_CHANGED, win.isFullScreen());
}

function sendFreeModeState(win) {
  sendTo(win, IPC.WINDOW_FREE_MODE_CHANGED, isFreeMode(win));
}

// macOS draws the traffic lights over the chrome's own title bar
// (titleBarStyle 'hiddenInset'). In Free Mode they would sit on the page, so
// they show only while the bar is revealed, moved to fit it.
// macOS lays the lights out again only while they are showing: moved while
// hidden, they come back where they were. So they are shown before they are
// moved, and moved before they are hidden.
function applyWindowButtons(win) {
  if (process.platform !== 'darwin' || win.isDestroyed()) return;
  const visible = !isFreeMode(win) || isBarRevealed(win);
  const position = isFreeMode(win) ? FREE_MODE_TRAFFIC_LIGHTS : TRAFFIC_LIGHTS;
  if (visible) {
    win.setWindowButtonVisibility?.(true);
    win.setWindowButtonPosition?.(position);
  } else {
    win.setWindowButtonPosition?.(position);
    win.setWindowButtonVisibility?.(false);
  }
}

const cursorPoint = () => require('electron').screen.getCursorScreenPoint();

function cursorOverBar(win) {
  const point = cursorPoint();
  const bounds = win.getContentBounds();
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + FREE_MODE_BAR_HEIGHT
  );
}

function foldFreeModeBar(win) {
  drags.delete(win);
  if (!isBarRevealed(win)) return;
  clearInterval(revealedBars.get(win));
  revealedBars.delete(win);
  applyWindowButtons(win);
  sendTo(win, IPC.WINDOW_FREE_MODE_BAR_CHANGED, false);
}

/** The pointer reached the top edge of a Free Mode window: show the bar. */
function revealFreeModeBar(win) {
  if (!win || win.isDestroyed() || !isFreeMode(win) || win.isFullScreen()) return;
  // The chrome's ask can be stale: Chromium re-sends the pointer to the strip
  // under a bar that just folded. The cursor itself decides.
  if (isBarRevealed(win) || !cursorOverBar(win)) return;
  revealedBars.set(
    win,
    setInterval(() => {
      if (win.isDestroyed()) foldFreeModeBar(win);
      else if (!isBeingDragged(win) && !cursorOverBar(win)) foldFreeModeBar(win);
    }, BAR_WATCH_MS)
  );
  applyWindowButtons(win);
  sendTo(win, IPC.WINDOW_FREE_MODE_BAR_CHANGED, true);
}

/**
 * The chrome's drag on the bar: 'start' on press, 'move' as the pointer
 * moves, 'end' on release. The window follows the cursor from where it was
 * pressed, read here rather than sent, so a page cannot steer the window.
 */
function dragFreeModeBar(win, phase) {
  if (!win || win.isDestroyed()) return;
  if (phase === 'start') {
    if (!isBarRevealed(win)) return;
    const [x, y] = win.getPosition();
    drags.set(win, { cursor: cursorPoint(), x, y });
  } else if (phase === 'move') {
    const drag = drags.get(win);
    if (!drag) return;
    const point = cursorPoint();
    win.setPosition(drag.x + point.x - drag.cursor.x, drag.y + point.y - drag.cursor.y);
  } else if (phase === 'end') {
    drags.delete(win);
  }
}

function setFreeMode(win, on) {
  if (!win || win.isDestroyed()) return;
  if (on) freeModeWindows.add(win);
  else {
    foldFreeModeBar(win);
    freeModeWindows.delete(win);
  }
  applyWindowButtons(win);
  sendFreeModeState(win);
  if (on && cursorOverBar(win)) revealFreeModeBar(win);
}

function toggleFreeMode(win) {
  setFreeMode(win, !isFreeMode(win));
}

/**
 * Report a chrome window's full-screen and Free Mode state to its renderer,
 * now and on every change.
 */
function attachFullscreenChromeSync(win) {
  win.on('enter-full-screen', () => {
    foldFreeModeBar(win);
    sendFullscreenState(win);
  });
  win.on('leave-full-screen', () => {
    sendFullscreenState(win);
    // macOS puts the traffic lights back on its way out of full screen.
    if (isFreeMode(win)) applyWindowButtons(win);
  });
  win.on('closed', () => {
    clearInterval(revealedBars.get(win));
    revealedBars.delete(win);
    drags.delete(win);
  });
  win.webContents?.on('did-finish-load', () => {
    sendFullscreenState(win);
    sendFreeModeState(win);
  });
}

module.exports = {
  TRAFFIC_LIGHTS,
  attachFullscreenChromeSync,
  isFreeMode,
  setFreeMode,
  toggleFreeMode,
  revealFreeModeBar,
  dragFreeModeBar,
};
