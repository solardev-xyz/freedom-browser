// Pop-up-blocked icon (#442): per-tab state, the popover's Open / Always
// allow actions, clearing on navigation, and the gesture-less named-target
// reuse that is tried before anything is recorded as blocked.

// `var` (not let) avoids the TDZ under jest.mock hoisting.
var mockTabs = [];
var mockActiveTab = null;
jest.mock('./tabs.js', () => ({
  getActiveTab: jest.fn(() => mockActiveTab),
  getTabByGuestId: jest.fn((id) => mockTabs.find((t) => t.guestId === id) || null),
  openInNewTabWithTarget: jest.fn(() => null),
}));
jest.mock('./modal-dialog.js', () => ({ isModalDialogOpen: jest.fn(() => false) }));
jest.mock('./debug.js', () => ({ pushDebug: jest.fn() }));
jest.mock('./popover-bounds.js', () => ({ boundPopoverToViewport: jest.fn() }));

import {
  initPopupBlockerUi,
  handlePopupBlocked,
  getBlockedPopups,
  closePopupBlockedPopover,
  MAX_LISTED_POPUPS,
  _resetForTests,
} from './popup-blocker-ui.js';
import { openInNewTabWithTarget } from './tabs.js';

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const makeTab = (id, guestId) => ({ id, guestId, webview: createElement('webview') });

describe('popup-blocker-ui', () => {
  let els;
  let doc;
  let api;
  let tabA;
  let tabB;

  const icon = () => els['popup-blocked-indicator'];
  const popover = () => els['popup-blocked-popover'];
  const iconShown = () => !icon().classList.contains('hidden');
  const openButtons = () => els['popup-blocked-list'].children;
  const switchTo = (tab) => {
    mockActiveTab = tab;
    doc.handlers['active-tab-changed']();
  };
  const blocked = (tab, url, extra = {}) =>
    handlePopupBlocked({
      guestId: tab.guestId,
      url,
      targetName: null,
      reuseOnly: false,
      origin: 'https://site.example',
      ...extra,
    });
  const openPopover = () => icon().dispatch('click');

  beforeEach(() => {
    _resetForTests();
    openInNewTabWithTarget.mockReset().mockReturnValue(null);
    els = {
      'popup-blocked-indicator': createElement('button', { classes: ['hidden'] }),
      'popup-blocked-popover': createElement('div'),
      'popup-blocked-origin': createElement('div'),
      'popup-blocked-list': createElement('div'),
      'popup-blocked-more': createElement('div', { classes: ['hidden'] }),
      'popup-blocked-allow': createElement('button'),
      'popup-blocked-allowed': createElement('div', { classes: ['hidden'] }),
    };
    els['popup-blocked-popover'].hidden = true;
    for (const id of ['origin', 'list', 'more', 'allow', 'allowed']) {
      els['popup-blocked-popover'].appendChild(els[`popup-blocked-${id}`]);
    }
    doc = createDocument({ elementsById: els });
    global.document = doc;
    api = { allowPopups: jest.fn(() => Promise.resolve(true)) };
    global.window = {
      sitePermissions: api,
      electronAPI: { onPopupBlocked: jest.fn() },
      addEventListener: jest.fn(),
    };
    tabA = makeTab(1, 101);
    tabB = makeTab(2, 102);
    mockTabs = [tabA, tabB];
    mockActiveTab = tabA;
    initPopupBlockerUi();
  });

  test('subscribes to main and starts hidden', () => {
    expect(window.electronAPI.onPopupBlocked).toHaveBeenCalledWith(handlePopupBlocked);
    expect(iconShown()).toBe(false);
  });

  test('a blocked popup shows the icon for its own tab only', () => {
    blocked(tabB, 'https://site.example/b');
    expect(iconShown()).toBe(false);
    switchTo(tabB);
    expect(iconShown()).toBe(true);
    expect(icon().getAttribute('aria-label')).toBe('Pop-up blocked');
    switchTo(tabA);
    expect(iconShown()).toBe(false);
  });

  test('the popover lists the blocked URLs in full, capped, with the rest counted', () => {
    for (let i = 0; i < MAX_LISTED_POPUPS + 2; i += 1) {
      blocked(tabA, `https://site.example/popup/${i}?a=very-long-query-string-that-stays-whole`);
    }
    openPopover();
    expect(popover().hidden).toBe(false);
    expect(openButtons()).toHaveLength(MAX_LISTED_POPUPS);
    expect(openButtons()[0].textContent).toBe(
      'Open https://site.example/popup/0?a=very-long-query-string-that-stays-whole'
    );
    expect(els['popup-blocked-more'].textContent).toBe('and 2 more blocked pop-ups');
    expect(els['popup-blocked-more'].classList.contains('hidden')).toBe(false);
    expect(els['popup-blocked-origin'].textContent).toBe('https://site.example');
    expect(icon().getAttribute('aria-label')).toBe(`${MAX_LISTED_POPUPS + 2} pop-ups blocked`);
  });

  test('"Open" opens that popup as a tab, as if it had been allowed, and drops it', () => {
    blocked(tabA, 'https://site.example/one');
    blocked(tabA, 'ipfs://bafyexample/', { targetName: 'viewer' });
    openPopover();
    openButtons()[1].dispatch('click');
    expect(openInNewTabWithTarget).toHaveBeenCalledWith('ipfs://bafyexample/', 'viewer', {
      openerTabId: tabA.id,
    });
    expect(getBlockedPopups(tabA).entries).toEqual([
      { url: 'https://site.example/one', targetName: null },
    ]);
    expect(iconShown()).toBe(true);
    openButtons()[0].dispatch('click');
    expect(openInNewTabWithTarget).toHaveBeenLastCalledWith('https://site.example/one', null, {
      openerTabId: tabA.id,
    });
    // Nothing left: the icon goes.
    expect(iconShown()).toBe(false);
    expect(popover().hidden).toBe(true);
  });

  test('"Always allow" records the site permission through main and says so', async () => {
    blocked(tabA, 'https://site.example/one');
    openPopover();
    expect(els['popup-blocked-allow'].classList.contains('hidden')).toBe(false);
    els['popup-blocked-allow'].dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    expect(api.allowPopups).toHaveBeenCalledWith('https://site.example');
    expect(els['popup-blocked-allow'].classList.contains('hidden')).toBe(true);
    expect(els['popup-blocked-allowed'].classList.contains('hidden')).toBe(false);
    // What was already blocked can still be opened.
    expect(openButtons()).toHaveLength(1);
  });

  test('"Always allow" that main refuses changes nothing', async () => {
    api.allowPopups.mockResolvedValue(false);
    blocked(tabA, 'https://site.example/one');
    openPopover();
    els['popup-blocked-allow'].dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    expect(els['popup-blocked-allow'].classList.contains('hidden')).toBe(false);
    expect(getBlockedPopups(tabA).allowed).toBe(false);
  });

  test('a page with no site origin gets no allow action', () => {
    blocked(tabA, 'https://x.example/', { origin: null });
    openPopover();
    expect(els['popup-blocked-allow'].classList.contains('hidden')).toBe(true);
  });

  test("a committed navigation of the tab clears its list; another tab's does not", () => {
    blocked(tabA, 'https://site.example/a');
    blocked(tabB, 'https://site.example/b');
    tabB.webview.dispatch('did-navigate');
    expect(getBlockedPopups(tabB)).toBeNull();
    expect(iconShown()).toBe(true);
    tabA.webview.dispatch('did-navigate');
    expect(getBlockedPopups(tabA)).toBeNull();
    expect(iconShown()).toBe(false);
    // The next page's blocked popups start a fresh list (one listener per webview).
    blocked(tabA, 'https://site.example/c');
    expect(getBlockedPopups(tabA).total).toBe(1);
    expect(tabA.webview.handlers['did-navigate']).toHaveLength(1);
  });

  test('a reuse-only named target that re-navigates its named tab is not a blocked popup', () => {
    openInNewTabWithTarget.mockReturnValueOnce(tabB);
    blocked(tabA, 'https://site.example/v', { targetName: 'viewer', reuseOnly: true });
    expect(openInNewTabWithTarget).toHaveBeenCalledWith('https://site.example/v', 'viewer', {
      reuseOnly: true,
      openerTabId: tabA.id,
    });
    expect(getBlockedPopups(tabA)).toBeNull();
    expect(iconShown()).toBe(false);

    // No such tab (or not this tab's to navigate): blocked like any other.
    blocked(tabA, 'https://site.example/w', { targetName: 'viewer', reuseOnly: true });
    expect(getBlockedPopups(tabA).entries).toEqual([
      { url: 'https://site.example/w', targetName: 'viewer' },
    ]);
    expect(iconShown()).toBe(true);
  });

  test('ignores reports for unknown tabs and malformed payloads', () => {
    handlePopupBlocked({ guestId: 999, url: 'https://x.example/' });
    handlePopupBlocked({ guestId: tabA.guestId, url: '' });
    handlePopupBlocked(null);
    expect(getBlockedPopups(tabA)).toBeNull();
  });

  test('closes on Escape, click-away, the shared dismissal hook and tab switch', () => {
    blocked(tabA, 'https://site.example/a');
    blocked(tabB, 'https://site.example/b');
    openPopover();
    doc.handlers.keydown({ key: 'Escape', preventDefault: jest.fn() });
    expect(popover().hidden).toBe(true);

    openPopover();
    doc.handlers.click({ target: createElement('div') });
    expect(popover().hidden).toBe(true);

    openPopover();
    // A click inside the popover (or on the icon) keeps it.
    doc.handlers.click({ target: els['popup-blocked-list'] });
    expect(popover().hidden).toBe(false);
    closePopupBlockedPopover();
    expect(popover().hidden).toBe(true);

    openPopover();
    switchTo(tabB);
    expect(popover().hidden).toBe(true);
    expect(icon().getAttribute('aria-expanded')).toBe('false');
  });
});
