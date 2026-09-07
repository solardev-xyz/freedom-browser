/**
 * No chrome rule may paint from a custom property the palette never defines
 * (#249).
 *
 * `color: var(--text-primary, #fff)` reads as "the palette's primary text,
 * falling back to white". It is not: `--text-primary` is defined nowhere in
 * the chrome, so the *fallback* is the value — in both themes, forever, with
 * no way to override it short of editing the rule. That is how the sidebar's
 * three "manage permissions" screens ended up rendering the site origin white
 * on the light theme's white sidebar (1.0 : 1 contrast) while looking correct
 * in dark: every `.perms-*` rule quoted a token from a palette that does not
 * exist here, and `styles/light-theme.css` could not reach any of them.
 *
 * The sweep below is deliberately keyed on the *fallback*, not on the missing
 * token. A `var(--nope)` with no fallback leaves the property unset — the
 * element inherits, which is visible the moment anyone looks at the screen. A
 * `var(--nope, <colour>)` is invisible: it renders a plausible dark value and
 * silently ignores the theme. Those are the ones that ship.
 *
 * It covers the whole chrome — every stylesheet in the `styles.css` bundle,
 * plus the inline `style=` attributes in `index.html` and the style strings the
 * renderer's own modules inject — because #249's tenth site was an inline
 * `border: 1px solid var(--border-color, #3a3a3c)` in the markup, not in any
 * stylesheet.
 */

const fs = require('fs');
const path = require('path');

const STYLES_DIR = __dirname;
const RENDERER_DIR = path.join(STYLES_DIR, '..');

const sheets = fs
  .readdirSync(STYLES_DIR)
  .filter((name) => name.endsWith('.css'))
  .sort();

/** Every `--token:` declaration anywhere in the chrome bundle. */
function definedTokens() {
  const defined = new Set();
  for (const name of sheets) {
    const css = fs.readFileSync(path.join(STYLES_DIR, name), 'utf8');
    for (const [, token] of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(token);
  }
  return defined;
}

/**
 * Does `fallback` name a colour?
 *
 * Font stacks (`var(--font-mono, monospace)`) and lengths are fine to fall back
 * on: they render identically in both themes. A colour does not.
 */
const COLOR_FALLBACK =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(|\b(?:currentColor|transparent|white|black|gray|grey|silver|red|blue|green|navy|teal|olive|lime|aqua|fuchsia|maroon|purple|yellow|orange)\b/;

/**
 * Every `var(--token, fallback)` in `source`, as `{ token, fallback }`.
 *
 * Hand-written rather than regex-matched on the whole thing: a fallback can
 * itself contain `var(…)` and parenthesised colour functions, so the closing
 * paren has to be found by counting depth.
 */
function varReferences(source) {
  const found = [];
  for (const match of source.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    if (!match[2]) continue; // no fallback
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    found.push({
      token: match[1],
      fallback: source.slice(match.index + match[0].length, i - 1).trim(),
    });
  }
  return found;
}

/** Files outside `styles/` that carry chrome CSS inline. */
function inlineStyleSources() {
  const files = [path.join(RENDERER_DIR, 'index.html')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(full);
    }
  };
  walk(path.join(RENDERER_DIR, 'lib'));
  return files.filter((file) => fs.readFileSync(file, 'utf8').includes('var(--'));
}

function offenders(source, label, defined) {
  return varReferences(source)
    .filter(({ token, fallback }) => !defined.has(token) && COLOR_FALLBACK.test(fallback))
    .map(({ token, fallback }) => `${label}: var(${token}, ${fallback})`);
}

describe('chrome palette tokens', () => {
  const defined = definedTokens();

  test('the palette defines the tokens the chrome actually themes with', () => {
    // variables.css is the palette; a token defined in a component sheet is a
    // component-local constant, which is fine, but these have to be there.
    const palette = fs.readFileSync(path.join(STYLES_DIR, 'variables.css'), 'utf8');
    for (const token of ['--bg', '--toolbar', '--border', '--text', '--muted', '--accent']) {
      expect(palette).toContain(`${token}:`);
      // …and re-declared for the light theme, or overridden nowhere else.
      expect(defined.has(token)).toBe(true);
    }
  });

  test('no stylesheet falls back on a hard-coded colour for an undefined token', () => {
    const found = [];
    for (const name of sheets) {
      found.push(...offenders(fs.readFileSync(path.join(STYLES_DIR, name), 'utf8'), name, defined));
    }
    expect(found).toEqual([]);
  });

  test('no inline style in the markup or the renderer modules does either', () => {
    const sources = inlineStyleSources();
    // The sweep is only worth anything while it still finds files to sweep.
    expect(sources.some((file) => file.endsWith('index.html'))).toBe(true);
    const found = [];
    for (const file of sources) {
      found.push(
        ...offenders(fs.readFileSync(file, 'utf8'), path.relative(RENDERER_DIR, file), defined)
      );
    }
    expect(found).toEqual([]);
  });

  // --- self-tests -----------------------------------------------------------

  test('the sweep still flags every shape #249 fixed', () => {
    const palette = new Set(['--text', '--muted', '--border']);
    // The ten sidebar sites, the inline one in the markup, and the one the
    // wallet's RPC panel injects from JS.
    for (const source of [
      '.perms-site { color: var(--text-primary, #fff) }',
      '.perms-section-header { color: var(--text-secondary, #888) }',
      '.perms-label { color: var(--text-primary, #ccc) }',
      '.perms-empty { color: var(--text-tertiary, #666) }',
      '.perms-tx-rule { background: var(--bg-elevated, rgba(255,255,255,0.03)) }',
      '.perms-tx-addr { color: var(--text-secondary, #aaa) }',
      '.swarm-manifest-row-detail { color: var(--sidebar-text-secondary, #8b8b8b) }',
      '.x402-perm-input { background: var(--input-background, rgba(255, 255, 255, 0.04)) }',
      '.swarm-manifest-row { border: 1px solid var(--sidebar-border, rgba(127, 127, 127, 0.25)) }',
      'style="border: 1px solid var(--border-color, #3a3a3c)"',
    ]) {
      expect(offenders(source, 'probe', palette)).toHaveLength(1);
    }

    // …and leaves alone the shapes that are not this bug: a defined token
    // (the fallback is dead code), a non-colour fallback, and a bare
    // reference with no fallback at all.
    expect(
      offenders('.a { color: var(--accent, #6366f1) }', 'probe', new Set(['--accent']))
    ).toEqual([]);
    expect(offenders('.a { font-family: var(--font-mono, monospace) }', 'probe', palette)).toEqual(
      []
    );
    expect(offenders('.a { color: var(--nope) }', 'probe', palette)).toEqual([]);
  });

  test('a fallback containing parens or a nested var() is read whole', () => {
    expect(varReferences('.a { background: var(--x, rgba(1, 2, 3, 0.4)); color: red }')).toEqual([
      { token: '--x', fallback: 'rgba(1, 2, 3, 0.4)' },
    ]);
    expect(varReferences('.a { color: var(--x, var(--y, #fff)) }')).toEqual([
      { token: '--x', fallback: 'var(--y, #fff)' },
      { token: '--y', fallback: '#fff' },
    ]);
  });

  test('the colour matcher reads the notations the chrome uses', () => {
    for (const value of [
      '#fff',
      '#3a3a3c',
      '#161b22cc',
      'rgba(255, 255, 255, 0.03)',
      'rgb(127 127 127 / 8%)',
      'oklch(0.5 0.1 200)',
      'white',
      '1px solid #3a3a3c',
      'transparent',
    ]) {
      expect(COLOR_FALLBACK.test(value)).toBe(true);
    }
    for (const value of ['monospace', '0', '8px', 'inherit', 'none', 'normal']) {
      expect(COLOR_FALLBACK.test(value)).toBe(false);
    }
  });
});
