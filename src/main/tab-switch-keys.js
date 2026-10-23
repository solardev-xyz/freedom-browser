/**
 * Next Tab / Previous Tab, answered in the browser process (#556).
 *
 * These two chords used to reach the tab strip on one of two paths, both of
 * which hand the key to a renderer first:
 *
 *   - the chrome renderer's own keydown fallback (tabs.js), which only sees
 *     the key while the chrome itself has focus; and
 *   - the application-menu accelerator, which only fires once the focused
 *     page has seen the keydown, declined it, and Chromium has routed the
 *     unhandled event from the guest back through the embedder to the menu.
 *
 * A tab switch moves keyboard focus into the incoming tab's page on every
 * activation (#304), so from the second press on the key always starts in a
 * guest and everything rides on that second route. On macOS it does not hold
 * up: after a keyboard switch, a rebound chord such as Cmd+Opt+Right switched
 * exactly once and then did nothing until a mouse click on a tab reset focus
 * (#556). The same route also lets any page swallow the chord by calling
 * `preventDefault()` on its keydown.
 *
 * Chrome does not route tab switching through the page at all: its
 * `PreHandleKeyboardEvent` claims the tab-switch commands before the renderer
 * sees them ("Tab switching/closing accelerators aren't sent to the renderer
 * to avoid a hung/malicious renderer from interfering", RenderWidgetHostImpl).
 * Electron surfaces that same hook as `before-input-event`, so this module
 * listens there on the chrome window and on every tab webview, matches the
 * effective binding (a Settings > Shortcuts remap, else the registry default)
 * plus its fixed aliases, and tells the owning window's chrome to switch —
 * the same `tab:next` / `tab:prev` message the menu item sends. Claiming the
 * keydown (`preventDefault`) also stops the menu accelerator and the
 * renderer fallback, so one press is one switch, and Chromium drops the
 * matching keyup and char events on its own once the keydown is pre-handled.
 *
 * Select Tab 1–8 and Select Last Tab (Cmd/Ctrl+1…9, #717) ride the same
 * path: Chrome reserves them the same way (IDC_SELECT_TAB_0…7 and
 * IDC_SELECT_LAST_TAB), and the press usually starts in a focused page too.
 * They answer with `tab:select` and the position (1–8, or 'last').
 *
 * A select-tab press can also be another shortcut's own binding on some
 * layouts: on French AZERTY the `6` key types `-` unshifted, so Ctrl+6 is
 * also Zoom Out's press, and Zoom Out has no other main-row key there. That
 * press is Zoom Out's, so it is not claimed here. Only another entry's own
 * binding (default or remap) takes the press, not one of its fixed aliases:
 * on Czech the `1` key types `+`, which Zoom In accepts through its
 * `CmdOrCtrl+Plus` alias, but Zoom In keeps its own `=` key there while
 * Select Tab 1 has no other.
 *
 * Zoom is a page-overridable shortcut, unlike tab switching: on a US layout
 * Ctrl+- / Ctrl+= / Ctrl+0 reach the page first and only zoom once it has
 * declined the keydown, so a web app can bind them for its own canvas zoom.
 * A zoom press on the digit row must stay that way on every layout. But
 * from a focused page Chromium reports such a press to the menu as the
 * digit's VKEY (VKEY_6 for the AZERTY `-`, VKEY_0 with Shift for the German
 * `=`), so on Windows and Linux the zoom accelerator never fires, and the
 * chrome's keydown fallback only runs while the chrome has focus. Nothing
 * zoomed. So webview-preload.js reports a trusted digit-row keydown the page
 * left un-cancelled (`page:unhandled-key`), and `matchUnhandledPageKey`
 * sends the zoom for it — only when the menu cannot answer the press
 * itself: the AZERTY `0` key (`à`) is VKEY_0, which the menu's own Ctrl+0
 * accelerator already takes, so answering it here would zoom twice. macOS
 * matches menu key equivalents by character, so the menu answers these
 * there and nothing is sent from here.
 *
 * One exception: while Settings > Shortcuts is recording a new binding, the
 * page has to receive the chord it is about to record — swapping Next and
 * Previous, say, means recording the chord that is live on the other row
 * right now. The page reports when a recording starts and stops
 * (`shortcuts:set-recording`), and keys bound for that page are left alone
 * in between.
 */

const { BrowserWindow } = require('electron');
const IPC = require('../shared/ipc-channels');
const {
  SHORTCUTS,
  eventMatchesAccelerator,
  getEffectiveAccelerator,
  getAliasAccelerators,
} = require('../shared/shortcuts');
const { loadSettings } = require('./settings-store');
const { isMainBrowserWindow } = require('./windows/mainWindow');

const TAB_SWITCH_SHORTCUTS = [
  { id: 'tab.next', channel: IPC.TAB_NEXT, args: [] },
  { id: 'tab.previous', channel: IPC.TAB_PREV, args: [] },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((position) => ({
    id: `tab.select${position}`,
    channel: IPC.TAB_SELECT,
    args: [position],
    yieldsToOthers: true,
  })),
  { id: 'tab.selectLast', channel: IPC.TAB_SELECT, args: ['last'], yieldsToOthers: true },
];
const TAB_SWITCH_IDS = new Set(TAB_SWITCH_SHORTCUTS.map(({ id }) => id));

// The zoom entries, with the message their menu item sends (menu.js).
const ZOOM_CHANNELS = {
  'page.zoomIn': 'page:zoom-in',
  'page.zoomOut': 'page:zoom-out',
  'page.zoomReset': 'page:zoom-reset',
};

const ZOOM_ENTRIES = SHORTCUTS.filter((entry) => ZOOM_CHANNELS[entry.id]);
// Entries the application menu carries an accelerator for (menu.js).
const MENU_ENTRIES = SHORTCUTS.filter((entry) => entry.context !== 'renderer');

// webContents id → disarm function, for settings pages with a shortcut
// recording armed.
const recordingContents = new Map();

// net::ERR_ABORTED: a navigation cancelled before it committed.
const ERR_ABORTED = -3;

const currentOverrides = () => {
  try {
    return loadSettings()?.shortcutOverrides || {};
  } catch {
    return {};
  }
};

// Electron's `before-input-event` input object → the KeyboardEvent shape the
// shared matcher reads.
const inputAsKeyboardEvent = (input) => ({
  key: input.key,
  code: input.code,
  ctrlKey: Boolean(input.control),
  altKey: Boolean(input.alt),
  shiftKey: Boolean(input.shift),
  metaKey: Boolean(input.meta),
});

const acceleratorMatches = (event, accelerator, platform) =>
  Boolean(accelerator) && eventMatchesAccelerator(event, accelerator, platform);

const shortcutMatches = (event, id, overrides, platform) =>
  [getEffectiveAccelerator(id, overrides, platform), ...getAliasAccelerators(id, platform)].some(
    (accelerator) => acceleratorMatches(event, accelerator, platform)
  );

// The other registry entry whose own binding (default or remap — not a fixed
// alias) this press is, if any. Registry order, so on a press two of them
// share Zoom In comes first, as in the chrome's zoom keydown chain (menus.js).
const ownBindingElsewhere = (event, overrides, platform) =>
  SHORTCUTS.find(
    (entry) =>
      !TAB_SWITCH_IDS.has(entry.id) &&
      acceleratorMatches(event, getEffectiveAccelerator(entry.id, overrides, platform), platform)
  ) || null;

/**
 * The message a `before-input-event` input asks for, as `{ channel, args }`,
 * or null for a tab switch. A select-tab press that is another shortcut's
 * own binding is left alone (see above). Only key-downs count (Electron reports
 * Chromium's raw key-down as `keyDown`); auto-repeat does too, so holding
 * the chord keeps cycling the way it does in Chrome. A key still inside an
 * IME composition is the IME's.
 */
function matchTabKeyInput(input, overrides = {}, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.isComposing) return null;
  const event = inputAsKeyboardEvent(input);
  for (const { id, channel, args, yieldsToOthers } of TAB_SWITCH_SHORTCUTS) {
    if (!shortcutMatches(event, id, overrides, platform)) continue;
    // Another entry's own binding: left for that entry, unclaimed.
    if (yieldsToOthers && ownBindingElsewhere(event, overrides, platform)) return null;
    return { channel, args };
  }
  return null;
}

/**
 * The zoom message, as `{ channel, args }`, for a keydown a tab page saw and
 * did not cancel (`page:unhandled-key`, from webview-preload.js), or null.
 * Only a digit-row press typing something other than its digit that is a
 * zoom binding (own or fixed alias) and that the menu cannot answer itself
 * (see above). Registry order, so Zoom In wins a press two of them share
 * (menus.js).
 */
function matchUnhandledPageKey(event, overrides = {}, platform = process.platform) {
  if (platform === 'darwin' || !event || event.isComposing) return null;
  const digit = /^Digit(\d)$/.exec(typeof event.code === 'string' ? event.code : '');
  if (!digit || typeof event.key !== 'string' || event.key === digit[1]) return null;
  const press = {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey === true,
    altKey: event.altKey === true,
    shiftKey: event.shiftKey === true,
    metaKey: event.metaKey === true,
  };
  // Claimed in before-input-event already; a page never sees it.
  const asInput = {
    type: 'keyDown',
    key: press.key,
    code: press.code,
    control: press.ctrlKey,
    alt: press.altKey,
    shift: press.shiftKey,
    meta: press.metaKey,
  };
  if (matchTabKeyInput(asInput, overrides, platform)) return null;
  // What the menu sees: the digit's VKEY with the same modifiers.
  const asMenuSeesIt = { ...press, key: digit[1] };
  if (MENU_ENTRIES.some(({ id }) => shortcutMatches(asMenuSeesIt, id, overrides, platform))) {
    return null;
  }
  const entry = ZOOM_ENTRIES.find(({ id }) => shortcutMatches(press, id, overrides, platform));
  return entry ? { channel: ZOOM_CHANNELS[entry.id], args: [] } : null;
}

/** The tab-switch IPC channel a `before-input-event` input asks for, or null. */
function matchTabSwitchInput(input, overrides = {}, platform = process.platform) {
  return matchTabKeyInput(input, overrides, platform)?.channel ?? null;
}

// The chrome window a webContents belongs to: itself for the chrome
// renderer, its embedder's window for a tab webview. Null for anything that
// is not one of our browser windows (DevTools, a window mid-teardown).
function chromeWindowFor(contents) {
  try {
    const host = contents.hostWebContents || contents;
    const win = BrowserWindow.fromWebContents(host);
    if (win && !win.isDestroyed() && isMainBrowserWindow(win)) return win;
  } catch {
    // contents may be tearing down
  }
  return null;
}

function attachTabSwitchKeys(contents, { platform = process.platform } = {}) {
  contents.on('before-input-event', (event, input) => {
    if (recordingContents.has(contents.id)) return;
    const match = matchTabKeyInput(input, currentOverrides(), platform);
    if (!match) return;
    const win = chromeWindowFor(contents);
    if (!win) return;
    event.preventDefault();
    win.webContents.send(match.channel, ...match.args);
  });
}

// Settings > Shortcuts arms/disarms a recording. Cleared again if the page
// goes away mid-recording, so a stale flag can't leave the chords dead on
// whatever that webContents shows next.
function setShortcutRecording(contents, recording) {
  if (!contents || typeof contents.id !== 'number') return;
  const { id } = contents;
  if (!recording) {
    recordingContents.get(id)?.();
    return;
  }
  if (recordingContents.has(id)) return;
  // Disarm only once the settings page has actually been replaced, i.e. on
  // a main-frame cross-document *commit* — not when a navigation merely
  // starts. A navigation that starts but never commits (Stop, a link that
  // turns into a download, an external-protocol link) leaves the page — and
  // its armed recorder — in place, so the chords must keep reaching it.
  // `did-navigate` is main-frame and cross-document only (its own #hash
  // routing fires `did-navigate-in-page` instead). A failed navigation that
  // commits an error page over the settings page reports `did-fail-load`
  // instead of `did-navigate`; that also unloads the page, unless the error
  // is ERR_ABORTED (-3), which is exactly the never-committed case above.
  const onFailLoad = (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) disarm();
  };
  const disarm = () => {
    recordingContents.delete(id);
    contents.removeListener?.('did-navigate', disarm);
    contents.removeListener?.('did-fail-load', onFailLoad);
    contents.removeListener?.('destroyed', disarm);
  };
  recordingContents.set(id, disarm);
  contents.on?.('did-navigate', disarm);
  contents.on?.('did-fail-load', onFailLoad);
  contents.once?.('destroyed', disarm);
}

// A keydown a tab page left un-cancelled (webview-preload.js); see
// matchUnhandledPageKey.
function handleUnhandledPageKey(contents, payload, { platform = process.platform } = {}) {
  if (!contents || !payload || typeof payload !== 'object') return;
  if (recordingContents.has(contents.id)) return;
  const match = matchUnhandledPageKey(payload, currentOverrides(), platform);
  if (!match) return;
  const win = chromeWindowFor(contents);
  if (!win) return;
  win.webContents.send(match.channel, ...match.args);
}

function registerTabSwitchKeysIpc(ipcMain) {
  ipcMain.on(IPC.PAGE_UNHANDLED_KEY, (event, payload) => {
    handleUnhandledPageKey(event.sender, payload);
  });
  ipcMain.handle(IPC.SHORTCUTS_SET_RECORDING, (event, recording) => {
    setShortcutRecording(event.sender, recording === true);
    return true;
  });
}

module.exports = {
  attachTabSwitchKeys,
  matchTabKeyInput,
  matchTabSwitchInput,
  matchUnhandledPageKey,
  handleUnhandledPageKey,
  setShortcutRecording,
  registerTabSwitchKeysIpc,
  _isRecording: (id) => recordingContents.has(id),
  _resetRecording: () => recordingContents.clear(),
};
