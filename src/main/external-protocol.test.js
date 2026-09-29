const { EventEmitter } = require('events');
const IPC = require('../shared/ipc-channels');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

function load({ appName = '' } = {}) {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const shell = { openExternal: jest.fn(() => Promise.resolve()) };
  const ctx = loadMainModule(require.resolve('./external-protocol'), {
    electronOverrides: { shell },
    extraMocks: { [require.resolve('./logger')]: () => log },
  });
  ctx.app.getApplicationNameForProtocol = jest.fn(() => appName);
  return { ...ctx, log, shell };
}

describe('external-protocol', () => {
  afterEach(() => {
    delete globalThis.__FREEDOM_TEST_EXTERNAL_PROTOCOL__;
  });

  test('schemeOf lower-cases valid schemes and rejects everything else', () => {
    const { mod } = load();
    expect(mod.schemeOf('magnet:?xt=urn:btih:abc')).toBe('magnet');
    expect(mod.schemeOf('MailTo:a@b.c')).toBe('mailto');
    expect(mod.schemeOf('web+app:x')).toBe('web+app');
    expect(mod.schemeOf(':nothing')).toBeNull();
    expect(mod.schemeOf('no scheme here')).toBeNull();
    expect(mod.schemeOf('1abc:x')).toBeNull();
    expect(mod.schemeOf('sp ace:x')).toBeNull();
    expect(mod.schemeOf(`${'a'.repeat(65)}:x`)).toBeNull();
    expect(mod.schemeOf(undefined)).toBeNull();
  });

  test('keys are per scheme, and blocked schemes get no key at all', () => {
    const { mod } = load();
    expect(mod.permissionKeyForExternalUrl('magnet:?xt=urn:btih:abc')).toBe('external:magnet');
    expect(mod.permissionKeyForExternalUrl('mailto:someone@example.com')).toBe('external:mailto');
    expect(mod.permissionKeyForExternalUrl('zoommtg://zoom.us/join?confno=1')).toBe(
      'external:zoommtg'
    );

    const blocked = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/uuid',
      'about:blank',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'http://example.com',
      'https://example.com',
      'freedom://settings',
      'bzz://abc',
      'ipfs://bafy',
      'ipns://name',
      'web3://0x0000000000000000000000000000000000000001',
      'ens://name.eth',
      'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5',
      'radapi://x',
      'ethereum:0x0000000000000000000000000000000000000001',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x&crumb=location:\\\\evil\\share',
      'ms-officecmd:{}',
      'ms-word:ofe|u|https://evil.example/doc.docx',
      'ms-appinstaller:?source=https://evil.example/x.appx',
      'hcp://system/x',
      'x-man-page://ls',
      'FILE:///etc/passwd',
    ];
    for (const url of blocked) {
      expect([url, mod.permissionKeyForExternalUrl(url)]).toEqual([url, null]);
    }
  });

  // docs/security-audit-electron.md, O-9: a link to a network share makes the
  // OS connect to an attacker-chosen server (on Windows, with the user's NTLM
  // hash); a settings/installer scheme opens a system pane. None may ever get
  // a prompt, let alone a launch.
  test('network-share, directory-service and OS-settings schemes are refused outright', async () => {
    const { mod, shell } = load({ appName: 'Some Handler' });
    const blocked = [
      'smb://attacker.example/share',
      'SMB://attacker.example/share',
      'cifs://attacker.example/share',
      'nfs://attacker.example/export',
      'afp://attacker.example/vol',
      'webdav://attacker.example/dav',
      'webdavs://attacker.example/dav',
      'dav://attacker.example/dav',
      'davs://attacker.example/dav',
      'ftp://attacker.example/pub',
      'ftps://attacker.example/pub',
      'sftp://attacker.example/home',
      'ldap://attacker.example/dc=x',
      'ldaps://attacker.example/dc=x',
      'ms-settings:network-proxy',
      'x-apple.systempreferences:com.apple.preference.security',
      'itms-services://?action=download-manifest&url=https://attacker.example/m.plist',
      'file://attacker.example/share/x',
    ];
    for (const url of blocked) {
      expect([url, mod.permissionKeyForExternalUrl(url)]).toEqual([url, null]);
      // Typed into the address bar, it is refused rather than launched too.
      await expect(mod.openFromAddressBar(url)).resolves.toEqual({
        opened: false,
        reason: expect.stringMatching(/^(blocked|not-external)$/),
      });
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('isExternalProtocolUrl counts dangerous OS schemes as external but not browser ones', () => {
    const { mod } = load();
    expect(mod.isExternalProtocolUrl('magnet:?xt=x')).toBe(true);
    expect(mod.isExternalProtocolUrl('ms-msdt:/id x')).toBe(true);
    expect(mod.isExternalProtocolUrl('https://example.com')).toBe(false);
    expect(mod.isExternalProtocolUrl('bzz://abc')).toBe(false);
    expect(mod.isExternalProtocolUrl('about:blank')).toBe(false);
  });

  test('logs carry the scheme only', () => {
    const { mod } = load();
    expect(mod.externalUrlForLog('mailto:secret.person@example.com')).toBe('mailto:<redacted>');
    expect(mod.externalUrlForLog('garbage')).toBe('unknown');
  });

  test('escapes like Chromium before handing a URL to the OS', () => {
    const { mod } = load();
    expect(mod.escapeExternalHandlerValue('magnet:?xt=urn:btih:abc&dn=a b')).toBe(
      'magnet:?xt=urn:btih:abc&dn=a%20b'
    );
    expect(mod.escapeExternalHandlerValue('x:"a"<b>|c^`{}\\')).toBe(
      'x:%22a%22%3Cb%3E%7Cc%5E%60%7B%7D%5C'
    );
    // Existing escapes and ordinary URL structure survive untouched.
    expect(mod.escapeExternalHandlerValue('mailto:a@b.c?subject=hi%20there#x')).toBe(
      'mailto:a@b.c?subject=hi%20there#x'
    );
    expect(mod.escapeExternalHandlerValue('tel:+1\n2')).toBe('tel:+1%0A2');
    expect(mod.escapeExternalHandlerValue('x:é')).toBe('x:%C3%A9');
  });

  test('a user gesture buys exactly one launch, and only within the activation window', () => {
    const { mod } = load();
    const contents = new EventEmitter();
    mod.trackUserGestures(contents);

    expect(mod.consumeUserGesture(contents)).toBe(false);

    contents.emit('input-event', {}, { type: 'mouseMove' });
    expect(mod.consumeUserGesture(contents)).toBe(false);

    contents.emit('input-event', {}, { type: 'mouseDown' });
    expect(mod.consumeUserGesture(contents)).toBe(true);
    expect(mod.consumeUserGesture(contents)).toBe(false);

    contents.emit('input-event', {}, { type: 'keyDown' });
    expect(mod.consumeUserGesture(contents, Date.now() + mod.USER_GESTURE_WINDOW_MS + 1)).toBe(
      false
    );
  });

  // #442: one press stamps the gesture once, on the event Chromium grants
  // activation on; the popup blocker spends the same gesture.
  test('only activating input counts, and one press does not re-arm a spent gesture', () => {
    const { mod } = load();
    expect(mod.isActivatingInput({ type: 'mouseDown' })).toBe(true);
    expect(mod.isActivatingInput({ type: 'rawKeyDown', key: 'a' })).toBe(true);
    expect(mod.isActivatingInput({ type: 'keyDown', key: 'Enter' })).toBe(true);
    expect(mod.isActivatingInput({ type: 'touchEnd' })).toBe(true);
    for (const input of [
      { type: 'mouseUp' },
      { type: 'mouseMove' },
      { type: 'mouseWheel' },
      { type: 'char', key: 'a' },
      { type: 'keyUp', key: 'a' },
      { type: 'rawKeyDown', key: 'Escape' },
      { type: 'rawKeyDown', key: 'Shift' },
      { type: 'keyDown', key: 'Meta' },
      { type: 'touchStart' },
      { type: 'gestureTap' },
      null,
    ]) {
      expect(mod.isActivatingInput(input)).toBe(false);
    }

    const contents = new EventEmitter();
    mod.trackUserGestures(contents);
    contents.emit('input-event', {}, { type: 'mouseDown' });
    expect(mod.consumeUserGesture(contents)).toBe(true);
    contents.emit('input-event', {}, { type: 'mouseUp' });
    expect(mod.consumeUserGesture(contents)).toBe(false);
  });

  // A touch that becomes a scroll/pinch ends in pointercancel in Chromium and
  // grants nothing, though the raw touchEnd still arrives. Event sequences
  // are the ones probed on Electron 44 (see TOUCH_TURNED_GESTURE).
  test('a touch tap stamps the gesture; a touch that became a scroll does not', () => {
    const { mod } = load();
    const contents = new EventEmitter();
    mod.trackUserGestures(contents);
    const feed = (types) => types.forEach((type) => contents.emit('input-event', {}, { type }));

    // A tap, with a few px of jitter.
    feed(['touchStart', 'gestureTapDown', 'touchMove', 'touchMove', 'touchEnd', 'gestureTap']);
    expect(mod.consumeUserGesture(contents)).toBe(true);

    // A swipe that scrolled.
    feed([
      'touchStart',
      'gestureTapDown',
      'touchMove',
      'gestureTapCancel',
      'gestureScrollBegin',
      'touchScrollStarted',
      'gestureScrollUpdate',
      'touchMove',
      'touchEnd',
      'gestureFlingStart',
      'gestureScrollEnd',
    ]);
    expect(mod.consumeUserGesture(contents)).toBe(false);

    // A pinch, and a cancelled touch.
    feed(['touchStart', 'gesturePinchBegin', 'touchEnd']);
    expect(mod.consumeUserGesture(contents)).toBe(false);
    feed(['touchStart', 'touchCancel', 'touchEnd']);
    expect(mod.consumeUserGesture(contents)).toBe(false);

    // The next plain tap after a scroll counts again.
    feed(['touchStart', 'touchEnd']);
    expect(mod.consumeUserGesture(contents)).toBe(true);
  });

  // Chromium's transient activation does not survive a cross-document
  // navigation: input on page A must not pay for a popup page B opens on load.
  test('a main-frame document commit clears the gesture; a same-document one does not', () => {
    const { mod } = load();
    const contents = new EventEmitter();
    mod.trackUserGestures(contents);

    contents.emit('input-event', {}, { type: 'mouseDown' });
    contents.emit('did-navigate', {}, 'https://b.example/');
    expect(mod.consumeUserGesture(contents)).toBe(false);

    contents.emit('input-event', {}, { type: 'mouseDown' });
    contents.emit('did-navigate-in-page', {}, 'https://b.example/#x', true);
    contents.emit('did-frame-navigate', {}, 'https://ad.example/', 200, 'OK', false);
    expect(mod.consumeUserGesture(contents)).toBe(true);

    // Input on the new document counts as usual.
    contents.emit('did-navigate', {}, 'https://c.example/');
    contents.emit('input-event', {}, { type: 'keyDown', key: 'Enter' });
    expect(mod.consumeUserGesture(contents)).toBe(true);
  });

  test('launchExternal hands the escaped URL to shell.openExternal', async () => {
    const { mod, shell } = load();
    await expect(mod.launchExternal('magnet:?dn=a b')).resolves.toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith('magnet:?dn=a%20b');
  });

  test('address bar: opens only a registered, allowed scheme', async () => {
    const { mod, shell, app } = load({ appName: 'Transmission' });

    await expect(mod.openFromAddressBar('magnet:?xt=urn:btih:abc')).resolves.toEqual({
      opened: true,
    });
    expect(app.getApplicationNameForProtocol).toHaveBeenCalledWith('magnet:');
    expect(shell.openExternal).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc');

    shell.openExternal.mockClear();
    await expect(mod.openFromAddressBar('ms-msdt:/id x')).resolves.toEqual({
      opened: false,
      reason: 'blocked',
    });
    await expect(mod.openFromAddressBar('https://example.com')).resolves.toEqual({
      opened: false,
      reason: 'not-external',
    });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('address bar: a scheme with no OS handler is left to search', async () => {
    const { mod, shell } = load({ appName: '' });
    await expect(mod.openFromAddressBar('define:serendipity')).resolves.toEqual({
      opened: false,
      reason: 'no-handler',
    });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('the address-bar IPC refuses webview guests', async () => {
    const { mod, ipcMain, shell } = load({ appName: 'Mail' });
    mod.registerExternalProtocolIpc();
    const handler = ipcMain.handlers.get(IPC.EXTERNAL_PROTOCOL_OPEN_FROM_ADDRESS_BAR);

    await expect(
      Promise.resolve(handler({ sender: { getType: () => 'webview' } }, 'mailto:a@b.c'))
    ).resolves.toEqual({ opened: false, reason: 'not-chrome' });
    expect(shell.openExternal).not.toHaveBeenCalled();

    await expect(handler({ sender: { getType: () => 'window' } }, 'mailto:a@b.c')).resolves.toEqual(
      { opened: true }
    );
  });

  test('test mode records launches instead of opening anything', async () => {
    const { mod, shell } = load();
    const opened = [];
    globalThis.__FREEDOM_TEST_EXTERNAL_PROTOCOL__ = {
      open: (url) => opened.push(url),
      appNameFor: (scheme) => (scheme === 'magnet' ? 'Torrents' : ''),
    };
    await expect(mod.openFromAddressBar('magnet:?x')).resolves.toEqual({ opened: true });
    await expect(mod.openFromAddressBar('mailto:a@b.c')).resolves.toEqual({
      opened: false,
      reason: 'no-handler',
    });
    expect(opened).toEqual(['magnet:?x']);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
