/**
 * `styles/theme.css` is the only palette internal pages have (#261 item 2).
 *
 * Before it existed each page carried its own copy: a dark block of literals
 * and a light block of overrides, kept in step by hand. That is how Settings
 * shipped dark-only for a month (#223 — one unclosed brace swallowed the light
 * block), how `freedom://publish` painted `rgb(30,30,30)` in a window where
 * `freedom://downloads` painted `rgb(245,247,249)` (#250), and how a `.perms-*`
 * rule ended up quoting a token no palette defined (#249).
 *
 * With one file the failure modes change shape, so the guards do too:
 *
 *  - a page that does not link the sheet — or whose CSP will not let it load —
 *    renders unstyled, so both are asserted per page;
 *  - a page that re-declares a palette of its own is the drift #261 removed;
 *  - a `var(--token)` no block defines is #249 again, now with one place to
 *    check it against;
 *  - a token defined only in the light block is undefined in dark, and a token
 *    nothing paints with is dead weight in the file everything reads.
 */

const fs = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, '..');
const INTERNAL_PAGES = require('../../../shared/internal-pages.json');

const pageFiles = [...Object.values(INTERNAL_PAGES.routable), ...INTERNAL_PAGES.other].sort();
const THEME = fs.readFileSync(path.join(__dirname, 'theme.css'), 'utf8');

/** Blank comment bodies so a commented-out declaration cannot satisfy a guard. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

/**
 * Blank quoted strings as well. The select chevron is an inline `data:` SVG
 * whose `data:` and `http://www.w3.org/…` read as declarations to the reader
 * below — but the *selectors* need their quotes (`[data-theme='light']`), so
 * this is only applied to rule bodies.
 */
const stripStrings = (css) => css.replace(/'[^']*'|"[^"]*"/g, (s) => ' '.repeat(s.length));

const THEME_CSS = stripComments(THEME);

/**
 * Every `prelude { body }` pair in a stylesheet, nested ones included.
 *
 * This started as a flat `/([^{}]+)\{([^{}]*)\}/` sweep, which only ever
 * matches the *innermost* block: given the pre-#261 shape
 * `:where(html[data-theme='light']) { body { … } }` it reports `body` and the
 * theme wrapper is never seen by any guard below. So walk the braces instead.
 * `prelude` is the whole ancestor chain, so a wrapper is still visible on the
 * rule it wraps; `body` is only that block's own declarations, never a nested
 * block's.
 */
const blocks = (css) => {
  const found = [];
  const open = [];
  let text = '';
  for (const part of stripComments(css).split(/([{}])/)) {
    if (part === '{') {
      // Anything up to the last `;` belongs to the enclosing block; the rest
      // (`… ; a > b`) is this block's prelude.
      const cut = text.lastIndexOf(';');
      if (open.length) open[open.length - 1].body += text.slice(0, cut + 1);
      open.push({
        prelude: text
          .slice(cut + 1)
          .replace(/\s+/g, ' ')
          .trim(),
        body: '',
      });
      text = '';
    } else if (part === '}') {
      const block = open.pop();
      if (block) {
        found.push({
          prelude: [...open.map((b) => b.prelude), block.prelude].join(' ').trim(),
          body: block.body + text,
        });
      }
      text = '';
    } else {
      text += part;
    }
  }
  return found;
};

const tokensOf = (body) =>
  new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map(([, name, value]) => [name, value.trim()])
  );

const themeBlocks = blocks(THEME_CSS);
const darkBlock = themeBlocks.find((b) => b.prelude === 'html');
const lightBlock = themeBlocks.find((b) => b.prelude === "html[data-theme='light']");

/** The CSS a page ships: inline `<style>` blocks plus every local sheet. */
function cssFor(file) {
  const html = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
  const parts = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(([, body]) => body);
  for (const [, href] of html.matchAll(/<link\b[^>]*href="(styles\/[^"]+\.css)"/g)) {
    if (href.endsWith('theme.css')) continue; // the palette itself, not a page rule
    parts.push(fs.readFileSync(path.join(PAGES_DIR, href), 'utf8'));
  }
  return stripComments(parts.join('\n'));
}

describe('the shared internal-page palette', () => {
  test('is two rules: the dark defaults and the light overrides', () => {
    expect((THEME.match(/\{/g) || []).length).toBe((THEME.match(/\}/g) || []).length);
    expect(themeBlocks.map((b) => b.prelude)).toEqual(['html', "html[data-theme='light']"]);
    // Nothing but the palette: a layout rule here would apply to every page.
    for (const block of themeBlocks) {
      const properties = [...stripStrings(block.body).matchAll(/([\w-]+)\s*:/g)].map(([, p]) => p);
      expect(properties.filter((p) => !p.startsWith('--') && p !== 'color-scheme')).toEqual([]);
    }
  });

  test('derives `color-scheme` from `data-theme` (#233, #250)', () => {
    expect(darkBlock.body).toMatch(/color-scheme:\s*dark/);
    expect(lightBlock.body).toMatch(/color-scheme:\s*light/);
    // The light block has to outweigh the `html` defaults, so it must not be
    // wrapped in the zero-specificity `:where()` the rule overrides used.
    expect(THEME_CSS).not.toMatch(/:where\(/);
    expect(THEME_CSS).not.toMatch(/prefers-color-scheme/);
  });

  test('every light-theme token is also declared in the dark block', () => {
    // The light block only *overrides*; a token declared there and nowhere else
    // is undefined in dark, which paints nothing at all.
    const dark = tokensOf(darkBlock.body);
    const orphans = [...tokensOf(lightBlock.body).keys()].filter((name) => !dark.has(name));
    expect(orphans).toEqual([]);
  });

  test('every internal page links it, and its CSP can load it', () => {
    const missing = [];
    for (const file of pageFiles) {
      const html = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
      if (!html.includes('<link rel="stylesheet" href="styles/theme.css" />')) {
        missing.push(`${file}: does not link styles/theme.css`);
      }
      // A `<meta>` CSP without `'self'` in `style-src` blocks the sheet and the
      // page renders unstyled — the loudest possible version of #250.
      const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/);
      if (csp && /style-src/.test(csp[1]) && !/style-src [^;]*'self'/.test(csp[1])) {
        missing.push(`${file}: style-src does not allow 'self'`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no page declares a palette of its own (#261)', () => {
    const shared = tokensOf(darkBlock.body);
    const offenders = [];
    for (const file of pageFiles) {
      const css = cssFor(file);
      for (const { prelude, body } of blocks(css)) {
        // Any selector, not just `:root`/`html`: re-pinning `--accent` on a
        // container div is the same drift one level down, and the token still
        // counts as "defined" to the #249 guard below.
        for (const name of tokensOf(stripStrings(body)).keys()) {
          if (shared.has(name)) {
            offenders.push(`${file}: \`${prelude}\` re-declares the shared token ${name}`);
          }
        }
        // `private.html` pins `color-scheme: dark` against the shared light
        // block on purpose (it is plum-on-dark in both themes); any other
        // theme-scoped rule is a page-local palette coming back — including
        // one nested inside a wrapper, which is the shape #261 removed.
        if (/data-theme/.test(prelude) && file !== 'private.html') {
          offenders.push(`${file}: \`${prelude}\` scopes rules by theme`);
        }
        // The page has no business asking the OS either: `theme.css` derives
        // `color-scheme` from `data-theme`, which is the setting.
        if (/prefers-color-scheme/.test(prelude)) {
          offenders.push(`${file}: \`${prelude}\` scopes rules by OS theme`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every token a page paints with is defined here, and every token here is used (#249)', () => {
    const defined = tokensOf(darkBlock.body);
    const used = new Map();
    for (const file of pageFiles) {
      for (const [, name] of cssFor(file).matchAll(/var\((--[\w-]+)/g)) {
        if (!used.has(name)) used.set(name, []);
        used.get(name).push(file);
      }
    }
    expect([...used.keys()].filter((name) => !defined.has(name)).sort()).toEqual([]);
    expect([...defined.keys()].filter((name) => !used.has(name)).sort()).toEqual([]);
  });
});
