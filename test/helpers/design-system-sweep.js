/**
 * The design system's ratchet (#1198): what the renderer still does outside
 * the shared tokens and blocks, recorded per file so it can only shrink.
 *
 * Four things are recorded, each as a sorted list per file:
 *
 *   legacyClasses  button-, card-, badge-, callout- and field-like classes a
 *                  stylesheet styles itself (padding, height, radius, fill or
 *                  border) instead of using a `ui-` block from ui.css;
 *   oldTokens      token names a file paints from that tokens.css does not
 *                  define: the chrome's renamed ones (`--toolbar`, `--muted`…),
 *                  the internal pages' palette (`--shell-*`, `--bg-card`…) and
 *                  the names sidebar.css used without any definition;
 *   literalSizes   `font-size` and `border-radius` written as a length rather
 *                  than a `--font-size-*` or `--radius-*` token;
 *   bareOutlines   selectors that remove the focus outline without drawing a
 *                  ring of their own.
 *
 * The Agent UI is outside all four: its stream owns that look and adopts the
 * shared tokens when it chooses, so the Agent's stylesheets and `agent-`
 * classes are not swept.
 *
 * `src/renderer/design-system.test.js` compares the tree with
 * `src/renderer/design-system-inventory.json` both ways, and
 * `npm run ui:inventory` rewrites the file after a migration removed entries.
 */
const fs = require('fs');
const path = require('path');
const { RENDERER, sources, cssOf, TOKEN_FILES } = require('./renderer-color-sweep');

const INVENTORY_FILE = path.join(RENDERER, 'design-system-inventory.json');
const ISSUE = 'https://github.com/solardev-xyz/freedom-browser/issues/1198';

const TOKENS_FILE = 'pages/styles/tokens.css';
const BLOCKS_FILE = 'pages/styles/ui.css';
// The catalog is the blocks' own demo page: it uses them and nothing else.
const CATALOG_FILE = 'pages/ui-catalog.html';

const AGENT_FILES = new Set([
  'styles/agent.css',
  'styles/agent-floating.css',
  'styles/agent-privacy.css',
  'styles/agent-dictation.css',
  'pages/styles/ai.css',
]);
const isAgentClass = (name) => /^agent-|^ai-/.test(name);
/** A selector (one comma part) that names an Agent class anywhere. */
/**
 * A selector (one comma part) that targets the Agent: it names an Agent
 * class positively, as the element or an ancestor. A class inside `:not()`
 * is the opposite (`.save-btn:not(.agent-skip)` paints every non-Agent
 * button), so negations are dropped before looking.
 */
const isAgentSelector = (selector) =>
  [...selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '').matchAll(/\.([\w-]+)/g)].some(
    ([, name]) => isAgentClass(name)
  );

/** The files the ratchet sweeps: every renderer stylesheet and page. */
const sweptSources = () =>
  sources().filter(
    (rel) =>
      !TOKEN_FILES.has(rel) && rel !== BLOCKS_FILE && rel !== CATALOG_FILE && !AGENT_FILES.has(rel)
  );

/**
 * Flat `selector { body }` rules, comments removed; a nested at-rule's rules
 * come out flat. Split on `}` rather than matched with one regex: an HTML
 * page's CSS view (cssOf) is mostly blanked markup, and a `[^{}]+\{` pattern
 * backtracks quadratically over such brace-free stretches.
 */
function rulesOf(css) {
  const rules = [];
  for (const chunk of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const open = chunk.lastIndexOf('{');
    if (open < 0) continue;
    const before = chunk.slice(0, open);
    const start = Math.max(before.lastIndexOf('{'), before.lastIndexOf(';')) + 1;
    const selector = before.slice(start).trim().replace(/\s+/g, ' ');
    if (selector && !selector.startsWith('@'))
      rules.push({ selector, body: chunk.slice(open + 1) });
  }
  return rules;
}

/**
 * Inline `style` attributes in an HTML source, as rules: the element's tag
 * and classes with a `[style]` marker for a selector, its declarations for a
 * body. cssOf() keeps these declarations but without any selector, so the
 * block, size and outline sweeps would not see them otherwise.
 */
// One attribute: a name, then optionally `=` and a double-quoted,
// single-quoted or unquoted value. Quote-aware, so a `>` inside a quoted
// value does not end the tag.
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TAG =
  /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;

function inlineRules(html) {
  const rules = [];
  for (const [, tag, rawAttrs] of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(TAG)) {
    const attrs = {};
    for (const [, name, double, single, bare] of rawAttrs.matchAll(ATTRIBUTE)) {
      attrs[name.toLowerCase()] = double ?? single ?? bare ?? '';
    }
    if (!attrs.style) continue;
    const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
    rules.push({
      selector: `${tag.toLowerCase()}${classes.map((name) => `.${name}`).join('')}[style]`,
      body: attrs.style,
      inline: true,
    });
  }
  return rules;
}

/**
 * Every rule a source declares: its stylesheet rules and, for a page, its
 * inline `style` attributes. Rules every selector of which names an Agent
 * class are left out: the Agent is outside the ratchet.
 */
function rulesFor(rel) {
  const rules = [...rulesOf(cssOf(rel))];
  if (rel.endsWith('.html'))
    rules.push(...inlineRules(fs.readFileSync(path.join(RENDERER, rel), 'utf8')));
  return withoutAgent(rules);
}

const withoutAgent = (rules) =>
  rules.filter((rule) => !rule.selector.split(',').every((part) => isAgentSelector(part)));

/** A css string (the self-tests) or rules already read. */
const asRules = (input) => (typeof input === 'string' ? withoutAgent(rulesOf(input)) : input);

const declaration = (body, property) => {
  const match = body.match(new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`));
  return match ? match[1].trim() : null;
};

/** The last compound of `selector`: the element the rule paints. */
const lastCompound = (selector) =>
  selector
    .split(/\s+|>|\+|~/)
    .filter(Boolean)
    .pop() || '';

/** The class names in the last compound of `selector`. */
const paintedClasses = (selector) =>
  [...lastCompound(selector).matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);

// A control styled by its element type rather than a class name.
const CONTROL_ELEMENT = /^(button|input|select|textarea)\b/i;

const BLOCK_LIKE =
  /(^|-)(btn|button|card|details|panel|box|banner|notice|callout|badge|pill|chip|tag|input|field|select|textarea)(-|$)/;
const BLOCK_STYLING =
  /(^|;)\s*(padding|height|min-height|border-radius|background|background-color|border)\s*:/;

/**
 * Button-, card-, badge- and field-like classes a source styles itself, and
 * controls it styles by element type (`button.save`, `input[type='text']`),
 * which the class names alone would miss.
 */
function legacyClasses(input) {
  const found = new Set();
  for (const rule of asRules(input)) {
    if (!BLOCK_STYLING.test(rule.body)) continue;
    for (const part of rule.selector.split(',')) {
      if (isAgentSelector(part)) continue;
      const names = paintedClasses(part);
      if (names.some((name) => name.startsWith('ui-'))) continue;
      for (const name of names) if (BLOCK_LIKE.test(name)) found.add(name);
      const last = lastCompound(part).replace(/:[\w-]+(\([^)]*\))?/g, '');
      if (CONTROL_ELEMENT.test(last)) found.add(last);
    }
  }
  return [...found].sort();
}

// The names sidebar.css used without any definition. tokens.css defines them
// as aliases until the sidebar migrates; they are old names all the same.
const LEGACY_ALIASES = [
  '--foreground',
  '--foreground-muted',
  '--background',
  '--hover',
  '--toolbar-hover',
  '--border-hover',
  '--text-inverse',
];

const definedIn = (css) =>
  new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

/**
 * The names a migrated screen must no longer paint from: everything the old
 * token files define, plus the names sidebar.css used undefined, less what
 * tokens.css defines under the same name. The Agent's tokens and the
 * stacking order (`--z-*`) are not palette names.
 */
function oldTokenNames() {
  const read = (rel) => fs.readFileSync(path.join(RENDERER, rel), 'utf8');
  const current = definedIn(read(TOKENS_FILE));
  for (const alias of LEGACY_ALIASES) current.delete(alias);
  const old = new Set([
    ...definedIn(read('styles/variables.css')),
    ...definedIn(read('pages/styles/theme.css')),
    ...LEGACY_ALIASES,
  ]);
  return new Set(
    [...old].filter(
      (name) => !current.has(name) && !name.startsWith('--agent-') && !name.startsWith('--z-')
    )
  );
}

function oldTokens(input, names) {
  const used = new Set();
  for (const rule of asRules(input)) {
    for (const [, name] of rule.body.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (names.has(name)) used.add(name);
    }
  }
  return [...used].sort();
}

// A length on the type or radius scale; keywords, percentages, `em` and
// `var()` are not (a 50% radius is a circle, not a size).
const SIZE_LITERAL = /^-?\d*\.?\d+(px|rem)$/;

function literalSizes(input) {
  const found = new Set();
  for (const rule of asRules(input)) {
    for (const property of ['font-size', 'border-radius']) {
      const value = declaration(rule.body, property);
      if (!value) continue;
      const parts = value
        .replace(/!important/, '')
        .trim()
        .split(/\s+/);
      if (parts.some((part) => SIZE_LITERAL.test(part))) {
        found.add(`${property}: ${value}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * The value `property` ends up with in one declaration block: the last
 * `!important` declaration if there is one, else the last declaration.
 * `outline: none !important; outline: 2px solid` removes the outline.
 */
function effectiveValue(body, property) {
  let normal = null;
  let important = null;
  for (const raw of body.split(';')) {
    const colon = raw.indexOf(':');
    if (colon < 0 || raw.slice(0, colon).trim().toLowerCase() !== property) continue;
    const value = raw.slice(colon + 1).trim();
    if (/!\s*important$/i.test(value)) important = value.replace(/!\s*important$/i, '').trim();
    else normal = value;
  }
  return important ?? normal;
}

// A ring: an outline or a box-shadow that draws something. An
// `outline-color` alone does not, while the outline's style is none.
const removesOutline = (body) => /^(none|0)$/.test(effectiveValue(body, 'outline') ?? '');
const drawsRing = (body) => {
  const outline = effectiveValue(body, 'outline');
  const shadow = effectiveValue(body, 'box-shadow');
  return (
    (outline !== null && !/^(none|0)$/.test(outline)) || (shadow !== null && shadow !== 'none')
  );
};
const withoutFocus = (selector) => selector.replace(/:focus(-visible|-within)?/g, '').trim();

/**
 * Selectors that remove the outline while no rule for the same selector in
 * the same file draws a ring. Candidates, not proven bugs: a chrome field
 * that drops its outline at rest still gets the shared ring from inputs.css's
 * element rules, so each entry is checked when its screen migrates.
 */
function bareOutlines(input) {
  const rules = asRules(input);
  const ringed = new Set();
  for (const rule of rules) {
    if (!drawsRing(rule.body)) continue;
    for (const part of rule.selector.split(',')) {
      if (/:focus/.test(part)) ringed.add(withoutFocus(part.trim()));
    }
  }
  const found = new Set();
  for (const rule of rules) {
    if (!removesOutline(rule.body) || drawsRing(rule.body)) continue;
    for (const part of rule.selector.split(',')) {
      const selector = part.trim();
      if (isAgentSelector(selector)) continue;
      if (!ringed.has(withoutFocus(selector))) found.add(selector);
    }
  }
  return [...found].sort();
}

/** The inventory as it should be for the tree as it stands right now. */
function buildInventory() {
  const names = oldTokenNames();
  const sections = { legacyClasses: {}, oldTokens: {}, literalSizes: {}, bareOutlines: {} };
  for (const rel of sweptSources()) {
    const rules = rulesFor(rel);
    const found = {
      legacyClasses: legacyClasses(rules),
      oldTokens: oldTokens(rules, names),
      literalSizes: literalSizes(rules),
      bareOutlines: bareOutlines(rules),
    };
    for (const [section, entries] of Object.entries(found)) {
      if (entries.length) sections[section][rel] = entries;
    }
  }
  const totals = Object.fromEntries(
    Object.entries(sections).map(([section, files]) => [
      section,
      Object.values(files).reduce((sum, entries) => sum + entries.length, 0),
    ])
  );
  return { issue: ISSUE, totals, ...sections };
}

const SECTIONS = ['legacyClasses', 'oldTokens', 'literalSizes', 'bareOutlines'];

/** Entries in `actual` missing from `recorded`, and the other way round. */
function compare(recorded, actual) {
  const added = [];
  const removed = [];
  for (const section of SECTIONS) {
    const before = recorded[section] || {};
    const now = actual[section] || {};
    for (const rel of new Set([...Object.keys(before), ...Object.keys(now)])) {
      const was = new Set(before[rel] || []);
      const is = new Set(now[rel] || []);
      for (const entry of is) if (!was.has(entry)) added.push(`${section} ${rel}: ${entry}`);
      for (const entry of was) if (!is.has(entry)) removed.push(`${section} ${rel}: ${entry}`);
    }
  }
  return { added: added.sort(), removed: removed.sort() };
}

module.exports = {
  INVENTORY_FILE,
  ISSUE,
  TOKENS_FILE,
  BLOCKS_FILE,
  CATALOG_FILE,
  AGENT_FILES,
  LEGACY_ALIASES,
  SECTIONS,
  rulesOf,
  inlineRules,
  rulesFor,
  declaration,
  paintedClasses,
  definedIn,
  legacyClasses,
  oldTokenNames,
  oldTokens,
  literalSizes,
  bareOutlines,
  sweptSources,
  buildInventory,
  compare,
};
