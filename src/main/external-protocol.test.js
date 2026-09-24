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
