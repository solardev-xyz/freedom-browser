const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const policy = require('./ipc-sender-policy');

const {
  isSenderAllowed,
  installIpcSenderPolicy,
  TIER,
  WEBVIEW_CHANNEL_TIERS,
  CHROME_INDEX,
  PAGES_DIR,
} = policy;

function makeEvent({ type = 'webview', url, subFrame = false, noFrame = false } = {}) {
  const mainFrame = { url };
  const sender = { getType: () => type, mainFrame };
  return {
    sender,
    senderFrame: noFrame ? null : subFrame ? { url } : mainFrame,
  };
}

const fileUrl = (p) => pathToFileURL(p).href;
const chrome = (extra = {}) => makeEvent({ type: 'window', url: fileUrl(CHROME_INDEX), ...extra });
const page = (file, extra = {}) =>
  makeEvent({ type: 'webview', url: fileUrl(path.join(PAGES_DIR, file)), ...extra });
const web = (url = 'https://evil.example/', extra = {}) =>
  makeEvent({ type: 'webview', url, ...extra });

describe('isSenderAllowed', () => {
  test('the chrome renderer may call any channel, including chrome-only ones', () => {
    for (const channel of [
      'wallet:send-transaction',
      'identity:export-mnemonic',
      'settings:save',
    ]) {
      expect(isSenderAllowed(channel, chrome())).toBe(true);
    }
    expect(
      isSenderAllowed(
        'wallet:send-transaction',
        chrome({ url: `${fileUrl(CHROME_INDEX)}?initialUrl=x` })
      )
    ).toBe(true);
  });

  test('a web page can never reach chrome-only channels', () => {
    for (const channel of [
      'wallet:send-transaction',
      'wallet:sign-message',
      'identity:export-mnemonic',
      'quick-unlock:unlock',
      'dapp:grant-permission',
      'permissions:prompt-response',
      'swarm:provider-execute',
    ]) {
      expect(isSenderAllowed(channel, web())).toBe(false);
      expect(isSenderAllowed(channel, web('bzz://abcd/'))).toBe(false);
      // Not even an internal page: only the chrome renders these flows.
      expect(isSenderAllowed(channel, page('settings.html'))).toBe(false);
    }
  });

  test('public bootstrap channels answer any sender and frame', () => {
    expect(isSenderAllowed('adblock:scriptlets', web())).toBe(true);
    expect(
      isSenderAllowed('adblock:scriptlets', web('https://ads.example/', { subFrame: true }))
    ).toBe(true);
    expect(isSenderAllowed('internal:get-pages', web('bzz://abcd/'))).toBe(true);
    // The chrome preload's document-start read from a frame with no URL yet.
    expect(isSenderAllowed('internal:get-pages', makeEvent({ type: 'window', url: '' }))).toBe(
      true
    );
    // ...but the same frameless sender gets nothing beyond the public tier.
    expect(isSenderAllowed('settings:get', makeEvent({ type: 'window', url: '' }))).toBe(false);
  });

  test('internal channels need the top frame of an internal page in our pages directory', () => {
    expect(isSenderAllowed('swarm:publish-file', page('publish.html'))).toBe(true);
    expect(isSenderAllowed('downloads:open-file', page('downloads.html'))).toBe(true);

    expect(isSenderAllowed('swarm:publish-file', web())).toBe(false);
    // An iframe inside an internal page is not the page.
    expect(isSenderAllowed('swarm:publish-file', page('publish.html', { subFrame: true }))).toBe(
      false
    );
    // A disposed / navigated-away frame is refused.
    expect(isSenderAllowed('swarm:publish-file', page('publish.html', { noFrame: true }))).toBe(
      false
    );
    // A look-alike file elsewhere on disk is not an internal page (suffix match).
    expect(
      isSenderAllowed(
        'swarm:publish-file',
        makeEvent({ url: fileUrl('/home/u/Downloads/x/src/renderer/pages/publish.html') })
      )
    ).toBe(false);
    // A non-allowlisted file inside the pages directory is not either.
    expect(isSenderAllowed('swarm:publish-file', page('evil.html'))).toBe(false);
    // The chrome's index.html loaded inside a webview is not the chrome.
    expect(
      isSenderAllowed(
        'wallet:send-transaction',
        makeEvent({ type: 'webview', url: fileUrl(CHROME_INDEX) })
      )
    ).toBe(false);
  });

  test('settings-only and profile-manager channels are narrower than internal', () => {
    expect(isSenderAllowed('permissions:revoke-all', page('settings.html'))).toBe(true);
    expect(isSenderAllowed('permissions:revoke-all', page('history.html'))).toBe(false);
    expect(isSenderAllowed('profile:delete', page('profiles.html'))).toBe(true);
    expect(isSenderAllowed('profile:delete', page('settings.html'))).toBe(true);
    expect(isSenderAllowed('profile:delete', page('downloads.html'))).toBe(false);
  });

  test('a chrome sender must be the top frame of our index.html in a window', () => {
    expect(isSenderAllowed('wallet:send-transaction', chrome({ subFrame: true }))).toBe(false);
    expect(isSenderAllowed('wallet:send-transaction', chrome({ noFrame: true }))).toBe(false);
    expect(
      isSenderAllowed(
        'wallet:send-transaction',
        makeEvent({ type: 'window', url: 'https://evil.example/' })
      )
    ).toBe(false);
    expect(
      isSenderAllowed(
        'wallet:send-transaction',
        makeEvent({ type: 'window', url: fileUrl('/tmp/index.html') })
      )
    ).toBe(false);
    expect(isSenderAllowed('wallet:send-transaction', {})).toBe(false);
    expect(isSenderAllowed('wallet:send-transaction', undefined)).toBe(false);
  });
});

describe('installIpcSenderPolicy', () => {
  function fakeIpcMain() {
    const ipc = new EventEmitter();
    ipc.handlers = new Map();
    ipc.handle = function (channel, fn) {
      this.handlers.set(channel, fn);
    };
    ipc.invoke = (channel, event, ...args) => ipc.handlers.get(channel)(event, ...args);
    return ipc;
  }

  test('wraps handle(): allowed senders reach the handler, others get a rejection', () => {
    const ipc = fakeIpcMain();
    const logger = { warn: jest.fn() };
    installIpcSenderPolicy(ipc, { logger });
    const handler = jest.fn(() => 'signed');
    ipc.handle('wallet:send-transaction', handler);

    expect(ipc.invoke('wallet:send-transaction', chrome(), { to: '0x1' })).toBe('signed');
    expect(() => ipc.invoke('wallet:send-transaction', web(), { to: '0x1' })).toThrow(
      /not available/
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('wallet:send-transaction'));
    // The log carries the scheme, never the URL.
    expect(logger.warn.mock.calls[0][0]).not.toContain('evil.example');
  });

  test('wraps on(): a refused sync message still gets an answer', () => {
    const ipc = fakeIpcMain();
    installIpcSenderPolicy(ipc, { logger: { warn: jest.fn() } });
    const listener = jest.fn((event) => {
      event.returnValue = 'secret';
    });
    ipc.on('identity:get-something', listener);

    const refused = web();
    ipc.emit('identity:get-something', refused);
    expect(listener).not.toHaveBeenCalled();
    expect(refused.returnValue).toBeNull();

    const allowed = chrome();
    ipc.emit('identity:get-something', allowed);
    expect(allowed.returnValue).toBe('secret');
  });

  test('removeListener with the original function still removes the wrapped one', () => {
    const ipc = fakeIpcMain();
    installIpcSenderPolicy(ipc, { logger: { warn: jest.fn() } });
    const listener = jest.fn();
    ipc.on('adblock:scriptlets', listener);
    expect(ipc.listenerCount('adblock:scriptlets')).toBe(1);
    ipc.removeListener('adblock:scriptlets', listener);
    expect(ipc.listenerCount('adblock:scriptlets')).toBe(0);
  });

  test('once() listeners are gated and removed after firing', () => {
    const ipc = fakeIpcMain();
    installIpcSenderPolicy(ipc, { logger: { warn: jest.fn() } });
    const listener = jest.fn();
    ipc.once('window:close', listener);
    ipc.emit('window:close', web());
    expect(listener).not.toHaveBeenCalled();
    ipc.emit('window:close', chrome());
    ipc.emit('window:close', chrome());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('is idempotent', () => {
    const ipc = fakeIpcMain();
    installIpcSenderPolicy(ipc);
    const once = ipc.handle;
    installIpcSenderPolicy(ipc);
    expect(ipc.handle).toBe(once);
  });
});

// Drift guard: the webview tiers must mirror webview-preload.js exactly —
// every main-bound channel the preload uses has a tier here, the tier matches
// the freedomAPI guard wrapping it, and nothing here is a channel the preload
// no longer uses (which would be a stale grant).
describe('webview tiers mirror webview-preload.js', () => {
  const source = fs.readFileSync(path.join(__dirname, 'webview-preload.js'), 'utf8');
  const CALL = /ipcRenderer\.(invoke|send|sendSync)\(\s*'([^']+)'/g;
  const GUARD_TIERS = {
    guardInternal: TIER.INTERNAL,
    guardSettingsPage: TIER.SETTINGS,
    guardProfileManagerPage: TIER.PROFILE_MANAGER,
  };

  function preloadTiers() {
    const start = source.indexOf("exposeInMainWorld('freedomAPI'");
    expect(start).toBeGreaterThan(0);
    // End of the freedomAPI object literal: first `});` at column 0 after it.
    const end = source.indexOf('\n});', start);
    expect(end).toBeGreaterThan(start);
    const tiers = new Map();
    const add = (channel, tier) => {
      const previous = tiers.get(channel);
      if (previous && previous !== tier) {
        throw new Error(`${channel} is used at two tiers (${previous}, ${tier})`);
      }
      tiers.set(channel, tier);
    };

    // Inside freedomAPI: attribute each call to the guard that opened the
    // chunk it sits in.
    const api = source.slice(start, end);
    const chunks = api.split(/\b(guard(?:Internal|SettingsPage|ProfileManagerPage))\(/);
    for (let i = 1; i < chunks.length; i += 2) {
      const tier = GUARD_TIERS[chunks[i]];
      for (const match of chunks[i + 1].matchAll(CALL)) add(match[2], tier);
    }
    // A call in freedomAPI that precedes any guard would be unguarded.
    expect([...chunks[0].matchAll(CALL)]).toEqual([]);

    // Outside freedomAPI: document-start bootstrap. internal:get-theme is only
    // issued from installInternalPageTheme (internal pages).
    const outside = source.slice(0, start) + source.slice(end);
    for (const match of outside.matchAll(CALL)) {
      add(match[2], match[2] === 'internal:get-theme' ? TIER.INTERNAL : TIER.PUBLIC);
    }
    return tiers;
  }

  test('every preload channel has the tier its preload guard implies, and nothing extra', () => {
    const fromPreload = preloadTiers();
    expect(fromPreload.size).toBeGreaterThan(50);
    expect(Object.fromEntries([...WEBVIEW_CHANNEL_TIERS].sort())).toEqual(
      Object.fromEntries([...fromPreload].sort())
    );
  });

  // CALL only recognises a single-quoted literal channel, so any other shape
  // (double quotes, a template literal, a constant, a computed name) would be
  // invisible to the tier comparison above — CI green, while the runtime
  // policy refuses the unlisted channel and the feature is dead in the app.
  // Every main-bound call must therefore name its channel as a plain
  // single-quoted literal. (sendToHost goes to the embedder, not ipcMain.)
  test('every main-bound preload call names its channel as a single-quoted literal', () => {
    // Dot, bracket, or optional-chaining (`?.`, `?.[`) access, with any
    // whitespace, newlines or comments (`/*…*/`, `//…`) around the accessor;
    // only the exact `ipcRenderer.<method>('…'` text is the form CALL reads,
    // so anything else — `ipcRenderer\n  .invoke(`, `ipcRenderer./*c*/invoke(`
    // — is an offender. (A comment after the method name is caught by the
    // `literal` check on what follows it.)
    const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*`;
    const anyCall = new RegExp(
      String.raw`ipcRenderer${gap}(\?\.${gap}\[|\?\.|\.|\[)${gap}['"\`]?(invoke|send|sendSync|postMessage)\b`,
      'g'
    );
    const literal = /^\(\s*'[^'\\$`]+'\s*[,)]/;
    const offenders = [];
    let total = 0;
    for (const match of source.matchAll(anyCall)) {
      total += 1;
      const rest = source.slice(match.index + match[0].length, match.index + match[0].length + 200);
      if (
        match[0] !== `ipcRenderer.${match[2]}` ||
        match[2] === 'postMessage' ||
        !literal.test(rest)
      ) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(
          `webview-preload.js:${line}: ${source.slice(match.index, match.index + 80).split('\n')[0]}`
        );
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
    // Nor may ipcRenderer escape under another name the scan can't see.
    expect(source).not.toMatch(/=\s*ipcRenderer\s*[;,\n]/);
    expect(source).not.toMatch(/\{[^}]*\b(invoke|send|sendSync)\b[^}]*\}\s*=\s*ipcRenderer/);
  });

  // The two tests above enumerate *bad* call shapes, which can never be
  // complete: `(ipcRenderer).invoke('x')`, `ipcRenderer.invoke.call(…)` or
  // `fn(ipcRenderer)` hand the object to an invoke the scans don't read. Close
  // the class instead by allow-listing every `ipcRenderer` token in the file:
  // each must be the one import, a comment line, a main-bound call in exactly
  // the form CALL reads, or a host/listener call that never reaches ipcMain.
  test('every ipcRenderer occurrence in the preload is an allow-listed form', () => {
    const allowed = [
      /^ipcRenderer\.(?:invoke|send|sendSync)\(\s*'[^'\\$`]+'\s*[,)]/,
      /^ipcRenderer\.(?:on|removeListener|sendToHost)\(/,
    ];
    const IMPORT = "const { contextBridge, ipcRenderer } = require('electron');";
    const offenders = [];
    let imports = 0;
    for (const match of source.matchAll(/\bipcRenderer\b/g)) {
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const lineEnd = source.indexOf('\n', match.index);
      const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (line === IMPORT) {
        imports += 1;
        continue;
      }
      if (/^\s*\/\//.test(line)) continue;
      const rest = source.slice(match.index, match.index + 200);
      if (allowed.some((re) => re.test(rest))) continue;
      const lineNo = source.slice(0, match.index).split('\n').length;
      offenders.push(`webview-preload.js:${lineNo}: ${line.trim()}`);
    }
    expect(imports).toBe(1);
    expect(offenders).toEqual([]);
  });

  test('get-theme is only read inside installInternalPageTheme', () => {
    const fn = source.indexOf('function installInternalPageTheme');
    const call = source.indexOf("sendSync('internal:get-theme')");
    expect(fn).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(fn);
    expect(source.indexOf("sendSync('internal:get-theme')", call + 1)).toBe(-1);
  });
});

describe('installation', () => {
  test('main/index.js installs the policy before any module can register a handler', () => {
    const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const install = index.indexOf('installIpcSenderPolicy(ipcMain');
    expect(install).toBeGreaterThan(0);
    // The only requires above the install are electron itself and the
    // threadpool sizing, which sets an env var and requires nothing.
    const before = index.slice(0, install);
    const requires = [...before.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    expect(requires).toEqual(['./uv-threadpool', 'electron', './ipc-sender-policy']);
  });
});
