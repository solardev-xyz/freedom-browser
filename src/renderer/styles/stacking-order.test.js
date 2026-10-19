/**
 * The chrome's menu-tier stacking order lives in one place (#66).
 *
 * The trust shield's single-click gesture (menu open, click the shield: the
 * menu closes and the trust popover opens) only works because the shield sits
 * above `#menu-backdrop`, and the trust popover's "Copy" hint only shows
 * because it sits above the popover it escapes. Those numbers used to be
 * spread over menus.css and toolbar.css with the order explained in prose, so
 * "bump this menu above the popover" in one sheet could silently break the
 * other. They are now `--z-*` tokens in variables.css; this guard keeps the
 * order and keeps raw menu-tier numbers from creeping back.
 */

const fs = require('fs');
const path = require('path');

const STYLES_DIR = __dirname;
const RENDERER_DIR = path.join(STYLES_DIR, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const VARIABLES_CSS = read(STYLES_DIR, 'variables.css');
const CHROME_SHEETS = [
  ...read(RENDERER_DIR, 'styles.css').matchAll(/@import\s+'\.\/styles\/([\w-]+\.css)'/g),
].map(([, name]) => ({ name, css: read(STYLES_DIR, name).replace(/\/\*[\s\S]*?\*\//g, '') }));

const TOKENS = Object.fromEntries(
  [...VARIABLES_CSS.matchAll(/(--z-[\w-]+):\s*(-?\d+)\s*;/g)].map(([, name, value]) => [
    name,
    Number(value),
  ])
);

// The lowest value on the scale: anything at or above it floats over the whole
// chrome and belongs to the scale.
const MENU_TIER = 9999;

describe('menu-tier stacking order (#66)', () => {
  test('the scale is declared in variables.css', () => {
    expect(Object.keys(TOKENS).sort()).toEqual([
      '--z-menu-backdrop',
      '--z-over-backdrop',
      '--z-over-popover',
      '--z-popover',
      '--z-title-bar',
    ]);
    expect(TOKENS['--z-menu-backdrop']).toBe(MENU_TIER);
  });

  test('the order the trust-shield gesture and its tooltip depend on holds', () => {
    // Popovers float over the backdrop that an open menu raises.
    expect(TOKENS['--z-popover']).toBeGreaterThan(TOKENS['--z-menu-backdrop']);
    // The shield and the menu buttons take a click while the backdrop is up.
    expect(TOKENS['--z-over-backdrop']).toBeGreaterThan(TOKENS['--z-menu-backdrop']);
    // A hint tooltip paints above the popover whose overflow clip it escapes.
    expect(TOKENS['--z-over-popover']).toBeGreaterThan(TOKENS['--z-popover']);
    // The title-bar strip's profile menu covers the toolbar's lifted buttons.
    expect(TOKENS['--z-title-bar']).toBeGreaterThan(TOKENS['--z-over-backdrop']);
  });

  test('the surfaces the gesture involves paint from the scale', () => {
    const ruleBody = (css, selector) => {
      const match = css.match(
        new RegExp(`(?:^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`)
      );
      return match ? match[1] : '';
    };
    const sheet = (name) => CHROME_SHEETS.find((s) => s.name === name).css;
    expect(ruleBody(sheet('menus.css'), '.menu-backdrop')).toMatch(
      /z-index:\s*var\(--z-menu-backdrop\)/
    );
    expect(ruleBody(sheet('toolbar.css'), '.trust-shield')).toMatch(
      /z-index:\s*var\(--z-over-backdrop\)/
    );
    expect(ruleBody(sheet('toolbar.css'), '.trust-popover')).toMatch(
      /z-index:\s*var\(--z-popover\)/
    );
    expect(ruleBody(sheet('toolbar.css'), '.trust-popover-tooltip')).toMatch(
      /z-index:\s*var\(--z-over-popover\)/
    );
    // Named in variables.css's scale comment as the one popover on the
    // over-popover tier; keep the comment and the sheet in step.
    expect(ruleBody(sheet('github-bridge.css'), '.github-bridge-panel')).toMatch(
      /z-index:\s*var\(--z-over-popover\)/
    );
  });

  test('no chrome sheet hard-codes a menu-tier z-index', () => {
    const raw = CHROME_SHEETS.flatMap(({ name, css }) =>
      [...css.matchAll(/z-index:\s*(-?\d+)/g)]
        .filter(([, z]) => Number(z) >= MENU_TIER)
        .map(([decl]) => `${name}: ${decl}`)
    );
    expect(raw).toEqual([]);
  });

  test('every stacking token a sheet uses is defined', () => {
    const undefinedTokens = CHROME_SHEETS.flatMap(({ name, css }) =>
      [...css.matchAll(/var\(\s*(--z-[\w-]+)/g)]
        .filter(([, token]) => !(token in TOKENS))
        .map(([, token]) => `${name}: ${token}`)
    );
    expect(undefinedTokens).toEqual([]);
  });
});
