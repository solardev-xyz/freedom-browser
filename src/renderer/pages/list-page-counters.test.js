// The three internal list pages (History, Downloads, Payments) each show a
// `<p class="subtitle" id="stats">` counter. They used to disagree three ways:
// Payments pluralised and showed `N of M` while a filter was active, History
// rendered `1 entries`, Downloads rendered `1 downloads`, and neither of the
// two moved at all when the user typed in the search box (#254).
//
// The pages' CSP is `script-src 'unsafe-inline'`, so they cannot import
// src/renderer/lib/ui-format.js; each carries an inline copy of `formatCount`.
// This suite is the drift guard for those copies: identical to each other, and
// behaving exactly like the shared helper.

import fs from 'node:fs';
import path from 'node:path';
import { formatCount } from '../lib/ui-format.js';

const PAGES = ['history.html', 'downloads.html', 'payments.html'];

function readPage(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

// Pull `function formatCount(...) { ... }` out of a page's inline script.
function extractFormatCount(source) {
  const match = source.match(/ {6}function formatCount\([\s\S]*?\n {6}\}\n/);
  if (!match) throw new Error('inline formatCount not found');
  return match[0];
}

function compileFormatCount(source) {
  return new Function(`${extractFormatCount(source)}; return formatCount;`)();
}

const COPIES = Object.fromEntries(PAGES.map((page) => [page, readPage(page)]));

describe('inline formatCount copies', () => {
  test('every list page carries one', () => {
    for (const page of PAGES) {
      expect(() => extractFormatCount(COPIES[page])).not.toThrow();
    }
  });

  test('the copies are byte-identical to each other', () => {
    const sources = PAGES.map((page) => extractFormatCount(COPIES[page]));
    expect(new Set(sources).size).toBe(1);
  });

  test.each(PAGES)('%s behaves exactly like lib/ui-format.js', (page) => {
    const inline = compileFormatCount(COPIES[page]);
    for (const total of [0, 1, 2, 12]) {
      for (let shown = 0; shown <= total; shown += 1) {
        for (const noun of ['page', 'download', 'payment']) {
          expect(inline(shown, total, noun)).toBe(formatCount(shown, total, noun));
        }
      }
    }
    expect(inline(1, 5, 'entry', 'entries')).toBe(formatCount(1, 5, 'entry', 'entries'));
  });

  test('pluralises a one-item list (#254)', () => {
    const inline = compileFormatCount(COPIES['history.html']);
    expect(inline(1, 1, 'page')).toBe('1 page');
    expect(inline(1, 1, 'download')).toBe('1 download');
    expect(inline(1, 1, 'payment')).toBe('1 payment');
    expect(inline(1, 1, 'page')).not.toBe('1 pages');
  });
});

describe('how each page calls it', () => {
  test('history counts pages, not generic "entries"', () => {
    expect(COPIES['history.html']).toMatch(
      /statsEl\.textContent = formatCount\([^)]*allHistory\.length, 'page'\)/
    );
    expect(COPIES['history.html']).not.toContain('${allHistory.length} entries');
  });

  test('downloads counts downloads and keeps its "in progress" suffix', () => {
    expect(COPIES['downloads.html']).toMatch(
      /formatCount\(shown, allDownloads\.length, 'download'\)/
    );
    expect(COPIES['downloads.html']).toContain('in progress');
    expect(COPIES['downloads.html']).not.toContain('${allDownloads.length} downloads');
  });

  test('payments keeps the behaviour the other two adopted', () => {
    expect(COPIES['payments.html']).toMatch(
      /statsEl\.textContent = formatCount\(filtered\.length, payments\.length, 'payment'\)/
    );
  });

  test('history and downloads recount on every render, so filtering moves them', () => {
    // The bug was that both wrote the counter once, in their load function,
    // and never again — so typing in the search box left it stale.
    for (const page of ['history.html', 'downloads.html']) {
      const render = COPIES[page].match(
        /function render(?:History|Downloads)\(entries\) \{\n(.*)\n/
      );
      expect(render).not.toBeNull();
      expect(render[1]).toMatch(/formatCount|updateStats/);
    }
  });
});
