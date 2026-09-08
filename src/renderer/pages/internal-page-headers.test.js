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
 */

const fs = require('fs');
const path = require('path');

// Dark value → light override. Both are literals on the pages that predate
// the token palette; `profiles.html` gets them from `--accent`, which is
// declared as exactly this pair.
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

const LIGHT_WRAPPER = ":where(html[data-theme='light'])";

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

// Comments are stripped up front so every offset below — rule positions and
// the light wrapper's — is measured on the same string.
const styleOf = (html) => {
  const match = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/);
  if (!match) throw new Error('no inline <style> block');
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '');
};

/**
 * Innermost `selector { body }` pairs, with their offset. Not a CSS parser:
 * the light theme is one level of nesting, and matching innermost braces
 * yields its inner rules flat, which is all these assertions need. The
 * wrapper's own offset then tells dark rules from light overrides.
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

/** The rule for `selector`, on the dark side of the sheet or the light one. */
const ruleFor = (css, selector, { light = false } = {}) => {
  const wrapper = css.indexOf(LIGHT_WRAPPER);
  expect(wrapper).toBeGreaterThan(-1);
  const matches = rulesOf(css).filter(
    (rule) =>
      rule.selector.split(',').some((part) => part.trim() === selector) &&
      (light ? rule.index > wrapper : rule.index < wrapper)
  );
  // Later rule wins, exactly as the cascade sees it.
  return matches.length ? matches[matches.length - 1] : null;
};

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
    const color = declaration(header.body, 'color');
    if (color === 'var(--accent)') {
      // Token pages: the palette has to resolve to the same pair.
      expect(declaration(ruleFor(css, ':root').body, '--accent')).toBe(ACCENT.dark);
      const lightPalette = rulesOf(css).find((rule) =>
        rule.selector.startsWith("html[data-theme='light']")
      );
      expect(declaration(lightPalette.body, '--accent')).toBe(ACCENT.light);
      return;
    }
    expect(color).toBe(ACCENT.dark);
    expect(declaration(ruleFor(css, selector, { light: true }).body, 'color')).toBe(ACCENT.light);
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
    // its input focus ring and tx links carried the same off-accent hue.
    for (const rule of rulesOf(css)) {
      const wrapper = css.indexOf(LIGHT_WRAPPER);
      const expected = rule.index > wrapper ? ACCENT.light : ACCENT.dark;
      if (!rule.selector.includes(':focus')) continue;
      const border = declaration(rule.body, 'border-color');
      if (!border || !border.startsWith('#')) continue;
      expect([expected, border]).toEqual([expected, expected]);
    }
  });
});

test('no internal page keeps the off-accent blue #2775ca (#256)', () => {
  const offenders = PAGES.map(({ file }) => file).filter((file) => /#2775ca/i.test(read(file)));
  expect(offenders).toEqual([]);
});
