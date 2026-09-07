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
 *   - every hard-coded dark background outside the light block has a light
 *     override (#224 — `.resolver-config` did not).
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

// --- tiny CSS reader ------------------------------------------------------
// Deliberately not a full CSS parser: enough to model blocks, preludes and
// declarations for a hand-written stylesheet with no strings containing braces.

function extractStyle(html) {
  const matches = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one inline <style> block, found ${matches.length}`);
  }
  return matches[0][1];
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
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

function parseColors(value) {
  const colors = [];
  for (const [, r, g, b, a] of value.matchAll(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g
  )) {
    colors.push({ r: +r, g: +g, b: +b, a: a === undefined ? 1 : +a });
  }
  for (const [, hex] of value.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex;
    colors.push({
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    });
  }
  return colors;
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

const css = stripComments(extractStyle(SOURCE));

// An unbalanced stylesheet must fail the brace test with a useful message
// rather than blowing up at module load and reporting "0 tests".
let parseError = null;
let sheet = { prelude: '', declarations: [], children: [] };
try {
  sheet = parseStylesheet(css);
} catch (err) {
  parseError = err;
}
const topLevel = sheet.children;

const LIGHT_MEDIA = /^@media\s*\(\s*prefers-color-scheme:\s*light\s*\)$/;
const lightBlock = topLevel.find((node) => LIGHT_MEDIA.test(node.prelude));

describe('settings.html inline stylesheet', () => {
  test('braces balance', () => {
    expect(parseError && parseError.message).toBeNull();
    expect((css.match(/\{/g) || []).length).toBe((css.match(/\}/g) || []).length);
  });

  test('no top-level style rule contains nested rules', () => {
    // The stylesheet is flat: only at-rules (@media) group other rules. A style
    // rule that has grown children means an earlier rule lost its closing brace
    // and swallowed everything after it.
    const nested = topLevel
      .filter((node) => !isAtRule(node) && node.children.length > 0)
      .map((node) => `${node.prelude} (swallowed ${node.children.length} rules)`);
    expect(nested).toEqual([]);
  });

  test('the light-theme media query is a top-level rule', () => {
    expect(topLevel.map((node) => node.prelude)).toContain('@media (prefers-color-scheme: light)');
    // …and it still carries the palette it exists for.
    const root = lightBlock.children.find((node) => node.prelude === ':root');
    expect(root).toBeDefined();
    expect(declaration(root, '--bg')).toEqual(['#ffffff']);
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

  test('every hard-coded dark background has a light-theme override', () => {
    expect(lightBlock).toBeDefined();
    const overridden = new Set(
      lightBlock.children.filter((node) => !isAtRule(node)).flatMap(selectorsOf)
    );

    const missing = [];
    for (const node of topLevel) {
      if (isAtRule(node)) continue;
      const value = darkBackgroundValue(node);
      if (!value) continue;
      for (const selector of selectorsOf(node)) {
        if (!overridden.has(selector)) missing.push(`${selector} { background: ${value} }`);
      }
    }
    expect(missing).toEqual([]);
  });
});
