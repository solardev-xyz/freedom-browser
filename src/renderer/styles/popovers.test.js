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

/** Every sheet the chrome bundle imports, in bundle order. */
const CHROME_SHEETS = [...STYLES_BUNDLE.matchAll(/@import\s+'\.\/styles\/([\w-]+\.css)'/g)].map(
  ([, name]) => ({ name, css: read(STYLES_DIR, name) })
);

/**
 * Every rule in `css` as `{ prelude, declarations }`, walking braces so a rule
 * nested inside an at-rule wrapper (`@media`) is seen as its own rule and the
 * wrapper is not mistaken for one.
 */
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  const stack = [];
  let buffer = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      const prelude = stack.pop() ?? '';
      // A wrapper's own text holds no declarations by the time its children
      // have been consumed, so only real rules are recorded.
      if (buffer.includes(':')) found.push({ prelude, declarations: buffer });
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return found;
}

// The band `#menu-backdrop` (9999) defines: everything that floats over the
// whole chrome rather than inside one of its panes. The sidebar's own
// in-panel dropdowns sit at 50-100 and scroll with the panel that contains
// them, so they are not chrome popovers and are deliberately below this line.
const MENU_TIER_Z_INDEX = 9999;

const floatsOverTheChrome = (declarations) =>
  /position:\s*(fixed|absolute)/.test(declarations) &&
  [...declarations.matchAll(/z-index:\s*(-?\d+)/g)].some(([, z]) => Number(z) >= MENU_TIER_Z_INDEX);

const classesIn = (prelude) => [...prelude.matchAll(/\.([A-Za-z][\w-]*)/g)].map(([, name]) => name);

/**
 * Menu-tier floating elements that are *not* popovers, each with the reason.
 *
 * This is the only hand-maintained half left, and it is the safe half: a name
 * here is one the sweeps below deliberately ignore, and a name that stops
 * matching the sheets fails its own test rather than quietly widening the
 * exemption. Everything else at this tier has to be in the mechanism.
 */
const NOT_POPOVERS = {
  'menu-backdrop': 'the full-window click catcher a popover raises, not a popover',
  'chrome-popover': 'the marker class itself',
  'download-shelf': 'a corner stack of cards with its own layout, never anchored or measured',
  'update-toast': 'a corner toast, same',
  'trust-shield': 'an address-bar button lifted over the backdrop, not a surface',
  'trust-popover-tooltip': 'a pointer-following hint, pointer-events: none, one line tall',
  'hover-tooltip': 'the same hint, generalised (lib/hover-tooltip.js)',
};

/**
 * Class tokens that mark an element as a popover, *derived from the sheets*:
 * anything the chrome paints at menu tier over the whole window, minus the
 * documented non-popovers above.
 *
 * Hand-maintaining this list was the hole (#328): a new popover with a new
 * class name carried neither `chrome-popover` nor a listed token, so both
 * sweeps below stayed green while it sat outside the mechanism entirely —
 * `.permission-prompt` was a live instance. A popover cannot float without a
 * rule that says so, so the rule is what the sweep reads.
 */
const POPOVER_CLASSES = [
  ...new Set(
    CHROME_SHEETS.flatMap(({ css }) =>
      rules(css)
        .filter(({ declarations }) => floatsOverTheChrome(declarations))
        .flatMap(({ prelude }) => classesIn(prelude))
    )
  ),
].filter((name) => !(name in NOT_POPOVERS));

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
    // POPOVER_CLASSES matches means the sweep and the sheets disagree about
    // what a popover is, and the first test is no longer covering everything
    // it should.
    const unknown = classLists(INDEX_HTML)
      .filter((tokens) => tokens.includes('chrome-popover'))
      .filter((tokens) => !isPopover(tokens))
      .map((tokens) => tokens.join(' '));
    expect(unknown).toEqual([]);
  });
});

describe('what counts as a popover comes from the sheets, not a hand-kept list', () => {
  test('every menu-tier floating surface is either a popover or a named exception', () => {
    // The derived list is the whole point: a popover class nobody remembered
    // to write down is still in it, because its own CSS rule put it there.
    expect([...POPOVER_CLASSES].sort()).toEqual([
      'autocomplete-dropdown',
      'bee-dropdown',
      'bookmarks-overflow-menu',
      'context-menu',
      'github-bridge-panel',
      'menu-dropdown',
      'permission-popover',
      'permission-prompt',
      'trust-popover',
    ]);
  });

  test('every documented exception is still a rule in the sheets', () => {
    // An exemption that no longer matches anything is an exemption that has
    // silently widened: it would keep a *future* rule of that name out of the
    // sweep. `chrome-popover` is the marker, not a floating rule of its own.
    const atMenuTier = new Set(
      CHROME_SHEETS.flatMap(({ css }) =>
        rules(css)
          .filter(({ declarations }) => floatsOverTheChrome(declarations))
          .flatMap(({ prelude }) => classesIn(prelude))
      )
    );
    const stale = Object.keys(NOT_POPOVERS).filter(
      (name) => name !== 'chrome-popover' && !atMenuTier.has(name)
    );
    expect(stale).toEqual([]);
  });

  test('a brand-new popover class is picked up with no test edit at all', () => {
    // The failure mode this replaced (#328): `.share-popover` lands in a
    // sheet, carries neither `chrome-popover` nor any listed token, and both
    // sweeps stay green. Now the rule that makes it float is what enrols it.
    const sheet = `
      /* a future surface */
      .share-popover {
        position: fixed;
        z-index: 10000;
        background: var(--menu-bg);
      }
      @media (prefers-color-scheme: light) {
        .share-popover-row {
          color: var(--text);
        }
      }
    `;
    const derived = rules(sheet)
      .filter(({ declarations }) => floatsOverTheChrome(declarations))
      .flatMap(({ prelude }) => classesIn(prelude));
    expect(derived).toEqual(['share-popover']);

    // …and with it in the list, the forward sweep flags the markup that forgot
    // the class, exactly as it does for today's popovers.
    const forgetful = '<div id="share" class="share-popover hidden"></div>';
    const missing = classLists(forgetful).filter((tokens) =>
      tokens.some((token) => derived.includes(token))
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).not.toContain('chrome-popover');
  });

  test('an in-panel dropdown below the menu tier is not swept', () => {
    // The sidebar's selectors (z-index 100) scroll with the pane that holds
    // them; enrolling them would be a different mechanism, not this one.
    const sheet = '.wallet-selector-dropdown { position: absolute; z-index: 100; }';
    expect(rules(sheet).filter(({ declarations }) => floatsOverTheChrome(declarations))).toEqual(
      []
    );
  });

  test('the rule walker sees a rule nested inside an at-rule wrapper', () => {
    const sheet =
      '@media (min-width: 10px) { .nested-popover { position: fixed; z-index: 10000; } }';
    const derived = rules(sheet)
      .filter(({ declarations }) => floatsOverTheChrome(declarations))
      .flatMap(({ prelude }) => classesIn(prelude));
    expect(derived).toEqual(['nested-popover']);
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
