/**
 * Structural guards for the inline stylesheet of `src/renderer/pages/settings.html`.
 *
 * The settings page ships its CSS in a single inline `<style>` block, so a
 * dropped closing brace is not a parse error — with CSS nesting every rule
 * after the unclosed one is silently reparented inside it and simply stops
 * matching. That is exactly how #223 happened: the merge of #146 lost the body
 * *and* the `}` of `.search-provider-actions`, which quietly disabled every
 * `.shortcut-*` rule, the search-provider form rules, and the whole
 * `@media (prefers-color-scheme: light)` block (so Settings stayed dark on the
 * light theme) with no error anywhere.
 *
 * These tests parse the shipped stylesheet and assert the structure it is
 * supposed to have:
 *   - braces balance, and no style rule has nested children;
 *   - the sections #223 swallowed are top-level rules and still have bodies;
 *   - the page links the shared palette (`styles/theme.css`, #261) and keeps no
 *     theme scope of its own;
 *   - no rule paints a hard-coded dark background — at any nesting depth, in
 *     any at-rule that is not a dark-scheme query. Before #261 such a literal
 *     was allowed with a matching light override (#224 — `.resolver-config` had
 *     none); now there is no light block to write one in, so the token is the
 *     only way to paint one.
 */

const fs = require('fs');
const path = require('path');

const {
  maskOpaqueSpans,
  parseStylesheet,
  selectorsOf,
  isAtRule,
  declaration,
  styleBlocks,
  HEX_LENGTHS,
  UNMODELLED_COLOR,
  NAMED_COLORS,
  parseColors,
  luminance,
} = require('../../../test/helpers/css-audit');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
// The palette both themes are declared in since #261, linked by every internal
// page. Settings' own sheet is asserted against it below.
const THEME_SOURCE = fs.readFileSync(path.join(__dirname, 'styles', 'theme.css'), 'utf8');

// The block reader, the mask and the colour notations live in
// `test/helpers/css-audit.js`, shared with the whole-renderer sweep in
// `src/renderer/renderer-styles.test.js` (#261 item 1a). What stays here is
// what is specific to this page: the single-<style>-block extraction and the
// hard-coded-dark-background sweep the light-theme override guard is built on.

function extractStyle(html) {
  // Attribute-tolerant on purpose: a CSP change that adds `<style nonce=…>`
  // must not make the block invisible to this sweep.
  const blocks = styleBlocks(html);
  if (blocks.length !== 1) {
    throw new Error(`expected exactly one inline <style> block, found ${blocks.length}`);
  }
  return blocks[0].css;
}

// --- colour helpers (for the hard-coded-dark-background sweep) -------------

// A background counts as "hard-coded dark" when every literal colour it paints
// is dark. Near-transparent tints (the amber conflict banner at alpha 0.08) sit
// close enough to whatever is underneath to read fine in both themes.
const OPAQUE_ENOUGH = 0.2;
const DARK = 0.5;

function darkBackgroundValue(node) {
  for (const property of ['background', 'background-color']) {
    for (const value of declaration(node, property)) {
      const colors = parseColors(value).filter((c) => c.a >= OPAQUE_ENOUGH);
      if (colors.length && colors.every((c) => luminance(c) < DARK)) return value;
    }
  }
  return null;
}

// --- fixtures -------------------------------------------------------------

// An unreadable stylesheet — unbalanced braces, or a `<style>` block this
// reader cannot find — must fail the brace test with a useful message rather
// than blowing up at module load and reporting "0 tests", so extraction lives
// inside the same catch as parsing.
let parseError = null;
let css = '';
let sheet = { prelude: '', declarations: [], children: [] };
try {
  css = maskOpaqueSpans(extractStyle(SOURCE));
  sheet = parseStylesheet(css);
} catch (err) {
  parseError = err;
}
const topLevel = sheet.children;

/** Every style rule in the sheet, at any depth. */
const allRules = (function collect(node) {
  return node.children.flatMap((child) => [child, ...collect(child)]);
})(sheet);

const backgroundValues = (node) => [
  ...declaration(node, 'background'),
  ...declaration(node, 'background-color'),
];

const LIGHT_MEDIA = /^@media\s*\(\s*prefers-color-scheme:\s*light\s*\)$/;
// Since #233 the light theme is scoped by the `data-theme` attribute the
// webview preload stamps on <html> from Settings > Appearance, not by the OS
// scheme. `:where()` keeps the wrapper at zero specificity, so the rules under
// it weigh exactly what they did as a media query; the palette rule that has
// to outweigh the `:root` defaults is written without it.
//
// These match the *shape* only: `maskOpaqueSpans` blanks the contents of
// quoted strings, so the prelude that reaches the tree reads
// `:where(html[data-theme='     '])`. The value itself is pinned against the
// unmasked source in the test below.
const LIGHT_WRAPPER = /^:where\(\s*html\[data-theme=(['"])\s*\1\]\s*\)$/;
const LIGHT_PALETTE = /^html\[data-theme=(['"])\s*\1\]$/;
const isLightScope = (prelude) =>
  LIGHT_MEDIA.test(prelude) || LIGHT_WRAPPER.test(prelude) || LIGHT_PALETTE.test(prelude);

// Which colour scheme a rule scopes its contents to. Rules under a `light`
// query — or under the `data-theme='light'` wrapper — are the overrides; rules
// under a `dark` one never paint the light theme. Everything else — top level,
// `@media (max-width: …)`, `@supports`, `@container` — does, so it is swept.
const schemeOf = (prelude, inherited) => {
  if (isLightScope(prelude)) return 'light';
  if (/prefers-color-scheme:\s*dark/.test(prelude)) return 'dark';
  return inherited;
};

/**
 * Every style rule under `root` at any depth, tagged with the colour scheme its
 * enclosing rules scope it to and the preludes it sits under. The sweep walks
 * this rather than `topLevel`, so a dark background added inside a future
 * `@media (max-width: 600px)` block — or inside the light-theme wrapper —
 * cannot slip past it.
 */
function scopedRules(root, scheme = 'any', context = []) {
  return root.children.flatMap((child) => {
    const nextContext = [...context, child.prelude];
    if (isAtRule(child)) {
      return scopedRules(child, schemeOf(child.prelude, scheme), nextContext);
    }
    const childScheme = schemeOf(child.prelude, scheme);
    return [
      { rule: child, scheme: childScheme, context },
      ...scopedRules(child, childScheme, nextContext),
    ];
  });
}

const describeRule = (entry, selector) =>
  entry.context.length ? `${entry.context.join(' > ')} > ${selector}` : selector;

/**
 * Selectors that paint a hard-coded dark background under the light theme:
 * either with no light-theme background at all, or with one that is itself
 * dark. Returns one message per offending selector; `[]` means the sheet is
 * clean.
 */
function missingLightOverrides(root) {
  const all = scopedRules(root);
  // Selector -> the light-scoped rules that repaint its background, in source
  // order; the last one wins, exactly as the cascade sees it.
  const overrides = new Map();
  for (const { rule, scheme } of all) {
    if (scheme !== 'light' || !backgroundValues(rule).length) continue;
    for (const selector of selectorsOf(rule)) {
      if (!overrides.has(selector)) overrides.set(selector, []);
      overrides.get(selector).push(rule);
    }
  }

  const missing = [];
  for (const entry of all) {
    // 'light' rules are the overrides themselves; 'dark' ones never paint the
    // light theme. Everything else needs an override, at any nesting depth.
    if (entry.scheme !== 'any') continue;
    const value = darkBackgroundValue(entry.rule);
    if (!value) continue;
    for (const selector of selectorsOf(entry.rule)) {
      const where = describeRule(entry, selector);
      const repaints = overrides.get(selector);
      if (!repaints) {
        missing.push(`${where} { background: ${value} } — no light-theme background`);
        continue;
      }
      // Membership is not enough: an override that cargo-cults the dark value
      // still renders dark on the light theme (#224).
      const stillDark = darkBackgroundValue(repaints[repaints.length - 1]);
      if (stillDark) {
        missing.push(`${where} { background: ${stillDark} } — light override is still dark`);
      }
    }
  }
  return missing;
}

describe('settings.html inline stylesheet', () => {
  test('braces balance', () => {
    expect(parseError && parseError.message).toBeNull();
    expect((css.match(/\{/g) || []).length).toBe((css.match(/\}/g) || []).length);
  });

  test('no style rule contains nested rules', () => {
    // The stylesheet is flat: since #261 moved the palette out, the one
    // deliberate grouping rule — the `:where(html[data-theme='light'])` wrapper
    // (#233) — is gone with it. A style rule that has grown children means an
    // earlier rule lost its closing brace and swallowed everything after it.
    const nested = topLevel
      .filter((node) => !isAtRule(node) && node.children.length > 0)
      .map((node) => `${node.prelude} (swallowed ${node.children.length} rules)`);
    expect(nested).toEqual([]);
  });

  test('the light theme is scoped by data-theme, not the OS colour scheme', () => {
    // #233: Settings > Appearance is the source of truth for internal pages.
    // The page must not fall back to `prefers-color-scheme` anywhere, or a
    // dark-themed app on a light desktop paints this page light again.
    expect(css).not.toMatch(/prefers-color-scheme/);

    // #261: both palettes live in `styles/theme.css`, which this page links —
    // and can only fetch because `style-src` allows `'self'`.
    expect(SOURCE).toContain('<link rel="stylesheet" href="styles/theme.css" />');
    expect(SOURCE).toMatch(/style-src [^;"]*'self'/);
    // …so the page itself carries no theme scope and no palette of its own; a
    // page-local override is exactly the per-page drift #261 removed.
    expect(css).not.toMatch(/data-theme/);
    expect(topLevel.filter((node) => node.prelude === ':root')).toEqual([]);

    // The palette it paints from, asserted against that one file: written
    // inside the zero-specificity `:where()` wrapper the light block would lose
    // to the `html` defaults above it, so it carries specificity on purpose.
    const theme = parseStylesheet(maskOpaqueSpans(THEME_SOURCE)).children;
    const dark = theme.find((node) => node.prelude === 'html');
    const light = theme.find((node) => LIGHT_PALETTE.test(node.prelude));
    expect(THEME_SOURCE).toContain("html[data-theme='light'] {");
    expect(declaration(dark, '--bg')).toEqual(['#0d1117']);
    expect(declaration(light, '--bg')).toEqual(['#ffffff']);

    // Scrollbars and form controls follow the same attribute (the second half
    // of #233 — the Shortcuts/Name Resolution sections scroll).
    expect(declaration(dark, 'color-scheme')).toEqual(['dark']);
    expect(declaration(light, 'color-scheme')).toEqual(['light']);
  });

  test('the rules dropped by #223 are top-level and non-empty', () => {
    const byPrelude = new Map(topLevel.map((node) => [node.prelude, node]));
    for (const prelude of [
      '.search-provider-actions',
      '.search-provider-form[hidden]',
      '.search-provider-fields',
      '.shortcut-toolbar',
      '.shortcut-toolbar input',
      '.shortcut-category',
      '.shortcut-kbd',
      '.shortcut-binding.recording',
      '.row.shortcut-conflict',
      '.shortcut-conflict-actions',
    ]) {
      const node = byPrelude.get(prelude);
      expect(node && node.declarations.length).toBeTruthy();
    }
    // The exact body the merge commit lost.
    expect(byPrelude.get('.search-provider-actions').declarations).toEqual([
      { property: 'display', value: 'flex' },
      { property: 'flex-shrink', value: '0' },
      { property: 'gap', value: '8px' },
    ]);
    // The two computed values #223's acceptance criteria call out.
    expect(declaration(byPrelude.get('.shortcut-category'), 'font-size')).toEqual(['12px']);
    expect(declaration(byPrelude.get('.shortcut-toolbar input'), 'font-family')).toEqual([
      'inherit',
    ]);
  });

  test('no rule paints a hard-coded dark background (#224)', () => {
    // The sweep used to accept a dark literal that had a light-theme override.
    // Since #261 this page has no light block to write one in, so the only way
    // to paint a dark background is a token from `styles/theme.css` — which
    // carries its own light value. Every remaining literal fails here.
    expect(missingLightOverrides(sheet)).toEqual([]);
  });

  test('anchors in settings copy are styled, in both shapes (#234)', () => {
    // Settings copy carries links two ways: inside a help paragraph
    // (`<p class="row-help">… <a href="#chains">Chains settings</a></p>`) and
    // as the paragraph itself (`<a class="row-help" href=…>Configure →</a>`).
    // Neither may fall through to the UA's default blue, which is barely
    // readable on the dark palette. One rule has to cover both.
    const styled = new Set(
      topLevel
        .filter((node) => !isAtRule(node) && declaration(node, 'color').includes('var(--accent)'))
        .flatMap(selectorsOf)
    );
    expect(styled).toContain('.row-help a');
    expect(styled).toContain('a.row-help');

    // And every anchor the page actually ships is one of those two shapes.
    const anchors = [...SOURCE.matchAll(/<a\s+([^>]*)>/g)].map(([, attrs]) => attrs);
    expect(anchors.length).toBeGreaterThan(0);
    const unstyled = anchors.filter((attrs) => !/class="[^"]*\brow-help\b/.test(attrs));
    for (const attrs of unstyled) {
      // A bare <a> is fine as long as it sits inside a `.row-help` paragraph;
      // the ones that do are all written inline in such a paragraph.
      const at = SOURCE.indexOf(`<a ${attrs}>`);
      const paragraph = SOURCE.lastIndexOf('<p', at);
      expect(SOURCE.slice(paragraph, at)).toMatch(/class="[^"]*\brow-help\b/);
    }
  });

  // --- self-tests: the guards above only guard while they can still see -----

  const parse = (text) => parseStylesheet(maskOpaqueSpans(text));
  const LIGHT_PANEL = '@media (prefers-color-scheme: light) { .panel { background: #ffffff } }';

  test('the dark-background sweep reaches inside at-rules, not just the top level', () => {
    expect(missingLightOverrides(parse('.panel { background: #0d1117 }'))).toEqual([
      '.panel { background: #0d1117 } — no light-theme background',
    ]);
    // The blind spot: a dark background nested in a non-light at-rule.
    const narrow = '@media (max-width: 600px) { .panel { background: rgba(13, 17, 23, 0.9) } }';
    expect(missingLightOverrides(parse(narrow))).toEqual([
      '@media (max-width: 600px) > .panel { background: rgba(13, 17, 23, 0.9) } — no light-theme background',
    ]);
    // …and its light override still counts, wherever the two are declared.
    expect(missingLightOverrides(parse(`${narrow} ${LIGHT_PANEL}`))).toEqual([]);
    // A rule scoped to the dark scheme never paints the light theme.
    expect(
      missingLightOverrides(
        parse('@media (prefers-color-scheme: dark) { .panel { background: #0d1117 } }')
      )
    ).toEqual([]);
    // An override that cargo-cults the dark value is not an override (#224).
    const cargoCult =
      '.panel { background: #0d1117 } @media (prefers-color-scheme: light) { .panel { background: rgba(22, 27, 34, 0.6) } }';
    expect(missingLightOverrides(parse(cargoCult))).toEqual([
      '.panel { background: rgba(22, 27, 34, 0.6) } — light override is still dark',
    ]);
  });

  test('a `;`, `{` or `}` inside url()/strings does not fracture the reader', () => {
    // The `;base64,` form of the `select` arrow is the likeliest future edit:
    // unmasked it splits the declaration at the `;`, hiding the colour that
    // follows from the sweep entirely.
    const tricky = parse(
      `.a { background: url(data:image/svg+xml;base64,PHN2ZyB7fS8+) , rgba(13, 17, 23, 0.9); color: red }
       .b::after { content: '} .c { background: #0d1117'; background: #ffffff }`
    );
    expect(tricky.children.map((node) => node.prelude)).toEqual(['.a', '.b::after']);
    expect(tricky.children.every((node) => node.children.length === 0)).toBe(true);

    const [a, b] = tricky.children;
    // The declaration survived the `;` inside the URL, so the dark colour after
    // it is still visible to the sweep.
    expect(declaration(a, 'color')).toEqual(['red']);
    expect(parseColors(declaration(a, 'background')[0])).toContainEqual({
      r: 13,
      g: 17,
      b: 23,
      a: 0.9,
    });
    expect(darkBackgroundValue(a)).toContain('rgba(13, 17, 23, 0.9)');
    // The braces and the `#0d1117` inside the string are inert: no phantom
    // rule, no unbalanced count, and `.b::after` reads as light.
    expect(darkBackgroundValue(b)).toBeNull();
  });

  test('comment markers inside strings do not hide rules from the guards', () => {
    // Both markers below are *string contents*, so everything between them is
    // real CSS. Stripping comments before masking strings takes the first for a
    // comment opener and deletes the rule in the middle — the sweep then reads
    // a stylesheet the browser never sees, and stays green on a dark panel.
    const inString = parse(
      `.a::before { content: '/*'; }
       .dark { background: #0d1117 }
       .b::after { content: '*/'; }`
    );
    expect(inString.children.map((node) => node.prelude)).toEqual([
      '.a::before',
      '.dark',
      '.b::after',
    ]);
    expect(missingLightOverrides(inString)).toEqual([
      '.dark { background: #0d1117 } — no light-theme background',
    ]);
    // The mirror case: an apostrophe inside a real comment is comment text, not
    // the start of a string that swallows the rest of the sheet.
    const inComment = parse(`/* don't mask me */ .panel { background: #0d1117 }`);
    expect(inComment.children.map((node) => node.prelude)).toEqual(['.panel']);
    expect(missingLightOverrides(inComment)).toEqual([
      '.panel { background: #0d1117 } — no light-theme background',
    ]);
    // Commented-out rules stay invisible, and an unterminated comment is loud.
    expect(parse('/* .panel { background: #0d1117 } */').children).toEqual([]);
    expect(() => parse('.panel { background: /* unterminated }')).toThrow(/unterminated comment/);
  });

  test('named colours are read by the sweep, not waved through', () => {
    // The closed CSS list, as shipped: a typo'd entry would silently stop
    // matching whatever name it belongs to.
    expect(NAMED_COLORS.size).toBe(148);
    expect([...NAMED_COLORS.values()].filter((hex) => !/^[0-9a-f]{6}$/.test(hex))).toEqual([]);

    expect(parseColors('black')).toEqual([{ r: 0, g: 0, b: 0, a: 1 }]);
    expect(parseColors('WhiteSmoke')).toEqual([{ r: 245, g: 245, b: 245, a: 1 }]);
    expect(parseColors('rebeccapurple')).toEqual([{ r: 102, g: 51, b: 153, a: 1 }]);
    // Keywords, custom properties and function names are not colours.
    expect(parseColors('none')).toEqual([]);
    expect(parseColors('transparent')).toEqual([]);
    expect(parseColors('var(--bg-red)')).toEqual([]);
    expect(parseColors('linear-gradient(135deg, #0d1117 0%, #161b22 100%)')).toHaveLength(2);
    // A name inside a url() is part of the filename, and is masked away first.
    expect(missingLightOverrides(parse('.panel { background: url(black.svg) #ffffff }'))).toEqual(
      []
    );

    // A named dark background is flagged exactly like a hex one…
    expect(missingLightOverrides(parse('.panel { background: black }'))).toEqual([
      '.panel { background: black } — no light-theme background',
    ]);
    // …a named light override counts as an override…
    expect(
      missingLightOverrides(
        parse(
          '.panel { background: black } @media (prefers-color-scheme: light) { .panel { background: white } }'
        )
      )
    ).toEqual([]);
    // …one that is itself dark does not (#224)…
    expect(
      missingLightOverrides(
        parse(
          '.panel { background: #0d1117 } @media (prefers-color-scheme: light) { .panel { background: navy } }'
        )
      )
    ).toEqual(['.panel { background: navy } — light override is still dark']);
    // …and a light name is never flagged in the first place.
    expect(missingLightOverrides(parse('.panel { background: tan }'))).toEqual([]);
  });

  test('the light-media matcher tolerates cosmetic reformatting', () => {
    for (const prelude of [
      '@media (prefers-color-scheme: light)',
      '@media (prefers-color-scheme:light)',
      '@media(prefers-color-scheme: light )',
    ]) {
      expect(LIGHT_MEDIA.test(prelude)).toBe(true);
    }
    expect(LIGHT_MEDIA.test('@media (prefers-color-scheme: dark)')).toBe(false);
  });

  test('no background uses a colour syntax the dark sweep cannot read', () => {
    // parseColors models rgb()/rgba() and 3/4/6/8-digit hex. Anything else
    // parses to zero colours, which the sweep above reads as "not dark" — so a
    // dark hsl()/oklch() background would slip through silently. Fail loudly
    // and extend parseColors instead.
    const unreadable = [];
    for (const node of allRules) {
      for (const value of backgroundValues(node)) {
        if (UNMODELLED_COLOR.test(value)) {
          unreadable.push(`${node.prelude} { background: ${value} }`);
          continue;
        }
        for (const [token, hex] of value.matchAll(/#([0-9a-fA-F]+)\b/g)) {
          if (!HEX_LENGTHS.has(hex.length)) unreadable.push(`${node.prelude} { ${token} }`);
        }
      }
    }
    expect(unreadable).toEqual([]);
  });

  test('parseColors reads the colour syntaxes the sweep depends on', () => {
    expect(parseColors('#161b22')).toEqual([{ r: 22, g: 27, b: 34, a: 1 }]);
    expect(parseColors('#161b22cc')).toEqual([{ r: 22, g: 27, b: 34, a: 204 / 255 }]);
    expect(parseColors('#1a2b')).toEqual([{ r: 17, g: 170, b: 34, a: 187 / 255 }]);
    expect(parseColors('rgba(22, 27, 34, 0.6)')).toEqual([{ r: 22, g: 27, b: 34, a: 0.6 }]);
    expect(parseColors('rgb(22 27 34 / 60%)')).toEqual([{ r: 22, g: 27, b: 34, a: 0.6 }]);
    expect(parseColors('rgb(22 27 34)')).toEqual([{ r: 22, g: 27, b: 34, a: 1 }]);

    // …and that the sweep actually flags backgrounds written in those forms.
    const rule = (value) => ({
      prelude: '.probe',
      declarations: [{ property: 'background', value }],
      children: [],
    });
    expect(darkBackgroundValue(rule('#161b22cc'))).toBe('#161b22cc');
    expect(darkBackgroundValue(rule('rgb(22 27 34 / 60%)'))).toBe('rgb(22 27 34 / 60%)');
    expect(darkBackgroundValue(rule('#ffffffcc'))).toBeNull();
    // Near-transparent tints stay exempt, in either notation.
    expect(darkBackgroundValue(rule('rgb(22 27 34 / 8%)'))).toBeNull();
  });
});

/**
 * Heading hierarchy (#255).
 *
 * `docs/agent-playbooks/ui-consistency.md` (lands with #247):
 * `h2.section-title` for the section, `h3.row-label` (or the 12 px uppercase
 * category style) for sub-headings, never a second large heading. The
 * chain-detail route used to emit up to five `h2.section-title`s — the page
 * title and four sub-sections — so a nested group was indistinguishable from
 * the page it lived in.
 *
 * Each `view.innerHTML = ` template in the file is one rendered route, so
 * counting the headings per template is what "one per route" means here.
 */
describe('settings.html heading hierarchy (#255)', () => {
  const routeTemplates = [...SOURCE.matchAll(/view\.innerHTML = `([\s\S]*?)`;/g)].map((m) => m[1]);

  test('the sub-heading style exists and is the small uppercase one', () => {
    const node = topLevel.find((rule) => rule.prelude === '.subsection-title');
    expect(node).toBeDefined();
    expect(declaration(node, 'font-size')).toEqual(['12px']);
    expect(declaration(node, 'text-transform')).toEqual(['uppercase']);
    // Same treatment as the Shortcuts categories it is shared with — the two
    // rules are separate only because the #223 guard above pins that one by
    // prelude.
    const shortcut = topLevel.find((rule) => rule.prelude === '.shortcut-category');
    expect(declaration(node, 'font-size')).toEqual(declaration(shortcut, 'font-size'));
    expect(declaration(node, 'text-transform')).toEqual(declaration(shortcut, 'text-transform'));
    expect(declaration(node, 'color')).toEqual(declaration(shortcut, 'color'));
  });

  test('no rendered route carries a second large heading', () => {
    // The dynamic views (chains list, chain detail, add-chain, RPC providers)
    // are the ones that grew extra titles; the static sections are one
    // `<section>` each, with their `<h2>` in the page markup. A view rendered
    // *under* such a section carries none of its own, which is why the bar is
    // "never more than one" rather than "exactly one".
    expect(routeTemplates.length).toBeGreaterThanOrEqual(4);
    const offenders = routeTemplates
      .map((template) => (template.match(/class="section-title"/g) || []).length)
      .filter((count) => count > 1);
    expect(offenders).toEqual([]);

    // The chain detail — the route this guards (#255) — has exactly its own.
    const detail = routeTemplates.find((template) => template.includes('Transaction broadcast'));
    expect((detail.match(/class="section-title"/g) || []).length).toBe(1);
  });

  test('the chain-detail sub-sections use the sub-heading style', () => {
    const detail = routeTemplates.find((template) => template.includes('Transaction broadcast'));
    expect(detail).toBeDefined();
    for (const title of ['Read and verification order', 'Transaction broadcast']) {
      expect(detail).toContain(`<h3 class="subsection-title">${title}</h3>`);
    }
    // …including the four RPC groups the `section()` helper emits.
    expect(SOURCE).toContain('<h3 class="subsection-title">${title}</h3>');
  });
});
