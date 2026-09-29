// docs/security-audit-electron.md, O-10: Electron silently sends the first
// matching TLS client certificate unless the app handles
// 'select-client-certificate'. A certificate identifies the user across
// sites, so Freedom must never auto-select one, and a private window must
// never send one at all.

const fs = require('fs');
const path = require('path');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const CERTS = [
  {
    subjectName: 'Alice Example',
    issuerName: 'Example Corp CA',
    validExpiry: Date.UTC(2027, 0, 31) / 1000,
    fingerprint: 'sha256/aaa',
  },
  {
    subjectName: 'Alice (work)',
    issuerName: 'Work CA',
    validExpiry: Date.UTC(2028, 5, 1) / 1000,
    fingerprint: 'sha256/bbb',
  },
];

function load({ isPrivate = false, privateThrows = false, window = {}, dialogResponse } = {}) {
  const win = window === null ? null : { isDestroyed: () => false, ...window };
  const dialog = {
    showMessageBox: jest.fn(() =>
      dialogResponse instanceof Error
        ? Promise.reject(dialogResponse)
        : Promise.resolve({ response: dialogResponse })
    ),
  };
  const BrowserWindow = { fromWebContents: jest.fn(() => win), getAllWindows: jest.fn(() => []) };
  const ctx = loadMainModule(require.resolve('./client-certificate'), {
    dialog,
    BrowserWindow,
    extraMocks: {
      [require.resolve('./private/private-windows')]: () => ({
        isPrivateWebContents: jest.fn(() => {
          if (privateThrows) throw new Error('destroyed');
          return isPrivate;
        }),
      }),
    },
  });
  return { ...ctx, dialog, BrowserWindow, win };
}

function select(
  mod,
  {
    list = CERTS,
    url = 'https://mtls.example:8443/',
    guest = { id: 7, hostWebContents: { id: 1 } },
  } = {}
) {
  const event = { preventDefault: jest.fn() };
  const callback = jest.fn();
  mod.handleSelectClientCertificate(event, guest, url, list, callback);
  return { event, callback };
}

describe('client-certificate selection', () => {
  test('registers on the app event', () => {
    const { mod, app } = load();
    app.on = jest.fn();
    mod.registerClientCertificateHandler();
    expect(app.on).toHaveBeenCalledWith(
      'select-client-certificate',
      mod.handleSelectClientCertificate
    );
  });

  // Without the listener Electron falls back to its first-match default, and
  // nothing else in the suite would notice.
  test('index.js installs the handler at startup', () => {
    const code = fs
      .readFileSync(path.join(__dirname, 'index.js'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(
      /const \{ registerClientCertificateHandler \} = require\('\.\/client-certificate'\);/
    );
    expect(code).toMatch(/^\s+registerClientCertificateHandler\(\);$/m);
  });

  test('a private window never sends a certificate and never prompts', async () => {
    const { mod, dialog } = load({ isPrivate: true, dialogResponse: 0 });
    const { event, callback } = select(mod);
    await flush();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]).toEqual([]);
  });

  test('privacy that cannot be determined is treated as private', async () => {
    const { mod, dialog } = load({ privateThrows: true, dialogResponse: 0 });
    const { callback } = select(mod);
    await flush();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(callback.mock.calls).toEqual([[]]);
  });

  // isPrivateWebContents() answers `false` (not private) for a torn-down
  // webContents instead of throwing, so the refusal must not depend on the
  // window lookup happening to fail too: here it still finds a window.
  test.each([
    ['a destroyed guest', { id: 7, isDestroyed: () => true, hostWebContents: { id: 1 } }],
    [
      'a guest whose host was destroyed',
      { id: 7, isDestroyed: () => false, hostWebContents: { id: 1, isDestroyed: () => true } },
    ],
    ['no webContents at all', null],
  ])('%s gets no certificate and no prompt', async (_label, guest) => {
    const { mod, dialog } = load({ isPrivate: false, dialogResponse: 0 });
    const { callback } = select(mod, { guest });
    await flush();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(callback.mock.calls).toEqual([[]]);
  });

  test('a normal window asks, with "don\'t send" as the default and cancel answer', async () => {
    const { mod, dialog, win } = load({ dialogResponse: 1 });
    const { event, callback } = select(mod);
    // Electron's first-match default is suppressed synchronously, before the
    // user has answered.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    await flush();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const [parent, options] = dialog.showMessageBox.mock.calls[0];
    expect(parent).toBe(win);
    expect(options.message).toBe('mtls.example:8443 is asking for a certificate');
    expect(options.buttons).toEqual([
      'Alice Example · issued by Example Corp CA · expires 2027-01-31',
      'Alice (work) · issued by Work CA · expires 2028-06-01',
      mod.DONT_SEND_LABEL,
    ]);
    expect(options.defaultId).toBe(2);
    expect(options.cancelId).toBe(2);

    // The user's pick is what is sent — not the first match.
    expect(callback.mock.calls).toEqual([[CERTS[1]]]);
  });

  test.each([
    ['declining', 2],
    ['an out-of-range answer', 9],
    ['no answer', undefined],
  ])('%s sends no certificate', async (_label, response) => {
    const { mod } = load({ dialogResponse: response });
    const { callback } = select(mod);
    await flush();
    expect(callback.mock.calls).toEqual([[]]);
  });

  test('a failed chooser sends no certificate', async () => {
    const { mod } = load({ dialogResponse: new Error('boom') });
    const { callback } = select(mod);
    await flush();
    expect(callback.mock.calls).toEqual([[]]);
  });

  test('no window to ask in, or nothing to choose from: no certificate, no prompt', async () => {
    for (const [opts, list] of [
      [{ window: null }, CERTS],
      [{}, []],
    ]) {
      const { mod, dialog } = load({ ...opts, dialogResponse: 0 });
      const { event, callback } = select(mod, { list });
      await flush();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
      expect(callback.mock.calls).toEqual([[]]);
    }
  });
});
