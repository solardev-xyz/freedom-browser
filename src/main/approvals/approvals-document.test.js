// The approvals document, main's side (freedom-core design 0011, "The
// approvals document" and "Rendering a page's data"; APS-1): one view per
// chrome window, its partition, its navigation and popup refusals, the
// exact sender checks on `approvals:*`, the routing of main's prompts to it
// with the flag on, and main's own 500 ms refusal.

const { EventEmitter } = require('events');
const path = require('path');
const { pathToFileURL } = require('url');
const approvals = require('./approvals-document');
const { createPageDocuments } = require('../page/page-documents');
const { createPageRequests } = require('../page/page-requests');
const { createWalletApprovals, REJECTED, LIMITED } = require('./wallet-approvals');

const {
  createApprovalsDocuments,
  isApprovalsDocumentEnabled,
  attachApprovalsDocument,
  registerApprovalsIpc,
  ownFile,
  outgoingPrompt,
  viewParts,
  panelBounds,
  APPROVALS_HTML,
  APPROVALS_URL,
  PRELOAD,
  PARTITION,
  CSP,
  CHANNELS,
  INPUT_DELAY_MS,
  MAX_VIEW_BYTES,
  MAX_PARTED_VIEW_BYTES,
  VIEW_PART_UNITS,
  DEFAULT_TOP,
  MAX_TOP,
  MIN_PANEL_WIDTH,
  MIN_PANEL_HEIGHT,
  MIN_WINDOW_SIZE,
  panelFits,
} = approvals;

const RENDERER = path.resolve(__dirname, '..', '..', 'renderer');
const HANDLE = 'a'.repeat(64);
const OTHER_HANDLE = 'b'.repeat(64);
const SITE = { key: `bzz://${'c'.repeat(64)}`, label: `bzz://${'c'.repeat(64)}` };
const VIEW = { title: 'One', message: 'About one', rows: [] };
const prompt = (handle = HANDLE, view = VIEW) => ({ handle, guest: 7, kind: 'test.prompt', site: SITE, view });
// The revision of the prompt main sent a document last: what the document
// names when it reports that prompt shown (APS-4).
const sentRevision = (contents) => contents.sent.filter(([channel]) => channel === CHANNELS.PROMPT).at(-1)?.[1]?.revision;
// A prompt's message as main forwards it: its own fields and its revision.
const delivered = (revision, handle = HANDLE, view = VIEW) => ({ handle, revision, guest: 7, kind: 'test.prompt', site: SITE, view });

let nextContentsId = 100;

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextContentsId++;
    this.destroyed = false;
    this.focused = false;
    this.sent = [];
    this.loaded = [];
    this.mainFrame = { url: APPROVALS_URL, detached: false };
    this.openHandler = null;
    this.closed = false;
    this.reloads = 0;
  }

  isDestroyed() {
    return this.destroyed;
  }

  send(channel, payload) {
    this.sent.push([channel, payload]);
  }

  focus() {
    this.focused = true;
  }

  isFocused() {
    return this.focused;
  }

  setWindowOpenHandler(handler) {
    this.openHandler = handler;
  }

  loadFile(file) {
    this.loaded.push(file);
    return Promise.resolve();
  }

  reload() {
    this.reloads += 1;
  }

  close() {
    this.closed = true;
    this.destroyed = true;
    this.emit('destroyed');
  }
}

class FakeView {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeContents();
    this.bounds = [];
    this.visibility = [];
  }

  setBounds(bounds) {
    this.bounds.push(bounds);
  }

  setVisible(visible) {
    this.visibility.push(visible);
  }

  get visible() {
    return this.visibility.at(-1);
  }
}

class FakeWindow extends EventEmitter {
  constructor(id, size = [1200, 800]) {
    super();
    this.id = id;
    this.size = size;
    this.children = [];
    this.contentView = { addChildView: (view) => this.children.push(view) };
    this.webContents = { id: 500 + id, focused: false, focus() { this.focused = true; } };
    this.minimum = [0, 0];
  }

  getContentSize() {
    return this.size;
  }

  getMinimumSize() {
    return this.minimum;
  }

  setMinimumSize(width, height) {
    this.minimum = [width, height];
  }
}

function fakeSession() {
  const ses = new EventEmitter();
  ses.handlers = {};
  ses.protocol = { handle: (scheme, fn) => (ses.handlers[scheme] = fn) };
  ses.webRequest = { onBeforeRequest: (fn) => (ses.beforeRequest = fn) };
  ses.setPermissionRequestHandler = (fn) => (ses.permissionRequest = fn);
  ses.setPermissionCheckHandler = (fn) => (ses.permissionCheck = fn);
  ses.setDevicePermissionHandler = (fn) => (ses.devicePermission = fn);
  ses.setSpellCheckerEnabled = (enabled) => (ses.spellcheck = enabled);
  return ses;
}

function setup({ theme = 'system' } = {}) {
  let clock = 0;
  const ses = fakeSession();
  const partitions = [];
  const views = [];
  const decisions = [];
  const trace = [];
  const themeListeners = [];
  const decide = jest.fn(async (windowId, payload) => {
    decisions.push([windowId, payload]);
    return { ok: true };
  });
  const deferred = [];
  const docs = createApprovalsDocuments({
    defer: (fn) => deferred.push(fn),
    WebContentsView: () =>
      class extends FakeView {
        constructor(options) {
          super(options);
          views.push(this);
        }
      },
    sessionFor: (partition) => {
      partitions.push(partition);
      return ses;
    },
    decide,
    chromeWindowOf: (contents) => (contents?.id >= 500 && contents.id < 600 ? contents.id - 500 : null),
    readFile: async (file) => Buffer.from(`contents of ${path.basename(file)}`),
    now: () => clock,
    themeSetting: () => theme,
    onThemeChange: (listener) => themeListeners.push(listener),
    onTrace: (entry) => trace.push(entry),
    log: { warn: () => {} },
  });
  const ipc = { on: jest.fn(), handle: jest.fn() };
  docs.register(ipc);
  const advance = (ms) => {
    clock += ms;
  };
  const runDeferred = async () => {
    while (deferred.length) deferred.shift()();
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
  };
  return { docs, ses, partitions, views, decide, decisions, trace, advance, themeListeners, ipc, runDeferred };
}

/** An IPC event from `contents`' main frame, or the frame given. */
const eventFrom = (contents, senderFrame = contents.mainFrame) => ({ sender: contents, senderFrame });

/** A window with its document attached and ready. */
function attached(env, id = 1) {
  const window = new FakeWindow(id);
  const record = env.docs.attach(window);
  const contents = record.contents;
  expect(env.docs.ready(eventFrom(contents))).toEqual({ ok: true });
  contents.sent.length = 0;
  return { window, contents, view: record.view };
}

describe('the flag', () => {
  test('on by default; FREEDOM_APPROVALS_DOCUMENT=0 turns it off in a development build, and nothing else does', () => {
    const dev = { packaged: false };
    expect(isApprovalsDocumentEnabled({}, dev)).toBe(true);
    for (const value of [undefined, '', '1']) {
      expect(isApprovalsDocumentEnabled({ FREEDOM_APPROVALS_DOCUMENT: value }, dev)).toBe(true);
    }
    expect(isApprovalsDocumentEnabled({ FREEDOM_APPROVALS_DOCUMENT: '0' }, dev)).toBe(false);
    // Any other value is a mistake: warned of, and the default runs.
    for (const value of ['false', 'off', 'no', ' 0', '00']) {
      expect(isApprovalsDocumentEnabled({ FREEDOM_APPROVALS_DOCUMENT: value }, dev)).toBe(true);
    }
  });

  test('a packaged build always runs it, whatever the environment says', () => {
    for (const value of [undefined, '', '0', '1', 'off']) {
      expect(isApprovalsDocumentEnabled({ FREEDOM_APPROVALS_DOCUMENT: value }, { packaged: true })).toBe(true);
    }
  });

  test('on with no variable set (a development build under jest)', () => {
    const saved = process.env.FREEDOM_APPROVALS_DOCUMENT;
    delete process.env.FREEDOM_APPROVALS_DOCUMENT;
    try {
      expect(isApprovalsDocumentEnabled()).toBe(true);
    } finally {
      if (saved !== undefined) process.env.FREEDOM_APPROVALS_DOCUMENT = saved;
    }
  });

  test('turned off (=0): no document for a window, no handlers', () => {
    const saved = process.env.FREEDOM_APPROVALS_DOCUMENT;
    process.env.FREEDOM_APPROVALS_DOCUMENT = '0';
    try {
      expect(attachApprovalsDocument(new FakeWindow(9))).toBeNull();
      const ipc = { on: jest.fn(), handle: jest.fn() };
      expect(registerApprovalsIpc(ipc)).toBe(false);
      expect(ipc.on).not.toHaveBeenCalled();
      expect(ipc.handle).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.FREEDOM_APPROVALS_DOCUMENT = saved;
    }
  });
});

describe('one document per chrome window', () => {
  test('a view added above the chrome, hidden, sandboxed, in its own in-memory partition, on the packaged file', () => {
    const env = setup();
    const window = new FakeWindow(1);
    const record = env.docs.attach(window);
    const [view] = env.views;
    expect(window.children).toEqual([view]);
    expect(view.visibility).toEqual([false]);
    expect(view.options.webPreferences).toMatchObject({
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
    });
    expect(PARTITION.startsWith('persist:')).toBe(false);
    expect(env.partitions).toEqual([PARTITION]);
    expect(PRELOAD).toBe(path.join(__dirname, 'approvals-preload.js'));
    expect(view.webContents.loaded).toEqual([APPROVALS_HTML]);
    expect(APPROVALS_HTML).toBe(path.join(RENDERER, 'approvals', 'approvals.html'));
    expect(APPROVALS_URL).toBe(pathToFileURL(APPROVALS_HTML).href);
    // At the right edge, below the toolbar, the wallet sidebar's width.
    expect(view.bounds).toEqual([{ x: 1200 - 320, y: DEFAULT_TOP, width: 320, height: 800 - DEFAULT_TOP }]);
    // Once per window.
    expect(env.docs.attach(window)).toBe(record);
    expect(env.views).toHaveLength(1);
    expect(env.docs.state()[1]).toMatchObject({ visible: false, shown: null, ready: false });
  });

  test('the window closing takes its document with it', () => {
    const env = setup();
    const { window, contents } = attached(env);
    window.emit('closed');
    expect(contents.closed).toBe(true);
    expect(env.docs.state()).toEqual({});
  });

  test('the panel moves with the window, and with the content area\'s top the chrome reports, clamped', () => {
    const env = setup();
    const { window, view } = attached(env);
    window.size = [1000, 700];
    window.emit('resize');
    expect(view.bounds.at(-1)).toEqual({ x: 680, y: DEFAULT_TOP, width: 320, height: 615 });
    const chrome = { id: 501 };
    expect(env.docs.anchor({ sender: chrome }, { top: 120.4 })).toBe(true);
    expect(view.bounds.at(-1)).toEqual({ x: 680, y: 120, width: 320, height: 580 });
    // However the chrome reports it, the panel stays beside the content.
    env.docs.anchor({ sender: chrome }, { top: 5000 });
    expect(view.bounds.at(-1).y).toBe(MAX_TOP);
    env.docs.anchor({ sender: chrome }, { top: -40 });
    expect(view.bounds.at(-1).y).toBe(0);
    // Not a number, or not this window's chrome: nothing moves.
    const moves = view.bounds.length;
    expect(env.docs.anchor({ sender: chrome }, { top: '90' })).toBe(false);
    expect(env.docs.anchor({ sender: { id: 77 } }, { top: 90 })).toBe(false);
    expect(env.docs.anchor({ sender: { id: 502 } }, { top: 90 })).toBe(false);
    expect(view.bounds).toHaveLength(moves);
  });

  test('panelBounds: never wider than the window, never shorter than its minimum while the window has room', () => {
    expect(panelBounds({ width: 1200, height: 800 }, Number.NaN)).toEqual({ x: 880, y: DEFAULT_TOP, width: 320, height: 715 });
    // A short window: the panel rises over the toolbar rather than lose
    // its buttons, however low the chrome says the content starts.
    expect(panelBounds({ width: 1200, height: 400 }, MAX_TOP)).toEqual({ x: 880, y: 400 - MIN_PANEL_HEIGHT, width: 320, height: MIN_PANEL_HEIGHT });
    expect(panelBounds({ width: 1200, height: MIN_PANEL_HEIGHT }, MAX_TOP)).toEqual({ x: 880, y: 0, width: 320, height: MIN_PANEL_HEIGHT });
    // No room at all (a window below its minimum size): it fills what there is.
    expect(panelBounds({ width: 200, height: 100 }, 85)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(panelFits(panelBounds({ width: 1200, height: 400 }, MAX_TOP))).toBe(true);
    expect(panelFits(panelBounds({ width: 300, height: 200 }, MAX_TOP))).toBe(false);
    expect(panelFits(panelBounds({ width: MIN_PANEL_WIDTH - 1, height: 800 }, 0))).toBe(false);
    expect(panelFits(null)).toBe(false);
  });

  test('the window keeps a minimum size while the flag is on, never lowering one it has', () => {
    const env = setup();
    const window = new FakeWindow(1);
    env.docs.attach(window);
    expect(window.minimum).toEqual([...MIN_WINDOW_SIZE]);
    // The panel fits beside some content at that size, frame and title bar
    // taken off.
    expect(MIN_WINDOW_SIZE[0] - 40).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
    expect(MIN_WINDOW_SIZE[1] - 80).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT);
    const bigger = new FakeWindow(2);
    bigger.minimum = [900, 700];
    env.docs.attach(bigger);
    expect(bigger.minimum).toEqual([900, 700]);
  });

  test('the chrome\'s anchor never leaves the panel without its buttons (the 300x200 window)', async () => {
    const env = setup();
    const { window, view, contents } = attached(env);
    const chrome = { id: 501 };
    env.docs.anchor({ sender: chrome }, { top: MAX_TOP });
    window.size = [1200, 400];
    window.emit('resize');
    expect(view.bounds.at(-1)).toEqual({ x: 880, y: 160, width: 320, height: MIN_PANEL_HEIGHT });
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    await env.runDeferred();
    expect(env.decide).not.toHaveBeenCalled();
    expect(env.docs.state()[1].shown).toBe(HANDLE);
    // Smaller than the window's minimum size can make it: no room for the
    // panel, and the chrome's decision is refused, so main rejects.
    window.size = [300, 200];
    window.emit('resize');
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    await env.runDeferred();
    expect(env.decisions).toEqual([[1, { handle: HANDLE, approve: false }]]);
    expect(env.trace.map((e) => e.kind)).toContain('no-room');
    expect(contents.sent.map(([channel]) => channel)).toContain(CHANNELS.PROMPT);
  });

  test('a prompt that arrives with no room for the panel is closed as rejected', async () => {
    const env = setup();
    const window = new FakeWindow(1, [300, 200]);
    const { contents } = env.docs.attach(window);
    env.docs.ready(eventFrom(contents));
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    await env.runDeferred();
    expect(env.decisions).toEqual([[1, { handle: HANDLE, approve: false }]]);
    // Once it is gone, nothing more.
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    window.emit('resize');
    await env.runDeferred();
    expect(env.decisions).toHaveLength(1);
  });
});

describe('its partition', () => {
  test('serves the document\'s own files with the CSP, and nothing else', async () => {
    const env = setup();
    attached(env);
    const serve = env.ses.handlers.file;
    const ok = await serve({ method: 'GET', url: APPROVALS_URL });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(ok.headers.get('content-security-policy')).toBe(CSP);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await ok.text()).toBe('contents of approvals.html');
    for (const file of ['approvals/approvals.js', 'approvals/approvals.css', 'styles/variables.css']) {
      const res = await serve({ method: 'GET', url: pathToFileURL(path.join(RENDERER, file)).href });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe(CSP);
    }
    for (const url of [
      pathToFileURL(path.join(RENDERER, 'index.html')).href,
      pathToFileURL(path.join(RENDERER, 'approvals', 'other.html')).href,
      `${pathToFileURL(path.join(RENDERER, 'approvals')).href}/../index.html`,
      'file:///etc/passwd',
      'file://host/share/approvals.html',
      'https://example.com/',
      'data:text/html,<p>x</p>',
    ]) {
      expect((await serve({ method: 'GET', url })).status).toBe(404);
    }
    expect((await serve({ method: 'POST', url: APPROVALS_URL })).status).toBe(404);
  });

  test('the design\'s CSP, word for word', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
        "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; " +
        "frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'"
    );
  });

  test('refuses every request but its own files, every permission, and every download', () => {
    const env = setup();
    attached(env);
    const verdict = (url) => {
      let out;
      env.ses.beforeRequest({ url }, (answer) => (out = answer));
      return out;
    };
    expect(verdict(APPROVALS_URL)).toEqual({ cancel: false });
    expect(verdict(pathToFileURL(path.join(RENDERER, 'styles', 'variables.css')).href)).toEqual({ cancel: false });
    for (const url of ['https://example.com/', 'http://127.0.0.1:1633/', 'ws://x/', 'file:///etc/passwd', 'bzz://x', 'data:,x', '']) {
      expect(verdict(url)).toEqual({ cancel: true });
    }
    let granted;
    env.ses.permissionRequest(null, 'media', (answer) => (granted = answer));
    expect(granted).toBe(false);
    expect(env.ses.permissionCheck(null, 'clipboard-read')).toBe(false);
    expect(env.ses.devicePermission({})).toBe(false);
    const download = { preventDefault: jest.fn() };
    env.ses.emit('will-download', download, {}, {});
    expect(download.preventDefault).toHaveBeenCalled();
    expect(env.ses.spellcheck).toBe(false);
  });

  test('prepared once, however many windows', () => {
    const env = setup();
    attached(env, 1);
    const first = env.ses.handlers.file;
    attached(env, 2);
    expect(env.ses.handlers.file).toBe(first);
  });

  test('ownFile: exact paths only', () => {
    expect(ownFile(APPROVALS_URL)).toBe(APPROVALS_HTML);
    expect(ownFile(`${APPROVALS_URL}?x#y`)).toBe(APPROVALS_HTML);
    expect(ownFile(pathToFileURL('/tmp/renderer/approvals/approvals.html').href)).toBeNull();
    expect(ownFile(null)).toBeNull();
    expect(ownFile('approvals.html')).toBeNull();
  });
});

describe('navigation and popups', () => {
  test('refused: will-navigate, will-frame-navigate, will-redirect, a webview, window.open', () => {
    const env = setup();
    const { contents } = attached(env);
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      const event = { preventDefault: jest.fn() };
      contents.emit(name, event, 'https://example.com/');
      expect(event.preventDefault).toHaveBeenCalled();
    }
    expect(contents.openHandler({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    expect(env.trace.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['navigation-refused', 'webview-refused', 'popup-refused'])
    );
  });

  test('a committed navigation is a new document: it answers nothing until it says it is ready', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    contents.emit('did-navigate');
    expect(env.docs.state()[1].ready).toBe(false);
    contents.sent.length = 0;
    env.docs.send(1, CHANNELS.HIDDEN, { handle: HANDLE });
    expect(contents.sent).toEqual([]);
  });

  test('a renderer that has gone is reloaded, and gets the prompt again when it is ready', () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    contents.emit('render-process-gone');
    expect(contents.reloads).toBe(1);
    expect(env.docs.state()[1]).toMatchObject({ ready: false, shown: HANDLE });
    contents.sent.length = 0;
    env.docs.ready(eventFrom(contents));
    expect(contents.sent.map(([channel]) => channel)).toEqual([CHANNELS.THEME, CHANNELS.PROMPT]);
  });
});

describe('the sender checks', () => {
  test('only the window\'s own view, its main frame, on the packaged file', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) })).toEqual({ ok: true });

    // Another webContents, even with the view's id, a sub-frame, a frame
    // that went, and the view after it navigated, in place or not.
    const impostor = new FakeContents();
    impostor.id = contents.id;
    const cases = [
      [eventFrom(impostor), 'not-the-view'],
      [eventFrom(new FakeContents()), 'not-the-view'],
      [{ sender: contents, senderFrame: { url: APPROVALS_URL, detached: false } }, 'sub-frame'],
      [{ sender: contents, senderFrame: null }, 'detached'],
      [{ sender: contents, senderFrame: { ...contents.mainFrame, detached: true } }, 'detached'],
      [{}, 'not-the-view'],
      [null, 'not-the-view'],
    ];
    for (const [event, reason] of cases) {
      expect(await env.docs.decide(event, { handle: HANDLE, approve: false })).toEqual({ ok: false, reason });
      expect(env.docs.shown(event, { handle: HANDLE })).toEqual({ ok: false, reason });
      expect(env.docs.ready(event)).toEqual({ ok: false, reason });
    }
    for (const url of [`${APPROVALS_URL}?moved`, `${APPROVALS_URL}#x`, pathToFileURL(path.join(RENDERER, 'approvals', 'approvals.css')).href, 'data:text/html,x']) {
      contents.mainFrame.url = url;
      expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: false })).toEqual({
        ok: false,
        reason: 'navigated',
      });
    }
    contents.mainFrame.url = APPROVALS_URL;
    contents.destroyed = true;
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: false })).toEqual({
      ok: false,
      reason: 'not-the-view',
    });
    expect(env.decide).not.toHaveBeenCalled();
  });

  test('a document decides only for its own window, and only the handle that window shows', async () => {
    const env = setup();
    const one = attached(env, 1);
    const two = attached(env, 2);
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE));
    env.docs.shown(eventFrom(one.contents), { handle: HANDLE, revision: sentRevision(one.contents) });
    env.advance(INPUT_DELAY_MS);
    // Window 2's document, for window 1's handle: it shows nothing.
    expect(await env.docs.decide(eventFrom(two.contents), { handle: HANDLE, approve: true })).toEqual({
      ok: false,
      reason: 'not-shown',
    });
    // Window 1's, for a handle it doesn't show.
    expect(await env.docs.decide(eventFrom(one.contents), { handle: OTHER_HANDLE, approve: false })).toEqual({
      ok: false,
      reason: 'not-shown',
    });
    expect(env.decide).not.toHaveBeenCalled();
    expect(await env.docs.decide(eventFrom(one.contents), { handle: HANDLE, approve: true })).toEqual({ ok: true });
    expect(env.decisions).toEqual([[1, { handle: HANDLE, approve: true }]]);
  });

  test('a decision of the wrong shape is refused', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    for (const payload of [null, 'x', [], { handle: 1, approve: true }, { handle: HANDLE, approve: 'yes' }, { handle: HANDLE }]) {
      expect(await env.docs.decide(eventFrom(contents), payload)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('main\'s own input delay', () => {
  test('an approval at 0 ms and at 499 ms after the report is refused; at 500 ms it counts', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    // Before any report: refused.
    env.advance(INPUT_DELAY_MS * 4);
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({
      ok: false,
      reason: 'not-reported',
    });
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: false, reason: 'too-soon' });
    env.advance(499);
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: false, reason: 'too-soon' });
    expect(env.decide).not.toHaveBeenCalled();
    env.advance(1);
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: true });
    expect(env.decide).toHaveBeenCalledTimes(1);
  });

  test('a rejection needs no wait', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: false })).toEqual({ ok: true });
  });

  test('the delay starts again for a new prompt, a changed one, the panel shown again, and the panel moved', async () => {
    const env = setup();
    const { window, contents } = attached(env);
    const approve = () => env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true });
    const showAndWait = () => {
      env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
      env.advance(INPUT_DELAY_MS);
    };
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    showAndWait();

    // A changed prompt (main shows it again with a new view): the old
    // report counts for nothing.
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, { ...VIEW, title: 'Changed' }));
    expect(await approve()).toEqual({ ok: false, reason: 'not-reported' });
    showAndWait();

    // Hidden, and shown again.
    env.docs.send(1, CHANNELS.HIDDEN, { handle: HANDLE });
    expect(await approve()).toEqual({ ok: false, reason: 'not-shown' });
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    expect(await approve()).toEqual({ ok: false, reason: 'not-reported' });
    showAndWait();

    // Moved: the report still stands, but main's own clock starts again,
    // and the document is told to restart its delay.
    contents.sent.length = 0;
    window.size = [1100, 800];
    window.emit('resize');
    expect(contents.sent).toEqual([[CHANNELS.MOVED, null]]);
    env.advance(INPUT_DELAY_MS - 1);
    expect(await approve()).toEqual({ ok: false, reason: 'too-soon' });
    env.advance(1);
    expect(await approve()).toEqual({ ok: true });
  });

  test('a report for a handle main doesn\'t show is ignored', () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    expect(env.docs.shown(eventFrom(contents), { handle: OTHER_HANDLE, revision: sentRevision(contents) })).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.shown(eventFrom(contents), 'nope')).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.state()[1].reported).toBeNull();
  });
});

describe('main\'s prompts in the document', () => {
  test('a prompt shows the panel and takes focus; hidden or closed, the panel goes and focus returns to the chrome', () => {
    const env = setup();
    const { window, contents, view } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    expect(view.visible).toBe(true);
    expect(contents.focused).toBe(true);
    expect(contents.sent).toEqual([[CHANNELS.PROMPT, delivered(1)]]);
    expect(env.docs.state()[1]).toMatchObject({ visible: true, shown: HANDLE, revision: 1 });

    // Another handle's hidden: ignored.
    env.docs.send(1, CHANNELS.HIDDEN, { handle: OTHER_HANDLE });
    expect(view.visible).toBe(true);

    env.docs.send(1, CHANNELS.HIDDEN, { handle: HANDLE });
    expect(view.visible).toBe(false);
    expect(window.webContents.focused).toBe(true);
    expect(contents.sent.at(-1)).toEqual([CHANNELS.HIDDEN, { handle: HANDLE }]);

    env.docs.send(1, CHANNELS.PROMPT, prompt());
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    expect(view.visible).toBe(false);
    expect(contents.sent.at(-1)).toEqual([CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' }]);
    expect(env.docs.state()[1]).toMatchObject({ visible: false, shown: null });
  });

  test('a hidden panel gives the keyboard back to the chrome; a shown one keeps it', () => {
    const env = setup();
    const { window, contents } = attached(env);
    // The view holds the focus (it takes it as its document loads, before
    // any prompt): on its focus, its load and the window's focus, the chrome
    // gets it back.
    for (const fire of [() => contents.emit('focus'), () => contents.emit('did-finish-load'), () => window.emit('focus')]) {
      window.webContents.focused = false;
      contents.focused = true;
      fire();
      expect(window.webContents.focused).toBe(true);
    }
    // A view without the focus takes nothing from the chrome.
    window.webContents.focused = false;
    contents.focused = false;
    window.emit('focus');
    expect(window.webContents.focused).toBe(false);

    // Shown, the panel keeps it.
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    window.webContents.focused = false;
    contents.emit('focus');
    window.emit('focus');
    expect(contents.focused).toBe(true);
    expect(window.webContents.focused).toBe(false);

    // Hidden again, it gives it back.
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    window.webContents.focused = false;
    contents.focused = true;
    contents.emit('focus');
    expect(window.webContents.focused).toBe(true);
  });

  test('a prompt sent before the document is ready reaches it when it is, after the theme', () => {
    const env = setup({ theme: 'dark' });
    const window = new FakeWindow(1);
    const { contents } = env.docs.attach(window);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    expect(contents.sent).toEqual([]);
    env.docs.ready(eventFrom(contents));
    expect(contents.sent).toEqual([
      [CHANNELS.THEME, { theme: 'dark' }],
      [CHANNELS.PROMPT, delivered(1)],
    ]);
  });

  test('for the E2E\'s early-input probe: the prompt shown, sent again, with main\'s delay started again', async () => {
    const env = setup();
    const { contents } = attached(env);
    expect(env.docs.reshow(1)).toBe(false);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    expect(env.docs.reshow(1)).toBe(true);
    // The same delivery: the revision the document rendered stays.
    expect(contents.sent.at(-1)).toEqual([CHANNELS.PROMPT, delivered(1)]);
    expect(env.docs.state()[1].reported).toBeNull();
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: false, reason: 'not-reported' });
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: false, reason: 'too-soon' });
    expect(env.docs.reshow(2)).toBe(false);
  });

  test('Settings > Appearance reaches every ready document', () => {
    const env = setup();
    const one = attached(env, 1);
    const two = attached(env, 2);
    env.themeListeners.forEach((listener) => listener('light'));
    expect(one.contents.sent).toEqual([[CHANNELS.THEME, { theme: 'light' }]]);
    expect(two.contents.sent).toEqual([[CHANNELS.THEME, { theme: 'light' }]]);
  });

  test('a view over 256 KiB, or one that can\'t be measured, is not forwarded in its message', () => {
    expect(outgoingPrompt(prompt(HANDLE, { title: 'x'.repeat(MAX_VIEW_BYTES) })).view).toBeNull();
    expect(outgoingPrompt(prompt(HANDLE, { n: 1n })).view).toBeNull();
    expect(outgoingPrompt(prompt(HANDLE, { n: 1n }))).not.toHaveProperty('parts');
    const fits = { title: 'x'.repeat(MAX_VIEW_BYTES - 20) };
    expect(outgoingPrompt(prompt(HANDLE, fits)).view).toBe(fits);
    // Only the prompt's own fields, and the delivery's revision.
    expect(Object.keys(outgoingPrompt({ ...prompt(), extra: 1 }))).toEqual(['handle', 'revision', 'guest', 'kind', 'site', 'view']);
    expect(outgoingPrompt(prompt(), 7).revision).toBe(7);
    // Over 4 MiB: no view, and still a revision the fixed error is reported for.
    expect(outgoingPrompt(prompt(HANDLE, { title: 'x'.repeat(MAX_PARTED_VIEW_BYTES) }), 9)).toEqual(delivered(9, HANDLE, null));
  });

  test('registers the document\'s channels and the chrome\'s anchor', () => {
    const env = setup();
    expect(env.ipc.on.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [CHANNELS.READY, CHANNELS.SHOWN, CHANNELS.ANCHOR].sort()
    );
    expect(env.ipc.handle.mock.calls.map(([channel]) => channel)).toEqual([CHANNELS.DECIDE, CHANNELS.VIEW_PART]);
  });
});

// APS-4: a view over 256 KiB goes in parts the document asks for, each
// within 256 KiB, for the prompt main shows it at that moment.
describe('APS-4: a view over 256 KiB, in parts', () => {
  const big = (chars, fill = 'x') => ({ title: 'T', message: fill.repeat(chars), rows: [] });
  // For the revision window 1's document was sent last, unless one is named.
  const part = (env, contents, index, handle = HANDLE, revision = env.docs.state()[1].revision) =>
    env.docs.viewPart(eventFrom(contents), { handle, revision, index });
  const lastPrompt = (contents) => contents.sent.filter(([channel]) => channel === CHANNELS.PROMPT).at(-1)[1];

  test('the message names its parts and carries no view; the parts join to the view\'s JSON, each within 256 KiB', () => {
    const view = big(600 * 1024);
    const message = outgoingPrompt(prompt(HANDLE, view));
    const json = JSON.stringify(view);
    expect(message.view).toBeNull();
    expect(message.parts).toEqual({ count: Math.ceil(json.length / VIEW_PART_UNITS), length: json.length });
    expect(message.revision).toBe(1);
    expect(outgoingPrompt(prompt(HANDLE, view), 7).revision).toBe(7);
    expect(Object.keys(message)).toEqual(['handle', 'revision', 'guest', 'kind', 'site', 'view', 'parts']);
    const parts = viewParts(json);
    expect(parts.join('')).toBe(json);
    for (const piece of parts) expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(MAX_VIEW_BYTES);
    // Over 4 MiB: no view, no parts.
    const over = outgoingPrompt(prompt(HANDLE, big(MAX_PARTED_VIEW_BYTES)));
    expect(over.view).toBeNull();
    expect(over).not.toHaveProperty('parts');
  });

  test('a part never splits a surrogate pair, and three-byte characters stay within 256 KiB a part', () => {
    const emoji = String.fromCodePoint(0x1f642);
    const odd = `"${'a'.repeat(VIEW_PART_UNITS - 2)}${emoji.repeat(4)}"`;
    const parts = viewParts(odd);
    expect(parts.join('')).toBe(odd);
    for (const piece of parts) {
      const last = piece.charCodeAt(piece.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    const wide = JSON.stringify(big(400 * 1024, '\u20ac'));
    for (const piece of viewParts(wide)) expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(MAX_VIEW_BYTES);
  });

  test('the document gets each part of the prompt it shows; nothing for another, a hidden or closed one, or another sender', () => {
    const env = setup();
    const { contents } = attached(env);
    const two = attached(env, 2);
    const view = big(300 * 1024);
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, view));
    const [, sent] = contents.sent.find(([channel]) => channel === CHANNELS.PROMPT);
    expect(sent.view).toBeNull();
    expect(env.docs.state()[1].parts).toBe(sent.parts.count);
    const pieces = [];
    for (let index = 0; index < sent.parts.count; index += 1) {
      const answer = part(env, contents, index);
      expect(answer.ok).toBe(true);
      pieces.push(answer.part);
    }
    expect(JSON.parse(pieces.join(''))).toEqual(view);
    expect(part(env, contents, sent.parts.count)).toEqual({ ok: false, reason: 'invalid' });
    expect(part(env, contents, -1)).toEqual({ ok: false, reason: 'invalid' });
    expect(part(env, contents, 0.5)).toEqual({ ok: false, reason: 'invalid' });
    expect(env.docs.viewPart(eventFrom(contents), null)).toEqual({ ok: false, reason: 'invalid' });
    expect(env.docs.viewPart(eventFrom(contents), { handle: HANDLE, index: 0 })).toEqual({ ok: false, reason: 'invalid' });
    expect(part(env, contents, 0, HANDLE, sent.revision + 1)).toEqual({ ok: false, reason: 'stale' });
    expect(part(env, contents, 0, OTHER_HANDLE)).toEqual({ ok: false, reason: 'not-shown' });
    // Another window's document, the chrome, a sub-frame.
    expect(part(env, two.contents, 0)).toEqual({ ok: false, reason: 'not-shown' });
    const revision = sent.revision;
    expect(env.docs.viewPart({ sender: { id: 501 }, senderFrame: {} }, { handle: HANDLE, revision, index: 0 })).toEqual({
      ok: false,
      reason: 'not-the-view',
    });
    expect(env.docs.viewPart(eventFrom(contents, { url: APPROVALS_URL }), { handle: HANDLE, revision, index: 0 }).ok).toBe(
      false
    );
    // A view within one message has no parts.
    env.docs.send(1, CHANNELS.PROMPT, prompt(OTHER_HANDLE));
    expect(part(env, contents, 0, OTHER_HANDLE)).toEqual({ ok: false, reason: 'invalid' });
    // Hidden, or closed: nothing more, and main lets the parts go.
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, view));
    env.docs.send(1, CHANNELS.HIDDEN, { handle: HANDLE });
    expect(part(env, contents, 0)).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.state()[1].parts).toBe(0);
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, view));
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    expect(part(env, contents, 0)).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.state()[1].parts).toBe(0);
  });

  test('an approval still waits for the report and its 500 ms; a device\'s account is read from main\'s whole view', async () => {
    const env = setup();
    const { contents } = attached(env);
    let answer;
    env.decide.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const view = { account: { index: 1, name: 'Ledger', address: null, type: 'ledger' }, data: `0x${'ab'.repeat(200 * 1024)}` };
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, view));
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: false, reason: 'not-reported' });
    // A report names its revision.
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE })).toEqual({ ok: false, reason: 'not-shown' });
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: lastPrompt(contents).revision });
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: false, reason: 'too-soon' });
    env.advance(INPUT_DELAY_MS);
    const decided = env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true });
    expect(env.docs.state()[1].waiting).toBe('ledger');
    answer({ ok: true });
    expect(await decided).toEqual({ ok: true });
  });

  // Codex, #1216 round 1: `page-prompts.update()` replaces a prompt's view
  // under the same handle, so a read of the parts must not run on into the
  // new view's.
  test('a view replaced under the same handle while its parts are read: the old revision gets no part of the new', async () => {
    const env = setup();
    const { contents } = attached(env);
    const viewA = big(300 * 1024, 'a');
    const viewB = big(300 * 1024, 'b');
    const partsA = viewParts(JSON.stringify(viewA));
    const partsB = viewParts(JSON.stringify(viewB));
    // Same shape: A's first part joined to B's others parses, and fits the
    // schema, which is why the revision has to tell them apart.
    expect(partsB.length).toBe(partsA.length);
    const hybrid = JSON.parse([partsA[0], ...partsB.slice(1)].join(''));
    expect(hybrid.message).toMatch(/^a+b+$/);

    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, viewA));
    const a = lastPrompt(contents).revision;
    expect(part(env, contents, 0, HANDLE, a)).toEqual({ ok: true, part: partsA[0] });
    // The prompt's view changes, the handle stays: a new revision.
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, viewB));
    const sentB = lastPrompt(contents);
    const b = sentB.revision;
    expect(b).toBeGreaterThan(a);
    expect(sentB.parts.count).toBe(partsB.length);
    // Nothing of B, or of A, for a read of A: every index is stale.
    for (let index = 0; index <= partsA.length; index += 1) {
      expect(part(env, contents, index, HANDLE, a)).toEqual({ ok: false, reason: 'stale' });
    }
    expect(env.trace.filter((e) => e.kind === 'view-part-stale').map((e) => e.revision)).toEqual(
      new Array(partsA.length + 1).fill(a)
    );
    // A report of A, or one naming no revision, doesn't count for B.
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: a })).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE })).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.state()[1].reported).toBeNull();
    env.advance(INPUT_DELAY_MS);
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({
      ok: false,
      reason: 'not-reported',
    });
    // B, read whole for its own revision, is B; sent again as it is (a
    // document that loads afresh), it keeps its revision.
    expect(env.docs.reshow(1)).toBe(true);
    expect(lastPrompt(contents).revision).toBe(b);
    const pieces = partsB.map((_piece, index) => part(env, contents, index, HANDLE, b));
    expect(pieces.every((answer) => answer.ok === true)).toBe(true);
    expect(JSON.parse(pieces.map((answer) => answer.part).join(''))).toEqual(viewB);
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: b })).toEqual({ ok: true });
    expect(env.docs.state()[1]).toMatchObject({ reported: HANDLE, revision: b });
    env.advance(INPUT_DELAY_MS);
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: true });
  });

  // Codex, #1216 round 2: the revision binds every delivery, not only a
  // view in parts. Main installs B under A's handle; B's message is still on
  // its way when the document, showing A, reports it again (the panel moved,
  // say) or reads on.
  test('an inline view replaced by an inline one under the same handle: A\'s late report never counts for B', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, { ...VIEW, title: 'A' }));
    const a = sentRevision(contents);
    expect(Number.isInteger(a)).toBe(true);
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: a })).toEqual({ ok: true });
    env.advance(INPUT_DELAY_MS);
    // B goes in under the same handle, inline too.
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, { ...VIEW, title: 'B' }));
    const b = sentRevision(contents);
    expect(b).toBeGreaterThan(a);
    expect(env.docs.state()[1]).toMatchObject({ shown: HANDLE, parts: 0, revision: b, reported: null });
    // The document, still showing A, reports it: nothing counts, with or
    // without a revision, or with one main never sent.
    for (const revision of [a, undefined, null, String(b), b + 1]) {
      expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision })).toEqual({ ok: false, reason: 'not-shown' });
    }
    expect(env.trace.filter((e) => e.kind === 'shown-ignored').map((e) => e.revision)).toEqual([a, undefined, null, String(b), b + 1]);
    expect(env.docs.state()[1].reported).toBeNull();
    env.advance(INPUT_DELAY_MS);
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({
      ok: false,
      reason: 'not-reported',
    });
    // B rendered and reported for its own revision: it counts, after its delay.
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: b })).toEqual({ ok: true });
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: false, reason: 'too-soon' });
    env.advance(INPUT_DELAY_MS);
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true })).toEqual({ ok: true });
  });

  test('a view in parts replaced by an inline one under the same handle: A\'s read is stale, its report counts for nothing', async () => {
    const env = setup();
    const { contents } = attached(env);
    const viewA = big(300 * 1024, 'a');
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, viewA));
    const a = sentRevision(contents);
    expect(part(env, contents, 0, HANDLE, a).ok).toBe(true);
    // B, inline, under the same handle: main keeps no parts now.
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, { ...VIEW, title: 'B' }));
    const b = sentRevision(contents);
    expect(b).toBeGreaterThan(a);
    expect(env.docs.state()[1]).toMatchObject({ parts: 0, revision: b });
    // A's next reads are stale, not `not-shown`: the document drops the load
    // rather than show (and report) A's fixed error.
    for (const index of [0, 1, 2]) {
      expect(part(env, contents, index, HANDLE, a)).toEqual({ ok: false, reason: 'stale' });
    }
    expect(env.trace.filter((e) => e.kind === 'view-part-stale').map((e) => [e.revision, e.index])).toEqual([
      [a, 0],
      [a, 1],
      [a, 2],
    ]);
    // Had the document shown A's fixed error anyway, its report would not
    // count for B.
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: a })).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.state()[1].reported).toBeNull();
    // B's own revision asks for a part of a view that came whole: nothing.
    expect(part(env, contents, 0, HANDLE, b)).toEqual({ ok: false, reason: 'invalid' });
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: b })).toEqual({ ok: true });
  });

  test('an inline view replaced by one in parts under the same handle: A\'s report doesn\'t count while B loads', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, { ...VIEW, title: 'A' }));
    const a = sentRevision(contents);
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, big(300 * 1024, 'b')));
    const b = sentRevision(contents);
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: a })).toEqual({ ok: false, reason: 'not-shown' });
    expect(part(env, contents, 0, HANDLE, a)).toEqual({ ok: false, reason: 'stale' });
    expect(part(env, contents, 0, HANDLE, b).ok).toBe(true);
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: b })).toEqual({ ok: true });
  });

  test('every delivery\'s revision is new: shown again after hiding, or in another window', () => {
    const env = setup();
    const one = attached(env, 1);
    const two = attached(env, 2);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    const first = sentRevision(one.contents);
    env.docs.send(1, CHANNELS.HIDDEN, { handle: HANDLE });
    expect(env.docs.shown(eventFrom(one.contents), { handle: HANDLE, revision: first })).toEqual({ ok: false, reason: 'not-shown' });
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    const second = sentRevision(one.contents);
    env.docs.send(2, CHANNELS.PROMPT, prompt(OTHER_HANDLE));
    const third = sentRevision(two.contents);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(env.docs.shown(eventFrom(one.contents), { handle: HANDLE, revision: first })).toEqual({ ok: false, reason: 'not-shown' });
    expect(env.docs.shown(eventFrom(one.contents), { handle: HANDLE, revision: second })).toEqual({ ok: true });
  });

  test('a reject while a view in parts loads needs no report', async () => {
    const env = setup();
    const { contents } = attached(env);
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, big(300 * 1024, 'a')));
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, big(300 * 1024, 'b')));
    expect(await env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: false })).toEqual({ ok: true });
    expect(env.decisions).toEqual([[1, { handle: HANDLE, approve: false }]]);
  });
});

// --- With page-requests: the flag on, end to end ------------------------------

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY = `bzz://${'d'.repeat(64)}`;
let nextGuestId = 1;
let nextNonce = 1;
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

class Guest extends EventEmitter {
  constructor(window = 1) {
    super();
    this.id = nextGuestId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return { url, frameTreeNodeId: 1000 + this.id, processId: 1, routingId: this.id, detached: false, send: jest.fn() };
  }

  isDestroyed() {
    return false;
  }

  getType() {
    return 'webview';
  }

  getURL() {
    return this.mainFrame.url;
  }

  commit(url) {
    this.mainFrame.detached = true;
    this.mainFrame = this.frame(url);
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }
}

function withPageRequests({ flag = true, testPrompts = true, dispatch = null, unlockVault = null, promptBudgets = null, randomHex = null } = {}) {
  const env = setup();
  const guests = new Map();
  const toChrome = [];
  const contexts = [];
  const windowWatchers = [];
  const closedWindows = new Set();
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async () => ({ type: 'not_found' }),
  });
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    hooks: {
      testPrompts,
      dispatch: async (context) => {
        contexts.push(context);
        if (dispatch) return dispatch(context);
        const decision = await context.prompt({ kind: 'test.prompt', view: context.params.view });
        return decision.approve === true ? { result: 'approved' } : { error: { code: 4001, message: 'User rejected the request' } };
      },
    },
    setTimer: () => null,
    clearTimer: () => {},
    chromeWindowOf: (contents) => (contents?.id >= 500 && contents.id < 600 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => toChrome.push([windowId, channel, payload]),
    // As Electron's: a closed window is not watched, and says so.
    watchWindow: (windowId, fn) => {
      if (closedWindows.has(windowId)) return false;
      windowWatchers.push([windowId, fn]);
      return true;
    },
    approvals: flag ? env.docs : null,
    ...(unlockVault ? { unlockVault } : {}),
    ...(promptBudgets ? { promptBudgets } : {}),
    ...(randomHex ? { randomHex } : {}),
  });
  env.decide.mockImplementation((windowId, payload) => requests.decideInWindow(windowId, payload));

  function tab(window = 1) {
    const guest = new Guest(window);
    guests.set(guest.id, guest);
    requests.track(guest);
    guest.commit(`${KEY}/`);
    const nonce = (nextNonce++).toString(16).padStart(32, '0');
    expect(requests.hello({ sender: guest, senderFrame: guest.mainFrame }, { nonce }).ok).toBe(true);
    requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
    return {
      guest,
      ask: (view) =>
        requests.request({ sender: guest, senderFrame: guest.mainFrame }, { nonce, provider: 'swarm', method: 'swarm_readChunk', params: { view } }),
    };
  }

  const chromeChannels = () => toChrome.map(([, channel]) => channel);
  const closeWindow = (windowId) => {
    closedWindows.add(windowId);
    windowWatchers.filter(([id]) => id === windowId).forEach(([, fn]) => fn());
  };
  return { ...env, requests, tab, toChrome, chromeChannels, contexts, guests, closeWindow };
}

describe('the flag on, with main\'s page prompts (page-requests.js)', () => {
  test('the document gets what shows, the chrome keeps its badges, and only the document decides', async () => {
    const env = withPageRequests();
    const { contents } = attached(env);
    const page = env.tab();
    const answer = page.ask(VIEW);
    await flush();
    const [[channel, shown]] = contents.sent;
    expect(channel).toBe(CHANNELS.PROMPT);
    expect(shown).toEqual({ handle: expect.stringMatching(/^[0-9a-f]{64}$/), revision: 1, guest: page.guest.id, kind: 'test.prompt', site: { key: KEY, label: KEY }, view: VIEW });
    // The chrome: the badge, not the prompt.
    expect(env.chromeChannels()).toEqual(['page:prompt-pending']);

    // The chrome's decision: refused, nothing decided.
    expect(await env.requests.decide({ sender: { id: 501 } }, { handle: shown.handle, approve: true })).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    expect(env.requests.promptState()[1].shown).toBe(shown.handle);

    // The document's, after its report and the delay.
    env.docs.shown(eventFrom(contents), { handle: shown.handle, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    expect(await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: true })).toEqual({ ok: true });
    expect(await answer).toEqual({ result: 'approved' });
    // Closed: to the chrome for its badge, and to the document.
    expect(env.chromeChannels()).toEqual(['page:prompt-pending', 'page:prompt-closed']);
    expect(contents.sent.at(-1)).toEqual([CHANNELS.CLOSED, { handle: shown.handle, reason: 'decided' }]);
    expect(env.docs.state()[1]).toMatchObject({ visible: false, shown: null });
  });

  test('another guest in front hides it in the document; back in front, it shows again', async () => {
    const env = withPageRequests();
    const { contents, view } = attached(env);
    const first = env.tab();
    first.ask(VIEW);
    await flush();
    const handle = contents.sent[0][1].handle;
    const second = env.tab();
    expect(contents.sent.at(-1)).toEqual([CHANNELS.HIDDEN, { handle }]);
    expect(view.visible).toBe(false);
    env.requests.foreground({ sender: { id: 501 } }, { guest: first.guest.id });
    expect(contents.sent.at(-1)).toEqual([CHANNELS.PROMPT, expect.objectContaining({ handle })]);
    expect(view.visible).toBe(true);
    expect(second.guest.id).not.toBe(first.guest.id);
    expect(env.chromeChannels().filter((c) => c === 'page:prompt' || c === 'page:prompt-hidden')).toEqual([]);
  });

  test('a changed prompt shows again in place (context.updatePrompt)', async () => {
    const env = withPageRequests();
    const { contents } = attached(env);
    env.tab().ask(VIEW);
    await flush();
    const handle = contents.sent[0][1].handle;
    const changed = { ...VIEW, title: 'Changed' };
    expect(env.contexts[0].updatePrompt(changed)).toBe(true);
    expect(contents.sent.at(-1)).toEqual([CHANNELS.PROMPT, expect.objectContaining({ handle, view: changed })]);
    env.docs.shown(eventFrom(contents), { handle, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    await env.docs.decide(eventFrom(contents), { handle, approve: false });
    await flush();
    expect(env.contexts[0].updatePrompt(VIEW)).toBe(false);
  });

  test('the flag off: the chrome gets the prompt and decides, as before', async () => {
    const env = withPageRequests({ flag: false });
    const page = env.tab();
    const answer = page.ask(VIEW);
    await flush();
    expect(env.chromeChannels()).toEqual(['page:prompt-pending', 'page:prompt']);
    const handle = env.toChrome[1][2].handle;
    expect(await env.requests.decideInWindow(1, { handle, approve: true })).toEqual({ ok: false, reason: 'not-a-window' });
    const decided = env.requests.decide({ sender: { id: 501 } }, { handle, approve: true });
    expect(await answer).toEqual({ result: 'approved' });
    expect(await decided).toEqual({ ok: true });
  });

  test('the harness\'s test kind only while its test hooks are on', async () => {
    const env = withPageRequests({ testPrompts: false });
    attached(env);
    const answer = await env.tab().ask(VIEW);
    expect(answer.error).toBeDefined();
    expect(env.chromeChannels()).toEqual([]);
  });
});

describe('no room for the panel, with page-requests', () => {
  test('the page hears its request rejected, nothing approved, and the panel goes', async () => {
    const env = withPageRequests();
    const window = new FakeWindow(1, [300, 200]);
    const { contents, view } = env.docs.attach(window);
    env.docs.ready(eventFrom(contents));
    const answer = env.tab().ask(VIEW);
    await flush();
    await env.runDeferred();
    expect(await answer).toEqual({ error: { code: 4001, message: 'User rejected the request' } });
    expect(view.visible).toBe(false);
    expect(env.docs.state()[1].shown).toBeNull();
  });
});

describe('APS-3b: the Safe boards show in the document, the chrome decides none, and page tokens come only from it', () => {
  const signingConfirmation = require('../wallet/signing-confirmation');

  test('both board kinds go to the document; the chrome\'s decision is refused for each; the dispatcher knows the document is on', async () => {
    const seen = [];
    const decisions = [];
    const env = withPageRequests({
      dispatch: async (context) => {
        seen.push(context.approvalsDocument);
        for (const kind of ['eth.safe_message', 'eth.safe_send']) {
          decisions.push([kind, await context.prompt({ kind, view: { step: 'collect' } })]);
        }
        return { result: 'done' };
      },
    });
    const { contents } = attached(env);
    const answer = env.tab().ask(VIEW);
    await flush();
    expect(seen).toEqual([true]);
    const pending = [];
    for (const kind of ['eth.safe_message', 'eth.safe_send']) {
      const shown = contents.sent.filter(([channel]) => channel === CHANNELS.PROMPT).at(-1)[1];
      expect(shown.kind).toBe(kind);
      // Nothing of it reaches the chrome but its badge.
      expect(env.chromeChannels().filter((c) => c === 'page:prompt' || c === 'page:prompt-hidden')).toEqual([]);
      expect(await env.requests.decide({ sender: { id: 501 } }, { handle: shown.handle, approve: true })).toEqual({
        ok: false,
        reason: 'approvals-document',
      });
      env.docs.shown(eventFrom(contents), { handle: shown.handle, revision: sentRevision(contents) });
      env.advance(INPUT_DELAY_MS);
      // Answered once the request is (no `released` here).
      pending.push(env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: false }));
      await flush();
    }
    expect(await answer).toEqual({ result: 'done' });
    expect(await Promise.all(pending)).toEqual([{ ok: true }, { ok: true }]);
    expect(decisions.map(([kind, decision]) => [kind, decision.approve, decision.from])).toEqual([
      ['eth.safe_message', false, 'approvals'],
      ['eth.safe_send', false, 'approvals'],
    ]);
  });

  test('a board\'s approval in the document mints no page token: only the request\'s own approval does', async () => {
    const minted = [];
    const mint = (context) => context.confirm('sign-message', 0, { method: 'personal_sign', params: ['0x00'] });
    const env = withPageRequests({
      dispatch: async (context) => {
        for (const kind of ['eth.safe_message', 'eth.safe_send', 'test.prompt']) {
          const decision = await context.prompt({ kind, view: kind === 'test.prompt' ? VIEW : { step: 'collect' } });
          try {
            minted.push([kind, decision.approve, typeof mint(context)]);
          } catch (err) {
            minted.push([kind, decision.approve, err.code]);
          }
        }
        return { result: 'done' };
      },
    });
    const { contents } = attached(env);
    const answer = env.tab().ask(VIEW);
    await flush();
    for (let i = 0; i < 3; i += 1) {
      const shown = contents.sent.filter(([channel]) => channel === CHANNELS.PROMPT).at(-1)[1].handle;
      env.docs.shown(eventFrom(contents), { handle: shown, revision: sentRevision(contents) });
      env.advance(INPUT_DELAY_MS);
      env.docs.decide(eventFrom(contents), { handle: shown, approve: true });
      await flush();
    }
    expect(await answer).toEqual({ result: 'done' });
    expect(minted).toEqual([
      ['eth.safe_message', true, signingConfirmation.NOT_CONFIRMED],
      ['eth.safe_send', true, signingConfirmation.NOT_CONFIRMED],
      ['test.prompt', true, 'string'],
    ]);
  });
});

describe('APS-3: an approval for a device\'s account keeps the panel up while it signs', () => {
  const deviceView = (type) => ({ account: { index: 1, name: 'Ledger', address: null, type } });

  test('the panel stays, closed, until the decision is answered; then it goes', async () => {
    const env = setup();
    const { contents, view } = attached(env);
    let answer;
    env.decide.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, deviceView('ledger')));
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    const decided = env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true });
    expect(env.docs.state()[1].waiting).toBe('ledger');
    // Main closes the handle as decided; the panel stays up, saying so.
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    expect(view.visible).toBe(true);
    expect(contents.sent.at(-1)).toEqual([CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' }]);
    answer({ ok: true });
    expect(await decided).toEqual({ ok: true });
    expect(view.visible).toBe(false);
    expect(env.docs.state()[1].waiting).toBeNull();
  });

  test('a vault account, or a rejection, closes the panel at once; a new prompt takes over a waiting one', async () => {
    const env = setup();
    const { contents, view } = attached(env);
    let answer;
    env.decide.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, deviceView('mnemonic')));
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    const decided = env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true });
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    expect(view.visible).toBe(false);
    answer({ ok: true });
    await decided;

    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, deviceView('remote')));
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    const rejected = env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: false });
    expect(env.docs.state()[1].waiting).toBeNull();
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    expect(view.visible).toBe(false);
    answer({ ok: true });
    await rejected;

    env.docs.send(1, CHANNELS.PROMPT, prompt(HANDLE, deviceView('remote')));
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    const first = env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true });
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    env.docs.send(1, CHANNELS.PROMPT, prompt(OTHER_HANDLE));
    expect(env.docs.state()[1]).toMatchObject({ waiting: null, shown: OTHER_HANDLE, visible: true });
    answer({ ok: true });
    await first;
    expect(view.visible).toBe(true);
  });
});

describe('APS-3: the window\'s own prompts', () => {
  test('a wallet prompt shows whichever tab is in front, after an older one, and closes with its window', async () => {
    const env = withPageRequests();
    const { contents } = attached(env);
    const decision = env.requests.walletPrompt(1, { kind: 'wallet.send', view: { amount: '1' } });
    await flush();
    // No tab reported in front yet: it shows all the same.
    const [[channel, shown]] = contents.sent;
    expect(channel).toBe(CHANNELS.PROMPT);
    expect(shown).toEqual({
      handle: expect.stringMatching(/^[0-9a-f]{64}$/),
      revision: 1,
      guest: null,
      kind: 'wallet.send',
      site: { key: 'freedom:wallet', label: 'Your wallet' },
      view: { amount: '1' },
    });
    expect(env.chromeChannels()).toEqual(['page:prompt-pending']);
    // The chrome can't decide it.
    expect(await env.requests.decide({ sender: { id: 501 } }, { handle: shown.handle, approve: true })).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    env.docs.shown(eventFrom(contents), { handle: shown.handle, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    // Answered: a window's prompt has no request (Codex, #1210).
    expect(await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: true })).toEqual({ ok: true });
    expect(await decision).toEqual({ approve: true, choices: {}, from: 'approvals' });

    // A page's prompt shown first keeps its place; the wallet's waits.
    const page = env.tab();
    page.ask(VIEW);
    await flush();
    const pageHandle = contents.sent.at(-1)[1].handle;
    const waiting = env.requests.walletPrompt(1, { kind: 'wallet.send', view: {} });
    await flush();
    expect(env.docs.state()[1].shown).toBe(pageHandle);
    env.docs.shown(eventFrom(contents), { handle: pageHandle, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    await env.docs.decide(eventFrom(contents), { handle: pageHandle, approve: false });
    await flush();
    expect(contents.sent.at(-1)).toEqual([CHANNELS.PROMPT, expect.objectContaining({ kind: 'wallet.send', guest: null })]);
    // Its window closing closes it.
    await expect(Promise.race([waiting, Promise.resolve('open')])).resolves.toBe('open');
    env.closeWindow(1);
    expect(await waiting).toEqual({ closed: 'closed' });
  });

  test('a window closed before its prompt opens gets none, watched or not', async () => {
    const env = withPageRequests();
    attached(env);
    env.closeWindow(1);
    expect(await env.requests.walletPrompt(1, { kind: 'wallet.send', view: {} })).toEqual({ closed: 'closed' });
    // Watched (a tab reported in front), then closed.
    const second = attached(env, 2);
    env.requests.foreground({ sender: { id: 502 } }, { guest: null });
    env.closeWindow(2);
    expect(await env.requests.walletPrompt(2, { kind: 'wallet.send', view: {} })).toEqual({ closed: 'closed' });
    expect(second.contents.sent).toEqual([]);
    expect(env.requests.promptState()[1]).toBeUndefined();
    expect(env.requests.promptState()[2]).toBeUndefined();
  });

  test('not a wallet kind, or the document off: no prompt', async () => {
    const env = withPageRequests({ flag: false });
    expect(await env.requests.walletPrompt(1, { kind: 'wallet.send', view: {} })).toEqual({ closed: 'cancelled' });
    const on = withPageRequests();
    expect(() => on.requests.walletPrompt(1, { kind: 'eth.send', view: {} })).toThrow('no wallet prompt');
  });
});

// The real path: wallet-approvals.js asking through page-requests.js's
// `walletPrompt`, decided in the document (Codex, #1210, findings 1 and 4).
describe('APS-3: the wallet\'s own approvals, through walletPrompt to the document', () => {
  const ACCOUNT = '0x1111111111111111111111111111111111111111';
  const TO = '0x2222222222222222222222222222222222222222';
  const WALLETS = [
    { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
    { index: 1, name: 'Ledger', address: TO, type: 'ledger' },
  ];
  const SEND = { chainId: 100, to: TO, value: '1', data: '0x', gasLimit: '21000', gasPrice: '1000000000' };
  const BELOW = { maxCost: '21000000000000', comparable: true, ratio: '1.0', above: false, oneEndpoint: false, basis: 'header', autoApprove: true };
  const chrome = { id: 501 };

  function walletApprovals(env, { checkFees = async () => BELOW, atPress = [] } = {}) {
    return createWalletApprovals({
      walletPrompt: (windowId, spec) => env.requests.walletPrompt(windowId, spec),
      chromeWindowOf: (contents) => (contents?.id >= 500 && contents.id < 600 ? contents.id - 500 : null),
      getDerivedWallets: async () => WALLETS,
      checkFees,
      checkAtApproval: async () => (atPress.length ? atPress.shift() : { ...BELOW, askAgain: false }),
    });
  }

  // The document's report of the prompt it shows, and main's delay past.
  async function onScreen(env, contents) {
    await flush();
    const [channel, shown] = contents.sent.at(-1);
    expect(channel).toBe(CHANNELS.PROMPT);
    env.docs.shown(eventFrom(contents), { handle: shown.handle, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    return shown;
  }

  test('an approval is answered once the token is minted, a Ledger account\'s too, with no wait on the device', async () => {
    const env = withPageRequests();
    const { contents, view } = attached(env);
    const order = [];
    let minted;
    const minting = new Promise((resolve) => (minted = resolve));
    const confirmed = walletApprovals(env).confirm({ sender: chrome, kind: 'wallet-send', index: 1, payload: SEND, feeChecked: true }, async () => {
      order.push('mint');
      await minting;
      order.push('minted');
      return { token: 'token' };
    });
    const shown = await onScreen(env, contents);
    expect(shown.view.account).toEqual({ index: 1, name: 'Ledger', address: TO, type: 'ledger' });
    const decided = env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: true }).then((result) => {
      order.push('answered');
      return result;
    });
    await flush();
    // The device's step comes after, with the token, on the chrome's
    // screen: the panel doesn't wait on it, and goes.
    expect(env.docs.state()[1]).toMatchObject({ waiting: null, shown: null, visible: false });
    expect(view.visible).toBe(false);
    expect(order).toEqual(['mint']);
    minted();
    expect(await decided).toEqual({ ok: true });
    expect(order).toEqual(['mint', 'minted', 'answered']);
    expect(await confirmed).toEqual({ token: 'token', approved: true });
  });

  // APS-5: x402's payment and an auto-pay cap's edit, the same way.
  test.each([
    [
      'x402-payment',
      0,
      {
        webContentsId: 42,
        detectionId: 'req-1',
        url: 'https://pay.example/a',
        acceptIndex: 0,
        accept: { scheme: 'exact', network: 'eip155:8453', amount: '2500000', asset: TO, payTo: TO },
        grant: null,
      },
    ],
    [
      'x402-cap-update',
      null,
      { window: 501, origin: 'https://pay.example', chainId: 8453, asset: TO, capAmount: '9', current: { capAmount: '5', createdAt: 1, expiresAt: 2, generation: 1 } },
    ],
  ])('%s: the chrome can\'t decide it; the document\'s approval mints once, its rejection never', async (kind, index, payload) => {
    const env = withPageRequests();
    const { contents } = attached(env);
    const approvals = createWalletApprovals({
      walletPrompt: (windowId, spec) => env.requests.walletPrompt(windowId, spec),
      chromeWindowOf: (sent) => (sent?.id === 501 ? 1 : null),
      getDerivedWallets: async () => WALLETS,
      checkFees: async () => BELOW,
      checkAtApproval: async () => ({ ...BELOW, askAgain: false }),
      x402Cap: () => ({ origin: 'https://pay.example', capAmount: '5', spentAmount: '0', createdAt: 1, expiresAt: 2 }),
    });
    const mint = jest.fn(() => ({ token: 'token' }));
    const rejected = approvals.confirm({ sender: chrome, kind, index, payload }, mint);
    let shown = await onScreen(env, contents);
    expect(shown).toMatchObject({ guest: null, kind: `wallet.${kind.replace(/-/g, '_')}` });
    expect(await env.requests.decide({ sender: chrome }, { handle: shown.handle, approve: true })).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    expect(await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: false })).toEqual({ ok: true });
    expect(await rejected).toMatchObject({ approved: false, code: 'USER_REJECTED' });
    expect(mint).not.toHaveBeenCalled();

    const approved = approvals.confirm({ sender: chrome, kind, index, payload }, mint);
    shown = await onScreen(env, contents);
    expect(await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: true })).toEqual({ ok: true });
    expect(await approved).toEqual({ token: 'token', approved: true });
    expect(mint).toHaveBeenCalledTimes(1);
  });

  test('a rejection is answered, and mints nothing; a fee asked again is answered as it asks, and its second press mints', async () => {
    const env = withPageRequests();
    const { contents } = attached(env);
    const mint = jest.fn(() => ({ token: 'token' }));
    const rejected = walletApprovals(env).confirm({ sender: chrome, kind: 'wallet-send', index: 0, payload: SEND, feeChecked: true }, mint);
    let shown = await onScreen(env, contents);
    expect(await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: false })).toEqual({ ok: true });
    expect(await rejected).toEqual(REJECTED);
    expect(mint).not.toHaveBeenCalled();

    const above = { ...BELOW, ratio: '4.5', above: true, autoApprove: false };
    const twice = walletApprovals(env, { atPress: [{ ...above, askAgain: true }, { ...above, askAgain: false }] }).confirm(
      { sender: chrome, kind: 'wallet-send', index: 0, payload: SEND, feeChecked: true },
      mint
    );
    shown = await onScreen(env, contents);
    expect(await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: true })).toEqual({ ok: true });
    expect(mint).not.toHaveBeenCalled();
    const again = await onScreen(env, contents);
    expect(again.handle).not.toBe(shown.handle);
    expect(again.view.feeAskAgain).toBe(true);
    expect(await env.docs.decide(eventFrom(contents), { handle: again.handle, approve: true })).toEqual({ ok: true });
    expect(await twice).toEqual({ token: 'token', approved: true });
    expect(mint).toHaveBeenCalledTimes(1);
  });

  test('its window closed during the fee check and account lookup: no prompt, and the confirmation settles', async () => {
    for (const watched of [false, true]) {
      const env = withPageRequests();
      const { contents } = attached(env);
      if (watched) env.requests.foreground({ sender: chrome }, { guest: null });
      let feesIn;
      const fees = new Promise((resolve) => (feesIn = resolve));
      const mint = jest.fn(() => ({ token: 'token' }));
      let settled = null;
      walletApprovals(env, { checkFees: () => fees })
        .confirm({ sender: chrome, kind: 'wallet-send', index: 0, payload: SEND, feeChecked: true }, mint)
        .then((outcome) => (settled = outcome));
      await flush();
      env.closeWindow(1);
      feesIn(BELOW);
      await flush();
      expect(settled).toEqual(REJECTED);
      expect(mint).not.toHaveBeenCalled();
      expect(contents.sent).toEqual([]);
      expect(env.requests.promptState()[1]).toBeUndefined();
    }
  });
});

// Codex, freedom-core #335: a window's own prompts have no request record,
// so nothing bounded them; a compromised chrome could leave any number of
// large views (and the requests behind them) waiting. Every open prompt's
// view, and a window's own prompt's request, are charged to its window and
// the browser (0011, "Prompt views").
describe('the prompt budget, through wallet:confirm-signing and a page\'s prompts', () => {
  const ACCOUNT = '0x1111111111111111111111111111111111111111';
  const TO = '0x2222222222222222222222222222222222222222';
  const WALLETS = [{ index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' }];
  const SEND = { chainId: 100, to: TO, value: '1', data: '0x', gasLimit: '21000', gasPrice: '1000000000' };
  const MiB = 1024 * 1024;

  const confirmations = (env) =>
    createWalletApprovals({
      walletPrompt: (windowId, spec) => env.requests.walletPrompt(windowId, spec),
      chromeWindowOf: (contents) => (contents?.id >= 500 && contents.id < 600 ? contents.id - 500 : null),
      getDerivedWallets: async () => WALLETS,
    });

  test('many concurrent confirmations from one window: past its 64 open prompts each is refused, nothing asked or minted', async () => {
    const env = withPageRequests();
    const { contents } = attached(env);
    const approvals = confirmations(env);
    const mint = jest.fn(() => ({ token: 'token' }));
    const outcomes = new Array(80).fill(null);
    for (let i = 0; i < outcomes.length; i += 1) {
      approvals.confirm({ sender: { id: 501 }, kind: 'wallet-send', index: 0, payload: SEND }, mint).then((outcome) => {
        outcomes[i] = outcome;
      });
    }
    await flush();
    // The first 64 wait in the window; the other 16 are answered at once.
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(64);
    expect(outcomes.filter((outcome) => outcome === LIMITED)).toHaveLength(16);
    expect(LIMITED).toMatchObject({ approved: false, code: 'LIMIT_EXCEEDED' });
    expect(env.requests.promptState()[1].open).toHaveLength(64);
    expect(env.requests.promptUsage()).toMatchObject({ count: 64, windows: { 1: { count: 64 } } });
    expect(env.chromeChannels().filter((c) => c === 'page:prompt-pending')).toHaveLength(64);
    expect(mint).not.toHaveBeenCalled();
    // One rejected: its charge goes, and the next confirmation is asked.
    const shown = contents.sent.filter(([channel]) => channel === CHANNELS.PROMPT).at(-1)[1];
    expect(await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: false })).toEqual({ ok: true });
    await flush();
    expect(env.requests.promptUsage().count).toBe(63);
    let next = null;
    approvals.confirm({ sender: { id: 501 }, kind: 'wallet-send', index: 0, payload: SEND }, mint).then((outcome) => (next = outcome));
    await flush();
    expect(next).toBeNull();
    expect(env.requests.promptUsage().count).toBe(64);
    // The window closes: every one of its own prompts closes, and lets go.
    env.closeWindow(1);
    await flush();
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(0);
    expect(next).toEqual(REJECTED);
    expect(env.requests.promptUsage()).toEqual({ count: 0, bytes: 0, windows: {} });
    expect(mint).not.toHaveBeenCalled();
  });

  test('large requests, from three windows: past a window\'s 8 MiB, or the browser\'s 16 MiB, refused; the request is charged with its view', async () => {
    const env = withPageRequests();
    for (const id of [1, 2, 3]) attached(env, id);
    const approvals = confirmations(env);
    // A send whose data is 1 MiB of hex: about 1 MiB in the view, and 1 MiB
    // more in the request main keeps while the prompt waits.
    const large = { ...SEND, data: `0x${'ab'.repeat(MiB / 2)}` };
    const ask = (window) => {
      const state = { outcome: null };
      approvals.confirm({ sender: { id: 500 + window }, kind: 'wallet-send', index: 0, payload: large }, () => ({})).then((outcome) => {
        state.outcome = outcome;
      });
      return state;
    };
    const one = ask(1);
    await flush();
    const each = env.requests.promptUsage().bytes;
    expect(each).toBeGreaterThan(2 * MiB);
    expect(each).toBeLessThan(2 * MiB + 4096);
    const perWindow = Math.floor((8 * MiB) / each);
    expect(perWindow).toBe(3);
    const asked = [one];
    for (let i = 1; i < perWindow + 2; i += 1) asked.push(ask(1));
    await flush();
    expect(asked.map((state) => state.outcome === LIMITED)).toEqual([false, false, false, true, true]);
    expect(env.requests.promptUsage().windows[1]).toEqual({ count: 3, bytes: 3 * each });
    // Window 2 has its own 8 MiB; the browser's 16 MiB then leaves window
    // 3 room for one.
    const two = [ask(2), ask(2), ask(2)];
    const three = [ask(3), ask(3)];
    await flush();
    expect(two.map((state) => state.outcome)).toEqual([null, null, null]);
    expect(three.map((state) => state.outcome === LIMITED)).toEqual([false, true]);
    expect(env.requests.promptUsage()).toMatchObject({ count: 7, bytes: 7 * each });
    expect(env.requests.promptUsage().bytes).toBeLessThanOrEqual(16 * MiB);
  });

  test('a page\'s prompt past the budget: the page gets -32005, and no handle opens', async () => {
    // As every dispatcher does, a prompt's `{ error }` answers the page.
    const dispatch = async (context) => {
      const decision = await context.prompt({ kind: 'test.prompt', view: context.params.view });
      if (decision.error) return { error: decision.error };
      return decision.approve === true ? { result: 'approved' } : { error: { code: 4001, message: 'User rejected the request' } };
    };
    const env = withPageRequests({ dispatch, promptBudgets: { window: { count: 1, bytes: MiB }, browser: { count: 4, bytes: 4 * MiB } } });
    const { contents } = attached(env);
    const firstTab = env.tab();
    const first = firstTab.ask(VIEW);
    await flush();
    expect(env.requests.promptState()[1].open).toHaveLength(1);
    const second = await env.tab().ask(VIEW);
    expect(second).toEqual({ error: { code: -32005, message: 'Limit exceeded' } });
    expect(env.requests.promptState()[1].open).toHaveLength(1);
    expect(env.requests.stats().handles).toBe(1);
    expect(env.chromeChannels().filter((c) => c === 'page:prompt-pending')).toHaveLength(1);
    // A window's own prompt is refused there too, with `-32005`.
    expect(await env.requests.walletPrompt(1, { kind: 'wallet.send', view: VIEW })).toEqual({
      error: { code: -32005, message: 'Limit exceeded' },
    });
    // The first rejected: its charge goes, and the next page's prompt opens.
    env.requests.foreground({ sender: { id: 501 } }, { guest: firstTab.guest.id });
    const handle = env.requests.promptState()[1].shown;
    expect(handle).toEqual(expect.any(String));
    expect(await env.docs.decide(eventFrom(contents), { handle, approve: false })).toEqual({ ok: true });
    expect(await first).toEqual({ error: { code: 4001, message: 'User rejected the request' } });
    expect(env.requests.promptUsage()).toEqual({ count: 0, bytes: 0, windows: {} });
    env.tab().ask(VIEW);
    await flush();
    expect(env.requests.promptUsage().count).toBe(1);
  });
  test('a throw while a prompt opens leaves no charge, handle or prompt behind, a page\'s or the window\'s own', async () => {
    // The handle's random bytes fail for a while: each prompt that opens
    // then throws on its way, after its charge was taken.
    let failing = true;
    const randomHex = (bytes) => {
      if (failing) throw new Error('no random bytes');
      return require('crypto').randomBytes(bytes).toString('hex');
    };
    const env = withPageRequests({ randomHex });
    attached(env);
    const empty = { count: 0, bytes: 0, windows: {} };
    // A window's own prompt: the throw reaches its caller, and nothing stays.
    for (let i = 0; i < 3; i += 1) {
      expect(() => env.requests.walletPrompt(1, { kind: 'wallet.send', view: VIEW })).toThrow('no random bytes');
    }
    expect(env.requests.promptUsage()).toEqual(empty);
    expect(env.requests.promptState()[1]?.open ?? []).toHaveLength(0);
    // A page's prompt: the page is answered with an error, and nothing stays.
    const answer = await env.tab().ask(VIEW);
    expect(answer).toEqual({ error: expect.objectContaining({ code: expect.any(Number) }) });
    expect(env.requests.promptUsage()).toEqual(empty);
    expect(env.requests.stats().handles).toBe(0);
    expect(env.chromeChannels()).not.toContain('page:prompt-pending');
    // The bytes come back: both kinds open, each charged once.
    failing = false;
    env.requests.walletPrompt(1, { kind: 'wallet.send', view: VIEW });
    env.tab().ask(VIEW);
    await flush();
    expect(env.requests.promptUsage()).toMatchObject({ count: 2, windows: { 1: { count: 2 } } });
  });
});

describe('APS-3b: a board\'s approval to sign with a device owner keeps the panel up while main signs', () => {
  const owners = [
    { index: 1, type: 'ledger', signed: false },
    { index: 2, type: 'mnemonic', signed: false },
    { index: 3, type: 'remote', signed: false },
    { index: 4, type: 'ledger', signed: true },
  ];
  const board = (kind) => ({ handle: HANDLE, guest: kind.startsWith('wallet.') ? null : 7, kind, site: SITE, view: { owners } });

  test.each([
    ['eth.safe_message', { action: 'sign', owner: 1 }, 'ledger'],
    ['eth.safe_send', { action: 'sign', owner: 3 }, 'remote'],
    ['wallet.safe_board', { action: 'sign', owner: 1 }, 'ledger'],
    ['eth.safe_send', { action: 'sign', owner: 2 }, null],
    // An owner who has signed is no device to wait on.
    ['eth.safe_send', { action: 'sign', owner: 4 }, null],
    ['wallet.safe_board', { action: 'discard' }, null],
    ['wallet.safe_board', undefined, null],
  ])('%s with %j waits on %s', async (kind, choices, device) => {
    const env = setup();
    const { contents, view } = attached(env);
    let answer;
    env.decide.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    env.docs.send(1, CHANNELS.PROMPT, board(kind));
    env.docs.shown(eventFrom(contents), { handle: HANDLE, revision: sentRevision(contents) });
    env.advance(INPUT_DELAY_MS);
    const decided = env.docs.decide(eventFrom(contents), { handle: HANDLE, approve: true, ...(choices ? { choices } : {}) });
    expect(env.docs.state()[1].waiting).toBe(device);
    env.docs.send(1, CHANNELS.CLOSED, { handle: HANDLE, reason: 'decided' });
    expect(view.visible).toBe(device !== null);
    answer({ ok: true });
    expect(await decided).toEqual({ ok: true });
    expect(view.visible).toBe(false);
  });
});

describe('APS-3b: a window\'s own vault unlock, for the wallet\'s Safe board', () => {
  test('the password in the document; a wrong one shown again, saying so; open, an approval with no choices', async () => {
    const attempts = [];
    const env = withPageRequests({
      unlockVault: async (password) => {
        attempts.push(password);
        if (password !== 'right') throw new Error('Incorrect password');
      },
    });
    const { contents } = attached(env);
    const unlocked = env.requests.walletUnlock(1, { reason: 'send' });
    const decideShown = async (choices) => {
      const shown = contents.sent.filter(([channel]) => channel === CHANNELS.PROMPT).at(-1)[1];
      env.docs.shown(eventFrom(contents), { handle: shown.handle, revision: sentRevision(contents) });
      env.advance(INPUT_DELAY_MS);
      const answer = await env.docs.decide(eventFrom(contents), { handle: shown.handle, approve: true, choices });
      await flush();
      return { shown, answer };
    };
    await flush();
    const first = await decideShown({ password: 'wrong' });
    expect(first.shown).toMatchObject({ kind: 'wallet.vault_unlock', guest: null, site: { key: 'freedom:wallet' }, view: { reason: 'send' } });
    expect(first.answer).toEqual({ ok: true });
    const second = await decideShown({ password: 'right' });
    expect(second.shown.view).toEqual({ reason: 'send', failed: true });
    expect(await unlocked).toEqual({ approve: true, choices: {}, from: 'approvals' });
    expect(attempts).toEqual(['wrong', 'right']);
    // Nothing of it reached the chrome but its badge.
    expect(env.chromeChannels().filter((c) => c === 'page:prompt')).toEqual([]);
    // Off: nothing asked.
    expect(await withPageRequests({ flag: false }).requests.walletUnlock(1, { reason: 'send' })).toEqual({ closed: 'cancelled' });
  });
});
