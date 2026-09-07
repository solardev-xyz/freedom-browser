/**
 * Every internal page follows Settings > Appearance, and its light theme is
 * complete (#250, #251).
 *
 * #245 moved every page under `src/renderer/pages/` off
 * `@media (prefers-color-scheme: …)` and onto the `data-theme` attribute the
 * webview preload stamps on `<html>` before first paint. Nothing checked that
 * every page had actually made the move: `freedom://publish` was left with a
 * pinned `color-scheme: dark` and no light palette at all, so it painted
 * `rgb(30,30,30)` in a window where `freedom://downloads` painted
 * `rgb(245,247,249)` — same setting, same run (#250).
 *
 * Having a light block is not the same as having a *correct* one, so the two
 * sweeps at the bottom check the two ways `freedom://payments` got it wrong:
 *
 *  - repainting a `<select>` with the `background` **shorthand** discards the
 *    `url('data:image/svg+xml,…')` chevron the dark rule drew with it, so the
 *    filter dropdowns lost their arrow;
 *  - overriding an element's background but not its `:hover` background leaves
 *    the dark hover fill in place, so hovering 'All kinds' turned it near-black
 *    under near-black text.
 *
 * Both are silent: the light block exists, the page looks styled, and only the
 * one state nobody screenshotted is broken.
 */

const fs = require('fs');
const path = require('path');

const PAGES_DIR = __dirname;
const INTERNAL_PAGES = require('../../shared/internal-pages.json');

// Private windows are deliberately plum-on-dark in *both* themes — the whole
// window chrome is, and the page is the start page a private window opens on
// (`lib/tabs.js`). It is the one page that pins `color-scheme: dark` on
// purpose, and `private.html:11-13` says why. Any other page that pins it is
// #250 again.
const DARK_ONLY = new Set(['private.html']);

const pageFiles = [...Object.values(INTERNAL_PAGES.routable), ...INTERNAL_PAGES.other].sort();

/** The CSS a page ships: its inline `<style>` blocks plus its own stylesheets. */
function cssFor(file) {
  const html = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
  const parts = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(([, body]) => body);
  for (const [, href] of html.matchAll(/<link\b[^>]*href="(styles\/[^"]+\.css)"/g)) {
    parts.push(fs.readFileSync(path.join(PAGES_DIR, href), 'utf8'));
  }
  return parts.join('\n');
}

/** Blank comment bodies so a commented-out rule cannot satisfy a guard. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

/**
 * Flat list of `{ selector, body }` for every style rule in `css`, at any
 * depth. `body` is only the rule's own declarations; nested rules are returned
 * as their own entries, so the light wrapper's children are visible here.
 */
function rules(css, prefix = '') {
  const found = [];
  let i = 0;
  let prelude = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      let depth = 1;
      let end = i + 1;
      for (; end < css.length && depth > 0; end += 1) {
        if (css[end] === '{') depth += 1;
        else if (css[end] === '}') depth -= 1;
      }
      const inner = css.slice(i + 1, end - 1);
      const selector = prelude.trim();
      // Own declarations only: everything outside a nested block.
      found.push({
        selector: `${prefix}${selector}`,
        body: inner.replace(/[^{}]*\{[^{}]*\}/g, ''),
      });
      if (/\{/.test(inner)) found.push(...rules(inner, `${prefix}${selector} `));
      prelude = '';
      i = end;
      continue;
    }
    if (ch === '}') {
      prelude = '';
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return found;
}

const LIGHT_SCOPE = /html\[data-theme=['"]light['"]\]/;
const declarationOf = (body, property) => {
  const match = body.match(new RegExp(`(?:^|[;{\\s])${property}\\s*:([^;]*)`));
  return match ? match[1].trim() : null;
};
/** Split a grouped prelude into its individual selectors. */
const selectorsOf = (selector) =>
  selector
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/** The rules a page paints in *both* themes, and the ones only the light theme sees. */
function split(css) {
  const all = rules(stripComments(css));
  return {
    base: all.filter((r) => !LIGHT_SCOPE.test(r.selector)),
    light: all
      .filter((r) => LIGHT_SCOPE.test(r.selector) && !/^[^ ]*$/.test(r.selector))
      .map((r) => ({ ...r, selector: r.selector.replace(/^.*?\]\)?\s+/, '') })),
  };
}

/** Selector -> the last light-theme `background`/`background-color` it sets. */
function lightBackgrounds(light) {
  const map = new Map();
  for (const rule of light) {
    const value =
      declarationOf(rule.body, 'background') ?? declarationOf(rule.body, 'background-color');
    if (value === null) continue;
    for (const selector of selectorsOf(rule.selector)) map.set(selector, { rule, value });
  }
  return map;
}

describe('internal page theming', () => {
  test('the page list this sweeps is the shipped one', () => {
    // A page added to internal-pages.json but never given a light theme has to
    // fail here, so the list is read from the manifest rather than the folder.
    expect(pageFiles.length).toBeGreaterThanOrEqual(15);
    for (const file of pageFiles) expect(fs.existsSync(path.join(PAGES_DIR, file))).toBe(true);
    expect(pageFiles).toContain('publish.html');
    expect(pageFiles).toContain('payments.html');
  });

  test('no page tracks the OS colour scheme (#233, #245)', () => {
    const offenders = pageFiles.filter((file) => /prefers-color-scheme/.test(cssFor(file)));
    expect(offenders).toEqual([]);
  });

  test('every page declares `color-scheme` from `data-theme`, or says why not', () => {
    const offenders = [];
    for (const file of pageFiles) {
      if (DARK_ONLY.has(file)) continue;
      const css = stripComments(cssFor(file));
      const light = rules(css).find(
        (r) => LIGHT_SCOPE.test(r.selector) && declarationOf(r.body, 'color-scheme') === 'light'
      );
      if (!light) offenders.push(`${file}: no html[data-theme='light'] { color-scheme: light }`);
    }
    expect(offenders).toEqual([]);
  });

  test('every page ships a light palette (#250)', () => {
    const offenders = [];
    for (const file of pageFiles) {
      if (DARK_ONLY.has(file)) continue;
      // Either a `:where(html[data-theme='light'])` block of rule overrides or
      // a light redefinition of the custom properties the page paints from —
      // publish.css does the latter and needs almost nothing of the former.
      const light = split(cssFor(file)).light;
      const paletteOnly = rules(stripComments(cssFor(file))).some(
        (r) => LIGHT_SCOPE.test(r.selector) && /(^|[;\s])--[\w-]+\s*:/.test(r.body)
      );
      if (!light.length && !paletteOnly) offenders.push(`${file}: no light-theme rules at all`);
    }
    expect(offenders).toEqual([]);
  });

  test('a light override never drops a chevron the dark rule painted (#251)', () => {
    const offenders = [];
    for (const file of pageFiles) {
      const { base, light } = split(cssFor(file));
      // Selectors whose dark background carries an image (the `<select>`
      // chevrons are the only ones today, drawn with an inline SVG data URL).
      const withImage = new Set();
      for (const rule of base) {
        const value = declarationOf(rule.body, 'background');
        if (value && /url\(/.test(value))
          selectorsOf(rule.selector).forEach((s) => withImage.add(s));
      }
      for (const rule of light) {
        const value = declarationOf(rule.body, 'background');
        if (value === null || /url\(/.test(value)) continue;
        for (const selector of selectorsOf(rule.selector)) {
          // `background-color` is fine — it is the shorthand that resets
          // `background-image` to `none`.
          if (withImage.has(selector)) {
            offenders.push(`${file}: ${selector} { background: ${value} } drops its url()`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('a light override of an element covers its :hover too (#251)', () => {
    const offenders = [];
    for (const file of pageFiles) {
      const { base, light } = split(cssFor(file));
      const overridden = lightBackgrounds(light);
      for (const rule of base) {
        for (const selector of selectorsOf(rule.selector)) {
          if (!selector.endsWith(':hover')) continue;
          const resting = selector.slice(0, -':hover'.length);
          // Only elements the light theme repaints at rest: if the base
          // background is already theme-neutral, so is its hover.
          if (!overridden.has(resting) || overridden.has(selector)) continue;
          const value =
            declarationOf(rule.body, 'background') ?? declarationOf(rule.body, 'background-color');
          if (value !== null) {
            offenders.push(`${file}: ${selector} { background: ${value} } has no light override`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // --- self-tests: the sweeps only guard while they can still see -----------

  const CHEVRON = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>')`;

  test('the reader flattens nested rules and keeps declarations with their own rule', () => {
    const flat = rules(
      ":root { --bg: #000 } :where(html[data-theme='light']) { .a { color: red } }"
    );
    expect(flat.map((r) => r.selector)).toEqual([
      ':root',
      ":where(html[data-theme='light'])",
      ":where(html[data-theme='light']) .a",
    ]);
    // The wrapper's own body must not carry its child's declarations, or a
    // palette-only check would read `color: red` as a custom property.
    expect(declarationOf(flat[1].body, 'color')).toBeNull();
    expect(declarationOf(flat[2].body, 'color')).toBe('red');
    // …and `background-color` must not answer a query for `background`.
    expect(declarationOf('background-color: #fff;', 'background')).toBeNull();
  });

  test('the chevron sweep flags the shorthand payments used, and only that', () => {
    const drops = `.filter-select { background: #21262d ${CHEVRON} no-repeat }
      :where(html[data-theme='light']) { .search-input, .filter-select, .btn { background: #ffffff } }`;
    const { base, light } = split(drops);
    expect(base.map((r) => r.selector)).toEqual(['.filter-select']);
    expect(light.map((r) => r.selector)).toEqual(['.search-input, .filter-select, .btn']);
    expect(declarationOf(light[0].body, 'background')).toBe('#ffffff');

    // The two shapes that are *not* the bug: re-declaring the url(), and
    // touching only `background-color`.
    for (const fixed of [
      `:where(html[data-theme='light']) { .filter-select { background: #ffffff ${CHEVRON} no-repeat } }`,
      `:where(html[data-theme='light']) { .filter-select:hover { background-color: #f6f8fa } }`,
    ]) {
      const rule = split(fixed).light[0];
      const value = declarationOf(rule.body, 'background');
      expect(value === null || /url\(/.test(value)).toBe(true);
    }
  });

  test('the hover sweep flags an uncovered :hover, and only an uncovered one', () => {
    const covered = (css) => {
      const { base, light } = split(css);
      const overridden = lightBackgrounds(light);
      return base
        .filter((r) => r.selector.endsWith(':hover'))
        .every((r) => overridden.has(r.selector) || !overridden.has(r.selector.slice(0, -6)));
    };
    const bare = `.filter-select { background: #21262d } .filter-select:hover { background-color: #30363d }
      :where(html[data-theme='light']) { .filter-select { background: #ffffff } }`;
    expect(covered(bare)).toBe(false);
    expect(
      covered(`${bare.slice(0, -1)} .filter-select:hover { background-color: #f6f8fa } }`)
    ).toBe(true);
    // An element the light theme never repaints needs no hover override.
    expect(covered('.a { background: transparent } .a:hover { background: #30363d }')).toBe(true);
  });
});
