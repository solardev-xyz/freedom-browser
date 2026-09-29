// Popup blocker (#442): the gate's IPC surface, against the real permissions
// manager/store (on a scratch userData dir) and the real per-guest gesture
// tracking. The window-open path is covered through the real handler in
// webcontents-setup.test.js.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const IPC = require('../shared/ipc-channels');
const {
  loadMainModule,
  createTempUserDataDir,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const INTERNAL_HOME_URL = pathToFileURL(
  path.resolve(__dirname, '..', 'renderer', 'pages', 'home.html')
).href;

let userDataDir;

function load({ partitions = {} } = {}) {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const ctx = loadMainModule(require.resolve('./popup-blocker'), {
    userDataDir,
    extraMocks: {
      [require.resolve('./logger')]: () => log,
      [require.resolve('./private/private-windows')]: () => ({
        getPartitionForWebContents: (wc) => partitions[wc?.id] ?? null,
        isPrivateWebContents: (wc) => !!partitions[wc?.id],
      }),
    },
  });
  ctx.mod.registerPopupBlockerIpc();
  const external = require('./external-protocol');
  const permissions = require('./permissions/permissions-manager');
  const store = require('./permissions/permissions-store');
  return { ...ctx, log, external, permissions, store };
}

// A tab guest: an input-event emitter with the bits the gate reads.
function guest({ id = 9, url = 'https://site.example/page', host } = {}) {
  const wc = new EventEmitter();
  wc.id = id;
  wc.getType = () => 'webview';
  wc.getURL = () => url;
  wc.isDestroyed = () => false;
  wc.mainFrame = { name: 'main' };
  wc.hostWebContents = host === undefined ? { send: jest.fn(), isDestroyed: () => false } : host;
  return wc;
}

const click = (wc) => wc.emit('input-event', {}, { type: 'mouseDown' });

// Call a registered handler the way ipcMain would, with a real-looking sender.
const invoke = (ctx, channel, event, ...args) => ctx.ipcMain.handlers.get(channel)(event, ...args);
const fromGuest = (wc, frame = wc.mainFrame) => ({ sender: wc, senderFrame: frame });
const blockedReports = (wc) =>
  wc.hostWebContents.send.mock.calls.filter(([ch]) => ch === IPC.POPUPS_BLOCKED);

describe('popup-blocker', () => {
  beforeEach(() => {
    userDataDir = createTempUserDataDir('freedom-popups-');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    removeTempUserDataDir(userDataDir);
  });

  describe('claimPopup', () => {
    test('one gesture allows one popup, consumed', () => {
      const ctx = load();
      const wc = guest();
      ctx.external.trackUserGestures(wc);
      expect(ctx.mod.claimPopup(wc)).toEqual({
        allowed: false,
        reason: 'no-gesture',
        origin: 'https://site.example',
      });
      click(wc);
      expect(ctx.mod.claimPopup(wc)).toMatchObject({ allowed: true, reason: 'gesture' });
      expect(ctx.mod.claimPopup(wc)).toMatchObject({ allowed: false, reason: 'no-gesture' });
    });

    test('the gesture is one budget with external-app launches', () => {
      const ctx = load();
      const wc = guest();
      ctx.external.trackUserGestures(wc);
      click(wc);
      // An external-protocol prompt spent it first: no popup from that click.
      expect(ctx.external.consumeUserGesture(wc)).toBe(true);
      expect(ctx.mod.claimPopup(wc).allowed).toBe(false);
      // And the other way round.
      click(wc);
      expect(ctx.mod.claimPopup(wc).allowed).toBe(true);
      expect(ctx.external.consumeUserGesture(wc)).toBe(false);
    });

    test('an allowed site bypasses the gesture and leaves it unspent', () => {
      const ctx = load();
      const wc = guest();
      ctx.external.trackUserGestures(wc);
      ctx.store.setDecision('https://site.example', 'popups', 'allow');
      click(wc);
      expect(ctx.mod.claimPopup(wc)).toMatchObject({ allowed: true, reason: 'site-allowed' });
      expect(ctx.mod.claimPopup(wc)).toMatchObject({ allowed: true, reason: 'site-allowed' });
      expect(ctx.external.consumeUserGesture(wc)).toBe(true);
      // Another site is not covered.
      const other = guest({ id: 10, url: 'https://other.example/' });
      expect(ctx.mod.claimPopup(other).allowed).toBe(false);
    });

    test('a stored block, or an allow for another permission, does not allow popups', () => {
      const ctx = load();
      const wc = guest();
      ctx.store.setDecision('https://site.example', 'popups', 'deny');
      ctx.store.setDecision('https://site.example', 'camera', 'allow');
      expect(ctx.mod.claimPopup(wc).allowed).toBe(false);
    });

    test('internal pages are exempt; a look-alike path elsewhere on disk is not', () => {
      const ctx = load();
      expect(ctx.mod.claimPopup(guest({ url: INTERNAL_HOME_URL }))).toEqual({
        allowed: true,
        reason: 'internal-page',
        origin: null,
      });
      expect(ctx.mod.claimPopup(guest({ url: 'file:///tmp/pages/home.html' })).allowed).toBe(false);
    });
  });

  describe('popups:claim (webview preload, dweb links)', () => {
    test('answers true once per gesture and reports a refused one to the tab window', async () => {
      const ctx = load();
      const wc = guest();
      ctx.external.trackUserGestures(wc);
      const request = { url: 'ipfs://bafyexample/', targetName: null, reuseOnly: false };
      click(wc);
      expect(await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), request)).toBe(true);
      expect(blockedReports(wc)).toHaveLength(0);
      expect(await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), request)).toBe(false);
      expect(blockedReports(wc)).toEqual([
        [
          IPC.POPUPS_BLOCKED,
          {
            guestId: 9,
            url: 'ipfs://bafyexample/',
            targetName: null,
            reuseOnly: false,
            origin: 'https://site.example',
          },
        ],
      ]);
      // The URL is never logged (it may be a private tab's).
      expect(JSON.stringify(ctx.log.info.mock.calls)).not.toContain('bafyexample');
    });

    test('forwards a named target as reuse-only only when asked, and drops special names', async () => {
      const ctx = load();
      const wc = guest();
      await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), {
        url: 'ipfs://a/',
        targetName: 'viewer',
        reuseOnly: true,
      });
      await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), {
        url: 'ipfs://b/',
        targetName: '_blank',
        reuseOnly: true,
      });
      expect(blockedReports(wc).map(([, p]) => [p.targetName, p.reuseOnly])).toEqual([
        ['viewer', true],
        [null, false],
      ]);
    });

    test('refuses non-webview senders, sub-frames and URLs the preload never routes', async () => {
      const ctx = load();
      const wc = guest();
      ctx.external.trackUserGestures(wc);
      click(wc);
      const chrome = guest({ id: 1 });
      chrome.getType = () => 'window';
      expect(await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(chrome), { url: 'ipfs://a/' })).toBe(
        false
      );
      expect(
        await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc, { name: 'sub' }), { url: 'ipfs://a/' })
      ).toBe(false);
      for (const url of [
        'javascript:alert(1)',
        'file:///etc/passwd',
        '',
        `ipfs://${'a'.repeat(9000)}`,
      ]) {
        expect(await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), { url })).toBe(false);
      }
      expect(await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), null)).toBe(false);
      // None of the refusals spent the gesture, and none was reported.
      expect(blockedReports(wc)).toHaveLength(0);
      expect(await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), { url: 'ipfs://a/' })).toBe(true);
    });

    test('a blocked claim from a guest with no live host reports nothing and does not throw', async () => {
      const ctx = load();
      const wc = guest({ host: null });
      expect(await invoke(ctx, IPC.POPUPS_CLAIM, fromGuest(wc), { url: 'ipfs://a/' })).toBe(false);
    });
  });

  describe('popups:allow-site (the icon\'s "Always allow")', () => {
    const chromeSender = (id) => ({ sender: { id } });

    test('a normal window persists the allow in the permissions store', async () => {
      const ctx = load();
      expect(
        await invoke(ctx, IPC.POPUPS_ALLOW_SITE, chromeSender(1), 'https://site.example')
      ).toBe(true);
      expect(ctx.store.getDecision('https://site.example', 'popups')).toBe('allow');
      const file = JSON.parse(fs.readFileSync(path.join(userDataDir, 'permissions.json'), 'utf8'));
      expect(file).toEqual({ 'https://site.example': { popups: 'allow' } });
      // It is listed like any other site permission, and revocable there.
      expect(ctx.permissions.getDecisionsForOrigin('https://site.example')).toEqual({
        popups: { decision: 'allow', remembered: true },
      });
      ctx.permissions.revokeDecision('https://site.example', 'popups');
      expect(ctx.mod.claimPopup(guest()).allowed).toBe(false);
    });

    test('a private window keeps the allow in its partition only', async () => {
      const ctx = load({ partitions: { 2: 'private-1', 9: 'private-1' } });
      expect(
        await invoke(ctx, IPC.POPUPS_ALLOW_SITE, chromeSender(2), 'https://site.example')
      ).toBe(true);
      expect(ctx.store.getDecision('https://site.example', 'popups')).toBeNull();
      expect(fs.existsSync(path.join(userDataDir, 'permissions.json'))).toBe(false);
      // It applies to that window's tabs…
      expect(ctx.mod.claimPopup(guest({ id: 9 })).reason).toBe('site-allowed');
      // …not to a normal window's…
      expect(ctx.mod.claimPopup(guest({ id: 11 })).allowed).toBe(false);
      // …and goes with the window.
      ctx.permissions.clearPrivateDecisions('private-1');
      expect(ctx.mod.claimPopup(guest({ id: 9 })).allowed).toBe(false);
    });

    test('refuses a value that is not a site origin', async () => {
      const ctx = load();
      for (const origin of ['', null, 42, 'not a url', 'data:text/html,x', 'file:///etc']) {
        expect(await invoke(ctx, IPC.POPUPS_ALLOW_SITE, chromeSender(1), origin)).toBe(false);
      }
      expect(ctx.store.getAllDecisions()).toEqual({});
    });

    test('is chrome-only: the sender policy gives it no webview tier', () => {
      const policy = require('./ipc-sender-policy');
      expect(policy.WEBVIEW_CHANNEL_TIERS.has(IPC.POPUPS_ALLOW_SITE)).toBe(false);
      expect(policy.WEBVIEW_CHANNEL_TIERS.get(IPC.POPUPS_CLAIM)).toBe(policy.TIER.PUBLIC);
    });
  });
});
