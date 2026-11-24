const { compareText, parsePatch, renderDocument, renderMarkdown } = require('./workspace-document');
const { createDocument } = require('../../../test/helpers/fake-dom');

describe('project document rendering', () => {
  beforeEach(() => { global.document = createDocument(); });
  afterEach(() => { delete global.document; });
  test('compares additions, deletions and unchanged lines with correct line numbers', () => {
    expect(compareText('one\ntwo\nthree', 'one\nnew\nthree')).toEqual([
      { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'deleted', text: 'two', oldLine: 2, newLine: null },
      { kind: 'added', text: 'new', oldLine: null, newLine: 2 },
      { kind: 'context', text: 'three', oldLine: 3, newLine: 3 },
    ]);
    expect(compareText('', 'new')[0]).toMatchObject({ kind: 'added', oldLine: null, newLine: 1 });
    expect(compareText('old', '')[0]).toMatchObject({ kind: 'deleted', oldLine: 1, newLine: null });
  });
  test('does not confuse diff headers or literal plus signs in unchanged content with changes', () => {
    const rows = parsePatch('--- a/x\n+++ b/x\n@@ -8,2 +9,2 @@\n +value\n-old\n+new\n');
    expect(rows[1].kind).toBe('meta');
    expect(rows[3]).toMatchObject({ kind: 'context', text: '+value', oldLine: 8, newLine: 9 });
    expect(rows[5]).toMatchObject({ kind: 'added', text: 'new', newLine: 10 });
  });
  test('bounds large comparisons and renders project HTML and markdown without executable elements', () => {
    const rows = compareText('old\n'.repeat(2000), '<script>x</script>\n'.repeat(2000));
    const host = document.createElement('div'); renderDocument(host, rows);
    expect(host.children.length).toBeLessThanOrEqual(2001);
    expect(host.querySelector('script')).toBeNull();
    renderMarkdown(host, '# Title\n<script>alert(1)</script>\n![image](https://example.test/x)');
    expect(host.querySelector('script')).toBeNull(); expect(host.querySelector('img')).toBeNull(); expect(host.querySelector('a')).toBeNull();
  });
  test('search reaches matching lines beyond the first rendered page', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ kind: 'context', text: i === 2500 ? 'needle' : 'ordinary', newLine: i + 1 }));
    const host = document.createElement('div'); renderDocument(host, rows, { query: 'needle' });
    expect(host.querySelectorAll('.workspace-code-text').flatMap(row => row.children).filter(child => child.tagName === 'MARK')).toHaveLength(1);
  });
  test('pairs removed/added lines in side-by-side comparisons', () => {
    const host = document.createElement('div'); renderDocument(host, compareText('before', 'after'), { split: true });
    expect(host.querySelectorAll('.workspace-code-pair')).toHaveLength(1);
    expect(host.querySelectorAll('.workspace-code-deleted')).toHaveLength(1);
    expect(host.querySelectorAll('.workspace-code-added')).toHaveLength(1);
  });
});
