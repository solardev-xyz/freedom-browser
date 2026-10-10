/**
 * Mechanical guards over *every* stylesheet the renderer ships (#261 item 1a).
 *
 * Two sweeps, both generalised from `pages/settings-styles.test.js` (#230),
 * which guarded the same things for `settings.html` alone:
 *
 *   1. **Braces balance** in every stylesheet and every inline `<style>` block
 *      under `src/renderer/`. With CSS nesting a dropped `}` is not a parse
 *      error — every rule after the unclosed one is silently reparented inside
 *      it and simply stops matching. That is #223: the merge of #146 lost the
 *      body *and* the `}` of `.search-provider-actions`, which quietly killed
 *      the whole light-theme block with no error anywhere.
 *
 *   2. **No colour literals outside the token files.** Hex, `rgb()`/`rgba()`,
 *      `hsl()`/`hsla()` and the CSS named colours all fail, in stylesheets, in
 *      inline `<style>` blocks and in `style=""` attributes — because that is
 *      how the 0.8.5 audit's theme bugs were written (#224: a hard-coded dark
 *      `.resolver-config` with no light override; #249: a dark literal reached
 *      through a `var()` fallback; #250/#251: pages carrying their own
 *      palette). Colours belong in `styles/variables.css` (and, from #261
 *      item 2, the shared internal-page theme file); everything else paints
 *      through `var(--token)`.
 *
 * ### The two escape hatches
 *
 * **Annotation.** A declaration that carries a `/* theme-literal: <reason> *\/`
 * comment — on its own line or on the line above — is allowed. That is for the
 * literals that are genuinely not theme surfaces: drop shadows, a protocol's
 * brand colour, a node's status green, the fixed contrast pair on a filled
 * accent button. Every annotation names why.
 *
 * **The inventory** (`renderer-color-literals.json`). `src/renderer/` carried
 * ~1 500 colour literals before this guard existed, the bulk of them the
 * per-page palettes that #261 item 2 exists to delete. Annotating them all
 * now would be churn we would remove again next PR, so they are recorded
 * instead, per file, as the set of `property: literal` pairs each file is
 * known to contain. The check is a two-sided ratchet:
 *
 *   - a pair that is not in the inventory fails — that is a *new* literal, the
 *     only case CI has to catch;
 *   - a pair in the inventory that no longer appears fails too, with the line
 *     to delete, so the file can only ever shrink and the inventory cannot
 *     quietly grow stale.
 *
 * Its known limit: the inventory is a set, not a count, so re-using a colour
 * the same file already uses for the same property is waved through. Deleting
 * an entry is one line of JSON; adding one is a review conversation.
 */

const fs = require('fs');
const path = require('path');

const {
  maskOpaqueSpans,
  parseStylesheet,
  findColorLiterals,
  cssViewOfHtml,
  styleBlocks,
  declarationsWithOffsets,
  lineOf,
} = require('../../test/helpers/css-audit');
const {
  INVENTORY_FILE,
  ISSUE,
  TOKEN_FILES,
  sources,
  read,
  cssOf,
  unannotatedPairs,
} = require('../../test/helpers/renderer-color-sweep');

const RENDERER = __dirname;
const SOURCES = sources();

/** Top-level comma split of a font-family list (no family name contains a comma). */
const familiesOf = (list) =>
  list
    .replace(/!\s*important\s*$/i, '')
    .split(',')
    .map((f) =>
      f
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);

// The `font` shorthand ends `<size>[/<line-height>] <family-list>`; the size is
// the last length/keyword/function before the families. Found on a copy with
// quoted names blanked, so a digit inside `'Mono 3'` cannot pose as a size.
const FONT_SIZE =
  /(?:^|\s)(?:[\d.]+(?:[a-z]+|%)?|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|(?:calc|var|clamp|min|max)\([^)]*\))(?:\s*\/\s*\S+)?(?=\s+\S)/gi;

/** Whether a `font-family`/`font` value leaves the stack to the bare generic. */
function isBareMonospace(property, value) {
  const v = value.replace(/!\s*important\s*$/i, '').trim();
  let list = v;
  if (property === 'font') {
    const blanked = v.replace(/'[^']*'|"[^"]*"/g, (q) => q[0] + ' '.repeat(q.length - 2) + q[0]);
    let cut = -1;
    for (const m of blanked.matchAll(FONT_SIZE)) cut = m.index + m[0].length;
    if (cut === -1) return false; // a system-font keyword (`caption`, `menu`, …)
    list = v.slice(cut);
  }
  const families = familiesOf(list);
  return families.length > 0 && families.every((f) => f === 'monospace');
}

/** Every renderer script that ships (not tests, not vendored bundles). */
function rendererScripts(dir = RENDERER, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor' && entry.name !== 'node_modules') rendererScripts(full, out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(path.relative(RENDERER, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/** Font values a script sets: DOM style props, `setProperty`, canvas, CSS in strings. */
function scriptFontValues(src) {
  const found = [];
  const add = (property, value, index) => found.push({ property, value, index });
  for (const m of src.matchAll(/\bfontFamily\s*[:=]\s*(['"`])([^'"`]*)\1/g))
    add('font-family', m[2], m.index);
  for (const m of src.matchAll(
    /\bsetProperty\(\s*(['"])font(-family)?\1\s*,\s*(['"`])([^'"`]*)\3/g
  )) {
    add(m[2] ? 'font-family' : 'font', m[4], m.index);
  }
  for (const m of src.matchAll(/\.font\s*=\s*(['"`])([^'"`]*)\1/g)) add('font', m[2], m.index);
  // CSS written inside template literals / strings (`style="…"`, injected sheets).
  for (const m of src.matchAll(/\b(font-family|font)\s*:\s*([^;{}<>`]*?)\s*(?=[;}"`<]|$)/gim)) {
    add(m[1].toLowerCase(), m[2], m.index);
  }
  return found;
}

describe('renderer stylesheets', () => {
  test('the sweep sees the stylesheets it is supposed to sweep', () => {
    // A rename or a moved directory must not silently empty this file.
    for (const rel of [
      'styles.css',
      'styles/variables.css',
      'styles/sidebar.css',
      'pages/styles/rad-browser.css',
      'index.html',
      'pages/settings.html',
      'pages/home.html',
    ]) {
      expect(SOURCES).toContain(rel);
    }
    expect(SOURCES.filter((rel) => rel.endsWith('.css')).length).toBeGreaterThan(20);
    expect(SOURCES.filter((rel) => rel.endsWith('.html')).length).toBeGreaterThan(10);
  });

  test('braces balance in every stylesheet and every inline <style> block', () => {
    const broken = [];
    for (const rel of SOURCES) {
      const blocks = rel.endsWith('.html')
        ? styleBlocks(read(rel)).map((b, i) => ({ label: `${rel} <style> #${i + 1}`, css: b.css }))
        : [{ label: rel, css: read(rel) }];
      for (const { label, css } of blocks) {
        try {
          const masked = maskOpaqueSpans(css);
          parseStylesheet(masked);
          const open = (masked.match(/\{/g) || []).length;
          const close = (masked.match(/\}/g) || []).length;
          if (open !== close) broken.push(`${label}: ${open} '{' vs ${close} '}'`);
        } catch (err) {
          broken.push(`${label}: ${err.message}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test('no font stack is the bare generic `monospace` (#616)', () => {
    // Electron on macOS resolves a lone `monospace` to Times, so the stack
    // must name real faces first; `var(--font-mono)` is the shared one. Every
    // way a stylesheet, inline `<style>`, `style=""` or renderer script can
    // set a family is swept: `font-family` and the `font` shorthand, any case,
    // across lines, quoted or not, with `!important`, plus `style.fontFamily`,
    // `setProperty('font-family', …)` and a canvas `ctx.font`.
    const bare = [];
    for (const rel of SOURCES) {
      const src = cssOf(rel);
      for (const decl of declarationsWithOffsets(maskOpaqueSpans(src))) {
        const property = decl.property.toLowerCase();
        if (property !== 'font-family' && property !== 'font') continue;
        const raw = src.slice(decl.start, decl.end);
        const value = raw.slice(raw.indexOf(':') + 1).replace(/\/\*[\s\S]*?\*\//g, ' ');
        if (isBareMonospace(property, value)) bare.push(`${rel}:${lineOf(src, decl.start)}`);
      }
    }
    for (const rel of rendererScripts()) {
      const src = read(rel);
      for (const { property, value, index } of scriptFontValues(src)) {
        if (isBareMonospace(property, value)) bare.push(`${rel}:${lineOf(src, index)}`);
      }
    }
    expect(bare).toEqual([]);
  });

  test('the bare-monospace check sees every spelling of it (#616)', () => {
    const bad = [
      ['font-family', 'monospace'],
      ['font-family', ' monospace !important'],
      ['font-family', '"monospace"'],
      ['font-family', "\n    'monospace',\n    monospace\n  "],
      ['font-family', 'MONOSPACE'],
      ['font', '12px monospace'],
      ['font', 'italic 700 12px/1.4 monospace !important'],
      ['font', "small 'monospace'"],
    ];
    const good = [
      ['font-family', 'var(--font-mono)'],
      ['font-family', "'SF Mono', Menlo, monospace"],
      ['font-family', 'inherit'],
      ['font', '12px var(--font-mono)'],
      ['font', "12px 'Mono 3', monospace"],
      ['font', 'caption'],
    ];
    for (const [property, value] of bad)
      expect([value, isBareMonospace(property, value)]).toEqual([value, true]);
    for (const [property, value] of good)
      expect([value, isBareMonospace(property, value)]).toEqual([value, false]);

    const script = [
      "el.style.fontFamily = 'monospace';",
      'el.style.fontFamily="monospace"',
      "el.style.setProperty('font-family', 'monospace', 'important');",
      "ctx.font = '11px monospace';",
      'html = `<span style="font-family: monospace">x</span>`;',
      "const s = { fontFamily: 'monospace' };",
    ].join('\n');
    expect(
      scriptFontValues(script).filter((v) => isBareMonospace(v.property, v.value))
    ).toHaveLength(6);
    expect(
      scriptFontValues("el.style.fontFamily = 'var(--font-mono)';").filter((v) =>
        isBareMonospace(v.property, v.value)
      )
    ).toEqual([]);
  });

  test('code, kbd, pre and samp default to --font-mono, not the UA `monospace` (#616)', () => {
    // Without an authored family these elements keep the user-agent sheet's
    // bare `monospace` — the same Times-on-macOS bug, with no rule to sweep.
    // `styles/base.css` covers the chrome window (via `styles.css`) and
    // `pages/styles/theme.css` every internal page (theme.test.js pins that).
    expect(read('styles.css')).toMatch(/@import '\.\/styles\/base\.css';/);
    for (const rel of ['styles/base.css', 'pages/styles/theme.css']) {
      const masked = maskOpaqueSpans(read(rel));
      expect([rel, masked]).toEqual([
        rel,
        expect.stringMatching(
          /(?:^|\})\s*code,\s*kbd,\s*pre,\s*samp\s*\{\s*font-family:\s*var\(--font-mono\);\s*\}/
        ),
      ]);
    }
  });

  test('both token files define --font-mono (#616)', () => {
    for (const rel of ['styles/variables.css', 'pages/styles/theme.css']) {
      expect(read(rel)).toMatch(/--font-mono:\s*[^;]*monospace;/);
    }
  });
});

describe('renderer colour literals (#261)', () => {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  const known = inventory.files;
  const label = path.relative(path.join(RENDERER, '..', '..'), INVENTORY_FILE);

  test('no file outside the token files carries an unrecorded colour literal', () => {
    const added = [];
    for (const rel of SOURCES) {
      if (TOKEN_FILES.has(rel)) continue;
      const recorded = new Set(known[rel] || []);
      for (const [pair, line] of unannotatedPairs(rel)) {
        if (recorded.has(pair)) continue;
        added.push(
          `${rel}:${line}  ${pair}  — use a var(--token), or annotate the declaration ` +
            `with /* theme-literal: <reason> */`
        );
      }
    }
    expect(added).toEqual([]);
  });

  test('the inventory has no stale entries', () => {
    // The ratchet's other side: a literal that has been tokenised or annotated
    // must leave the inventory in the same commit, or the slot it frees lets a
    // different literal back in unnoticed.
    const stale = [];
    for (const [rel, pairs] of Object.entries(known)) {
      if (!SOURCES.includes(rel)) {
        stale.push(`${rel} — file is gone; delete its entry from ${label}`);
        continue;
      }
      const present = new Set(unannotatedPairs(rel).keys());
      for (const pair of pairs) {
        if (!present.has(pair)) stale.push(`${rel}: "${pair}" — delete this line from ${label}`);
      }
    }
    expect(stale).toEqual([]);
  });

  test('the token files are the only unconditional exemption', () => {
    // The exemption is what makes the guard usable, so it stays small and
    // explicit: a palette file, not "any file with `theme` in the name".
    // The first three are the chrome window's palette; `pages/styles/theme.css`
    // is the internal pages' one, added by #261 item 2 (#287).
    expect([...TOKEN_FILES].filter((rel) => SOURCES.includes(rel)).sort()).toEqual([
      'pages/styles/theme.css',
      'styles/light-theme.css',
      'styles/private.css',
      'styles/variables.css',
    ]);
    // Every exemption names a file that is actually in the tree: a name listed
    // for a file that does not exist yet is a free pass nobody would notice
    // being taken.
    expect([...TOKEN_FILES].filter((rel) => !SOURCES.includes(rel))).toEqual([]);
    // …and none of them may appear in the inventory as well.
    expect(Object.keys(known).filter((rel) => TOKEN_FILES.has(rel))).toEqual([]);
  });

  test('every annotation states a reason', () => {
    const bare = [];
    for (const rel of SOURCES) {
      for (const hit of findColorLiterals(cssOf(rel))) {
        if (hit.annotated && !/[a-z]{3}/i.test(hit.reason || '')) {
          bare.push(`${rel}:${hit.line} — /* theme-literal: */ with no reason`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  // --- self-tests: the guard is only worth its runtime while it still sees ---

  const pairs = (css) =>
    [...findColorLiterals(css)]
      .filter((h) => !h.annotated)
      .map((h) => `${h.property}: ${h.literal}`);

  test('every notation #261 names is caught', () => {
    expect(pairs('.a { color: #fff; background: #0d1117cc }')).toEqual([
      'color: #fff',
      'background: #0d1117cc',
    ]);
    expect(pairs('.a { background: rgb(1 2 3 / 40%); border-color: rgba(1, 2, 3, 0.4) }')).toEqual([
      'background: rgb(1 2 3 / 40%)',
      'border-color: rgba(1, 2, 3, 0.4)',
    ]);
    // hsl()/hsla() are in the guard even though nothing in the renderer uses
    // them: settings-styles.test.js has to *reject* them because its dark
    // sweep cannot read them, which makes them the obvious way to smuggle one
    // in past that sweep.
    expect(pairs('.a { color: hsl(210 30% 8%); background: hsla(210, 30%, 8%, 0.5) }')).toEqual([
      'color: hsl(210 30% 8%)',
      'background: hsla(210, 30%, 8%, 0.5)',
    ]);
    // CSS Color 4 notations, for the same reason hsl() is here: they paint the
    // same colours, Chromium ships them, and a guard that does not know them is
    // a documented way round it.
    expect(
      pairs('.a { background: oklch(60% 0.1 240); color: oklab(0.6 0.1 -0.1 / 50%) }')
    ).toEqual(['background: oklch(60% 0.1 240)', 'color: oklab(0.6 0.1 -0.1 / 50%)']);
    expect(pairs('.a { color: lch(60% 40 240); background: lab(60% 20 -30) }')).toEqual([
      'color: lch(60% 40 240)',
      'background: lab(60% 20 -30)',
    ]);
    expect(pairs('.a { color: hwb(240 20% 10%); background: color(display-p3 1 0 0) }')).toEqual([
      'color: hwb(240 20% 10%)',
      'background: color(display-p3 1 0 0)',
    ]);
    expect(pairs('.a { color: black; border: 1px solid RebeccaPurple }')).toEqual([
      'color: black',
      'border: RebeccaPurple',
    ]);
    // Two literals in one declaration are two findings, not one.
    expect(pairs('.a { background: linear-gradient(135deg, #0d1117 0%, #161b22 100%) }')).toEqual([
      'background: #0d1117',
      'background: #161b22',
    ]);
  });

  test('what is not a colour literal is left alone', () => {
    expect(pairs('.a { color: var(--text); background: var(--bg) }')).toEqual([]);
    // Keywords, lengths, and an id fragment in a url() (masked before the
    // sweep) are not colours; nor is a `#`-sequence of a non-colour length.
    expect(pairs('.a { color: inherit; border: none; fill: url(#grad-1) }')).toEqual([]);
    expect(pairs('.a { background: url(black.svg) }')).toEqual([]);
    expect(pairs(".a::after { content: '#ff0000' }")).toEqual([]);
    expect(pairs('.a { grid-area: header; transition: color 0.2s linear }')).toEqual([]);
    // Preludes are not declarations: a hex in a selector or a media query is
    // not a painted colour.
    expect(pairs('@media (min-width: 600px) { #f00bar { padding: 0 } }')).toEqual([]);
  });

  test('an annotation exempts its own declaration and nothing else', () => {
    const annotated = `
      .a {
        /* theme-literal: brand orange */
        background: #f7931a;
        color: #000;
      }
      .b {
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); /* theme-literal: drop shadow */
        border-color: #333;
      }`;
    expect(pairs(annotated)).toEqual(['color: #000', 'border-color: #333']);
    // …and the reason is carried through, so the "no bare annotation" test has
    // something to check.
    const reasons = findColorLiterals(annotated)
      .filter((h) => h.annotated)
      .map((h) => h.reason);
    expect(reasons).toEqual(['brand orange', 'drop shadow']);
    // A comment two lines above does not reach the declaration.
    expect(pairs('/* theme-literal: nope */\n\n.a { color: #fff }')).toEqual(['color: #fff']);
    // Neither does a bare `/* allowed */`.
    expect(pairs('/* allowed */\n.a { color: #fff }')).toEqual(['color: #fff']);
    // A *trailing* annotation covers its own line only: the declaration below
    // it is not annotated, or one allowlist comment would silently cover two.
    expect(
      pairs('.a { color: #fff; /* theme-literal: on accent */\n  border-color: #333 }')
    ).toEqual(['border-color: #333']);
  });

  test('inline <style> blocks and style="" attributes are swept too', () => {
    // #249's tenth site was an inline `style=` in the markup, not in any
    // stylesheet, and #223/#250 lived in inline `<style>` blocks.
    const html = [
      '<!doctype html>',
      '<style>',
      '  body { background: #0d1117 }',
      '</style>',
      '<div style="color: #8b949e">a</div>',
      '<div style="border: 1px solid #30363d">b</div>',
      '<p title="#not-a-style">c</p>',
    ].join('\n');
    const view = cssViewOfHtml(html);
    expect(pairs(view)).toEqual(['background: #0d1117', 'color: #8b949e', 'border: #30363d']);
    // Line numbers still address the original file after blanking.
    const lines = findColorLiterals(view).map((h) => h.line);
    expect(lines).toEqual([3, 5, 6]);
  });

  test('the inventory is a ratchet, not a mute button', () => {
    // Mutation-proof of both directions, on a fixture rather than on the real
    // files: a literal absent from the inventory is a failure, and an
    // inventory line whose literal is gone is a failure too.
    const recorded = new Set(['background: #0d1117']);
    const present = new Set(pairs('.a { background: #0d1117; color: #8b949e }'));
    expect([...present].filter((p) => !recorded.has(p))).toEqual(['color: #8b949e']);
    expect([...recorded].filter((p) => !new Set(pairs('.a { color: red }')).has(p))).toEqual([
      'background: #0d1117',
    ]);
  });

  test('the inventory only ever shrinks from here', () => {
    // Not an assertion about correctness — a note in the test output about how
    // much of #261 item 2 is still ahead, so the number moving the wrong way is
    // visible in a diff.
    const total = Object.values(known).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(inventory.total);
    expect(inventory.issue).toBe(ISSUE);
  });
});
