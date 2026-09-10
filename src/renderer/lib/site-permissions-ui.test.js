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
import { getDisplayUrlForWebview } from './tabs.js';

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

  // #328: the prompt was the one address-bar popover outside the shared bound.
  // With the chrome document pinned (`html, body { overflow: hidden }`) an
  // unbounded prompt is clipped rather than scrollable: in a 220 px-tall window
  // its bottom landed at 235 and the last rows — the Allow button among them —
  // could not be reached at all.
  test('is bounded to the window when it is shown, like its sibling popover', () => {
    global.window.innerHeight = 220;
    els['permission-prompt'].setRect({ top: 88, bottom: 235, height: 147 });

    sendRequest({ id: 12, origin: 'https://a.example', keys: ['notifications'], guestId: 1 });

    expect(promptVisible()).toBe(true);
    // The room actually under it, measured from where it really is.
    expect(els['permission-prompt'].style.maxHeight).toBe(`${220 - 88 - 8}px`);
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

  // #306: Escape closes only the innermost open surface, as in Chrome, and
  // consumes the press while doing it — navigation.js's window-level Escape
  // (stop loading + restore the address bar) stands down on `defaultPrevented`,
  // so dismissing a prompt over a still-loading page can't cancel that load.
  test('Escape consumes the press only when it actually dismisses the prompt', () => {
    const idle = { key: 'Escape', preventDefault: jest.fn() };
    doc.handlers.keydown(idle);
    expect(idle.preventDefault).not.toHaveBeenCalled();

    sendRequest({ id: 16, origin: 'https://a.example', keys: ['camera'], guestId: 1 });
    expect(promptVisible()).toBe(true);

    const escape = { key: 'Escape', preventDefault: jest.fn() };
    doc.handlers.keydown(escape);
    expect(promptVisible()).toBe(false);
    expect(api.respondToPrompt).toHaveBeenCalledWith({
      id: 16,
      decision: 'dismiss',
      remember: false,
    });
    expect(escape.preventDefault).toHaveBeenCalled();
  });

  // #306, dialog sibling: a page can request a permission at any moment,
  // including while a modal <dialog> (the bookmark editor, the profile-create
  // or external-node prompt, onboarding) is up. The prompt then sits behind
  // the dialog's top layer, inert and un-answerable, and every gesture in that
  // state belongs to the dialog. Answering the prompt from one of them denies
  // the page's request behind the user's back — and the Escape's
  // `preventDefault()` additionally cancels the dialog's own close request, so
  // the dialog stays open too.
  const openModalDialog = () => {
    const dialog = createElement('dialog');
    dialog.setAttribute('open', '');
    doc.body.appendChild(dialog);
    return dialog;
  };

  test('a modal dialog owns the Escape: the prompt behind it is neither dismissed nor consumed', () => {
    sendRequest({ id: 17, origin: 'https://a.example', keys: ['notifications'], guestId: 1 });
    expect(promptVisible()).toBe(true);

    const dialog = openModalDialog();
    const escape = { key: 'Escape', preventDefault: jest.fn() };
    doc.handlers.keydown(escape);

    expect(promptVisible()).toBe(true);
    expect(api.respondToPrompt).not.toHaveBeenCalled();
    // Cancelling the press here would suppress the dialog's built-in cancel.
    expect(escape.preventDefault).not.toHaveBeenCalled();

    // Once the dialog is gone the prompt is the innermost surface again, and
    // the next press dismisses it as a deny-once.
    dialog.remove();
    const next = { key: 'Escape', preventDefault: jest.fn() };
    doc.handlers.keydown(next);
    expect(promptVisible()).toBe(false);
    expect(api.respondToPrompt).toHaveBeenCalledWith({
      id: 17,
      decision: 'dismiss',
      remember: false,
    });
    expect(next.preventDefault).toHaveBeenCalled();
  });

  test('a click inside a modal dialog is not a click-away from the prompt behind it', () => {
    sendRequest({ id: 18, origin: 'https://a.example', keys: ['camera'], guestId: 1 });
    expect(promptVisible()).toBe(true);

    const dialog = openModalDialog();
    const field = createElement('input');
    dialog.appendChild(field);
    doc.handlers.click({ target: field });

    expect(promptVisible()).toBe(true);
    expect(api.respondToPrompt).not.toHaveBeenCalled();

    // With the dialog closed, an ordinary click-away still dismisses.
    dialog.remove();
    doc.handlers.click({ target: doc.body });
    expect(promptVisible()).toBe(false);
    expect(api.respondToPrompt).toHaveBeenCalledWith({
      id: 18,
      decision: 'dismiss',
      remember: false,
    });
  });
});

describe('site-permissions-ui popover revoke label', () => {
  const originalDocument = global.document;
  const originalWindow = global.window;

  let els;
  let doc;
  let api;

  beforeEach(() => {
    _resetForTests();
    els = {
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
    els['permission-prompt'].hidden = true;
    els['permission-popover'].hidden = true;
    doc = createDocument({ elementsById: els });
    global.document = doc;

    api = {
      onPromptRequest: jest.fn(),
      onPromptCancel: jest.fn(),
      onOsDenied: jest.fn(),
      onChanged: jest.fn(),
      respondToPrompt: jest.fn(() => Promise.resolve(true)),
      getForOrigin: jest.fn(() =>
        Promise.resolve({
          camera: { decision: 'allow', remembered: true },
          geolocation: { decision: 'deny', remembered: true },
        })
      ),
      revoke: jest.fn(() => Promise.resolve(true)),
    };
    global.window = { sitePermissions: api, addEventListener: jest.fn() };
    mockActiveWebview = { getWebContentsId: () => 1 };
    getDisplayUrlForWebview.mockReturnValue('https://a.example/page');
    initSitePermissionsUi();
  });

  afterEach(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    mockActiveWebview = null;
    getDisplayUrlForWebview.mockReturnValue('');
  });

  // #226: the popover said 'Reset' while Settings > Site Permissions says
  // 'Remove' / 'Remove site' / 'Remove all' for the same action.
  test("each row's revoke button says Remove, matching Settings", async () => {
    // Let the indicator refresh kicked off by init resolve.
    await Promise.resolve();
    await Promise.resolve();

    els['permission-indicator'].dispatch('click');

    const buttons = els['permission-popover-list'].querySelectorAll('.permission-popover-revoke');
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.textContent)).toEqual(['Remove', 'Remove']);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove Camera permission',
      'Remove Location permission',
    ]);

    buttons[0].dispatch('click');
    expect(api.revoke).toHaveBeenCalledWith('https://a.example', 'camera');
  });
});
