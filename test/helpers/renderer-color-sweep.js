/**
 * The colour-literal sweep over `src/renderer/`, shared by the guard
 * (`src/renderer/renderer-styles.test.js`) and by the script that regenerates
 * its inventory (`scripts/update-renderer-color-literals.js`).
 *
 * Both have to agree exactly on which files are swept, which are exempt and
 * what a "pair" is, or `npm run lint:colors -- --write` would produce an
 * inventory the guard immediately rejects.
 */

const fs = require('fs');
const path = require('path');

const { findColorLiterals, cssViewOfHtml } = require('./css-audit');

const RENDERER = path.resolve(__dirname, '..', '..', 'src', 'renderer');
const INVENTORY_FILE = path.join(RENDERER, 'renderer-color-literals.json');
const ISSUE = 'https://github.com/solardev-xyz/freedom-browser/issues/261';

// Directories with no hand-written renderer CSS in them: third-party bundles,
// binary assets, and the page-local scripts (which theme-tokens.test.js already
// sweeps for `var(--token, <colour>)` fallbacks).
const SKIP_DIRS = new Set(['vendor', 'assets', 'images', 'scripts']);

/**
 * The token files: the one place a colour literal is the *point*. #261 item 2
 * adds a shared internal-page theme file; both of the names it might take are
 * listed here already so that PR does not have to touch this guard.
 */
const TOKEN_FILES = new Set([
  'styles/variables.css',
  'styles/light-theme.css',
  'styles/private.css',
  'styles/theme.css',
  'pages/styles/theme.css',
]);

function sources(dir = RENDERER, out = []) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sources(full, out);
    } else if (/\.(css|html)$/.test(entry.name)) {
      out.push(path.relative(RENDERER, full).split(path.sep).join('/'));
    }
  }
  return out;
}

const read = (rel) => fs.readFileSync(path.join(RENDERER, rel), 'utf8');

/** The CSS in `rel`, with every non-CSS region blanked (offsets preserved). */
const cssOf = (rel) => (rel.endsWith('.html') ? cssViewOfHtml(read(rel)) : read(rel));

/** `property: literal` — the inventory's unit, and what a reviewer reads. */
const pairOf = (hit) => `${hit.property}: ${hit.literal}`;

/** Unannotated `property: literal` pairs in `rel`, mapped to their first line. */
function unannotatedPairs(rel) {
  const pairs = new Map();
  for (const hit of findColorLiterals(cssOf(rel))) {
    if (hit.annotated) continue;
    if (!pairs.has(pairOf(hit))) pairs.set(pairOf(hit), hit.line);
  }
  return pairs;
}

/** The inventory as it should be for the tree as it stands right now. */
function buildInventory() {
  const files = {};
  let total = 0;
  for (const rel of sources()) {
    if (TOKEN_FILES.has(rel)) continue;
    const pairs = [...unannotatedPairs(rel).keys()].sort();
    if (!pairs.length) continue;
    files[rel] = pairs;
    total += pairs.length;
  }
  return { issue: ISSUE, total, files };
}

module.exports = {
  RENDERER,
  INVENTORY_FILE,
  ISSUE,
  SKIP_DIRS,
  TOKEN_FILES,
  sources,
  read,
  cssOf,
  pairOf,
  unannotatedPairs,
  buildInventory,
};
