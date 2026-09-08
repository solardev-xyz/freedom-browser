/**
 * One header component for every internal page (#256).
 *
 * History, Downloads and Links have always shared a header: a 28 px accent
 * `h1` laid out as a flex row with an inline icon, over a one-line
 * `.subtitle`. Two pages had drifted out of it — Profiles used a 22 px
 * body-grey `.page-title` with no icon and no subtitle at all, and Payments
 * kept the shape but painted the accent `#2775ca` instead of the siblings'
 * `#58a6ff` / `#0969da`, so its focus rings and tx links were a different blue
 * from every other page's.
 *
 * Each page ships its own inline stylesheet, so nothing but a test compares
 * them. This reads all five and asserts the header they are supposed to share.
 *
 * Since #261 the palette itself lives in `styles/theme.css`, which every page
 * links: the header's accent is `var(--accent)` on all five, and the pair it
 * resolves to is asserted once, against that file.
 */

const fs = require('fs');
const path = require('path');

// Dark value → light override, as `styles/theme.css` declares them.
const ACCENT = { dark: '#58a6ff', light: '#0969da' };

// `links.html` is the link-behaviour dev harness, not a shipped surface: it
// carries the same type scale, accent and subtitle, but titles itself with an
// emoji rather than an inline icon, so it has no flex row to assert. It is in
// the list for the colour/type checks, exempt from the icon ones.
const PAGES = [
  { file: 'history.html', selector: 'h1', icon: true },
  { file: 'downloads.html', selector: 'h1', icon: true },
  { file: 'links.html', selector: 'h1', icon: false },
  { file: 'payments.html', selector: 'h1', icon: true },
  { file: 'profiles.html', selector: '.page-title', icon: true },
];

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

// Comments are stripped up front so every offset below is measured on the same
// string.
const styleOf = (html) => {
  const match = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/);
  if (!match) throw new Error('no inline <style> block');
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '');
};

/**
 * Innermost `selector { body }` pairs, with their offset. Not a CSS parser:
 * the pages are flat since the light blocks moved to `styles/theme.css`, and
 * matching innermost braces is all these assertions need.
 */
const rulesOf = (css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim().replace(/\s+/g, ' '),
    body: match[2],
    index: match.index,
  }));

const declaration = (body, property) => {
  const match = body.match(new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`));
  return match ? match[1].trim() : null;
};

/** The rule for `selector`. */
const ruleFor = (css, selector) => {
  const matches = rulesOf(css).filter((rule) =>
    rule.selector.split(',').some((part) => part.trim() === selector)
  );
  // Later rule wins, exactly as the cascade sees it.
  return matches.length ? matches[matches.length - 1] : null;
};

// The shared palette: `html { … }` for dark, `html[data-theme='light'] { … }`
// for light. Read once — it is the only place either value is written now.
const THEME = styleOf(`<style>${read(path.join('styles', 'theme.css'))}</style>`);
const paletteValue = (scope, token) =>
  declaration(rulesOf(THEME).find((rule) => rule.selector === scope).body, token);

describe.each(PAGES)('$file header', ({ file, selector, icon }) => {
  const html = read(file);
  const css = styleOf(html);
  const header = ruleFor(css, selector);

  test('is the shared 28 px title', () => {
    expect(header).not.toBeNull();
    expect(declaration(header.body, 'font-size')).toBe('28px');
    expect(declaration(header.body, 'font-weight')).toBe('600');
    expect(declaration(header.body, 'letter-spacing')).toBe('-0.5px');
    if (!icon) return;
    // The icon sits in the title, so the row is a flex box with a fixed gap.
    expect(declaration(header.body, 'display')).toBe('flex');
    expect(declaration(header.body, 'gap')).toBe('12px');
  });

  test('is painted in the shared accent, in both themes', () => {
    // Every page paints the title from the token now (#261), so a page that
    // reintroduces a literal — the #256 drift — fails here rather than passing
    // with a second blue of its own.
    expect(declaration(header.body, 'color')).toBe('var(--accent)');
    expect(paletteValue('html', '--accent')).toBe(ACCENT.dark);
    expect(paletteValue("html[data-theme='light']", '--accent')).toBe(ACCENT.light);
  });

  test('carries an inline icon and a subtitle line', () => {
    const markup = html.match(/<h1\b[\s\S]*?<\/h1>/);
    expect(markup).not.toBeNull();
    if (icon) expect(markup[0]).toMatch(/<svg\b/);
    expect(html).toMatch(/class="subtitle"/);
    const subtitle = ruleFor(css, '.subtitle');
    expect(subtitle).not.toBeNull();
    expect(declaration(subtitle.body, 'font-size')).toBe('14px');
  });

  test('focus rings use the accent, not a second blue', () => {
    // The drift that made Payments visibly different was not only the title:
    // its input focus ring and tx links carried the same off-accent hue. A
    // focus ring painted with a literal is that drift coming back — the pages
    // have no light block to correct it in any more.
    for (const rule of rulesOf(css)) {
      if (!rule.selector.includes(':focus')) continue;
      const border = declaration(rule.body, 'border-color');
      if (!border) continue;
      expect([rule.selector, border]).toEqual([rule.selector, 'var(--accent)']);
    }
  });
});

test('no internal page keeps the off-accent blue #2775ca (#256)', () => {
  const offenders = PAGES.map(({ file }) => file).filter((file) => /#2775ca/i.test(read(file)));
  expect(offenders).toEqual([]);
});
