/**
 * The chrome's popovers are bounded by ONE mechanism, and every popover is in
 * it (#324).
 *
 * With all nodes enabled the Nodes menu is ~650 px tall. In a 1200x600 window
 * it ran past the bottom edge, the chrome document itself grew a scrollbar and
 * the toolbar scrolled away — because no dropdown had a height bound and the
 * chrome had no `overflow` rule. Chrome's model is the opposite: menus scroll
 * internally, the browser frame never does.
 *
 * The fix is deliberately global — one class (`.chrome-popover`) plus one
 * module (`lib/popover-bounds.js`) — so this guard is what keeps the next
 * popover from being the one that forgot. It sweeps the shipped markup and the
 * renderer modules that build popovers at runtime, both directions: nothing
 * that looks like a chrome popover may be missing the class, and the class must
 * still do what the popovers rely on.
 */

const fs = require('fs');
const path = require('path');

const STYLES_DIR = __dirname;
const RENDERER_DIR = path.join(STYLES_DIR, '..');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const INDEX_HTML = read(RENDERER_DIR, 'index.html');
const POPOVERS_CSS = read(STYLES_DIR, 'popovers.css');
const BASE_CSS = read(STYLES_DIR, 'base.css');
const STYLES_BUNDLE = read(RENDERER_DIR, 'styles.css');

/**
 * Class tokens that mark an element as a popover: something absolutely or
 * fixed-positioned that floats over the chrome and can outgrow the window.
 * `.menu-flyout` and `.bookmarks-overflow-menu` always come with one of these
 * on the same element, so listing the containers is enough.
 */
const POPOVER_CLASSES = [
  'menu-dropdown',
  'bee-dropdown',
  'context-menu',
  'autocomplete-dropdown',
  'bookmarks-overflow-menu',
  'trust-popover',
  'permission-popover',
];

/** Every `class="…"` attribute value in `html`, as arrays of tokens. */
function classLists(html) {
  return [...html.matchAll(/class="([^"]*)"/g)].map(([, value]) =>
    value.split(/\s+/).filter(Boolean)
  );
}

/** Class strings assigned in renderer JS: `el.className = 'context-menu hidden'`. */
function assignedClassLists(source) {
  return [...source.matchAll(/\.className\s*=\s*'([^']*)'/g)].map(([, value]) =>
    value.split(/\s+/).filter(Boolean)
  );
}

const isPopover = (tokens) => tokens.some((token) => POPOVER_CLASSES.includes(token));

describe('every chrome popover carries the shared bound (#324)', () => {
  test('in the markup', () => {
    const missing = classLists(INDEX_HTML)
      .filter(isPopover)
      .filter((tokens) => !tokens.includes('chrome-popover'))
      .map((tokens) => tokens.join(' '));
    expect(missing).toEqual([]);
  });

  test('and in the popovers the renderer builds at runtime', () => {
    const modules = fs
      .readdirSync(path.join(RENDERER_DIR, 'lib'))
      .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));

    const missing = [];
    for (const name of modules) {
      for (const tokens of assignedClassLists(read(RENDERER_DIR, 'lib', name))) {
        if (isPopover(tokens) && !tokens.includes('chrome-popover')) {
          missing.push(`${name}: ${tokens.join(' ')}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('the sweep would catch a popover that forgot the class', () => {
    // Mutation check: without this, both sweeps above could be passing because
    // they match nothing at all.
    const forgetful = '<div id="new-menu" class="context-menu hidden"></div>';
    expect(
      classLists(forgetful)
        .filter(isPopover)
        .filter((t) => !t.includes('chrome-popover'))
    ).toHaveLength(1);
    expect(
      assignedClassLists("el.className = 'bookmarks-overflow-menu hidden';").filter(isPopover)
    ).toHaveLength(1);
    // …and it does not fire on the popovers' child rows, whose class names
    // start with the same words.
    expect(classLists('<button class="context-menu-item"></button>').filter(isPopover)).toEqual([]);
  });

  test('every popover in the markup is one the shared sweep knows about', () => {
    // The other direction: a `chrome-popover` on an element none of
    // POPOVER_CLASSES matches means the list above has gone stale and the
    // first test is no longer covering everything it should.
    const unknown = classLists(INDEX_HTML)
      .filter((tokens) => tokens.includes('chrome-popover'))
      .filter((tokens) => !isPopover(tokens))
      .map((tokens) => tokens.join(' '));
    expect(unknown).toEqual([]);
  });
});

describe('the shared bound itself', () => {
  test('.chrome-popover scrolls inside instead of growing', () => {
    const rule = POPOVERS_CSS.match(/\.chrome-popover\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/overflow-y:\s*auto/);
    expect(rule[1]).toMatch(/overflow-x:\s*hidden/);
  });

  test('its scrollbar is painted from the palette, so it follows the theme', () => {
    expect(POPOVERS_CSS).toMatch(
      /\.chrome-popover::-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--border\)/
    );
    // No literal colours: a hard-coded scrollbar would be dark in both themes.
    // (Comments are stripped first — an issue reference like "#324" is not a
    // colour.)
    const declarations = POPOVERS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(declarations).not.toMatch(/\brgba?\(/);
  });

  test('the chrome document itself never scrolls', () => {
    const rule = BASE_CSS.match(/body,\s*\nhtml\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/overflow:\s*hidden/);
  });

  test('the sheet is in the chrome bundle', () => {
    expect(STYLES_BUNDLE).toContain("@import './styles/popovers.css';");
  });
});
