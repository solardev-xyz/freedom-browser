// tabs.js reads `window` at module scope (heavy chrome-DOM import chain);
// mock it with a controllable "active webview" so the prompt tests can
// simulate tab switches. `var` (not let) avoids the TDZ under jest.mock
// hoisting; the name must start with "mock" to be referenced here.
var mockActiveWebview = null;
jest.mock('./tabs.js', () => ({
  getActiveWebview: jest.fn(() => mockActiveWebview),
  getDisplayUrlForWebview: jest.fn(() => ''),
}));

import {
  permissionLabel,
  describePermissionRequest,
  permissionRequestNote,
  initSitePermissionsUi,
  _resetForTests,
} from './site-permissions-ui.js';

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

describe('site-permissions-ui helpers', () => {
  describe('permissionLabel', () => {
    test('maps storage keys to human labels', () => {
      expect(permissionLabel('camera')).toBe('Camera');
      expect(permissionLabel('microphone')).toBe('Microphone');
      expect(permissionLabel('notifications')).toBe('Notifications');
      expect(permissionLabel('clipboard-read')).toBe('Clipboard reading');
      expect(permissionLabel('geolocation')).toBe('Location');
      expect(permissionLabel('midi')).toBe('MIDI devices');
    });

    test('falls back to the raw key for unknown permissions', () => {
      expect(permissionLabel('somefuturething')).toBe('somefuturething');
    });
  });

  describe('describePermissionRequest', () => {
    test('names single devices', () => {
      expect(describePermissionRequest(['camera'])).toBe('use your camera');
      expect(describePermissionRequest(['microphone'])).toBe('use your microphone');
      expect(describePermissionRequest(['notifications'])).toBe('show notifications');
      expect(describePermissionRequest(['clipboard-read'])).toBe(
        'read text and images from your clipboard'
      );
      expect(describePermissionRequest(['geolocation'])).toBe('know your location');
      expect(describePermissionRequest(['midi'])).toBe('use your MIDI devices');
    });

    test('collapses camera + microphone into one phrase', () => {
      expect(describePermissionRequest(['camera', 'microphone'])).toBe(
        'use your camera and microphone'
      );
      expect(describePermissionRequest(['microphone', 'camera'])).toBe(
        'use your camera and microphone'
      );
    });

    test('deduplicates keys and joins the rest with "and"', () => {
      expect(describePermissionRequest(['camera', 'camera'])).toBe('use your camera');
      expect(describePermissionRequest(['notifications', 'geolocation'])).toBe(
        'show notifications and know your location'
      );
    });

    test('has a safe fallback for empty input', () => {
      expect(describePermissionRequest([])).toBe('use a device');
      expect(describePermissionRequest()).toBe('use a device');
    });
  });

  describe('permissionRequestNote', () => {
    test('geolocation carries the reliability caveat', () => {
      expect(permissionRequestNote(['geolocation'])).toMatch(/may not work reliably/);
    });

    test('other permissions carry no note', () => {
      expect(permissionRequestNote(['camera'])).toBeNull();
      expect(permissionRequestNote([])).toBeNull();
    });
  });
});

describe('site-permissions-ui prompt tab-scoping', () => {
  const originalDocument = global.document;
  const originalWindow = global.window;

  let els;
  let doc;
  let api;

  const setActiveGuest = (id) => {
    mockActiveWebview = id == null ? null : { getWebContentsId: () => id };
  };

  const buildDom = () => {
    const byId = {
      'permission-prompt': createElement('div'),
      'permission-prompt-origin': createElement('span'),
      'permission-prompt-action': createElement('span'),
      'permission-prompt-note': createElement('div'),
      'permission-prompt-remember-label': createElement('label'),
      'permission-prompt-remember': createElement('input'),
      'permission-prompt-allow': createElement('button'),
      'permission-prompt-block': createElement('button'),
      'permission-indicator': createElement('button'),
      'permission-popover': createElement('div'),
      'permission-popover-title': createElement('div'),
      'permission-popover-list': createElement('div'),
    };
    byId['permission-prompt'].hidden = true;
    byId['permission-popover'].hidden = true;
    return byId;
  };

  const makeApi = () => {
    const fake = { handlers: {} };
    fake.onPromptRequest = jest.fn((cb) => {
      fake.handlers.request = cb;
    });
    fake.onPromptCancel = jest.fn((cb) => {
      fake.handlers.cancel = cb;
    });
    fake.onOsDenied = jest.fn((cb) => {
      fake.handlers.osDenied = cb;
    });
    fake.onChanged = jest.fn((cb) => {
      fake.handlers.changed = cb;
    });
    fake.respondToPrompt = jest.fn(() => Promise.resolve(true));
    fake.getForOrigin = jest.fn(() => Promise.resolve({}));
    fake.revoke = jest.fn(() => Promise.resolve(true));
    return fake;
  };

  const promptVisible = () => els['permission-prompt'].hidden === false;
  const sendRequest = (payload) => api.handlers.request(payload);
  // Held prompts surface on the next task (see the click-away note in
  // site-permissions-ui.js), so drain timers after every tab switch.
  const switchTab = (guestId) => {
    setActiveGuest(guestId);
    doc.handlers['active-tab-changed']();
    jest.runOnlyPendingTimers();
  };
  // The real thing: clicking a tab in the strip runs switchTab() —
  // which dispatches active-tab-changed synchronously — and the same
  // click then bubbles up to the document click-away listener.
  const clickTabInStrip = (guestId) => {
    const tabEl = createElement('div');
    doc.body.appendChild(tabEl);
    setActiveGuest(guestId);
    doc.handlers['active-tab-changed']();
    doc.handlers.click({ target: tabEl });
    jest.runOnlyPendingTimers();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    _resetForTests();
    els = buildDom();
    doc = createDocument({ elementsById: els });
    global.document = doc;
    api = makeApi();
    global.window = { sitePermissions: api, addEventListener: jest.fn() };
    setActiveGuest(1);
    initSitePermissionsUi();
  });

  afterEach(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    mockActiveWebview = null;
    jest.useRealTimers();
  });

  test("a request from the active tab's webview shows immediately", () => {
    sendRequest({ id: 10, origin: 'https://a.example', keys: ['notifications'], guestId: 1 });
    expect(promptVisible()).toBe(true);
    expect(els['permission-prompt-origin'].textContent).toBe('https://a.example');
  });

  test("a background tab's request is held, not shown under the active tab", () => {
    sendRequest({ id: 11, origin: 'https://bg.example', keys: ['camera'], guestId: 2 });

    // Active tab is guest 1 — nothing may render beneath its address bar.
    expect(promptVisible()).toBe(false);
    expect(api.respondToPrompt).not.toHaveBeenCalled();

    // Switching to the requesting tab surfaces the held prompt.
    switchTab(2);
    expect(promptVisible()).toBe(true);
    expect(els['permission-prompt-origin'].textContent).toBe('https://bg.example');
  });

  test('switching away holds the prompt unanswered; switching back re-shows it', () => {
    sendRequest({ id: 12, origin: 'https://a.example', keys: ['microphone'], guestId: 1 });
    expect(promptVisible()).toBe(true);

    switchTab(2);
    expect(promptVisible()).toBe(false);
    expect(api.respondToPrompt).not.toHaveBeenCalled();

    switchTab(1);
    expect(promptVisible()).toBe(true);

    els['permission-prompt-allow'].dispatch('click');
    expect(api.respondToPrompt).toHaveBeenCalledWith({
      id: 12,
      decision: 'allow',
      remember: true,
    });
  });

  test('clicking the requesting tab in the strip surfaces its held prompt, unanswered', () => {
    sendRequest({ id: 20, origin: 'https://bg.example', keys: ['notifications'], guestId: 2 });
    expect(promptVisible()).toBe(false);

    // The click that switches tabs must not also click-away the prompt
    // it just surfaced.
    clickTabInStrip(2);
    expect(promptVisible()).toBe(true);
    expect(els['permission-prompt-origin'].textContent).toBe('https://bg.example');
    expect(api.respondToPrompt).not.toHaveBeenCalled();

    // A later, separate click outside the prompt still dismisses it.
    doc.handlers.click({ target: doc.body });
    expect(promptVisible()).toBe(false);
    expect(api.respondToPrompt).toHaveBeenCalledWith({
      id: 20,
      decision: 'dismiss',
      remember: false,
    });
  });

  test('active-tab navigation does not dismiss the prompt (main owns invalidation)', () => {
    sendRequest({ id: 13, origin: 'https://a.example', keys: ['geolocation'], guestId: 1 });
    expect(promptVisible()).toBe(true);

    doc.handlers['navigation-completed']();
    expect(promptVisible()).toBe(true);
    expect(api.respondToPrompt).not.toHaveBeenCalled();
  });

  test('prompt-cancel withdraws shown and held prompts without answering', () => {
    sendRequest({ id: 14, origin: 'https://a.example', keys: ['camera'], guestId: 1 });
    sendRequest({ id: 15, origin: 'https://bg.example', keys: ['camera'], guestId: 2 });
    expect(promptVisible()).toBe(true);

    // Withdraw the on-screen prompt (its document navigated away).
    api.handlers.cancel({ id: 14 });
    expect(promptVisible()).toBe(false);

    // Withdraw the held background prompt; switching to its tab shows nothing.
    api.handlers.cancel({ id: 15 });
    switchTab(2);
    expect(promptVisible()).toBe(false);
    expect(api.respondToPrompt).not.toHaveBeenCalled();
  });
});
