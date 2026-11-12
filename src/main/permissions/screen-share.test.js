const { EventEmitter } = require('events');
const IPC = require('../../shared/ipc-channels');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

const PARTITION = 'private-1';
const realPlatform = process.platform;
const setPlatform = (value) => Object.defineProperty(process, 'platform', { value });

let nextId = 1;

function makeHost() {
  const host = new EventEmitter();
  host.id = nextId++;
  host.send = jest.fn();
  host.getOSProcessId = () => 4000;
  host.destroyed = false;
  host.isDestroyed = () => host.destroyed;
  host.destroy = () => {
    host.destroyed = true;
    host.emit('destroyed');
  };
  return host;
}

// The frames Electron still knows, by `<processId>:<frameToken>`, as
// webFrameMain.fromFrameToken answers.
const liveFrames = new Map();

function makeFrame(url, owner, osProcessId = 4100) {
  const frame = {
    url,
    owner,
    processId: 7,
    osProcessId,
    frameToken: `token-${nextId++}`,
    framesInSubtree: [],
  };
  liveFrames.set(`${frame.processId}:${frame.frameToken}`, frame);
  return frame;
}

// An iframe in `tab`, in a renderer process of its own; `.remove()` takes its
// document away.
function addSubframe(tab, url, osProcessId = 4200) {
  const frame = makeFrame(url, tab, osProcessId);
  tab.mainFrame.framesInSubtree.push(frame);
  frame.remove = () => {
    liveFrames.delete(`${frame.processId}:${frame.frameToken}`);
    tab.mainFrame.framesInSubtree = tab.mainFrame.framesInSubtree.filter((f) => f !== frame);
  };
  return frame;
}

// A tab's webContents: a webview guest in `host`, with a main frame.
function makeTab(url, host, { title = 'A page', privatePartition = null } = {}) {
  const tab = new EventEmitter();
  tab.id = nextId++;
  tab.hostWebContents = host;
  tab.privatePartition = privatePartition;
  tab.currentUrl = url;
  tab.destroyed = false;
  tab.getType = () => 'webview';
  tab.getURL = () => tab.currentUrl;
  tab.getTitle = () => title;
  tab.isDestroyed = () => tab.destroyed;
  tab.mainFrame = makeFrame(url, tab);
  tab.mainFrame.framesInSubtree.push(tab.mainFrame);
  tab.forcefullyCrashRenderer = jest.fn();
  tab.capturing = false;
  tab.isBeingCaptured = () => tab.capturing;
  tab.navigate = (next) => {
    tab.currentUrl = next;
    tab.emit('did-navigate');
  };
  tab.destroy = () => {
    tab.destroyed = true;
    tab.emit('destroyed');
  };
  return tab;
}

const image = (dataUrl) => ({ isEmpty: () => !dataUrl, toDataURL: () => dataUrl });

describe('screen sharing (#951)', () => {
  let ctx;
  let mod;
  let external;
  let log;
  let allContents;
  let desktopCapturer;
  let systemPreferences;
  let shell;

  const load = ({ screenAccess = 'granted', sources = [] } = {}) => {
    allContents = [];
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    desktopCapturer = { getSources: jest.fn(() => Promise.resolve(sources)) };
    systemPreferences = { getMediaAccessStatus: jest.fn(() => screenAccess) };
    shell = { openExternal: jest.fn(() => Promise.resolve()) };
    ctx = loadMainModule(require.resolve('./screen-share'), {
      webContents: {
        getAllWebContents: () => allContents,
        fromId: (id) => allContents.find((contents) => contents.id === id),
        fromFrame: (frame) => frame?.owner,
      },
      electronOverrides: {
        desktopCapturer,
        systemPreferences,
        shell,
        webFrameMain: {
          fromFrameToken: (processId, frameToken) =>
            liveFrames.get(`${processId}:${frameToken}`) || null,
        },
      },
      extraMocks: {
        [require.resolve('../logger')]: () => log,
        [require.resolve('../private/private-windows')]: () => ({
          getPartitionForWebContents: (contents) => contents?.privatePartition || null,
        }),
        [require.resolve('../favicons')]: () => ({
          getCachedFavicon: (url) =>
            url.includes('example') ? 'data:image/png;base64,icon' : null,
        }),
      },
    });
    mod = ctx.mod;
    external = require('../external-protocol');
    mod.registerScreenShareIpc();
  };

  // The older-route guard kills renderer processes; never for real here.
  let kill;
  beforeEach(() => {
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });
  afterEach(() => {
    kill.mockRestore();
    setPlatform(realPlatform);
  });
  const killed = () => kill.mock.calls.map(([pid, signal]) => `${pid}:${signal}`).sort();

  const click = (tab) => tab.emit('input-event', {}, { type: 'mouseDown' });

  // A tab that was just clicked, registered among the app's webContents.
  const tabFor = (host, url = 'https://meet.example.com/room', options = {}) => {
    const tab = makeTab(url, host, options);
    allContents.push(tab);
    external.trackUserGestures(tab);
    if (options.gesture !== false) click(tab);
    return tab;
  };

  // The permission request as permissions-manager hands it over.
  const ask = (tab, { callback = jest.fn(), mediaTypes = ['video'], ...rest } = {}) => {
    mod.requestScreenShare({
      guest: tab,
      host: tab.hostWebContents,
      origin: rest.origin === undefined ? 'https://meet.example.com' : rest.origin,
      details: {
        mediaTypes,
        requestingUrl: rest.requestingUrl || tab.getURL(),
        isMainFrame: rest.isMainFrame !== false,
      },
      callback,
      privatePartition: rest.privatePartition || null,
    });
    return callback;
  };

  // The picker most recently opened in `host`.
  const openedPicker = (host) => {
    const calls = host.send.mock.calls.filter(
      ([channel]) => channel === IPC.SCREEN_SHARE_PICKER_OPEN
    );
    return calls.length ? calls[calls.length - 1][1] : null;
  };

  const invoke = (channel, sender, payload) =>
    ctx.ipcMain.handlers.get(channel)({ sender }, payload);

  // getDisplayMedia(): granting the permission runs the display-media handler
  // synchronously, inside the callback.
  const displayMediaRoute = (tab, request = {}) => {
    const displayCallback = jest.fn();
    const permissionCallback = jest.fn((granted) => {
      if (!granted) return;
      mod.handleDisplayMediaRequest(
        {
          frame: tab.mainFrame,
          securityOrigin: 'https://meet.example.com/',
          videoRequested: true,
          audioRequested: false,
          userGesture: true,
          ...request,
        },
        displayCallback
      );
    });
    return { permissionCallback, displayCallback };
  };

  describe('before the picker', () => {
    test('a request with no recent user input is refused without a picker', () => {
      load();
      const host = makeHost();
      const tab = tabFor(host, undefined, { gesture: false });
      expect(ask(tab)).toHaveBeenCalledWith(false);
      expect(host.send).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no recent user input'));
    });

    test('one click opens one picker: asking again needs another click', () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const first = ask(tab);
      expect(first).not.toHaveBeenCalled();
      const { id } = openedPicker(host);
      invoke(IPC.SCREEN_SHARE_RESPOND, host, { id, sourceId: null });
      expect(first).toHaveBeenCalledWith(false);
      expect(ask(tab)).toHaveBeenCalledWith(false);
    });

    test('a tab gets one picker at a time', () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      ask(tab);
      click(tab);
      expect(ask(tab)).toHaveBeenCalledWith(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('already open'));
    });

    test('a page with no site origin is refused', () => {
      load();
      const host = makeHost();
      const tab = tabFor(host, 'file:///pages/settings.html');
      expect(ask(tab, { origin: null })).toHaveBeenCalledWith(false);
      expect(host.send).not.toHaveBeenCalled();
    });

    test('the picker names the site and offers tab audio when the page asked for audio', () => {
      load();
      setPlatform('darwin');
      const host = makeHost();
      const tab = tabFor(host);
      ask(tab, { mediaTypes: ['audio', 'video'] });
      expect(openedPicker(host)).toEqual({
        id: expect.any(Number),
        guestId: tab.id,
        origin: 'https://meet.example.com',
        audio: { tab: true, screen: false },
        platform: 'darwin',
      });
    });

    test('system audio is offered on Windows only', () => {
      load();
      setPlatform('win32');
      const host = makeHost();
      ask(tabFor(host), { mediaTypes: ['audio', 'video'] });
      expect(openedPicker(host).audio).toEqual({ tab: true, screen: true });
    });
  });

  describe('listing sources', () => {
    test("tabs: the requester's profile only, the requesting tab marked", async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host, 'https://meet.example.com/room', { title: 'Meeting' });
      const other = tabFor(host, 'https://docs.test/slides', { title: 'Slides' });
      tabFor(makeHost(), 'https://private.test/', { privatePartition: PARTITION });
      allContents.push({ ...makeTab('https://x.test/', host), getType: () => 'window' });
      ask(tab);
      const { id } = openedPicker(host);

      const result = await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'tab' });
      expect(result).toEqual({
        kind: 'tab',
        sources: [
          {
            kind: 'tab',
            id: `tab:${tab.id}`,
            name: 'Meeting',
            detail: 'meet.example.com',
            favicon: 'data:image/png;base64,icon',
            current: true,
          },
          {
            kind: 'tab',
            id: `tab:${other.id}`,
            name: 'Slides',
            detail: 'docs.test',
            favicon: null,
            current: false,
          },
        ],
      });
    });

    test("a private window's picker lists that window's tabs only", async () => {
      load();
      const host = makeHost();
      tabFor(makeHost(), 'https://normal.test/');
      const tab = tabFor(host, 'https://meet.example.com/', { privatePartition: PARTITION });
      ask(tab, { privatePartition: PARTITION });
      const { id } = openedPicker(host);
      const result = await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'tab' });
      expect(result.sources.map((source) => source.id)).toEqual([`tab:${tab.id}`]);
      // PRIVATE MODE GUARD: the log never names the private window's site.
      expect(JSON.stringify(log.info.mock.calls)).not.toContain('meet.example.com');
    });

    test('screens and windows come from desktopCapturer, with thumbnails', async () => {
      load({
        sources: [
          {
            id: 'screen:1:0',
            name: 'Screen 1',
            thumbnail: image('data:image/png;base64,thumb'),
            appIcon: null,
          },
        ],
      });
      const host = makeHost();
      ask(tabFor(host));
      const { id } = openedPicker(host);
      const result = await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'screen' });
      expect(desktopCapturer.getSources).toHaveBeenCalledWith({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      expect(result).toEqual({
        kind: 'screen',
        sources: [
          {
            kind: 'screen',
            id: 'screen:1:0',
            name: 'Screen 1',
            thumbnail: 'data:image/png;base64,thumb',
            icon: null,
          },
        ],
      });
    });

    test('on a Mac without Screen Recording, windows and screens say so instead', async () => {
      load({ screenAccess: 'denied' });
      setPlatform('darwin');
      const host = makeHost();
      ask(tabFor(host));
      const { id } = openedPicker(host);
      for (const kind of ['window', 'screen']) {
        expect(await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind })).toEqual({
          kind,
          sources: [],
          blocked: 'screen-recording',
        });
      }
      expect(desktopCapturer.getSources).not.toHaveBeenCalled();
      // Tabs need no OS permission.
      const tabs = await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'tab' });
      expect(tabs.sources).toHaveLength(1);
    });

    test('a Mac that declines the first Screen Recording prompt gets the same notice', async () => {
      load({ screenAccess: 'not-determined', sources: [] });
      setPlatform('darwin');
      systemPreferences.getMediaAccessStatus
        .mockReturnValueOnce('not-determined')
        .mockReturnValueOnce('denied');
      const host = makeHost();
      ask(tabFor(host));
      const { id } = openedPicker(host);
      const result = await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'window' });
      expect(desktopCapturer.getSources).toHaveBeenCalled();
      expect(result.blocked).toBe('screen-recording');
    });

    test('only the window the picker was sent to may list, preview or answer', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const callback = ask(tab);
      const { id } = openedPicker(host);
      const stranger = makeHost();
      expect(await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, stranger, { id, kind: 'tab' })).toBeNull();
      await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'tab' });
      expect(invoke(IPC.SCREEN_SHARE_RESPOND, stranger, { id, sourceId: `tab:${tab.id}` })).toBe(
        false
      );
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('the pick', () => {
    const pickAndShare = async (
      host,
      tab,
      { kind = 'tab', sourceId, audio = false, callback, mediaTypes } = {}
    ) => {
      ask(tab, { callback, mediaTypes });
      const { id } = openedPicker(host);
      await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind });
      return invoke(IPC.SCREEN_SHARE_RESPOND, host, { id, sourceId, audio });
    };

    test('cancel refuses the request', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const callback = ask(tab);
      const { id } = openedPicker(host);
      expect(invoke(IPC.SCREEN_SHARE_RESPOND, host, { id, sourceId: null })).toBe(true);
      expect(callback).toHaveBeenCalledWith(false);
    });

    test('a shared tab is shown and kept painted until nothing captures it', async () => {
      jest.useFakeTimers();
      try {
        load();
        const host = makeHost();
        const tab = tabFor(host);
        const slides = tabFor(host, 'https://docs.test/slides');
        const route = displayMediaRoute(tab);
        await pickAndShare(host, tab, {
          sourceId: `tab:${slides.id}`,
          callback: route.permissionCallback,
        });
        expect(host.send).toHaveBeenCalledWith(IPC.SCREEN_SHARE_TAB_SHARED, {
          guestId: slides.id,
        });
        const unshared = () =>
          host.send.mock.calls.some(([channel]) => channel === IPC.SCREEN_SHARE_TAB_UNSHARED);
        // Not started yet: the grace period holds.
        jest.advanceTimersByTime(3000);
        expect(unshared()).toBe(false);
        slides.capturing = true;
        jest.advanceTimersByTime(30000);
        expect(unshared()).toBe(false);
        // The page stopped its track.
        slides.capturing = false;
        jest.advanceTimersByTime(1000);
        expect(host.send).toHaveBeenCalledWith(IPC.SCREEN_SHARE_TAB_UNSHARED, {
          guestId: slides.id,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    // The share before might still be running, or already stopped, when the
    // tab is shared again; either way the new share keeps its grace period.
    test.each([
      ['after the earlier share stopped', false],
      ['while the earlier share still runs', true],
    ])('sharing a watched tab again restarts the grace period (%s)', async (_name, overlap) => {
      jest.useFakeTimers();
      try {
        load();
        const host = makeHost();
        const tab = tabFor(host);
        const slides = tabFor(host, 'https://docs.test/slides');
        const shareSlides = async () => {
          click(tab);
          const route = displayMediaRoute(tab);
          await pickAndShare(host, tab, {
            sourceId: `tab:${slides.id}`,
            callback: route.permissionCallback,
          });
        };
        const unshared = () =>
          host.send.mock.calls.some(([channel]) => channel === IPC.SCREEN_SHARE_TAB_UNSHARED);
        await shareSlides();
        slides.capturing = true;
        jest.advanceTimersByTime(12000);
        slides.capturing = overlap;
        await shareSlides();
        jest.advanceTimersByTime(1000);
        // The earlier share stops before the new capture has started.
        slides.capturing = false;
        jest.advanceTimersByTime(5000);
        expect(unshared()).toBe(false);
        slides.capturing = true;
        jest.advanceTimersByTime(10000);
        expect(unshared()).toBe(false);
        slides.capturing = false;
        jest.advanceTimersByTime(1000);
        expect(unshared()).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a tab share that never starts ends the watch after the grace period', async () => {
      jest.useFakeTimers();
      try {
        load();
        const host = makeHost();
        const tab = tabFor(host);
        const route = displayMediaRoute(tab);
        await pickAndShare(host, tab, {
          sourceId: `tab:${tab.id}`,
          callback: route.permissionCallback,
        });
        jest.advanceTimersByTime(9000);
        expect(host.send).not.toHaveBeenCalledWith(IPC.SCREEN_SHARE_TAB_UNSHARED, {
          guestId: tab.id,
        });
        jest.advanceTimersByTime(1000);
        expect(host.send).toHaveBeenCalledWith(IPC.SCREEN_SHARE_TAB_UNSHARED, { guestId: tab.id });
      } finally {
        jest.useRealTimers();
      }
    });

    test('a pick that was not listed is refused', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const callback = jest.fn();
      expect(await pickAndShare(host, tab, { sourceId: 'screen:1:0', callback })).toBe(false);
      expect(callback).toHaveBeenCalledWith(false);
    });

    test('getDisplayMedia() gets the picked tab, its audio, and keeps it audible', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const slides = tabFor(host, 'https://docs.test/slides');
      const { permissionCallback, displayCallback } = displayMediaRoute(tab, {
        audioRequested: true,
      });
      await pickAndShare(host, tab, {
        sourceId: `tab:${slides.id}`,
        audio: true,
        callback: permissionCallback,
        mediaTypes: ['audio', 'video'],
      });
      expect(permissionCallback).toHaveBeenCalledWith(true);
      expect(displayCallback).toHaveBeenCalledWith({
        video: slides.mainFrame,
        audio: slides.mainFrame,
        enableLocalEcho: true,
      });
      expect(tab.forcefullyCrashRenderer).not.toHaveBeenCalled();
    });

    test('no audio unless the page asked for it and the user kept it ticked', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const asked = displayMediaRoute(tab, { audioRequested: false });
      await pickAndShare(host, tab, {
        sourceId: `tab:${tab.id}`,
        audio: true,
        callback: asked.permissionCallback,
      });
      expect(asked.displayCallback).toHaveBeenCalledWith({ video: tab.mainFrame });

      click(tab);
      const unticked = displayMediaRoute(tab, { audioRequested: true });
      await pickAndShare(host, tab, {
        sourceId: `tab:${tab.id}`,
        audio: false,
        callback: unticked.permissionCallback,
        mediaTypes: ['audio', 'video'],
      });
      expect(unticked.displayCallback).toHaveBeenCalledWith({ video: tab.mainFrame });
    });

    test('a screen is handed over by id; system audio only on Windows', async () => {
      const sources = [{ id: 'screen:1:0', name: 'Screen 1', thumbnail: image(null) }];
      for (const [platform, audio] of [
        ['darwin', undefined],
        ['win32', 'loopback'],
      ]) {
        load({ sources });
        setPlatform(platform);
        const host = makeHost();
        const tab = tabFor(host);
        const route = displayMediaRoute(tab, { audioRequested: true });
        await pickAndShare(host, tab, {
          kind: 'screen',
          sourceId: 'screen:1:0',
          audio: true,
          callback: route.permissionCallback,
          mediaTypes: ['audio', 'video'],
        });
        expect(route.displayCallback).toHaveBeenCalledWith({
          video: { id: 'screen:1:0', name: 'Screen 1' },
          ...(audio ? { audio } : {}),
        });
      }
    });

    test('a window never carries audio', async () => {
      load({
        sources: [{ id: 'window:42:0', name: 'Notes', thumbnail: image(null), appIcon: null }],
      });
      setPlatform('win32');
      const host = makeHost();
      const tab = tabFor(host);
      const route = displayMediaRoute(tab, { audioRequested: true });
      await pickAndShare(host, tab, {
        kind: 'window',
        sourceId: 'window:42:0',
        audio: true,
        callback: route.permissionCallback,
        mediaTypes: ['audio', 'video'],
      });
      expect(route.displayCallback).toHaveBeenCalledWith({
        video: { id: 'window:42:0', name: 'Notes' },
      });
    });

    test("getUserMedia's chromeMediaSource skips the handler: the page is stopped", async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      // The older route: the permission is granted and nothing else runs.
      const callback = jest.fn();
      await pickAndShare(host, tab, { sourceId: `tab:${tab.id}`, callback });
      expect(callback).toHaveBeenCalledWith(true);
      // Killed at once, then the fallback.
      expect(killed()).toEqual(['4100:SIGKILL']);
      expect(tab.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
      expect(host.send).toHaveBeenCalledWith(IPC.SCREEN_SHARE_BLOCKED, {
        origin: 'https://meet.example.com',
        guestId: tab.id,
      });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('chromeMediaSource'));
    });

    // The older route from an iframe: the permission is granted and nothing else runs.
    const askFromIframe = async (host, tab, frameUrl, beforeShare = () => {}) => {
      const callback = jest.fn();
      ask(tab, {
        callback,
        isMainFrame: false,
        requestingUrl: frameUrl,
        origin: 'https://call.test',
      });
      const { id } = openedPicker(host);
      await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'tab' });
      beforeShare();
      invoke(IPC.SCREEN_SHARE_RESPOND, host, { id, sourceId: `tab:${tab.id}` });
      expect(callback).toHaveBeenCalledWith(true);
    };

    test('an iframe that left before the grant is not mistaken for the older route', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const iframe = addSubframe(tab, 'https://call.test/embed');
      await askFromIframe(host, tab, 'https://call.test/embed', () => iframe.remove());
      expect(tab.forcefullyCrashRenderer).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    });

    test('an iframe that changed its URL in place is still stopped', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const iframe = addSubframe(tab, 'https://call.test/embed');
      // history.replaceState: same document, new URL.
      await askFromIframe(host, tab, 'https://call.test/embed', () => {
        iframe.url = 'https://call.test/elsewhere';
      });
      // The iframe's own process, not only the tab's main renderer.
      expect(killed()).toEqual(['4100:SIGKILL', '4200:SIGKILL']);
      expect(tab.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    });

    test('a request whose frame could not be identified counts as still there', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      addSubframe(tab, 'https://call.test/embed', 4300);
      await askFromIframe(host, tab, 'https://call.test/not-a-frame');
      // Every frame of the tab, as any of them may have asked.
      expect(killed()).toEqual(['4100:SIGKILL', '4300:SIGKILL']);
      expect(tab.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    });

    test("the guard never signals Freedom's own processes", async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      tab.mainFrame.osProcessId = process.pid;
      addSubframe(tab, 'https://call.test/embed', 4000);
      await askFromIframe(host, tab, 'https://call.test/not-a-frame');
      expect(kill).not.toHaveBeenCalled();
      expect(tab.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    });

    test('the display-media handler refuses when no pick is being granted', () => {
      load();
      const callback = jest.fn();
      mod.handleDisplayMediaRequest({ frame: null, securityOrigin: 'https://x.test/' }, callback);
      expect(callback).toHaveBeenCalledWith(null);
    });

    test('the pick goes to the tab that asked, and to nothing else', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const elsewhere = tabFor(host, 'https://other.test/');
      const route = displayMediaRoute(elsewhere, { securityOrigin: 'https://other.test/' });
      await pickAndShare(host, tab, {
        sourceId: `tab:${tab.id}`,
        callback: route.permissionCallback,
      });
      expect(route.displayCallback).toHaveBeenCalledWith(null);
      // It still was the getDisplayMedia route: nothing to stop.
      expect(tab.forcefullyCrashRenderer).not.toHaveBeenCalled();
    });

    test('a picked tab that closed before Share refuses the request', async () => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const slides = tabFor(host, 'https://docs.test/');
      const callback = jest.fn();
      ask(tab, { callback });
      const { id } = openedPicker(host);
      await invoke(IPC.SCREEN_SHARE_LIST_SOURCES, host, { id, kind: 'tab' });
      slides.destroyed = true;
      invoke(IPC.SCREEN_SHARE_RESPOND, host, { id, sourceId: `tab:${slides.id}` });
      expect(callback).toHaveBeenCalledWith(false);
    });
  });

  describe('the request ending under the picker', () => {
    test.each([
      ['the tab navigates', (tab) => tab.navigate('https://elsewhere.test/')],
      ['the tab closes', (tab) => tab.destroy()],
      ['the window closes', (tab) => tab.hostWebContents.destroy()],
    ])('%s: the request is refused and the picker withdrawn', (_name, end) => {
      load();
      const host = makeHost();
      const tab = tabFor(host);
      const callback = ask(tab);
      const { id } = openedPicker(host);
      end(tab);
      expect(callback).toHaveBeenCalledWith(false);
      if (!host.destroyed) {
        expect(host.send).toHaveBeenCalledWith(IPC.SCREEN_SHARE_PICKER_CLOSE, { id });
      }
      // The picker is gone: a late answer applies to nothing.
      expect(invoke(IPC.SCREEN_SHARE_RESPOND, host, { id, sourceId: null })).toBe(false);
    });
  });

  test('System Settings opens on a Mac, from the picker window only', () => {
    load({ screenAccess: 'denied' });
    setPlatform('darwin');
    const host = makeHost();
    ask(tabFor(host));
    const { id } = openedPicker(host);
    expect(invoke(IPC.SCREEN_SHARE_OPEN_SYSTEM_SETTINGS, makeHost(), { id })).toBe(false);
    expect(invoke(IPC.SCREEN_SHARE_OPEN_SYSTEM_SETTINGS, host, { id })).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith(mod.MACOS_SCREEN_RECORDING_SETTINGS);
    setPlatform('linux');
    expect(invoke(IPC.SCREEN_SHARE_OPEN_SYSTEM_SETTINGS, host, { id })).toBe(false);
  });

  test('installs the handler on a session that has one', () => {
    load();
    const session = { setDisplayMediaRequestHandler: jest.fn() };
    mod.installScreenShareHandler(session);
    expect(session.setDisplayMediaRequestHandler).toHaveBeenCalledWith(
      mod.handleDisplayMediaRequest
    );
    expect(() => mod.installScreenShareHandler({})).not.toThrow();
  });
});
