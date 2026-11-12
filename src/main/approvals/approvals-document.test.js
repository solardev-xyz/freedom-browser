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

const {
  createApprovalsDocuments,
  isApprovalsDocumentEnabled,
  attachApprovalsDocument,
  registerApprovalsIpc,
  ownFile,
  outgoingPrompt,
  panelBounds,
  APPROVALS_HTML,
  APPROVALS_URL,
  PRELOAD,
  PARTITION,
  CSP,
  CHANNELS,
  INPUT_DELAY_MS,
  MAX_VIEW_BYTES,
  DEFAULT_TOP,
  MAX_TOP,
} = approvals;

const RENDERER = path.resolve(__dirname, '..', '..', 'renderer');
const HANDLE = 'a'.repeat(64);
const OTHER_HANDLE = 'b'.repeat(64);
const SITE = { key: `bzz://${'c'.repeat(64)}`, label: `bzz://${'c'.repeat(64)}` };
const VIEW = { title: 'One', message: 'About one', rows: [] };
const prompt = (handle = HANDLE, view = VIEW) => ({ handle, guest: 7, kind: 'test.prompt', site: SITE, view });

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
  }

  getContentSize() {
    return this.size;
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
  const docs = createApprovalsDocuments({
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
  return { docs, ses, partitions, views, decide, decisions, trace, advance, themeListeners, ipc };
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
  test('FREEDOM_APPROVALS_DOCUMENT=1 turns it on; anything else leaves it off', () => {
    expect(isApprovalsDocumentEnabled({ FREEDOM_APPROVALS_DOCUMENT: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(isApprovalsDocumentEnabled({ FREEDOM_APPROVALS_DOCUMENT: value })).toBe(false);
    }
    expect(isApprovalsDocumentEnabled({})).toBe(false);
  });

  test('off by default: no document for a window, no handlers', () => {
    const saved = process.env.FREEDOM_APPROVALS_DOCUMENT;
    delete process.env.FREEDOM_APPROVALS_DOCUMENT;
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

  test('panelBounds: never wider than the window, never below it', () => {
    expect(panelBounds({ width: 200, height: 100 }, 85)).toEqual({ x: 0, y: 85, width: 200, height: 15 });
    expect(panelBounds({ width: 200, height: 50 }, 85)).toEqual({ x: 0, y: 50, width: 200, height: 0 });
    expect(panelBounds({ width: 1200, height: 800 }, Number.NaN)).toEqual({ x: 880, y: DEFAULT_TOP, width: 320, height: 715 });
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
    expect(env.docs.shown(eventFrom(contents), { handle: HANDLE })).toEqual({ ok: true });

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
    env.docs.shown(eventFrom(one.contents), { handle: HANDLE });
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
    env.docs.shown(eventFrom(contents), { handle: HANDLE });
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
      env.docs.shown(eventFrom(contents), { handle: HANDLE });
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
    expect(env.docs.shown(eventFrom(contents), { handle: OTHER_HANDLE })).toEqual({ ok: false, reason: 'not-shown' });
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
    expect(contents.sent).toEqual([[CHANNELS.PROMPT, prompt()]]);
    expect(env.docs.state()[1]).toMatchObject({ visible: true, shown: HANDLE });

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

  test('a prompt sent before the document is ready reaches it when it is, after the theme', () => {
    const env = setup({ theme: 'dark' });
    const window = new FakeWindow(1);
    const { contents } = env.docs.attach(window);
    env.docs.send(1, CHANNELS.PROMPT, prompt());
    expect(contents.sent).toEqual([]);
    env.docs.ready(eventFrom(contents));
    expect(contents.sent).toEqual([
      [CHANNELS.THEME, { theme: 'dark' }],
      [CHANNELS.PROMPT, prompt()],
    ]);
  });

  test('Settings > Appearance reaches every ready document', () => {
    const env = setup();
    const one = attached(env, 1);
    const two = attached(env, 2);
    env.themeListeners.forEach((listener) => listener('light'));
    expect(one.contents.sent).toEqual([[CHANNELS.THEME, { theme: 'light' }]]);
    expect(two.contents.sent).toEqual([[CHANNELS.THEME, { theme: 'light' }]]);
  });

  test('a view over 256 KiB, or one that can\'t be measured, is not forwarded', () => {
    expect(outgoingPrompt(prompt(HANDLE, { title: 'x'.repeat(MAX_VIEW_BYTES) })).view).toBeNull();
    expect(outgoingPrompt(prompt(HANDLE, { n: 1n })).view).toBeNull();
    const fits = { title: 'x'.repeat(MAX_VIEW_BYTES - 20) };
    expect(outgoingPrompt(prompt(HANDLE, fits)).view).toBe(fits);
    // Only the prompt's own fields.
    expect(Object.keys(outgoingPrompt({ ...prompt(), extra: 1 }))).toEqual(['handle', 'guest', 'kind', 'site', 'view']);
  });

  test('registers the document\'s channels and the chrome\'s anchor', () => {
    const env = setup();
    expect(env.ipc.on.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [CHANNELS.READY, CHANNELS.SHOWN, CHANNELS.ANCHOR].sort()
    );
    expect(env.ipc.handle.mock.calls.map(([channel]) => channel)).toEqual([CHANNELS.DECIDE]);
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

function withPageRequests({ flag = true, testPrompts = true } = {}) {
  const env = setup();
  const guests = new Map();
  const toChrome = [];
  const contexts = [];
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
        const decision = await context.prompt({ kind: 'test.prompt', view: context.params.view });
        return decision.approve === true ? { result: 'approved' } : { error: { code: 4001, message: 'User rejected the request' } };
      },
    },
    setTimer: () => null,
    clearTimer: () => {},
    chromeWindowOf: (contents) => (contents?.id >= 500 && contents.id < 600 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => toChrome.push([windowId, channel, payload]),
    watchWindow: () => {},
    approvals: flag ? env.docs : null,
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
  return { ...env, requests, tab, toChrome, chromeChannels, contexts, guests };
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
    expect(shown).toEqual({ handle: expect.stringMatching(/^[0-9a-f]{64}$/), guest: page.guest.id, kind: 'test.prompt', site: { key: KEY, label: KEY }, view: VIEW });
    // The chrome: the badge, not the prompt.
    expect(env.chromeChannels()).toEqual(['page:prompt-pending']);

    // The chrome's decision: refused, nothing decided.
    expect(await env.requests.decide({ sender: { id: 501 } }, { handle: shown.handle, approve: true })).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    expect(env.requests.promptState()[1].shown).toBe(shown.handle);

    // The document's, after its report and the delay.
    env.docs.shown(eventFrom(contents), { handle: shown.handle });
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
    env.docs.shown(eventFrom(contents), { handle });
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
