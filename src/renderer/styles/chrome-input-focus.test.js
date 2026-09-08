/**
 * One focus treatment for every chrome text field (#237).
 *
 * The regression this guards against is not "the ring is wrong" — it is "a
 * new component sheet quietly brought its own back". Before styles/inputs.css
 * there were five treatments living side by side (none on the address bar,
 * an `--accent` border on most fields, a hard-coded `#2775ca` on the x402 cap
 * inputs, `#f59e0b` on the publisher-identity search, and a light-theme rule
 * that explicitly removed the address bar's), because each screen styled its
 * own inputs and nothing ever compared them.
 *
 * So this reads every chrome stylesheet and asserts that inputs.css is the
 * only file with anything to say about a focused text field, and that what it
 * says is a visible, palette-driven ring.
 */

const fs = require('fs');
const path = require('path');

const STYLES_DIR = __dirname;
const SHARED_SHEET = 'inputs.css';

const sheets = fs
  .readdirSync(STYLES_DIR)
  .filter((name) => name.endsWith('.css'))
  .sort();

/** Every `:focus` / `:focus-visible` rule in `css`, as `{ selector, body }`. */
function focusRules(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  for (const [, prelude, body] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of prelude.split(',')) {
      const trimmed = selector.trim();
      if (trimmed.includes(':focus')) found.push({ selector: trimmed, body });
    }
  }
  return found;
}

const focusSelectors = (css) => focusRules(css).map((rule) => rule.selector);

// The properties that *draw* the focus indicator. A component may still lift
// its own fill on focus (`.send-input` does); what it may not do is decide
// what the ring looks like. The side longhands are in because an underline
// treatment (`border-bottom: 2px solid …` on :focus) is a focus indicator just
// as much as a full border swap is. `border-radius` and `outline-offset` are
// deliberately out: neither draws anything on its own.
const INDICATOR =
  /(^|[;\s])(box-shadow|outline(-(color|width|style))?|border(-(top|right|bottom|left))?(-(color|width|style))?)\s*:/;

/**
 * Does `selector` style the focused element *itself* as a form field?
 *
 * Keyed on the last compound selector, which is the element the rule paints.
 * `.toggle-switch input:focus + .toggle-slider` therefore does not count: it
 * paints the slider next to a focused checkbox, not the field.
 */
function targetsAFormField(selector) {
  const last =
    selector
      .split(/\s+|>|\+|~/)
      .filter(Boolean)
      .pop() || '';
  if (!last.includes(':focus')) return false;
  return /(^|[.#[])?(input|textarea|select)\b/.test(last) || /-input\b|-input:/.test(last);
}

describe('chrome text-field focus', () => {
  test('every stylesheet in the chrome bundle is imported, so this sweep is complete', () => {
    const bundle = fs.readFileSync(path.join(STYLES_DIR, '..', 'styles.css'), 'utf8');
    const imported = [...bundle.matchAll(/@import\s+'\.\/styles\/([^']+)'/g)].map(([, n]) => n);
    expect(new Set(imported)).toEqual(new Set(sheets));
    expect(imported).toContain(SHARED_SHEET);
  });

  test('the shared sheet is the last word: it is imported after every component sheet', () => {
    const bundle = fs.readFileSync(path.join(STYLES_DIR, '..', 'styles.css'), 'utf8');
    const imported = [...bundle.matchAll(/@import\s+'\.\/styles\/([^']+)'/g)].map(([, n]) => n);
    const shared = imported.indexOf(SHARED_SHEET);
    // Only the theme/palette sheets, which redefine custom properties rather
    // than focus rules, may come after it.
    expect(imported.slice(shared + 1)).toEqual(['light-theme.css', 'private.css']);
  });

  test('only inputs.css draws a focus indicator on a text field', () => {
    const offenders = [];
    for (const name of sheets) {
      if (name === SHARED_SHEET) continue;
      const css = fs.readFileSync(path.join(STYLES_DIR, name), 'utf8');
      for (const { selector, body } of focusRules(css)) {
        if (targetsAFormField(selector) && INDICATOR.test(body)) {
          offenders.push(`${name}: ${selector} { ${body.trim().replace(/\s+/g, ' ')} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the indicator sweep still flags each treatment this replaced', () => {
    // Mutation check on INDICATOR: the five shapes that used to live in the
    // component sheets…
    for (const body of [
      'outline: none; border-color: var(--accent);',
      'border-color: var(--accent);',
      'outline: none; border-color: #2775ca;',
      'background-color: #ffffff; border-color: transparent; box-shadow: none;',
      'box-shadow: 0 0 0 2px var(--accent);',
      // …plus the shapes a component sheet could reintroduce one in next: an
      // underline swap, which draws a ring just as visibly as a full border.
      'border-bottom: 2px solid var(--accent);',
      'border-bottom-color: #f59e0b;',
      'border-left: 2px solid var(--accent);',
      'border-top-width: 2px;',
      'outline-color: #2775ca;',
    ]) {
      expect(INDICATOR.test(body)).toBe(true);
    }
    // …and the fill lift a component is still allowed to keep, plus the
    // properties that shape a ring without drawing one.
    expect(INDICATOR.test('background: rgba(255, 255, 255, 0.08);')).toBe(false);
    expect(INDICATOR.test('background-color: #ffffff;')).toBe(false);
    expect(INDICATOR.test('border-radius: 6px;')).toBe(false);
    expect(INDICATOR.test('outline-offset: -1px;')).toBe(false);
  });

  test('the shared rule is a visible, palette-driven ring on every text field', () => {
    const css = fs.readFileSync(path.join(STYLES_DIR, SHARED_SHEET), 'utf8');
    const selectors = focusSelectors(css);

    // Every text-entry type the chrome actually uses, plus the untyped
    // <input> form and <textarea>. A missing one is a field with no
    // indicator at all, which is exactly the address bar's old state.
    for (const type of ['text', 'search', 'password', 'number', 'url', 'email']) {
      expect(selectors).toContain(`input[type='${type}']:focus-visible`);
    }
    expect(selectors).toContain('input:not([type]):focus-visible');
    expect(selectors).toContain('textarea:focus-visible');

    // `:focus-visible`, never a bare `:focus`.
    expect(selectors.filter((s) => !s.includes(':focus-visible'))).toEqual([]);

    // An outline rather than a border swap, because several of these fields
    // rest on a transparent border and the light palette's --border equals
    // its --bg. `--accent` so it tracks light/dark/private without an
    // override.
    const body = css.match(/\{([^}]*)\}/)[1];
    expect(body).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(body).toMatch(/outline-offset:\s*-1px/);
    expect(body).not.toMatch(/outline:\s*none/);
  });

  test('the sweep can tell a field rule from its neighbours', () => {
    // Mutation check on `targetsAFormField` itself: the rules this sweep is
    // meant to catch…
    for (const selector of [
      '.find-bar-input:focus',
      '.form-input:focus',
      ".x402-grant input[type='number']:focus",
      '.publisher-identity-search input:focus',
      'input:not([type]):focus-visible',
      'textarea:focus-visible',
    ]) {
      expect(targetsAFormField(selector)).toBe(true);
    }
    // …and the ones it must leave alone.
    for (const selector of [
      '.toggle-switch input:focus + .toggle-slider',
      '.primary-btn:focus',
      '.resolver-drag-handle:focus-visible',
      '.sidebar-close:focus',
    ]) {
      expect(targetsAFormField(selector)).toBe(false);
    }
  });
});
