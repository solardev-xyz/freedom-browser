/**
 * The design system's guards (#1198, docs/design-system.md).
 *
 * The chrome and the internal pages paint from one token file
 * (`pages/styles/tokens.css`) and draw their buttons, cards, badges, fields
 * and the rest from one sheet of shared blocks (`pages/styles/ui.css`). What
 * the renderer still does on its own is recorded in
 * `design-system-inventory.json`, which may only shrink: a screen that moves
 * onto the blocks deletes its entries (`npm run ui:inventory -- --write`), and
 * a new screen cannot add any.
 *
 * Like the colour-literal ratchet (renderer-styles.test.js), the comparison
 * is two-sided: an entry the tree has and the inventory does not is a screen
 * styling itself again, and an entry the inventory has and the tree does not
 * is a stale line, so the file never claims more than is true.
 */
const fs = require('fs');
const path = require('path');
const {
  INVENTORY_FILE,
  TOKENS_FILE,
  BLOCKS_FILE,
  CATALOG_FILE,
  SECTIONS,
  rulesOf,
  inlineRules,
  declaration,
  definedIn,
  legacyClasses,
  oldTokenNames,
  oldTokens,
  literalSizes,
  bareOutlines,
  sweptSources,
  buildInventory,
  compare,
} = require('../../test/helpers/design-system-sweep');
const { RENDERER, sources, cssOf } = require('../../test/helpers/renderer-color-sweep');

const read = (rel) => fs.readFileSync(path.join(RENDERER, rel), 'utf8');
const tokensCss = read(TOKENS_FILE);
const blocksCss = read(BLOCKS_FILE);

/** The custom properties a `selector { … }` block in tokens.css declares. */
function tokensOf(selector) {
  const rule = rulesOf(tokensCss).find((candidate) => candidate.selector === selector);
  if (!rule) throw new Error(`tokens.css has no ${selector} block`);
  return [...rule.body.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
}

describe('design tokens (#1198)', () => {
  const dark = tokensOf(":root, [data-theme='dark']");
  const light = tokensOf("[data-theme='light']");

  test('the light theme defines exactly the tokens the dark one does', () => {
    expect([...light].sort()).toEqual([...dark].sort());
    // The roles the spec names, so a rename here is a decision, not a slip.
    expect(dark).toEqual(
      expect.arrayContaining([
        '--surface-canvas',
        '--surface',
        '--surface-raised',
        '--surface-inset',
        '--surface-hover',
        '--text',
        '--text-strong',
        '--text-muted',
        '--text-faint',
        '--text-on-accent',
        '--border',
        '--border-strong',
        '--accent',
        '--accent-hover',
        '--accent-soft',
        '--danger',
        '--danger-soft',
        '--warning',
        '--warning-soft',
        '--success',
        '--success-soft',
        '--info-soft',
        '--focus-ring',
        '--shadow-raised',
        '--shadow-overlay',
      ])
    );
  });

  test('the private window redefines every colour token, dark in both profile themes', () => {
    // It sits on <body> under whatever theme <html> carries: a token it left
    // out would come from the light theme in a light profile (dark heading
    // text on the plum surface).
    expect([...tokensOf('body.private-window')].sort()).toEqual([...dark].sort());
    const block = rulesOf(tokensCss).find((rule) => rule.selector === 'body.private-window');
    expect(declaration(block.body, 'color-scheme')).toBe('dark');
  });

  test('so does the Tor window, a private window in its own palette (#473)', () => {
    const selector = 'body.private-window.tor-window';
    expect([...tokensOf(selector)].sort()).toEqual([...dark].sort());
    const block = rulesOf(tokensCss).find((rule) => rule.selector === selector);
    expect(declaration(block.body, 'color-scheme')).toBe('dark');
  });

  test('a token that refers to another is declared on every theme scope', () => {
    // `--a: var(--b)` resolves where it is declared: declared on :root only,
    // a nested `data-theme` (the catalog's light column) or the private
    // window would inherit the root's answer.
    const rule = rulesOf(tokensCss).find((candidate) => /var\(/.test(candidate.body));
    expect(rule.selector).toBe(
      ":root, [data-theme='dark'], [data-theme='light'], body.private-window"
    );
    for (const block of rulesOf(tokensCss)) {
      if (block.selector !== rule.selector) expect(block.body).not.toMatch(/var\(/);
    }
  });

  test('the size scales are defined once, on :root', () => {
    const scales = tokensOf(':root');
    for (const prefix of ['--space-', '--radius-', '--font-size-', '--control-']) {
      expect(scales.some((token) => token.startsWith(prefix))).toBe(true);
    }
    // Sizes are `--font-size-*`: `--text-*` names are colours.
    expect(scales.filter((token) => token.startsWith('--text-'))).toEqual([]);
  });
});

describe('shared blocks (#1198)', () => {
  const blockRules = rulesOf(blocksCss);

  test('every class in ui.css is a ui- block', () => {
    const classes = new Set(
      blockRules.flatMap((rule) => [...rule.selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]))
    );
    expect(classes.size).toBeGreaterThan(30);
    expect([...classes].filter((name) => !name.startsWith('ui-'))).toEqual([]);
  });

  test('the blocks paint only from tokens.css', () => {
    const defined = definedIn(tokensCss);
    const used = [...blocksCss.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(50);
    expect([...new Set(used)].filter((token) => !defined.has(token))).toEqual([]);
  });

  test('font sizes, radii and control heights come from the scales', () => {
    const offenders = [];
    for (const rule of blockRules) {
      for (const property of ['font-size', 'border-radius', 'min-height']) {
        const value = declaration(rule.body, property);
        if (value && value !== '0' && !/^(calc\()?var\(--(font-size|radius|control)-/.test(value)) {
          offenders.push(`${rule.selector} { ${property}: ${value} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a field's focus ring is the chrome's text-field ring (inputs.css, #237)", () => {
    const ring = blockRules.find((rule) => rule.selector === '.ui-field__control:focus-visible');
    expect(declaration(ring.body, 'outline')).toBe('2px solid var(--focus-ring)');
    expect(declaration(ring.body, 'outline-offset')).toBe('-1px');
    const chrome = read('styles/inputs.css');
    expect(chrome).toMatch(/outline: 2px solid var\(--accent\);\s*outline-offset: -1px;/);
  });

  test('no other stylesheet or inline style restyles a block', () => {
    const offenders = [];
    for (const rel of sources()) {
      if (rel === BLOCKS_FILE || rel === CATALOG_FILE) continue;
      const rules = [...rulesOf(cssOf(rel))];
      if (rel.endsWith('.html')) rules.push(...inlineRules(read(rel)));
      for (const rule of rules) {
        if (/\.ui-/.test(rule.selector)) offenders.push(`${rel}: ${rule.selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the catalog page shows every block, in both themes', () => {
    const catalog = read(CATALOG_FILE);
    for (const block of [
      'ui-button',
      'ui-button-row',
      'ui-icon-button',
      'ui-card',
      'ui-detail-list',
      'ui-callout',
      'ui-badge',
      'ui-field',
      'ui-list-row',
      'ui-sheet',
      'ui-page-header',
      'ui-empty-state',
    ]) {
      expect(catalog).toMatch(new RegExp(`class="${block}[ "]`));
    }
    expect(catalog).toContain('data-theme="dark"');
    expect(catalog).toContain('data-theme="light"');
  });
});

describe('the ratchet (#1198)', () => {
  const recorded = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  const actual = buildInventory();
  const { added, removed } = compare(recorded, actual);

  test('nothing new styles itself outside the shared blocks and tokens', () => {
    // Each entry is `<section> <file>: <what>`. A new legacy class: use a ui-
    // block. An old token: paint from tokens.css. A literal size: use the
    // scale. A bare outline: keep the ring. If none fits, extend ui.css.
    expect(added).toEqual([]);
  });

  test('every recorded entry is still in the tree (regenerate after a migration)', () => {
    // npm run ui:inventory -- --write
    expect(removed).toEqual([]);
  });

  test('the recorded totals add up', () => {
    for (const section of SECTIONS) {
      const entries = Object.values(recorded[section]).flat();
      expect(recorded.totals[section]).toBe(entries.length);
    }
  });

  test('the sweep covers the chrome and the pages, and leaves the Agent alone', () => {
    const swept = sweptSources();
    expect(swept).toEqual(
      expect.arrayContaining(['styles/sidebar.css', 'pages/settings.html', 'index.html'])
    );
    expect(swept).not.toContain('styles/agent.css');
    expect(swept).not.toContain(TOKENS_FILE);
    expect(swept).not.toContain(BLOCKS_FILE);
  });

  // --- self-tests -----------------------------------------------------------

  test('legacy classes: a block-like class styled in place, not a ui- or Agent one', () => {
    expect(
      legacyClasses(
        '.send-confirm-btn { padding: 14px } .x:hover .dapp-tx-details { border: 1px solid } ' +
          '.ui-button { padding: 0 } .agent-button { padding: 0 } .send-label { padding: 4px } ' +
          '.chain-badge { color: red } .agent-panel .save-btn { padding: 0 }'
      )
    ).toEqual(['dapp-tx-details', 'send-confirm-btn']);
  });

  test('legacy classes: a control styled by its element type, whatever its class', () => {
    expect(
      legacyClasses(
        'button.review-action { padding: 0 var(--space-4); background: var(--accent) } ' +
          ".panel input[type='text']:focus { border: 1px solid var(--border) } " +
          'select { min-height: var(--control-md) } button { font: inherit }'
      )
    ).toEqual(['button.review-action', "input[type='text']", 'select']);
  });

  test('inline styles are rules too, with their element for a selector', () => {
    const rules = inlineRules(
      '<button class="ui-button send-btn" style="font-size:17px;border-radius:7px;outline:none">' +
        '<span title="x">no style</span><div style=\'padding: 4px\'>'
    );
    expect(rules.map((rule) => rule.selector)).toEqual([
      'button.ui-button.send-btn[style]',
      'div[style]',
    ]);
    expect(literalSizes(rules)).toEqual(['border-radius: 7px', 'font-size: 17px']);
    expect(bareOutlines(rules)).toEqual(['button.ui-button.send-btn[style]']);
  });

  test('inline styles: quote-aware attributes, unquoted values, comments skipped', () => {
    expect(
      inlineRules(
        '<button title="x > y" class="ui-button" style="font-size:17px">' +
          '<div style=padding:4px>' +
          '<!-- <span class="ui-badge" style="color: var(--muted)"> -->'
      ).map((rule) => `${rule.selector} ${rule.body}`)
    ).toEqual(['button.ui-button[style] font-size:17px', 'div[style] padding:4px']);
  });

  test("a class inside :not() does not make a selector the Agent's", () => {
    const css = '.review-btn:not(.agent-skip) { padding: 4px; font-size: 13px }';
    expect(legacyClasses(css)).toEqual(['review-btn']);
    expect(literalSizes(css)).toEqual(['font-size: 13px']);
  });

  test('the Agent is outside every section', () => {
    const css =
      '.agent-review-label { font-size: 31px; border-radius: 17px; color: var(--muted) } ' +
      '.agent-composer:focus { outline: none } .agent-send-btn { padding: 4px }';
    expect(literalSizes(css)).toEqual([]);
    expect(oldTokens(css, oldTokenNames())).toEqual([]);
    expect(bareOutlines(css)).toEqual([]);
    expect(legacyClasses(css)).toEqual([]);
  });

  test('old tokens: names tokens.css does not define', () => {
    const names = oldTokenNames();
    for (const name of ['--toolbar', '--muted', '--shell-muted', '--bg-card', '--foreground']) {
      expect(names.has(name)).toBe(true);
    }
    for (const name of ['--text', '--accent', '--border', '--agent-sheet', '--z-popover']) {
      expect(names.has(name)).toBe(false);
    }
    expect(
      oldTokens(
        '.a { color: var(--muted); background: var(--surface) } /* var(--toolbar) */',
        names
      )
    ).toEqual(['--muted']);
  });

  test('literal sizes: lengths, not keywords, percentages or tokens', () => {
    expect(
      literalSizes(
        '.a { font-size: 13px; border-radius: 50% } .b { font-size: var(--font-size-md) } ' +
          '.c { border-radius: 8px 8px 0 0 } .d { font-size: inherit; border-radius: 0 } ' +
          '.e { font-size: 15px !important }'
      )
    ).toEqual(['border-radius: 8px 8px 0 0', 'font-size: 13px', 'font-size: 15px !important']);
  });

  test('bare outlines: removed with no ring for the same selector', () => {
    expect(
      bareOutlines(
        '.a:focus { outline: none } ' +
          '.b { outline: none } .b:focus-visible { outline: 2px solid var(--focus-ring) } ' +
          '.c:focus { outline: none; box-shadow: 0 0 0 2px var(--accent) } ' +
          '.d:focus { outline: 0 } .d:focus-visible { box-shadow: none } ' +
          '.e:focus { outline: none !important } ' +
          '.f:focus { outline: none; outline-color: var(--focus-ring) } ' +
          '.g:focus { outline: none !important; outline: 2px solid var(--focus-ring) } ' +
          '.h:focus { outline: none; outline: 2px solid var(--focus-ring) }'
      )
    ).toEqual(['.a:focus', '.d:focus', '.e:focus', '.f:focus', '.g:focus']);
  });

  test('the rule parser reads nested at-rules flat and survives long markup', () => {
    expect(
      rulesOf('@media (max-width: 600px) { .a { color: red } } .b { padding: 0 }').map(
        (rule) => rule.selector
      )
    ).toEqual(['.a', '.b']);
    // A page's CSS view is mostly blanked markup; this must stay linear.
    const start = Date.now();
    rulesOf(`${' '.repeat(400000)}.x { padding: 0 }`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
