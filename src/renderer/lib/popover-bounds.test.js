// The one viewport bound every chrome popover goes through (#324).
//
// The rules under test are Chrome's: a popover never grows past the window (it
// scrolls inside itself instead), and a pointer-anchored context menu that does
// not fit below the pointer opens upwards before it gives up and scrolls.

const {
  boundPopoverToViewport,
  placePopoverAtPoint,
  rebindOpenPopovers,
  initPopoverBounds,
  POPOVER_VIEWPORT_MARGIN,
  POPOVER_MIN_HEIGHT,
} = require('./popover-bounds.js');

const originalWindow = global.window;
const originalDocument = global.document;

/**
 * A popover stand-in. `top`/`height` are what the layout would report; setting
 * an inline `top` (as placePopoverAtPoint does) moves the reported rect, the
 * way a `position: fixed` element behaves.
 */
const createPopover = ({ top = 100, left = 0, width = 200, height = 300, visible = true } = {}) => {
  const el = {
    style: {},
    scrollTop: 40,
    // Records the max-height in force at every measurement, so a test can
    // prove the bound is computed from the natural size and not from a stale
    // one left behind by an earlier open.
    measuredWith: [],
    getClientRects: () => (visible ? [{}] : []),
  };
  el.getBoundingClientRect = () => {
    el.measuredWith.push(el.style.maxHeight);
    const t = el.style.top ? parseFloat(el.style.top) : top;
    const l = el.style.left ? parseFloat(el.style.left) : left;
    return { top: t, left: l, right: l + width, bottom: t + height, width, height };
  };
  return el;
};

const setViewport = (width, height, popovers = []) => {
  global.window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener: jest.fn(),
  };
  global.document = {
    documentElement: { clientWidth: width, clientHeight: height },
    querySelectorAll: jest.fn(() => popovers),
  };
};

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

describe('boundPopoverToViewport', () => {
  test('bounds an anchored popover to the space below its own top edge', () => {
    setViewport(1200, 600);
    const el = createPopover({ top: 87, height: 647 });

    expect(boundPopoverToViewport(el)).toBe(600 - 87 - POPOVER_VIEWPORT_MARGIN);
    expect(el.style.maxHeight).toBe(`${600 - 87 - POPOVER_VIEWPORT_MARGIN}px`);
  });

  test('measures the natural position, not a bound left over from a taller window', () => {
    setViewport(1200, 600);
    const el = createPopover({ top: 87, height: 647 });
    el.style.maxHeight = '813px'; // what a 900 px-tall window left behind

    boundPopoverToViewport(el);

    // The measurement that produced the new bound saw no max-height at all.
    expect(el.measuredWith).toEqual(['']);
    expect(el.style.maxHeight).toBe('505px');
  });

  test('keeps the bottom edge on screen rather than honour the floor (#328)', () => {
    // An anchored popover's top is not ours to move, so in a window with less
    // than POPOVER_MIN_HEIGHT below that top the floor has to yield: scrolling
    // moves the content inside the box, so a box whose own bottom edge is
    // off-screen has a tail nothing can bring back into view.
    setViewport(1200, 200);
    const el = createPopover({ top: 180, height: 300 });

    const applied = boundPopoverToViewport(el);
    expect(applied).toBeLessThan(POPOVER_MIN_HEIGHT);
    expect(applied).toBe(200 - 180 - POPOVER_VIEWPORT_MARGIN);
    expect(180 + applied).toBeLessThanOrEqual(200 - POPOVER_VIEWPORT_MARGIN);
  });

  test('only ever tightens the sheet’s own cap, never loosens it', () => {
    // Autocomplete caps its list at 360 px on purpose. A tall window must not
    // stretch it to fill the viewport…
    setViewport(1200, 900);
    global.window.getComputedStyle = () => ({ maxHeight: '360px' });
    const tall = createPopover({ top: 90, height: 360 });
    expect(boundPopoverToViewport(tall)).toBe(360);

    // …and a short one still bounds it below that cap.
    setViewport(1200, 400);
    global.window.getComputedStyle = () => ({ maxHeight: '360px' });
    const short = createPopover({ top: 90, height: 360 });
    expect(boundPopoverToViewport(short)).toBe(400 - 90 - POPOVER_VIEWPORT_MARGIN);
  });

  test('ignores anything that is not an element', () => {
    setViewport(1200, 600);
    expect(boundPopoverToViewport(null)).toBe(0);
    expect(boundPopoverToViewport({})).toBe(0);
  });
});

describe('placePopoverAtPoint', () => {
  test('opens down-right from the pointer when it fits, with no bound', () => {
    setViewport(1200, 600);
    const el = createPopover({ height: 160, width: 200 });

    placePopoverAtPoint(el, 300, 120);

    expect(el.style.top).toBe('120px');
    expect(el.style.left).toBe('300px');
    expect(el.style.maxHeight).toBe('');
    // An open always starts at the top of the menu.
    expect(el.scrollTop).toBe(0);
  });

  test('flips upwards when the space below the pointer is too small', () => {
    setViewport(1200, 600);
    const el = createPopover({ height: 240, width: 200 });

    placePopoverAtPoint(el, 300, 500);

    // Bottom edge lands on the pointer; nothing has to scroll.
    expect(el.style.top).toBe('260px');
    expect(el.style.maxHeight).toBe('');
  });

  test('takes the roomier side and scrolls when the menu fits neither way', () => {
    setViewport(1200, 400);
    const el = createPopover({ height: 600, width: 200 });

    placePopoverAtPoint(el, 300, 300);

    // Above the pointer there are 300 px, below only 100: open at the top edge
    // and bound to what is above.
    expect(el.style.top).toBe(`${POPOVER_VIEWPORT_MARGIN}px`);
    expect(el.style.maxHeight).toBe(`${300 - POPOVER_VIEWPORT_MARGIN}px`);
  });

  test('stays below the pointer when that is the roomier side', () => {
    setViewport(1200, 400);
    const el = createPopover({ height: 600, width: 200 });

    placePopoverAtPoint(el, 300, 100);

    expect(el.style.top).toBe('100px');
    expect(el.style.maxHeight).toBe(`${400 - 100 - POPOVER_VIEWPORT_MARGIN}px`);
  });

  test('opens the menu higher than the pointer to make room for the floor (#328)', () => {
    // 180 px tall window, pointer near the bottom: neither side holds the
    // minimum height, and the position here *is* ours to pick — so the menu
    // moves up instead of hanging its last rows off the bottom edge.
    setViewport(1200, 180);
    const el = createPopover({ height: 600, width: 200 });

    // Below the pointer there are 92 px, above it only 72: below is the roomier
    // side, and still short of the 96 px floor.
    placePopoverAtPoint(el, 300, 80);

    const applied = parseFloat(el.style.maxHeight);
    expect(applied).toBe(POPOVER_MIN_HEIGHT);
    expect(parseFloat(el.style.top)).toBe(180 - POPOVER_VIEWPORT_MARGIN - POPOVER_MIN_HEIGHT);
    expect(parseFloat(el.style.top) + applied).toBeLessThanOrEqual(180 - POPOVER_VIEWPORT_MARGIN);
  });

  test('and in a window shorter than the floor, fills what there is (#328)', () => {
    setViewport(1200, 80);
    const el = createPopover({ height: 600, width: 200 });

    placePopoverAtPoint(el, 300, 60);

    const applied = parseFloat(el.style.maxHeight);
    expect(applied).toBe(80 - 2 * POPOVER_VIEWPORT_MARGIN);
    expect(parseFloat(el.style.top)).toBe(POPOVER_VIEWPORT_MARGIN);
  });

  test('clamps horizontally against the right edge, then the left', () => {
    setViewport(1200, 600);
    const wide = createPopover({ height: 100, width: 300 });
    placePopoverAtPoint(wide, 1150, 100);
    expect(wide.style.left).toBe(`${1200 - 300 - POPOVER_VIEWPORT_MARGIN}px`);

    setViewport(200, 600);
    const wider = createPopover({ height: 100, width: 300 });
    placePopoverAtPoint(wider, 150, 100);
    expect(wider.style.left).toBe(`${POPOVER_VIEWPORT_MARGIN}px`);
  });
});

describe('rebindOpenPopovers', () => {
  test('re-bounds the popovers that are on screen and skips the hidden ones', () => {
    const open = createPopover({ top: 87, height: 647 });
    const hidden = createPopover({ top: 87, height: 647, visible: false });
    setViewport(1200, 500, [open, hidden]);

    rebindOpenPopovers();

    expect(open.style.maxHeight).toBe(`${500 - 87 - POPOVER_VIEWPORT_MARGIN}px`);
    expect(hidden.style.maxHeight).toBeUndefined();
    expect(document.querySelectorAll).toHaveBeenCalledWith('.chrome-popover');
  });

  test('a window resize re-runs the bound', () => {
    const open = createPopover({ top: 87, height: 647 });
    setViewport(1200, 900, [open]);
    initPopoverBounds();

    const [event, handler] = window.addEventListener.mock.calls[0];
    expect(event).toBe('resize');

    window.innerHeight = 500;
    handler();
    expect(open.style.maxHeight).toBe(`${500 - 87 - POPOVER_VIEWPORT_MARGIN}px`);
  });
});
