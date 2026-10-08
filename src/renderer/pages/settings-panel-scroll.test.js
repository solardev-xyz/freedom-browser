/**
 * Panel deep links on the settings page (#268, #604) —
 * `src/renderer/pages/settings.html`.
 *
 * A route naming a panel below its entry's first (`#networks/ens`,
 * `#networks/rpc`, `#privacy/permissions`, `#nodes/startup`) brings that panel
 * to the top of the content column, and keeps re-aligning it for a second
 * while the panels above it paint from IPC. #268 did that with
 * `panel.scrollIntoView`, which scrolls every scrollable ancestor — the
 * document too — and Settings rendered blank (`networks/ens`) or shifted down
 * under a seam (#604). Now only `.layout` scrolls: the document is pinned by
 * `overflow: hidden` and the panel is aligned by setting that one container's
 * offset.
 *
 * Same extraction approach as `settings-hash-routing.test.js`: the page is one
 * classic script, so the block is lifted out of the shipped source between
 * the markers it keeps for this and driven with a fake container, panel and
 * window — this repo has no jsdom. `test-e2e/settings.spec.js` drives the
 * same code in the running app and reads `window.scrollY` there.
 */

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8');

const START = '/* settings panel scroll: start */';
const END = '/* settings panel scroll: end */';

const SCROLLER_TOP = 0; // `.layout` fills the window, so its box starts at 0
const MARGIN = 48; // `.section { scroll-margin-top: 48px }`

/**
 * A scroll container holding panels at fixed offsets in its content. A
 * panel's on-screen top follows the container's `scrollTop`, as in a browser,
 * and `offsets` can be changed to model a panel above growing.
 */
function makePage(offsets) {
  const scroller = {
    scrollTop: 0,
    calls: [],
    focus: jest.fn(),
    getBoundingClientRect: () => ({ top: SCROLLER_TOP }),
    scrollTo({ top }) {
      this.calls.push(top);
      this.scrollTop = top;
    },
  };
  const panels = Object.fromEntries(
    Object.keys(offsets).map((id) => [
      id,
      {
        id,
        scrollIntoView: jest.fn(),
        getBoundingClientRect: () => ({ top: SCROLLER_TOP + offsets[id] - scroller.scrollTop }),
      },
    ])
  );
  const document = { getElementById: (id) => panels[id] || null, body: {}, activeElement: null };
  document.activeElement = document.body;
  const getComputedStyle = () => ({ scrollMarginTop: `${MARGIN}px` });
  const window = new EventTarget();
  window.scrollTo = jest.fn();
  return { scroller, panels, document, getComputedStyle, window };
}

function loadPanelScroll(page) {
  const start = SCRIPT.indexOf(START);
  const end = SCRIPT.indexOf(END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = SCRIPT.slice(start + START.length, end);
  return new Function(
    'document',
    'window',
    'getComputedStyle',
    'contentScroller',
    'setTimeout',
    'clearTimeout',
    `${body}\nreturn { panelScrollTop, scrollToPanel, focusScrollerIfIdle, stop: () => stopPanelScroll() };`
  )(page.document, page.window, page.getComputedStyle, page.scroller, setTimeout, clearTimeout);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('scrollToPanel', () => {
  test('aligns the panel to the top of the content column, its scroll margin above it', () => {
    const page = makePage({ rpc: 467, ens: 790 });
    const { scrollToPanel } = loadPanelScroll(page);

    scrollToPanel('ens');

    expect(page.scroller.scrollTop).toBe(790 - MARGIN);
    expect(page.panels.ens.getBoundingClientRect().top).toBe(MARGIN);
  });

  test('scrolls only the content container: never the window, never every ancestor', () => {
    const page = makePage({ ens: 790 });
    const { scrollToPanel } = loadPanelScroll(page);

    scrollToPanel('ens');
    jest.advanceTimersByTime(2_000);

    expect(page.window.scrollTo).not.toHaveBeenCalled();
    expect(page.panels.ens.scrollIntoView).not.toHaveBeenCalled();
  });

  test('aligns from wherever the container already is', () => {
    const page = makePage({ ens: 790 });
    const { panelScrollTop } = loadPanelScroll(page);

    page.scroller.scrollTop = 300;
    expect(panelScrollTop(page.panels.ens, page.scroller)).toBe(790 - MARGIN);
  });

  test('never asks for a negative offset for a panel near the top', () => {
    const page = makePage({ adblock: 20 });
    const { panelScrollTop } = loadPanelScroll(page);

    expect(panelScrollTop(page.panels.adblock, page.scroller)).toBe(0);
  });

  test('re-aligns while the panels above it are still painting, then stops', () => {
    const offsets = { ens: 300 };
    const page = makePage(offsets);
    const { scrollToPanel } = loadPanelScroll(page);

    scrollToPanel('ens');
    expect(page.scroller.scrollTop).toBe(300 - MARGIN);

    // The chain list paints from IPC a beat later and pushes the panel down.
    offsets.ens = 790;
    jest.advanceTimersByTime(100);
    expect(page.scroller.scrollTop).toBe(790 - MARGIN);

    offsets.ens = 900;
    jest.advanceTimersByTime(900);
    expect(page.scroller.scrollTop).toBe(900 - MARGIN);

    // Past the last re-align at 1s the scroll is the user's.
    offsets.ens = 1_200;
    jest.advanceTimersByTime(5_000);
    expect(page.scroller.scrollTop).toBe(900 - MARGIN);
  });

  test.each(['wheel', 'touchstart', 'keydown', 'mousedown'])(
    'a %s hands the scroll back to the user',
    (type) => {
      const offsets = { ens: 300 };
      const page = makePage(offsets);
      const { scrollToPanel } = loadPanelScroll(page);

      scrollToPanel('ens');
      page.window.dispatchEvent(new Event(type));
      offsets.ens = 790;
      jest.advanceTimersByTime(2_000);

      expect(page.scroller.calls).toEqual([300 - MARGIN]);
    }
  );

  test('a second route cancels the first one’s re-aligns', () => {
    const offsets = { rpc: 200, ens: 500 };
    const page = makePage(offsets);
    const { scrollToPanel } = loadPanelScroll(page);

    scrollToPanel('rpc');
    scrollToPanel('ens');
    jest.advanceTimersByTime(2_000);

    expect(new Set(page.scroller.calls)).toEqual(new Set([200 - MARGIN, 500 - MARGIN]));
    expect(page.scroller.scrollTop).toBe(500 - MARGIN);
  });

  test('a panel the page does not have is ignored', () => {
    const page = makePage({ ens: 790 });
    const { scrollToPanel } = loadPanelScroll(page);

    scrollToPanel('nope');
    jest.advanceTimersByTime(2_000);

    expect(page.scroller.calls).toEqual([]);
  });
});

describe('the settings document itself never scrolls (#604)', () => {
  const rule = (selector) => {
    const match = HTML.match(new RegExp(`\\n\\s*${selector}\\s*\\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    return match[1];
  };

  test('html and body clip, and .layout is the scroll container', () => {
    expect(rule('html,\\s*body')).toMatch(/overflow:\s*hidden/);
    const layout = rule('\\.layout');
    expect(layout).toMatch(/height:\s*100vh/);
    expect(layout).toMatch(/overflow-y:\s*auto/);
  });

  test('the script scrolls the content container, not the window', () => {
    expect(SCRIPT).not.toMatch(/window\.scrollTo\(/);
    expect(SCRIPT).toMatch(/const contentScroller = document\.querySelector\('\.layout'\)/);
  });
});

describe('focusScrollerIfIdle', () => {
  test('focuses the scroller when nothing in the page has focus, so PageDown scrolls it', () => {
    const page = makePage({});
    const { focusScrollerIfIdle } = loadPanelScroll(page);

    focusScrollerIfIdle();

    expect(page.scroller.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test('leaves a focused field or nav button alone', () => {
    const page = makePage({});
    const { focusScrollerIfIdle } = loadPanelScroll(page);

    page.document.activeElement = { id: 'settings-search' };
    focusScrollerIfIdle();

    expect(page.scroller.focus).not.toHaveBeenCalled();
  });

  test('runs again when the tab gains focus', () => {
    const page = makePage({});
    loadPanelScroll(page);

    page.window.dispatchEvent(new Event('focus'));

    expect(page.scroller.focus).toHaveBeenCalledTimes(1);
  });
});
