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

const tokensOf = (value) => value.split(/\s+/).filter(Boolean);

/** Every `class="…"` attribute value in `html`, as arrays of tokens. */
function classLists(html) {
  return [...html.matchAll(/class="([^"]*)"/g)].map(([, value]) => tokensOf(value));
}

/** Every string literal in `text`, whichever of the three quote styles it uses. */
const literals = (text) =>
  [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/**
 * Class strings a renderer module puts on an element it builds at runtime.
 *
 * There is no single way to write that, so the sweep reads all of them: a
 * popover assembled with `classList.add('context-menu', 'hidden')`, with a
 * double-quoted or template-literal `className`, with `setAttribute('class',
 * …)`, or as a `class="…"` attribute inside a markup template must be caught
 * exactly like the `.className = '…'` form the shipped popovers happen to use
 * today (#328). A guard that only knows one spelling is one refactor away from
 * being green and blind.
 */
function assignedClassLists(source) {
  const lists = [];
  const push = (value) => {
    const tokens = tokensOf(value);
    if (tokens.length) lists.push(tokens);
  };

  // `el.className = '…'` / `+= '…'`, any quote style.
  for (const [, expression] of source.matchAll(/\.className\s*\+?=([^;\n]*)/g)) {
    for (const value of literals(expression)) push(value);
  }
  // `el.classList.add('context-menu', 'hidden')` — one token per argument.
  for (const [, args] of source.matchAll(/\.classList\.add\(([^)]*)\)/g)) {
    push(literals(args).join(' '));
  }
  // `el.setAttribute('class', '…')`
  for (const [, value] of source.matchAll(/\.setAttribute\(\s*['"`]class['"`]\s*,([^)]*)\)/g)) {
    for (const one of literals(value)) push(one);
  }
  // `class="…"` inside a markup string the module builds.
  for (const [, value] of source.matchAll(/\bclass=["']([^"'>]*)["']/g)) push(value);

  return lists;
}

/** Every renderer module that can build chrome, `lib/` and its subdirectories. */
function rendererModules(dir = RENDERER_DIR) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // `pages/` is a separate document with its own sheets — no chrome popovers.
    if (entry.isDirectory()) {
      if (entry.name !== 'pages' && entry.name !== 'styles') found.push(...rendererModules(full));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      found.push(full);
    }
  }
  return found;
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
    const files = rendererModules();
    // The walk really did reach the modules that build popovers.
    expect(files.some((file) => file.endsWith(path.join('lib', 'bookmarks-ui.js')))).toBe(true);

    const missing = [];
    for (const file of files) {
      for (const tokens of assignedClassLists(fs.readFileSync(file, 'utf8'))) {
        if (isPopover(tokens) && !tokens.includes('chrome-popover')) {
          missing.push(`${path.relative(RENDERER_DIR, file)}: ${tokens.join(' ')}`);
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
    // …however the renderer happens to spell it.
    const forgetfulSources = [
      "el.className = 'bookmarks-overflow-menu hidden';",
      'el.className = "bookmarks-overflow-menu hidden";',
      'el.className = `bookmarks-overflow-menu hidden`;',
      "el.className += ' bookmarks-overflow-menu';",
      "el.classList.add('bookmarks-overflow-menu', 'hidden');",
      'el.setAttribute("class", "bookmarks-overflow-menu hidden");',
      'wrap.innerHTML = `<div class="bookmarks-overflow-menu hidden"></div>`;',
    ];
    for (const source of forgetfulSources) {
      expect([source, assignedClassLists(source).filter(isPopover).length]).toEqual([source, 1]);
    }
    // …and it does not fire on the popovers' child rows, whose class names
    // start with the same words, nor on an id/selector that reads like one.
    expect(classLists('<button class="context-menu-item"></button>').filter(isPopover)).toEqual([]);
    expect(
      assignedClassLists("el.classList.add('context-menu-item');\nq('#context-menu');").filter(
        isPopover
      )
    ).toEqual([]);
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
