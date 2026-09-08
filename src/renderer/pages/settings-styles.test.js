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
 *   - braces balance, and no top-level style rule has nested children;
 *   - the light-theme media query is a *top-level* rule, as are the sections
 *     that were swallowed;
 *   - every hard-coded dark background that paints the light theme — at any
 *     nesting depth, in any at-rule that is not a dark-scheme query — has a
 *     light-theme override that is itself light (#224 — `.resolver-config` had
 *     none).
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

// --- tiny CSS reader ------------------------------------------------------
// Deliberately not a full CSS parser: enough to model blocks, preludes and
// declarations for a hand-written stylesheet. Strings and `url(…)` tokens are
// blanked first (see `maskOpaqueSpans`) so a `;`, `{` or `}` inside a value
// cannot fracture the block structure.

function extractStyle(html) {
  // Attribute-tolerant on purpose: a CSP change that adds `<style nonce=…>`
  // must not make the block invisible to this sweep.
  const matches = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one inline <style> block, found ${matches.length}`);
  }
  return matches[0][1];
}

/**
 * Blank the *contents* of comments, quoted strings and unquoted `url(…)`
 * tokens, keeping their delimiters (and their length, so offsets in error
 * messages still line up).
 *
 * The block reader below is not a tokenizer: it treats every `;`, `{` and `}`
 * as structural. CSS lets all three appear inside a string or a URL — the
 * likeliest one here is a `data:image/svg+xml;base64,…` background, whose `;`
 * would split the declaration mid-value and hide whatever colour follows it
 * from the dark sweep, while a `content: '{'` would unbalance the brace count
 * on a perfectly correct stylesheet. Hiding those spans first makes both
 * cases inert without pretending to parse the value.
 *
 * Comments are masked in this same pass, not stripped beforehand, because the
 * two are mutually recursive: a regex comment strip run first reads the `/`+`*`
 * inside `content: '/*'` as a real comment opener and deletes every rule up to
 * the next comment terminator — hiding them from the guards on a perfectly
 * valid stylesheet — while masking strings first would take an apostrophe
 * inside a comment for the start of a string. Whichever span opens first wins.
 */
function maskOpaqueSpans(css) {
  const blank = (text) => ' '.repeat(text.length);
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) throw new Error(`unterminated comment at offset ${i}`);
      out += blank(css.slice(i, close + 2));
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < css.length && css[end] !== ch) end += css[end] === '\\' ? 2 : 1;
      if (end >= css.length) throw new Error(`unterminated ${ch} string at offset ${i}`);
      out += ch + blank(css.slice(i + 1, end)) + ch;
      i = end + 1;
      continue;
    }
    const isUrlToken =
      css.slice(i, i + 4).toLowerCase() === 'url(' && !/[\w-]/.test(css[i - 1] || '');
    if (isUrlToken) {
      let start = i + 4;
      while (start < css.length && /\s/.test(css[start])) start += 1;
      // A quoted URL is left to the string branch on the next iteration.
      if (css[start] === '"' || css[start] === "'") {
        out += css.slice(i, start);
        i = start;
        continue;
      }
      const close = css.indexOf(')', start);
      if (close === -1) throw new Error(`unclosed url( at offset ${i}`);
      out += css.slice(i, start) + blank(css.slice(start, close)) + ')';
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function flushDeclaration(node, buffer) {
  const text = buffer.trim();
  if (!text) return;
  const colon = text.indexOf(':');
  if (colon === -1) return;
  node.declarations.push({
    property: text.slice(0, colon).trim(),
    value: text.slice(colon + 1).trim(),
  });
}

/** Parse `css` into a tree of `{ prelude, declarations, children }` nodes. */
function parseStylesheet(css) {
  const root = { prelude: '', declarations: [], children: [] };
  const stack = [root];
  let buffer = '';

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      const node = { prelude: buffer.trim(), declarations: [], children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      buffer = '';
    } else if (ch === '}') {
      flushDeclaration(stack[stack.length - 1], buffer);
      buffer = '';
      if (stack.length === 1) {
        throw new Error(`unbalanced '}' at offset ${i}`);
      }
      stack.pop();
    } else if (ch === ';') {
      flushDeclaration(stack[stack.length - 1], buffer);
      buffer = '';
    } else {
      buffer += ch;
    }
  }

  if (stack.length !== 1) {
    throw new Error(`unclosed rule: ${stack[stack.length - 1].prelude || '<root>'}`);
  }
  return root;
}

const selectorsOf = (node) =>
  node.prelude
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const isAtRule = (node) => node.prelude.startsWith('@');

const declaration = (node, property) =>
  node.declarations.filter((d) => d.property === property).map((d) => d.value);

// --- colour helpers (for the hard-coded-dark-background sweep) -------------

// `rgb()`/`rgba()` in both the legacy comma form and the modern
// space-separated form, with a `,`- or `/`-introduced alpha that may be a
// number or a percentage: rgb(22, 27, 34), rgba(22, 27, 34, .6),
// rgb(22 27 34), rgb(22 27 34 / 60%).
const CHANNEL = String.raw`[\d.]+%?`;
const RGB_FUNCTION = new RegExp(
  String.raw`rgba?\(\s*(${CHANNEL})\s*(?:,\s*|\s+)(${CHANNEL})\s*(?:,\s*|\s+)(${CHANNEL})\s*(?:[,/]\s*(${CHANNEL})\s*)?\)`,
  'g'
);
// #rgb, #rgba, #rrggbb, #rrggbbaa.
const HEX_LENGTHS = new Set([3, 4, 6, 8]);
// Colour syntaxes this reader does *not* model. A background written in one of
// them would parse to zero colours and be waved through the dark sweep, so the
// stylesheet is guarded against them instead (see the test below).
const UNMODELLED_COLOR = /\b(?:hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/;
// The CSS named colours (CSS Color 4 §6.1, values cross-checked against the
// `color-name` table in node_modules). They are a *closed* list, so modelling
// them here is complete rather than a guess: without it `background: black`
// parses to zero colours, which the sweep reads as "not dark" — and
// UNMODELLED_COLOR cannot catch it either, since a bare keyword has no
// functional notation to match on.
const NAMED_COLORS = new Map(
  `aliceblue f0f8ff, antiquewhite faebd7, aqua 00ffff, aquamarine 7fffd4, azure f0ffff,
   beige f5f5dc, bisque ffe4c4, black 000000, blanchedalmond ffebcd, blue 0000ff,
   blueviolet 8a2be2, brown a52a2a, burlywood deb887, cadetblue 5f9ea0, chartreuse 7fff00,
   chocolate d2691e, coral ff7f50, cornflowerblue 6495ed, cornsilk fff8dc, crimson dc143c,
   cyan 00ffff, darkblue 00008b, darkcyan 008b8b, darkgoldenrod b8860b, darkgray a9a9a9,
   darkgreen 006400, darkgrey a9a9a9, darkkhaki bdb76b, darkmagenta 8b008b,
   darkolivegreen 556b2f, darkorange ff8c00, darkorchid 9932cc, darkred 8b0000,
   darksalmon e9967a, darkseagreen 8fbc8f, darkslateblue 483d8b, darkslategray 2f4f4f,
   darkslategrey 2f4f4f, darkturquoise 00ced1, darkviolet 9400d3, deeppink ff1493,
   deepskyblue 00bfff, dimgray 696969, dimgrey 696969, dodgerblue 1e90ff, firebrick b22222,
   floralwhite fffaf0, forestgreen 228b22, fuchsia ff00ff, gainsboro dcdcdc,
   ghostwhite f8f8ff, gold ffd700, goldenrod daa520, gray 808080, green 008000,
   greenyellow adff2f, grey 808080, honeydew f0fff0, hotpink ff69b4, indianred cd5c5c,
   indigo 4b0082, ivory fffff0, khaki f0e68c, lavender e6e6fa, lavenderblush fff0f5,
   lawngreen 7cfc00, lemonchiffon fffacd, lightblue add8e6, lightcoral f08080,
   lightcyan e0ffff, lightgoldenrodyellow fafad2, lightgray d3d3d3, lightgreen 90ee90,
   lightgrey d3d3d3, lightpink ffb6c1, lightsalmon ffa07a, lightseagreen 20b2aa,
   lightskyblue 87cefa, lightslategray 778899, lightslategrey 778899, lightsteelblue b0c4de,
   lightyellow ffffe0, lime 00ff00, limegreen 32cd32, linen faf0e6, magenta ff00ff,
   maroon 800000, mediumaquamarine 66cdaa, mediumblue 0000cd, mediumorchid ba55d3,
   mediumpurple 9370db, mediumseagreen 3cb371, mediumslateblue 7b68ee,
   mediumspringgreen 00fa9a, mediumturquoise 48d1cc, mediumvioletred c71585,
   midnightblue 191970, mintcream f5fffa, mistyrose ffe4e1, moccasin ffe4b5,
   navajowhite ffdead, navy 000080, oldlace fdf5e6, olive 808000, olivedrab 6b8e23,
   orange ffa500, orangered ff4500, orchid da70d6, palegoldenrod eee8aa, palegreen 98fb98,
   paleturquoise afeeee, palevioletred db7093, papayawhip ffefd5, peachpuff ffdab9,
   peru cd853f, pink ffc0cb, plum dda0dd, powderblue b0e0e6, purple 800080,
   rebeccapurple 663399, red ff0000, rosybrown bc8f8f, royalblue 4169e1, saddlebrown 8b4513,
   salmon fa8072, sandybrown f4a460, seagreen 2e8b57, seashell fff5ee, sienna a0522d,
   silver c0c0c0, skyblue 87ceeb, slateblue 6a5acd, slategray 708090, slategrey 708090,
   snow fffafa, springgreen 00ff7f, steelblue 4682b4, tan d2b48c, teal 008080,
   thistle d8bfd8, tomato ff6347, turquoise 40e0d0, violet ee82ee, wheat f5deb3,
   white ffffff, whitesmoke f5f5f5, yellow ffff00, yellowgreen 9acd32`
    .split(',')
    .map((entry) => entry.trim().split(/\s+/))
);
// A bare identifier: not a fragment of a longer word, of a custom property
// (`var(--bg-red)`), of a function name (`linear-gradient`) or of a hex
// literal. Anything left that is not in the table above is a keyword
// (`none`, `no-repeat`, `center`), not a colour.
const NAMED_COLOR_TOKEN = /(?<![\w#-])[a-zA-Z]+(?![\w-])/g;

const channelValue = (raw) => (raw.endsWith('%') ? (parseFloat(raw) * 255) / 100 : parseFloat(raw));
const alphaValue = (raw) => {
  if (raw === undefined) return 1;
  return raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
};

function parseColors(value) {
  const colors = [];
  for (const [, r, g, b, a] of value.matchAll(RGB_FUNCTION)) {
    colors.push({
      r: channelValue(r),
      g: channelValue(g),
      b: channelValue(b),
      a: alphaValue(a),
    });
  }
  for (const [, hex] of value.matchAll(/#([0-9a-fA-F]+)\b/g)) {
    if (!HEX_LENGTHS.has(hex.length)) continue;
    colors.push(hexColor(hex));
  }
  for (const [token] of value.matchAll(NAMED_COLOR_TOKEN)) {
    const hex = NAMED_COLORS.get(token.toLowerCase());
    if (hex) colors.push(hexColor(hex));
  }
  return colors;
}

function hexColor(hex) {
  const full =
    hex.length <= 4
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

const luminance = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

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
const lightBlock = topLevel.find((node) => LIGHT_WRAPPER.test(node.prelude));
const lightPalette = topLevel.find((node) => LIGHT_PALETTE.test(node.prelude));

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

  test('only the light-theme wrapper contains nested rules', () => {
    // The stylesheet is flat apart from the one deliberate grouping style rule
    // — the `:where(html[data-theme='light'])` wrapper (#233) — plus at-rules.
    // Any *other* style rule that has grown children means an earlier rule lost
    // its closing brace and swallowed everything after it.
    const nested = topLevel
      .filter((node) => !isAtRule(node) && node.children.length > 0)
      .filter((node) => !LIGHT_WRAPPER.test(node.prelude))
      .map((node) => `${node.prelude} (swallowed ${node.children.length} rules)`);
    expect(nested).toEqual([]);
  });

  test('the light theme is scoped by data-theme, not the OS colour scheme', () => {
    // #233: Settings > Appearance is the source of truth for internal pages.
    // The page must not fall back to `prefers-color-scheme` anywhere, or a
    // dark-themed app on a light desktop paints this page light again.
    expect(css).not.toMatch(/prefers-color-scheme/);

    // Exactly one wrapper, at the top level, matched with a whitespace-tolerant
    // regex: a cosmetic reformat must not fail a sheet that still works.
    expect(topLevel.map((node) => node.prelude).filter((p) => LIGHT_WRAPPER.test(p))).toHaveLength(
      1
    );
    // The mask hides the attribute *value* from the tree, so pin both scopes
    // against the raw source — `[data-theme='dark']` has the same masked shape.
    expect(SOURCE).toContain(":where(html[data-theme='light'])");
    expect(SOURCE).toContain("html[data-theme='light'] {");

    // …and the palette it exists for is declared on a *specificity-carrying*
    // selector, because it has to outweigh the `:root` defaults above it.
    // Written inside the zero-specificity `:where()` wrapper it would lose.
    expect(lightPalette).toBeDefined();
    expect(declaration(lightPalette, '--bg')).toEqual(['#ffffff']);

    // Scrollbars and form controls follow the same attribute (the second half
    // of #233 — the Shortcuts/Name Resolution sections scroll).
    const root = topLevel.find((node) => node.prelude === ':root');
    expect(declaration(root, 'color-scheme')).toEqual(['dark']);
    expect(declaration(lightPalette, 'color-scheme')).toEqual(['light']);
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

  test('every hard-coded dark background has a *light* light-theme override', () => {
    expect(lightBlock).toBeDefined();
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
