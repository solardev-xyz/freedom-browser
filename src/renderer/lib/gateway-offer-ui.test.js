// "Open without gateway" pill (#70): per-tab offers on commit, the popover's
// Open / Cancel / "always" choice, and the opt-in automatic redirect with its
// Back-button and stale-answer guards. Main's host parsing is covered by
// src/main/gateway-offer.test.js; here `getGatewayOffer` is the IPC stub.

// `var` (not let) avoids the TDZ under jest.mock hoisting.
var mockActiveTab = null;
var mockWebviewCreated = null;
// The running total of Back/Forward requests (historyTraversalRequestCount).
var mockTraversalPending = 0;
jest.mock('./tabs.js', () => ({
  getActiveTab: jest.fn(() => mockActiveTab),
  onWebviewCreated: jest.fn((listener) => {
    mockWebviewCreated = listener;
  }),
}));
jest.mock('./history-traversal.js', () => ({
  historyTraversalRequestCount: jest.fn(() => mockTraversalPending),
}));
jest.mock('./modal-dialog.js', () => ({ isModalDialogOpen: jest.fn(() => false) }));
jest.mock('./debug.js', () => ({ pushDebug: jest.fn() }));
jest.mock('./popover-bounds.js', () => ({ boundPopoverToViewport: jest.fn() }));

import {
  initGatewayOfferUi,
  closeGatewayOfferPopover,
  getActiveOffer,
  looksLikeGatewayUrl,
  isSameGatewayService,
  describeOffer,
  noteUserNavigation,
  _resetForTests,
} from './gateway-offer-ui.js';

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const GATEWAY = 'https://vitalik.eth.limo/blog/?p=1#c';
const OFFER = {
  gateway: 'eth.limo',
  gatewayHost: 'vitalik.eth.limo',
  protocol: 'ipfs',
  target: 'ipfs://vitalik.eth',
  destination: 'ipfs://vitalik.eth/blog/?p=1#c',
};

// bzz.link's answer for a CID that is not on its allowlist.
const SWARM_REF = 'e53efa25'.padEnd(64, '0');
const CID_URL =
  'https://bah5acgza4u7pujju42fv7fu36if7xhkfij7gcyzfjj535g5pdy73yp26fdra.bzz.link/docs/?q=1#top';
const FORBIDDEN = `https://bzz.link/forbidden?hash=${SWARM_REF}`;
const CID_OFFER = {
  gateway: 'bzz.link',
  gatewayHost: 'bah5acgza4u7pujju42fv7fu36if7xhkfij7gcyzfjj535g5pdy73yp26fdra.bzz.link',
  protocol: 'bzz',
  target: `bzz://${SWARM_REF}`,
  destination: `bzz://${SWARM_REF}/docs/?q=1#top`,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('isSameGatewayService (which redirect landings borrow the start)', () => {
  test.each([
    [CID_URL, FORBIDDEN, true],
    [CID_URL, 'http://bzz.link./forbidden', true],
    ['https://vitalik.eth.limo/', 'https://eth.limo/error', true],
    ['https://vitalik.eth.limo/', 'https://www.eth.limo/', true],
    ['https://evil.eth.limo/', 'https://bank.example/login', false],
    ['https://evil.eth.limo/', 'https://bzz.link/forbidden', false],
    ['https://evil.eth.link/', 'https://eth.limo/', false],
    [CID_URL, 'https://evilbzz.link/', false],
    [CID_URL, 'https://bzz.link.example/', false],
    [CID_URL, 'ftp://bzz.link/', false],
    ['https://example.com/', 'https://example.com/x', false],
    ['not a url', FORBIDDEN, false],
  ])('%s -> %s: %s', (started, landed, expected) => {
    expect(isSameGatewayService(started, landed)).toBe(expected);
  });
});

describe('looksLikeGatewayUrl (the IPC pre-filter)', () => {
  test.each([
    'https://vitalik.eth.limo/',
    'https://vitalik.eth.link',
    'http://vitalik.bzz.link/x?y#z',
    'https://VITALIK.ETH.LIMO/',
    'https://vitalik.eth.limo./',
  ])('%s is sent to main', (url) => expect(looksLikeGatewayUrl(url)).toBe(true));

  test.each([
    'https://example.com/',
    'https://eth.limo/',
    'https://vitalik.eth.limo.evil.example/',
    'https://example.com/?u=https://vitalik.eth.limo/',
    'ipfs://vitalik.eth/',
    '',
    null,
  ])('%s is not', (url) => expect(looksLikeGatewayUrl(url)).toBe(false));
});

test('describeOffer names the transport and the gateway', () => {
  expect(describeOffer(OFFER)).toBe(
    'Loads directly from IPFS instead of through the eth.limo gateway.'
  );
  expect(describeOffer({ protocol: 'bzz', gateway: 'bzz.link' })).toBe(
    'Loads directly from Swarm instead of through the bzz.link gateway.'
  );
});

describe('gateway-offer-ui', () => {
  let els;
  let doc;
  let api;
  let navigate;
  let windowHandlers;
  let tabA;
  let tabB;

  const pill = () => els['gateway-offer-pill'];
  const popover = () => els['gateway-offer-popover'];
  const pillShown = () => !pill().classList.contains('hidden');
  const makeTab = (id) => {
    const tab = { id, webview: createElement('webview') };
    mockWebviewCreated(tab.webview);
    return tab;
  };
  const commit = (tab, url) => tab.webview.dispatch('did-navigate', { url });
  const start = (tab, url, extra = {}) =>
    tab.webview.dispatch('did-start-navigation', {
      url,
      isMainFrame: true,
      isInPlace: false,
      ...extra,
    });
  const switchTo = (tab) => {
    mockActiveTab = tab;
    doc.handlers['active-tab-changed']();
  };
  const setAlways = (value) =>
    windowHandlers['settings:updated']({ detail: { openWithoutGateway: value } });

  beforeEach(() => {
    _resetForTests();
    mockTraversalPending = 0;
    els = {
      'gateway-offer-pill': createElement('button', { classes: ['hidden'] }),
      'gateway-offer-pill-icon': createElement('span'),
      'gateway-offer-popover': createElement('div'),
      'gateway-offer-popover-icon': createElement('span'),
      'gateway-offer-destination': createElement('div'),
      'gateway-offer-explanation': createElement('div'),
      'gateway-offer-always': createElement('input'),
      'gateway-offer-open': createElement('button'),
      'gateway-offer-cancel': createElement('button'),
      'trust-popover-gateway-toggle': createElement('input'),
    };
    els['gateway-offer-popover'].hidden = true;
    for (const id of ['popover-icon', 'destination', 'explanation', 'always', 'open', 'cancel']) {
      els['gateway-offer-popover'].appendChild(els[`gateway-offer-${id}`]);
    }
    doc = createDocument({ elementsById: els });
    global.document = doc;
    windowHandlers = {};
    api = {
      getGatewayOffer: jest.fn(async (url) => (url === GATEWAY ? OFFER : null)),
      getSettings: jest.fn(async () => ({ openWithoutGateway: false })),
      saveSettings: jest.fn(async () => true),
    };
    global.window = {
      electronAPI: api,
      addEventListener: jest.fn((event, handler) => {
        windowHandlers[event] = handler;
      }),
    };
    navigate = jest.fn();
    initGatewayOfferUi({ navigate });
    tabA = makeTab(1);
    tabB = makeTab(2);
    mockActiveTab = tabA;
  });

  test('starts hidden and watches every new webview', () => {
    expect(pillShown()).toBe(false);
    expect(typeof mockWebviewCreated).toBe('function');
  });

  test('a committed gateway page with a native version shows the pill', async () => {
    commit(tabA, GATEWAY);
    await flush();
    expect(api.getGatewayOffer).toHaveBeenCalledWith(GATEWAY);
    expect(pillShown()).toBe(true);
    expect(pill().title).toBe('Open ipfs://vitalik.eth/blog/?p=1#c');
    expect(pill().getAttribute('aria-label')).toBe(
      'Open without gateway: ipfs://vitalik.eth/blog/?p=1#c'
    );
    expect(els['gateway-offer-pill-icon'].dataset.protocol).toBe('ipfs');
  });

  test('a page that is not a gateway costs no lookup and shows nothing', async () => {
    commit(tabA, 'https://example.com/');
    await flush();
    expect(api.getGatewayOffer).not.toHaveBeenCalled();
    expect(pillShown()).toBe(false);
  });

  test('no offer from main (failed lookup, invalid CID) means no pill', async () => {
    commit(tabA, 'https://nothing.eth.limo/');
    await flush();
    expect(api.getGatewayOffer).toHaveBeenCalled();
    expect(pillShown()).toBe(false);
  });

  test('a commit takes the old offer away at once, and a late answer for it is dropped', async () => {
    commit(tabA, GATEWAY);
    await flush();
    expect(pillShown()).toBe(true);

    let release;
    api.getGatewayOffer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    commit(tabA, 'https://other.eth.limo/');
    expect(pillShown()).toBe(false);
    commit(tabA, 'https://example.com/');
    release(OFFER);
    await flush();
    expect(pillShown()).toBe(false);
    expect(getActiveOffer()).toBeNull();
  });

  // petfold on #739: bzz.link answers `<cid>.bzz.link` hashes that are not on
  // its allowlist with a 302 to `https://bzz.link/forbidden?hash=<hex>`, so
  // the commit is never the gateway address the user asked for.
  describe('a gateway address redirected elsewhere', () => {
    beforeEach(() => {
      api.getGatewayOffer.mockImplementation(async (url) => (url === CID_URL ? CID_OFFER : null));
    });

    test('offers the address it started at, path and all, on the page it landed on', async () => {
      start(tabA, CID_URL);
      commit(tabA, FORBIDDEN);
      await flush();
      expect(api.getGatewayOffer).toHaveBeenCalledWith(CID_URL);
      expect(pillShown()).toBe(true);
      expect(getActiveOffer()).toBe(CID_OFFER);
      expect(pill().title).toBe(`Open ${CID_OFFER.destination}`);
      expect(els['gateway-offer-pill-icon'].dataset.protocol).toBe('swarm');

      pill().dispatch('click');
      els['gateway-offer-open'].dispatch('click');
      await flush();
      expect(navigate).toHaveBeenCalledWith(CID_OFFER.destination, tabA.webview, {
        auto: false,
      });
    });

    test('only for that navigation: the next page gets no offer from it', async () => {
      start(tabA, CID_URL);
      commit(tabA, FORBIDDEN);
      await flush();
      expect(pillShown()).toBe(true);
      // A commit with no start of its own (never expected) borrows nothing:
      // the redirect's commit consumed the start.
      commit(tabA, 'https://example.org/');
      await flush();
      expect(pillShown()).toBe(false);
      // A link, then a same-document move there.
      start(tabA, 'https://bzz.link/');
      commit(tabA, 'https://bzz.link/');
      await flush();
      expect(pillShown()).toBe(false);
      tabA.webview.dispatch('did-navigate-in-page', {
        url: 'https://bzz.link/#x',
        isMainFrame: true,
      });
      commit(tabA, FORBIDDEN);
      await flush();
      expect(pillShown()).toBe(false);
      expect(api.getGatewayOffer).toHaveBeenCalledTimes(1);
    });

    test('a start that never committed (a download) does not speak for the next page', async () => {
      start(tabA, CID_URL); // never commits
      start(tabA, 'https://example.com/');
      commit(tabA, 'https://example.com/');
      await flush();
      expect(api.getGatewayOffer).not.toHaveBeenCalled();
      expect(pillShown()).toBe(false);
    });

    // R1-M1 on #739: a gateway-served site's own redirect (an IPFS
    // `_redirects` 302) off the gateway's domain is not the gateway refusing
    // the address, so the unrelated page it lands on gets no offer.
    test('a gateway site redirecting off the gateway domain gets no offer', async () => {
      api.getGatewayOffer.mockImplementation(async () => OFFER);
      start(tabA, 'https://evil.eth.limo/');
      commit(tabA, 'https://bank.example/login');
      await flush();
      expect(api.getGatewayOffer).not.toHaveBeenCalled();
      expect(pillShown()).toBe(false);
      // Nor onto a look-alike that only ends in the apex's text.
      start(tabA, CID_URL);
      commit(tabA, 'https://evilbzz.link/forbidden');
      await flush();
      expect(api.getGatewayOffer).not.toHaveBeenCalled();
      expect(pillShown()).toBe(false);
    });

    test('a non-gateway start redirected somewhere else costs no lookup', async () => {
      start(tabA, 'https://example.com/');
      commit(tabA, 'https://www.example.com/');
      await flush();
      expect(api.getGatewayOffer).not.toHaveBeenCalled();
    });

    test('a gateway redirecting to another gateway page offers the page it landed on', async () => {
      api.getGatewayOffer.mockImplementation(async (url) => (url === GATEWAY ? OFFER : null));
      start(tabA, 'https://vitalik.eth.limo/blog');
      commit(tabA, GATEWAY);
      await flush();
      expect(api.getGatewayOffer).toHaveBeenCalledTimes(1);
      expect(api.getGatewayOffer).toHaveBeenCalledWith(GATEWAY);
      expect(getActiveOffer()).toBe(OFFER);
    });

    test('a late answer for the redirect is dropped once the tab moved on', async () => {
      let release;
      api.getGatewayOffer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      start(tabA, CID_URL);
      commit(tabA, FORBIDDEN);
      start(tabA, 'https://example.com/');
      commit(tabA, 'https://example.com/');
      release(CID_OFFER);
      await flush();
      expect(pillShown()).toBe(false);
    });
  });

  test('an in-page navigation refreshes the destination; a subframe one does not', async () => {
    commit(tabA, GATEWAY);
    await flush();
    api.getGatewayOffer.mockClear();
    tabA.webview.dispatch('did-navigate-in-page', { url: GATEWAY, isMainFrame: false });
    expect(api.getGatewayOffer).not.toHaveBeenCalled();
    tabA.webview.dispatch('did-navigate-in-page', { url: GATEWAY, isMainFrame: true });
    await flush();
    expect(api.getGatewayOffer).toHaveBeenCalledWith(GATEWAY);
  });

  test("the pill follows the active tab: a background tab's offer shows once switched to", async () => {
    commit(tabB, GATEWAY);
    await flush();
    expect(pillShown()).toBe(false);
    switchTo(tabB);
    expect(pillShown()).toBe(true);
    switchTo(tabA);
    expect(pillShown()).toBe(false);
  });

  test('the pill opens the popover with the whole destination and what changes', async () => {
    commit(tabA, GATEWAY);
    await flush();
    pill().dispatch('click');
    expect(popover().hidden).toBe(false);
    expect(pill().getAttribute('aria-expanded')).toBe('true');
    expect(els['gateway-offer-destination'].textContent).toBe(OFFER.destination);
    expect(els['gateway-offer-explanation'].textContent).toBe(
      'Loads directly from IPFS instead of through the eth.limo gateway.'
    );
    expect(els['gateway-offer-always'].checked).toBe(false);
    pill().dispatch('click');
    expect(popover().hidden).toBe(true);
  });

  test('"Open without gateway" navigates this tab to the native URL, setting untouched', async () => {
    commit(tabA, GATEWAY);
    await flush();
    pill().dispatch('click');
    els['gateway-offer-open'].dispatch('click');
    await flush();
    expect(navigate).toHaveBeenCalledWith(OFFER.destination, tabA.webview, { auto: false });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(popover().hidden).toBe(true);
  });

  test('ticking "Always" applies with Open, and the trust popover box follows', async () => {
    commit(tabA, GATEWAY);
    await flush();
    pill().dispatch('click');
    els['gateway-offer-always'].checked = true;
    els['gateway-offer-open'].dispatch('click');
    await flush();
    expect(api.saveSettings).toHaveBeenCalledWith({ openWithoutGateway: true });
    expect(els['trust-popover-gateway-toggle'].checked).toBe(true);
    expect(navigate).toHaveBeenCalledWith(OFFER.destination, tabA.webview, { auto: false });
  });

  test('Cancel (and Escape) close without navigating or saving the box', async () => {
    commit(tabA, GATEWAY);
    await flush();
    pill().dispatch('click');
    els['gateway-offer-always'].checked = true;
    els['gateway-offer-cancel'].dispatch('click');
    expect(popover().hidden).toBe(true);
    pill().dispatch('click');
    expect(els['gateway-offer-always'].checked).toBe(false);
    doc.handlers.keydown({ key: 'Escape', preventDefault: jest.fn() });
    expect(popover().hidden).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  test('closeGatewayOfferPopover closes it for the shared dismissal paths', async () => {
    commit(tabA, GATEWAY);
    await flush();
    pill().dispatch('click');
    closeGatewayOfferPopover();
    expect(popover().hidden).toBe(true);
  });

  test('the trust popover checkbox saves the setting on change', () => {
    els['trust-popover-gateway-toggle'].checked = true;
    els['trust-popover-gateway-toggle'].dispatch('change');
    expect(api.saveSettings).toHaveBeenCalledWith({ openWithoutGateway: true });
  });

  test('a settings broadcast keeps the trust popover checkbox current', () => {
    setAlways(true);
    expect(els['trust-popover-gateway-toggle'].checked).toBe(true);
    setAlways(false);
    expect(els['trust-popover-gateway-toggle'].checked).toBe(false);
  });

  describe('"Always open without gateway"', () => {
    test('off (the default): a gateway navigation is only offered, never redirected', async () => {
      start(tabA, GATEWAY);
      commit(tabA, GATEWAY);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
      expect(pillShown()).toBe(true);
    });

    test('on: a starting gateway navigation goes to the native URL, in any tab', async () => {
      setAlways(true);
      start(tabB, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledWith(OFFER.destination, tabB.webview, { auto: true });
    });

    test('on: no native version, no redirect', async () => {
      setAlways(true);
      start(tabA, 'https://nothing.eth.limo/');
      await flush();
      expect(navigate).not.toHaveBeenCalled();
    });

    test('on: subframe and same-document starts are ignored', async () => {
      setAlways(true);
      start(tabA, GATEWAY, { isMainFrame: false });
      start(tabA, GATEWAY, { isInPlace: true });
      await flush();
      expect(api.getGatewayOffer).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    test('on: an answer that lands after the tab moved on is dropped', async () => {
      setAlways(true);
      let release;
      api.getGatewayOffer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      start(tabA, GATEWAY);
      start(tabA, 'https://example.com/');
      release(OFFER);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
    });

    test('on: Back onto a gateway page stays there and shows the pill', async () => {
      setAlways(true);
      mockTraversalPending = 1;
      start(tabA, GATEWAY);
      commit(tabA, GATEWAY);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
      expect(pillShown()).toBe(true);
    });

    test('on: the page it just redirected away from is not redirected again right away', async () => {
      setAlways(true);
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(1);
      // e.g. the user goes back by a route that leaves no traversal mark
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(1);
      // …but a later visit is redirected again.
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(2);
    });

    test('on: the guard expires once the tab moves on (R1-M1)', async () => {
      setAlways(true);
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(1);
      // The native destination starts and commits: the guard still stands…
      start(tabA, OFFER.destination);
      commit(tabA, OFFER.destination);
      // …the user browses elsewhere, then types/bookmarks the gateway URL again.
      start(tabA, 'https://example.com/');
      commit(tabA, 'https://example.com/');
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(2);
    });

    test('on: the guard survives the destination itself, so an unmarked Back stays', async () => {
      setAlways(true);
      start(tabA, GATEWAY);
      await flush();
      start(tabA, OFFER.destination);
      commit(tabA, OFFER.destination);
      // In-page moves on the destination do not end it either.
      tabA.webview.dispatch('did-navigate-in-page', {
        url: `${OFFER.destination}x`,
        isMainFrame: true,
      });
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    test('on: the gateway page committing before the redirect does not spend the guard', async () => {
      setAlways(true);
      start(tabA, GATEWAY);
      await flush();
      commit(tabA, GATEWAY); // a fast gateway committed before loadTarget took over
      start(tabA, OFFER.destination);
      commit(tabA, OFFER.destination);
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    test('on: a mark left by a same-document Back does not shield the next link (R1-M2)', async () => {
      setAlways(true);
      commit(tabA, 'https://example.com/a');
      // Back resolves in place: the mark stays, the in-page commit snapshots it.
      mockTraversalPending = 1;
      tabA.webview.dispatch('did-navigate-in-page', {
        url: 'https://example.com/a#top',
        isMainFrame: true,
      });
      // A link click to a gateway page is not a traversal: redirected.
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledWith(OFFER.destination, tabA.webview, { auto: true });
    });

    test('on: a Back asked for after a same-document Back is still a traversal', async () => {
      setAlways(true);
      commit(tabA, 'https://example.com/a');
      mockTraversalPending = 1;
      tabA.webview.dispatch('did-navigate-in-page', {
        url: 'https://example.com/a#top',
        isMainFrame: true,
      });
      mockTraversalPending = 2; // a second Back, cross-document this time
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
    });

    test('on: two Backs, the first resolving in place, still treat the second as a traversal (R2-M1)', async () => {
      setAlways(true);
      commit(tabA, 'https://example.com/a#b');
      // Both Backs were asked for before the first one's in-place commit is seen.
      mockTraversalPending = 2;
      tabA.webview.dispatch('did-navigate-in-page', {
        url: 'https://example.com/a#a',
        isMainFrame: true,
      });
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
    });

    test('on: a page moving itself in place with no Back pending accounts for nothing', async () => {
      setAlways(true);
      commit(tabA, 'https://example.com/a');
      mockTraversalPending = 1;
      start(tabA, 'https://example.com/b'); // cross-document Back, accounted for
      commit(tabA, 'https://example.com/b');
      for (let i = 0; i < 3; i++) {
        tabA.webview.dispatch('did-navigate-in-page', {
          url: `https://example.com/b#${i}`,
          isMainFrame: true,
        });
      }
      mockTraversalPending = 2; // a fresh Back onto a gateway page
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
    });

    test('on: a Back that never commits (a download) does not shield the next link (R2-M1)', async () => {
      setAlways(true);
      commit(tabA, 'https://example.com/a');
      mockTraversalPending = 1;
      start(tabA, 'https://example.com/file.zip'); // the traversal; no commit follows
      start(tabA, GATEWAY); // a link click: not a traversal
      await flush();
      expect(navigate).toHaveBeenCalledWith(OFFER.destination, tabA.webview, { auto: true });
    });

    test('on: a second Back asked for while the first is still loading is a traversal', async () => {
      setAlways(true);
      commit(tabA, 'https://example.com/a');
      mockTraversalPending = 1;
      start(tabA, 'https://example.com/prev');
      mockTraversalPending = 2;
      commit(tabA, 'https://example.com/prev');
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
    });

    // petfold on #739: pasting the same gateway address again and again in
    // one tab landed on the gateway every second time. A typed or
    // bookmarked address (navigation.js calls noteUserNavigation for every
    // user-driven loadTarget) is never the Back the guard is for.
    test('on: typing the same gateway address twice in a row redirects both times', async () => {
      setAlways(true);
      for (let i = 1; i <= 3; i += 1) {
        noteUserNavigation(tabA.webview); // the address bar's loadTarget
        start(tabA, GATEWAY);
        await flush();
        expect(navigate).toHaveBeenCalledTimes(i);
        start(tabA, OFFER.destination);
        commit(tabA, OFFER.destination);
      }
      // An unmarked Back afterwards is still caught by the guard.
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(3);
    });

    test('on: noteUserNavigation on another tab leaves this one guarded', async () => {
      setAlways(true);
      start(tabA, GATEWAY);
      await flush();
      start(tabA, OFFER.destination);
      commit(tabA, OFFER.destination);
      noteUserNavigation(tabB.webview);
      noteUserNavigation(createElement('webview')); // never watched: a no-op
      start(tabA, GATEWAY);
      await flush();
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    test('on: the gateway redirecting to its forbidden page does not spend the guard', async () => {
      api.getGatewayOffer.mockImplementation(async (url) => (url === CID_URL ? CID_OFFER : null));
      setAlways(true);
      start(tabA, CID_URL);
      await flush();
      expect(navigate).toHaveBeenCalledWith(CID_OFFER.destination, tabA.webview, { auto: true });
      commit(tabA, FORBIDDEN); // the gateway's 302 landing before loadTarget took over
      start(tabA, CID_OFFER.destination);
      commit(tabA, CID_OFFER.destination);
      start(tabA, CID_URL); // an unmarked Back
      await flush();
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    test('switched off while a lookup is in flight: no redirect', async () => {
      setAlways(true);
      let release;
      api.getGatewayOffer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      start(tabA, GATEWAY);
      setAlways(false);
      release(OFFER);
      await flush();
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
