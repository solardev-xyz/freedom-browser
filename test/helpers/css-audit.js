/**
 * A small, deliberately incomplete CSS reader shared by the renderer style
 * guards (`src/renderer/renderer-styles.test.js`,
 * `src/renderer/pages/settings-styles.test.js`).
 *
 * It is not a CSS parser: it models blocks, preludes and declarations well
 * enough for hand-written stylesheets, plus the colour notations the guards
 * have to reason about. Strings, `url(…)` tokens and comments are blanked
 * first (see `maskOpaqueSpans`) so a `;`, `{` or `}` inside a value cannot
 * fracture the block structure.
 *
 * Lives under `test/helpers/` rather than `src/renderer/` on purpose: it is
 * test-only machinery and must not be collected by the coverage sweep over
 * `src/**` or shipped in the packaged app.
 */

// --- masking ---------------------------------------------------------------

/**
 * Blank the *contents* of comments, quoted strings and unquoted `url(…)`
 * tokens, keeping their delimiters, their length and their newlines (so both
 * offsets and line numbers in error messages still line up).
 *
 * The block reader below is not a tokenizer: it treats every `;`, `{` and `}`
 * as structural. CSS lets all three appear inside a string or a URL — the
 * likeliest one here is a `data:image/svg+xml;base64,…` background, whose `;`
 * would split the declaration mid-value and hide whatever colour follows it
 * from the sweeps, while a `content: '{'` would unbalance the brace count on a
 * perfectly correct stylesheet. Hiding those spans first makes both cases
 * inert without pretending to parse the value.
 *
 * Comments are masked in this same pass, not stripped beforehand, because the
 * two are mutually recursive: a regex comment strip run first reads the `/`+`*`
 * inside `content: '/*'` as a real comment opener and deletes every rule up to
 * the next comment terminator — hiding them from the guards on a perfectly
 * valid stylesheet — while masking strings first would take an apostrophe
 * inside a comment for the start of a string. Whichever span opens first wins.
 *
 * `comments` (optional) collects `{ start, end, text }` for every real comment,
 * which is what the colour-literal guard matches `/* theme-literal: … *\/`
 * annotations against.
 */
function maskOpaqueSpans(css, comments) {
  // Newlines are preserved so a masked span never changes the line numbering.
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) throw new Error(`unterminated comment at offset ${i}`);
      if (comments) {
        comments.push({ start: i, end: close + 2, text: css.slice(i + 2, close) });
      }
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

// --- block reader ----------------------------------------------------------

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

// --- colour notations ------------------------------------------------------

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
// Colour syntaxes `parseColors` does *not* model. A background written in one
// of them would parse to zero colours and be waved through the dark sweep, so
// the stylesheet is guarded against them instead (see settings-styles.test.js).
const UNMODELLED_COLOR = /\b(?:hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/;
// The CSS named colours (CSS Color 4 §6.1, values cross-checked against the
// `color-name` table in node_modules). They are a *closed* list, so modelling
// them here is complete rather than a guess: without it `background: black`
// parses to zero colours, which the dark sweep reads as "not dark" — and
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

const luminance = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

// --- colour-literal sweep --------------------------------------------------

/**
 * Every colour literal notation the guard rejects, in one pass over a
 * declaration value: hex, `rgb()`/`rgba()`, `hsl()`/`hsla()` and the CSS named
 * colours. The functional forms are matched loosely (`name(` up to the first
 * `)`) rather than by channel grammar, because the point here is "a literal was
 * written", not "what colour is it" — a malformed `rgb(` must not slip through
 * on a grammar mismatch.
 *
 * `#` sequences that are not a legal hex colour length are skipped: those are
 * fragment URLs (`fill: url(#grad)` — already masked) and ids, not colours.
 */
const COLOR_LITERAL = new RegExp(
  [
    String.raw`#[0-9a-fA-F]+\b`,
    String.raw`\b(?:rgba?|hsla?)\([^)]*\)`,
    NAMED_COLOR_TOKEN.source,
  ].join('|'),
  'g'
);

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

/**
 * Declarations in `masked` with their source offsets.
 *
 * Deliberately independent of `parseStylesheet`: the colour-literal guard has
 * to point at a line number and match an annotation comment against it, and the
 * block tree throws both away. A bare declaration list (a `style=""` attribute)
 * parses here as well as a full stylesheet does.
 */
function declarationsWithOffsets(masked) {
  const found = [];
  let start = 0;
  const flush = (end) => {
    const raw = masked.slice(start, end);
    const colon = raw.indexOf(':');
    if (colon !== -1 && raw.trim()) {
      const lead = raw.length - raw.trimStart().length;
      found.push({
        property: raw.slice(0, colon).trim(),
        value: raw.slice(colon + 1).trim(),
        start: start + lead,
        end,
      });
    }
    start = end + 1;
  };
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === ';' || ch === '}') flush(i);
    else if (ch === '{') start = i + 1;
  }
  flush(masked.length);
  return found;
}

/** `/* theme-literal: <reason> *\/` — the only allowlist the guard honours. */
const ANNOTATION = /^\s*theme-literal:\s*\S/;

/**
 * Every colour literal in `source`, as
 * `{ property, value, literal, line, annotated, reason }`.
 *
 * `source` is the file text with every non-CSS region already blanked (see
 * `cssViewOfHtml`), so offsets and line numbers are the real ones.
 *
 * An annotation counts for a declaration when the comment sits on the
 * declaration's own line(s) or on the line immediately above it — the two
 * shapes a reader would write:
 *
 *   color: #fff; /* theme-literal: badge text on the accent fill *\/
 *
 *   /* theme-literal: badge text on the accent fill *\/
 *   color: #fff;
 */
function findColorLiterals(source) {
  const comments = [];
  const masked = maskOpaqueSpans(source, comments);
  const annotations = comments
    .filter((c) => ANNOTATION.test(c.text))
    .map((c) => ({
      line: lineOf(source, c.start),
      // A comment alone on its line annotates the declaration below it; one
      // written after code on the same line annotates only that line. Without
      // the distinction a trailing annotation would leak onto the *next*
      // declaration, which is how an allowlist quietly grows.
      ownLine: !/\S/.test(source.slice(source.lastIndexOf('\n', c.start) + 1, c.start)),
      reason: c.text
        .trim()
        .replace(/^theme-literal:\s*/, '')
        .trim(),
    }));

  const found = [];
  for (const decl of declarationsWithOffsets(masked)) {
    const literals = [];
    for (const [token] of decl.value.matchAll(COLOR_LITERAL)) {
      if (token.startsWith('#')) {
        if (HEX_LENGTHS.has(token.length - 1)) literals.push(token);
        continue;
      }
      if (token.endsWith(')')) {
        literals.push(token.replace(/\s+/g, ' '));
        continue;
      }
      if (NAMED_COLORS.has(token.toLowerCase())) literals.push(token);
    }
    if (!literals.length) continue;
    const firstLine = lineOf(source, decl.start);
    const lastLine = lineOf(source, decl.end);
    const annotation = annotations.find(
      (a) => (a.line >= firstLine && a.line <= lastLine) || (a.ownLine && a.line === firstLine - 1)
    );
    for (const literal of literals) {
      found.push({
        property: decl.property,
        value: decl.value.replace(/\s+/g, ' '),
        literal,
        line: firstLine,
        annotated: Boolean(annotation),
        reason: annotation ? annotation.reason : null,
      });
    }
  }
  return found;
}

// --- HTML ------------------------------------------------------------------

const blankKeepNewlines = (text) => text.replace(/[^\n]/g, ' ');

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
// `style="…"` / `style='…'`, as written in markup *and* inside the renderer's
// own template literals in the same file.
const STYLE_ATTRIBUTE = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/g;

/** Every inline `<style>` block in `html`, as `{ css, line }`. */
function styleBlocks(html) {
  return [...html.matchAll(STYLE_BLOCK)].map((m) => ({
    css: m[1],
    line: lineOf(html, m.index),
  }));
}

/**
 * `html` with every non-CSS region blanked out, keeping length and newlines so
 * offsets and line numbers still address the original file.
 *
 * Each `style=""` attribute's closing quote becomes a `;` so two attributes
 * separated only by blanked-out markup cannot run into one declaration.
 */
function cssViewOfHtml(html) {
  const view = new Array(html.length).fill(null);
  const keep = (from, to) => {
    for (let i = from; i < to; i += 1) view[i] = html[i];
  };
  for (const m of html.matchAll(STYLE_BLOCK)) {
    const from = m.index + m[0].indexOf('>') + 1;
    keep(from, from + m[1].length);
  }
  for (const m of html.matchAll(STYLE_ATTRIBUTE)) {
    const from = m.index + m[0].length - 1 - m[2].length;
    keep(from, from + m[2].length);
    view[from + m[2].length] = ';';
  }
  let out = '';
  for (let i = 0; i < html.length; i += 1) {
    out += view[i] === null ? (html[i] === '\n' ? '\n' : ' ') : view[i];
  }
  return out;
}

module.exports = {
  blankKeepNewlines,
  cssViewOfHtml,
  styleBlocks,
  findColorLiterals,
  declarationsWithOffsets,
  lineOf,
  COLOR_LITERAL,
  maskOpaqueSpans,
  parseStylesheet,
  selectorsOf,
  isAtRule,
  declaration,
  HEX_LENGTHS,
  UNMODELLED_COLOR,
  NAMED_COLORS,
  NAMED_COLOR_TOKEN,
  RGB_FUNCTION,
  hexColor,
  parseColors,
  luminance,
};
