'use strict';

/**
 * The approvals document (freedom-core design 0011, "The approvals document"
 * and "Rendering a page's data"; step APS-1), behind a flag.
 *
 * One per chrome window: a `WebContentsView` added to the window's
 * `contentView` above the chrome's own view, hidden until it has a prompt
 * to show, at the side of the content area below the toolbar, where the
 * wallet sidebar shows its prompts. The chrome can't paint over a view
 * stacked above it, and a page paints only inside its own guest.
 *
 * Its own document and preload (`renderer/approvals/approvals.html`,
 * `approvals-preload.js`), sandboxed, isolated, with no Node, no
 * `<webview>` and no preload in sub-frames. Its own in-memory partition,
 * whose `file:` handler serves the document's few files with the CSP and
 * nothing else, and whose request filter cancels everything else.
 * Navigation and popups are refused.
 *
 * With the flag on, main's page prompts (`page-prompts.js`) run between
 * main and this document:
 *
 *   page:prompt          main -> document  { handle, guest, kind, site, view }
 *   page:prompt-hidden   main -> document  { handle }
 *   page:prompt-closed   main -> document  { handle, reason } (and to the chrome)
 *   approvals:moved      main -> document  the panel moved or was resized
 *   approvals:theme      main -> document  { theme }: Settings > Appearance
 *   approvals:ready      document -> main  its listeners are set: send what shows
 *   approvals:shown      document -> main  { handle }: the prompt is on screen
 *                                          and the document's input delay started
 *   approvals:decide     document -> main  { handle, approve, choices }
 *                                          -> { ok } | { ok: false, reason }
 *
 * The chrome keeps `page:prompt-pending` and `page:prompt-closed` for the
 * badges and the count, and its `page:decide` is refused
 * (`page-requests.js`). It reports where its content area starts
 * (`page:approvals-anchor { top }`), which main clamps.
 *
 * The `approvals:*` handlers accept only the window's own view: the exact
 * webContents main created, its main frame, still on the packaged file.
 * Main refuses an approval that reaches it sooner than 500 ms after the
 * document last reported the prompt shown, or after main last showed or
 * moved the panel.
 *
 * The panel stays whole and actionable: the chrome's anchor never pushes
 * it below its minimum height, the window keeps a minimum size, and a
 * prompt that still has no room for the panel (a screen smaller than that
 * minimum) is closed as rejected rather than left pending, since the
 * chrome's decision is refused.
 *
 * The flag: `FREEDOM_APPROVALS_DOCUMENT=1` in the environment. It only
 * narrows what the chrome can do, so packaged builds honour it too. It
 * stays off by default until the panel's gaps close (Touch ID, a device's
 * feedback after the press, views over 256 KiB) and the page specs drive
 * it; the default flips in its own pull request.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { pathToFileURL, fileURLToPath } = require('url');

const FLAG = 'FREEDOM_APPROVALS_DOCUMENT';
// On the chrome's command line while the flag is on, so it makes room for
// the panel beside the content (preload.js; keep the two in sync).
const APPROVALS_RENDERER_ARG = '--freedom-approvals-document';

const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'renderer');
const APPROVALS_DIR = path.join(RENDERER_DIR, 'approvals');
const APPROVALS_HTML = path.join(APPROVALS_DIR, 'approvals.html');
const APPROVALS_URL = pathToFileURL(APPROVALS_HTML).href;
const PRELOAD = path.join(__dirname, 'approvals-preload.js');

// No `persist:` prefix: the partition lives in memory and holds nothing.
const PARTITION = 'freedom-approvals';

// Everything the partition serves: the document, its script and styles, and
// the chrome's colour tokens, so the panel paints from the chrome's palette.
const FILES = new Map([
  [APPROVALS_HTML, 'text/html; charset=utf-8'],
  [path.join(APPROVALS_DIR, 'approvals-core.js'), 'text/javascript; charset=utf-8'],
  [path.join(APPROVALS_DIR, 'approvals-kinds.js'), 'text/javascript; charset=utf-8'],
  [path.join(APPROVALS_DIR, 'approvals.js'), 'text/javascript; charset=utf-8'],
  [path.join(APPROVALS_DIR, 'approvals.css'), 'text/css; charset=utf-8'],
  [path.join(RENDERER_DIR, 'styles', 'variables.css'), 'text/css; charset=utf-8'],
]);

// Sent with every file the partition serves. The last two make every markup
// sink (`innerHTML`, `insertAdjacentHTML`, `document.write`) throw, so a
// slip in a template fails closed.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const RESPONSE_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
});

const CHANNELS = Object.freeze({
  PROMPT: 'page:prompt',
  HIDDEN: 'page:prompt-hidden',
  CLOSED: 'page:prompt-closed',
  MOVED: 'approvals:moved',
  THEME: 'approvals:theme',
  READY: 'approvals:ready',
  SHOWN: 'approvals:shown',
  DECIDE: 'approvals:decide',
  ANCHOR: 'page:approvals-anchor',
});

// The channels a renderer sends main here. The sender policy gives the
// first three to the approvals document alone (`ipc-sender-policy.js`).
const DOCUMENT_CHANNELS = Object.freeze([CHANNELS.READY, CHANNELS.SHOWN, CHANNELS.DECIDE]);

// Clicks and keys do nothing for this long after a prompt appears, its
// content changes, or the panel is shown again or moves; main refuses an
// approval sooner than this after the document reported the prompt shown.
const INPUT_DELAY_MS = 500;

// The panel: the wallet sidebar's width, at the right edge of the content
// area, from the top of the content area to the bottom of the window.
const PANEL_WIDTH = 320;
// Before the chrome's first report: the tab strip and the toolbar.
const DEFAULT_TOP = 85;
// However the chrome reports it, the panel starts no lower than this.
const MAX_TOP = 240;
// The least room the panel needs to show a prompt's heading, site and both
// buttons, with some of its body; however the chrome reports its anchor,
// the panel keeps this height.
const MIN_PANEL_WIDTH = 240;
const MIN_PANEL_HEIGHT = 240;
// The window's minimum size while the flag is on, so the panel always
// fits beside some content (outer size: room for a frame and title bar).
const MIN_WINDOW_SIZE = Object.freeze([480, 360]);

// The most of a view main forwards (design 0011, "What a prompt shows").
const MAX_VIEW_BYTES = 256 * 1024;

// Pinned, so a default change or a stray option can't weaken the renderer
// that holds the decision channel.
const WEB_PREFERENCES = Object.freeze({
  preload: PRELOAD,
  partition: PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  disableDialogs: true,
  safeDialogs: true,
  transparent: false,
});

function isApprovalsDocumentEnabled(env = process.env) {
  return env?.[FLAG] === '1';
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safely(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The document's own file a URL names, or null. */
function ownFile(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  let file;
  try {
    file = path.resolve(fileURLToPath(url));
  } catch {
    return null;
  }
  return FILES.has(file) ? file : null;
}

/** What main forwards of a prompt: its fields, and a view only within its size. */
function outgoingPrompt(payload) {
  let view = payload?.view;
  let bytes;
  try {
    const json = JSON.stringify(view);
    bytes = typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0;
  } catch {
    bytes = Infinity;
  }
  // Over its size, or not serializable: the document gets no view, shows
  // its fixed error, and the prompt can only be rejected.
  if (bytes > MAX_VIEW_BYTES) view = null;
  return {
    handle: payload?.handle,
    guest: payload?.guest,
    kind: payload?.kind,
    site: { key: payload?.site?.key, label: payload?.site?.label },
    view,
  };
}

/**
 * The panel's bounds in a window of `width` x `height`, below `top`, but
 * never so low that it is shorter than its minimum: in a short window it
 * rises over the toolbar rather than lose its buttons.
 */
function panelBounds({ width, height }, top) {
  const w = Math.max(0, Math.floor(width) || 0);
  const h = Math.max(0, Math.floor(height) || 0);
  const panelWidth = Math.min(PANEL_WIDTH, w);
  const y = Math.max(0, Math.min(clampTop(top), h - MIN_PANEL_HEIGHT));
  return { x: w - panelWidth, y, width: panelWidth, height: h - y };
}

// An approved prompt for an account that signs on a device: the panel stays
// up, saying where to confirm, until the decision's request is answered
// (APS-3; the chrome's screens held their device label the same way).
const DEVICES = new Set(['ledger', 'remote']);
const deviceOf = (prompt) => {
  const type = prompt?.view?.account?.type;
  return typeof type === 'string' && DEVICES.has(type) ? type : null;
};

/** Whether bounds leave the panel room for a whole, actionable prompt. */
const panelFits = (bounds) =>
  Boolean(bounds) && bounds.width >= MIN_PANEL_WIDTH && bounds.height >= MIN_PANEL_HEIGHT;

function clampTop(top) {
  if (typeof top !== 'number' || !Number.isFinite(top)) return DEFAULT_TOP;
  return Math.min(MAX_TOP, Math.max(0, Math.round(top)));
}

const sameBounds = (a, b) =>
  Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function defaultChromeWindowOf(contents) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.fromWebContents(contents);
  if (!win || win.isDestroyed() || win.webContents !== contents) return null;
  return Number.isInteger(win.id) ? win.id : null;
}

/**
 * @param {object} [options]
 * @param {() => Function} [options.WebContentsView] Electron's class.
 * @param {(partition: string) => object} [options.sessionFor]
 * @param {(windowId: number, payload: object) => Promise<object>} [options.decide]
 *   a decision for a handle of window `windowId` (`page-requests.js`
 *   `decideInWindow`), once main's own checks here have passed.
 * @param {(contents: object) => number|null} [options.chromeWindowOf]
 * @param {(file: string) => Promise<Buffer>} [options.readFile]
 * @param {() => number} [options.now] a monotonic clock, in ms.
 * @param {(fn: Function) => void} [options.defer] runs `fn` once the
 *   current call is over.
 * @param {() => string} [options.themeSetting] Settings > Appearance:
 *   'light', 'dark' or 'system'. The setting doesn't reach
 *   `prefers-color-scheme` on every platform, so the document is told.
 * @param {(listener: (theme: string) => void) => void} [options.onThemeChange]
 * @param {(entry: object) => void} [options.onTrace]
 */
function createApprovalsDocuments({
  WebContentsView = () => require('electron').WebContentsView,
  sessionFor = (partition) => require('electron').session.fromPartition(partition),
  decide = async () => ({ ok: false, reason: 'unavailable' }),
  chromeWindowOf = defaultChromeWindowOf,
  readFile = (file) => fs.promises.readFile(file),
  now = () => performance.now(),
  defer = (fn) => queueMicrotask(fn),
  themeSetting = () => 'system',
  onThemeChange = () => {},
  onTrace = () => {},
  log = console,
} = {}) {
  const byWindow = new Map(); // window id -> record
  const byContents = new Map(); // the view's webContents id -> record
  const preparedSessions = new WeakSet();

  const trace = (entry) => {
    try {
      onTrace(entry);
    } catch {
      // A test hook never changes what main does.
    }
  };

  // The partition: its own files with the CSP, every other request refused,
  // every permission denied, no download.
  async function serve(request) {
    const file = request?.method === 'GET' || request?.method === undefined ? ownFile(request?.url) : null;
    if (!file) {
      trace({ kind: 'request-refused', url: String(request?.url || '').slice(0, 200) });
      return new Response(null, { status: 404 });
    }
    const body = await readFile(file);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': FILES.get(file), ...RESPONSE_HEADERS },
    });
  }

  function prepareSession() {
    const ses = sessionFor(PARTITION);
    if (preparedSessions.has(ses)) return ses;
    preparedSessions.add(ses);
    ses.protocol.handle('file', (request) => serve(request));
    // Every request the partition sees is logged for the tests: a prompt's
    // data must make none (design 0011, APS-2's hostile data).
    ses.webRequest.onBeforeRequest((details, callback) => {
      const cancel = ownFile(details?.url) === null;
      trace({ kind: cancel ? 'request-refused' : 'request', url: String(details?.url || '').slice(0, 200) });
      callback({ cancel });
    });
    ses.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler?.(() => false);
    ses.setDevicePermissionHandler?.(() => false);
    ses.on?.('will-download', (event) => event.preventDefault());
    ses.setSpellCheckerEnabled?.(false);
    return ses;
  }

  // Navigation and popups refused, as `lockChromeWindow` refuses them for
  // the chrome. Main's own loads (`loadFile`, a reload) don't pass here.
  function lock(contents) {
    const refuse = (kind) => (event) => {
      event.preventDefault();
      trace({ kind, contents: contents.id });
    };
    contents.on('will-navigate', refuse('navigation-refused'));
    contents.on('will-frame-navigate', refuse('navigation-refused'));
    contents.on('will-redirect', refuse('navigation-refused'));
    contents.on('will-attach-webview', refuse('webview-refused'));
    contents.setWindowOpenHandler(() => {
      trace({ kind: 'popup-refused', contents: contents.id });
      return { action: 'deny' };
    });
  }

  function contentSize(record) {
    const size = safely(() => record.window.getContentSize(), null);
    return Array.isArray(size) ? { width: size[0], height: size[1] } : { width: 0, height: 0 };
  }

  function deliver(record, channel, payload) {
    if (!record.ready) return;
    try {
      if (!record.contents.isDestroyed()) record.contents.send(channel, payload);
    } catch {
      // The view mid-teardown: it closes with its window.
    }
  }

  // Restart main's input delay: the panel was shown, or moved.
  function arm(record) {
    record.armedAt = now();
  }

  // Place the panel; a move while it shows restarts the delay, in main and
  // in the document.
  function layout(record) {
    const bounds = panelBounds(contentSize(record), record.top);
    if (sameBounds(bounds, record.bounds)) return false;
    record.bounds = bounds;
    safely(() => record.view.setBounds(bounds));
    if (record.visible) {
      arm(record);
      trace({ kind: 'moved', window: record.windowId, bounds });
      deliver(record, CHANNELS.MOVED, null);
      rejectIfNoRoom(record);
    }
    return true;
  }

  /**
   * The prompt shown in a panel with no room for it (a window smaller than
   * its minimum size, on a screen smaller than that) can't be answered, and
   * the chrome's decision is refused: main closes it as rejected rather
   * than leave the page waiting.
   */
  function rejectIfNoRoom(record) {
    if (!record.shown || panelFits(record.bounds)) return;
    const handle = record.shown.handle;
    defer(() => {
      if (record.shown?.handle !== handle || panelFits(record.bounds)) return;
      trace({ kind: 'no-room', window: record.windowId, handle, bounds: { ...record.bounds } });
      Promise.resolve()
        .then(() => decide(record.windowId, { handle, approve: false }))
        .catch(() => {});
    });
  }

  function show(record) {
    layout(record);
    if (!record.visible) {
      record.visible = true;
      safely(() => record.view.setVisible(true));
    }
    arm(record);
    // The panel takes focus when it shows.
    safely(() => record.contents.focus());
    rejectIfNoRoom(record);
  }

  function hide(record) {
    if (!record.visible) return;
    record.visible = false;
    // Focus goes back to the chrome rather than to a view nobody sees.
    if (safely(() => record.contents.isFocused(), false)) safely(() => record.window.webContents.focus());
    safely(() => record.view.setVisible(false));
  }

  function forget(record) {
    if (byWindow.get(record.windowId) === record) byWindow.delete(record.windowId);
    if (byContents.get(record.contentsId) === record) byContents.delete(record.contentsId);
  }

  /** The window's approvals document: created with the window, hidden. */
  function attach(window) {
    const windowId = window?.id;
    if (!Number.isInteger(windowId)) return null;
    if (byWindow.has(windowId)) return byWindow.get(windowId);
    prepareSession();
    const View = WebContentsView();
    const view = new View({ webPreferences: { ...WEB_PREFERENCES } });
    const contents = view.webContents;
    const record = {
      windowId,
      window,
      view,
      contents,
      contentsId: contents.id,
      ready: false,
      visible: false,
      shown: null,
      report: null,
      // `{ handle, device }` while an approval for a device's account signs.
      waiting: null,
      armedAt: -Infinity,
      top: DEFAULT_TOP,
      bounds: null,
    };
    byWindow.set(windowId, record);
    byContents.set(record.contentsId, record);
    lock(contents);
    safely(() => view.setVisible(false));
    // Room for the panel beside some content, whatever the chrome asks for.
    safely(() => {
      const [minWidth, minHeight] = window.getMinimumSize?.() || [0, 0];
      window.setMinimumSize(Math.max(minWidth, MIN_WINDOW_SIZE[0]), Math.max(minHeight, MIN_WINDOW_SIZE[1]));
    });
    window.contentView.addChildView(view);
    layout(record);
    const relayout = () => layout(record);
    for (const event of ['resize', 'enter-full-screen', 'leave-full-screen']) window.on(event, relayout);
    // A document that has gone answers nothing until its replacement says
    // it is ready, and the prompt is sent to it again.
    contents.on('render-process-gone', () => {
      record.ready = false;
      record.report = null;
      safely(() => contents.reload());
    });
    // A committed document of its own (main's reload, or a load main didn't
    // make) is a new document: it says when it is ready. A navigation that
    // was refused never commits.
    contents.on('did-navigate', () => {
      record.ready = false;
      record.report = null;
    });
    contents.once('destroyed', () => forget(record));
    window.once('closed', () => {
      forget(record);
      safely(() => {
        if (!contents.isDestroyed()) contents.close();
      });
    });
    contents.loadFile(APPROVALS_HTML).catch((err) => {
      log.warn?.(`[approvals] the approvals document did not load: ${err?.message || err}`);
    });
    trace({ kind: 'attached', window: windowId, contents: record.contentsId });
    return record;
  }

  /**
   * A prompt message for window `windowId` (`page-requests.js` routes
   * `page:prompt`, `page:prompt-hidden` and `page:prompt-closed` here).
   * Which prompt shows is main's state, recorded before the document hears.
   */
  function send(windowId, channel, payload) {
    const record = byWindow.get(windowId);
    if (!record) return;
    const handle = payload?.handle;
    if (channel === CHANNELS.PROMPT) {
      const message = outgoingPrompt(payload);
      record.shown = message;
      record.report = null;
      record.waiting = null;
      show(record);
      trace({ kind: 'prompt', window: windowId, handle });
      deliver(record, CHANNELS.PROMPT, message);
    } else if (channel === CHANNELS.HIDDEN) {
      if (record.shown?.handle !== handle) return;
      record.shown = null;
      record.report = null;
      trace({ kind: 'hidden', window: windowId, handle });
      deliver(record, CHANNELS.HIDDEN, { handle });
      hide(record);
    } else if (channel === CHANNELS.CLOSED) {
      if (record.shown?.handle === handle) {
        record.shown = null;
        record.report = null;
        // Approved for a device: the panel stays up while it signs.
        if (record.waiting?.handle !== handle) hide(record);
      }
      trace({ kind: 'closed', window: windowId, handle });
      deliver(record, CHANNELS.CLOSED, { handle, reason: payload?.reason });
    }
  }

  /**
   * The record of the window whose approvals document sent `event`, or why
   * not: the exact webContents main created for it, its main frame, not
   * detached, still on the packaged file.
   */
  function senderOf(event) {
    let sender;
    let frame;
    try {
      sender = event?.sender;
      frame = event?.senderFrame;
    } catch {
      return { reason: 'no-sender' };
    }
    const record = Number.isInteger(sender?.id) ? byContents.get(sender.id) : null;
    if (!record || record.contents !== sender) return { reason: 'not-the-view' };
    try {
      if (sender.isDestroyed()) return { reason: 'not-the-view' };
      if (!frame || frame.detached) return { reason: 'detached' };
      if (frame !== sender.mainFrame) return { reason: 'sub-frame' };
      if (frame.url !== APPROVALS_URL) return { reason: 'navigated' };
    } catch {
      return { reason: 'detached' };
    }
    return { record };
  }

  function refused(channel, reason) {
    trace({ kind: 'sender-refused', channel, reason });
    return { ok: false, reason };
  }

  /** `approvals:ready`: the document listens now; send it what shows. */
  function ready(event) {
    const { record, reason } = senderOf(event);
    if (!record) return refused(CHANNELS.READY, reason);
    record.ready = true;
    record.report = null;
    trace({ kind: 'ready', window: record.windowId });
    deliver(record, CHANNELS.THEME, { theme: safely(() => themeSetting(), 'system') });
    if (record.shown) {
      arm(record);
      deliver(record, CHANNELS.PROMPT, record.shown);
    }
    return { ok: true };
  }

  /** `approvals:shown { handle }`: the prompt main shows is on screen. */
  function shown(event, payload) {
    const { record, reason } = senderOf(event);
    if (!record) return refused(CHANNELS.SHOWN, reason);
    const handle = isPlainObject(payload) ? payload.handle : undefined;
    if (typeof handle !== 'string' || record.shown?.handle !== handle) {
      trace({ kind: 'shown-ignored', window: record.windowId });
      return { ok: false, reason: 'not-shown' };
    }
    record.report = { handle, at: now() };
    trace({ kind: 'shown', window: record.windowId, handle, at: record.report.at });
    return { ok: true };
  }

  /**
   * `approvals:decide { handle, approve, choices }` from a window's own
   * document, for the handle main shows it at this moment. An approval
   * counts only once 500 ms have passed since the document reported that
   * prompt shown, and since main last showed or moved the panel.
   */
  async function decideFrom(event, payload) {
    const { record, reason } = senderOf(event);
    if (!record) return refused(CHANNELS.DECIDE, reason);
    const out = (result) => {
      trace({ kind: 'decide', window: record.windowId, ok: result.ok === true, reason: result.reason });
      return result;
    };
    if (!isPlainObject(payload) || typeof payload.handle !== 'string' || typeof payload.approve !== 'boolean') {
      return out({ ok: false, reason: 'invalid' });
    }
    if (record.shown?.handle !== payload.handle) return out({ ok: false, reason: 'not-shown' });
    if (payload.approve) {
      const report = record.report;
      if (!report || report.handle !== payload.handle) return out({ ok: false, reason: 'not-reported' });
      const at = now();
      if (at - report.at < INPUT_DELAY_MS || at - record.armedAt < INPUT_DELAY_MS) {
        return out({ ok: false, reason: 'too-soon' });
      }
    }
    // Approved for an account that signs on a device: the panel keeps
    // saying where to confirm until the request is answered.
    const device = payload.approve ? deviceOf(record.shown) : null;
    if (device) record.waiting = { handle: payload.handle, device };
    let result;
    try {
      result = await decide(record.windowId, payload);
    } catch {
      result = { ok: false, reason: 'failed' };
    }
    if (device && record.waiting?.handle === payload.handle) {
      record.waiting = null;
      if (!record.shown) hide(record);
    }
    return out(isPlainObject(result) ? result : { ok: false, reason: 'failed' });
  }

  /**
   * `page:approvals-anchor { top }` from a window's chrome: where its content
   * area starts. Clamped, so the panel stays beside the content, below the
   * toolbar, wherever the chrome says it is.
   */
  function anchor(event, payload) {
    const windowId = safely(() => chromeWindowOf(event?.sender), null);
    const record = Number.isInteger(windowId) ? byWindow.get(windowId) : null;
    if (!record || !isPlainObject(payload) || typeof payload.top !== 'number') return false;
    record.top = clampTop(payload.top);
    layout(record);
    return true;
  }

  function register(ipcMain) {
    onThemeChange((theme) => {
      for (const record of byWindow.values()) deliver(record, CHANNELS.THEME, { theme });
    });
    ipcMain.on(CHANNELS.READY, (event) => {
      ready(event);
    });
    ipcMain.on(CHANNELS.SHOWN, (event, payload) => {
      shown(event, payload);
    });
    ipcMain.handle(CHANNELS.DECIDE, (event, payload) => decideFrom(event, payload));
    ipcMain.on(CHANNELS.ANCHOR, (event, payload) => {
      anchor(event, payload);
    });
  }

  /** For tests and diagnostics: each window's panel. */
  function state() {
    const out = {};
    for (const [windowId, record] of byWindow) {
      out[windowId] = {
        contents: record.contentsId,
        ready: record.ready,
        visible: record.visible,
        bounds: record.bounds ? { ...record.bounds } : null,
        top: record.top,
        shown: record.shown ? record.shown.handle : null,
        reported: record.report ? record.report.handle : null,
        waiting: record.waiting ? record.waiting.device : null,
      };
    }
    return out;
  }

  return { attach, send, ready, shown, decide: decideFrom, anchor, register, state, serve };
}

// The app's one instance, and its test hooks: inert until the E2E harness
// enables them (test-harness.js, only under FREEDOM_TEST_MODE).
const sharedHooks = {};
let shared = null;

function getApprovalsDocuments() {
  if (!shared) {
    const settings = require('../settings-store');
    shared = createApprovalsDocuments({
      decide: (windowId, payload) => require('../page/page-requests').getPageRequests().decideInWindow(windowId, payload),
      themeSetting: () => settings.loadSettings().theme,
      onThemeChange: (listener) =>
        settings.onSettingsChanged((merged, previous) => {
          if (merged?.theme !== previous?.theme) listener(merged?.theme);
        }),
      onTrace: (entry) => sharedHooks.onTrace?.(entry),
      log: require('../logger'),
    });
  }
  return shared;
}

/** With the flag on: the window's approvals document (mainWindow.js). */
function attachApprovalsDocument(window) {
  if (!isApprovalsDocumentEnabled()) return null;
  return getApprovalsDocuments().attach(window);
}

/** With the flag on: the `approvals:*` handlers and the chrome's anchor. */
function registerApprovalsIpc(ipcMain = require('electron').ipcMain) {
  if (!isApprovalsDocumentEnabled()) return false;
  getApprovalsDocuments().register(ipcMain);
  return true;
}

/** Test only: what the harness exposes to specs (test-harness.js). */
function enableApprovalsTestHooks() {
  const trace = [];
  sharedHooks.onTrace = (entry) => {
    trace.push(entry);
    if (trace.length > 1000) trace.shift();
  };
  return {
    trace,
    enabled: () => isApprovalsDocumentEnabled(),
    state: () => getApprovalsDocuments().state(),
    partition: PARTITION,
    url: APPROVALS_URL,
    csp: CSP,
  };
}

module.exports = {
  FLAG,
  APPROVALS_RENDERER_ARG,
  CHANNELS,
  DOCUMENT_CHANNELS,
  CSP,
  PARTITION,
  APPROVALS_HTML,
  APPROVALS_URL,
  PRELOAD,
  FILES,
  INPUT_DELAY_MS,
  PANEL_WIDTH,
  DEFAULT_TOP,
  MAX_TOP,
  MIN_PANEL_WIDTH,
  MIN_PANEL_HEIGHT,
  MIN_WINDOW_SIZE,
  MAX_VIEW_BYTES,
  WEB_PREFERENCES,
  isApprovalsDocumentEnabled,
  ownFile,
  outgoingPrompt,
  panelBounds,
  panelFits,
  createApprovalsDocuments,
  getApprovalsDocuments,
  attachApprovalsDocument,
  registerApprovalsIpc,
  enableApprovalsTestHooks,
};
