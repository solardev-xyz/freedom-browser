// Guards for the *native* menu's user-facing copy conventions.
//
// The sibling of src/renderer/renderer-copy.test.js, one process over. The
// native application menu (src/main/menu.js, plus the update row labelled by
// src/main/updater.js) names the same actions as the in-app hamburger flyout,
// so the two drift as a pair: #257 moved every renderer string to U+2026 and
// left `Check for Updates...` sitting in the macOS menu bar next to the
// flyout's `Check for Updates…`. The renderer guard walks only src/renderer
// and structurally cannot see that, so the same convention is asserted here.

const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname);
const RENDERER = path.join(__dirname, '..', 'renderer');

// Every first-party main-process source file.
function mainSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        out.push(full);
      }
    }
  };
  walk(MAIN);
  return out.sort();
}

const rel = (file) => path.relative(path.join(__dirname, '..', '..'), file);
const read = (file) => fs.readFileSync(file, 'utf8');

const SOURCES = mainSources();

// ---------------------------------------------------------------------------
// #257 — one ellipsis character
// ---------------------------------------------------------------------------

// Scoped to the labels of clickable controls, which is the whole drift class:
// a main-process file is also full of `log.info('… trying next...')` lines and
// of literal encoding prefixes (`bafy...`, `k51...` in ipfs-protocol.js), and
// neither is copy a user ever reads as prose.
const CONTROL_LABEL =
  /\b(label|menuLabel|actionLabel|buttonLabel|checkboxLabel)\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g;

function asciiEllipsisLabels(source, file) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(CONTROL_LABEL)) {
      if (match[3].includes('...')) {
        hits.push(`${rel(file)}:${index + 1}: ${match[1]}: ${match[3]}`);
      }
    }
  });
  return hits;
}

describe('native menu ellipsis character (#257)', () => {
  test('no menu or button label uses three ASCII dots', () => {
    const hits = SOURCES.flatMap((file) => asciiEllipsisLabels(read(file), file));
    expect(hits).toEqual([]);
  });

  test('the detector reads label values, not every line with dots in it', () => {
    // Mutation check: without this, the guard above could be passing because
    // it silently matches nothing.
    const fake = '/tmp/fake.js';
    expect(asciiEllipsisLabels("log.info('[Tor] Force killing arti...');\n", fake)).toEqual([]);
    expect(asciiEllipsisLabels("const hint = 'publish it in bafy... form';\n", fake)).toEqual([]);
    expect(asciiEllipsisLabels("  label: 'Find in Page…',\n", fake)).toEqual([]);
    expect(asciiEllipsisLabels("  label: 'Find in Page...',\n", fake)).toHaveLength(1);
    expect(
      asciiEllipsisLabels("    menuLabel: 'Install Update and Close...',\n", fake)
    ).toHaveLength(1);
  });

  test('the labels the native menu shares with the app chrome are identical', () => {
    const menu = read(path.join(MAIN, 'menu.js'));
    const chrome = read(path.join(RENDERER, 'index.html'));
    // Same action, two surfaces: the menu bar and the hamburger flyout. These
    // must match character for character, ellipsis included.
    for (const label of ['Create Profile…', 'Manage Profiles…', 'Check for Updates…']) {
      expect(menu).toContain(label);
      expect(chrome).toContain(label);
    }
    // Find in Page has no flyout twin, but follows the same convention.
    expect(menu).toContain('Find in Page…');
  });

  test('the update row labels follow the convention too', () => {
    const updater = read(path.join(MAIN, 'updater.js'));
    expect(updater).toContain('Install Update and Restart…');
    expect(updater).toContain('Install Update and Close…');
  });
});
