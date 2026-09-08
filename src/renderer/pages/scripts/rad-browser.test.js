/**
 * rad-browser page-script tests.
 *
 * The script is a classic (non-module) page script that runs `init()` at
 * load and touches DOM globals, so it can't just be `require()`d. These
 * tests extract the specific helper under test from the source and evaluate
 * it in isolation.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'rad-browser.js'), 'utf8');

/** Pull a top-level `const NAME = ...` / `function NAME(...)` out of the source. */
function loadHelpers(names) {
  const chunks = names.map((name) => {
    const constStart = SOURCE.indexOf(`const ${name} =`);
    const fnStart = SOURCE.indexOf(`function ${name}(`);
    const start = fnStart !== -1 ? fnStart : constStart;
    expect(start).toBeGreaterThanOrEqual(0);
    // Helpers are separated by a blank line at top level.
    const end = SOURCE.indexOf('\n\n', start);
    return SOURCE.slice(start, end === -1 ? undefined : end);
  });
  return new Function(`${chunks.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

const { escapeHtml } = loadHelpers(['HTML_ESCAPES', 'escapeHtml']);
const { parseViewerPath, serializeViewerPath } = loadHelpers([
  'FULL_REVISION_RE',
  'parseViewerPath',
  'serializeViewerPath',
]);
const { encodePathSegments } = loadHelpers(['encodePathSegments']);
const { buildViewerHref } = loadHelpers(['buildViewerHref']);
const { resolveRevision } = loadHelpers(['resolveRevision']);
const REVISION = '0123456789abcdef0123456789abcdef01234567';

describe('escapeHtml', () => {
  test('escapes the text-context metacharacters', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  // The regression: a textContent -> innerHTML escaper leaves quotes intact,
  // and this page interpolates repository-supplied names into data-path="…" on a
  // privileged internal page with full freedomAPI access.
  test('escapes quotes so attribute contexts cannot be broken out of', () => {
    expect(escapeHtml('pwn.md" onmouseover="alert(1)')).toBe(
      'pwn.md&quot; onmouseover=&quot;alert(1)'
    );
    expect(escapeHtml("pwn.md' onmouseover='alert(1)")).toBe(
      'pwn.md&#39; onmouseover=&#39;alert(1)'
    );
  });

  // No renderable metacharacter may survive, whichever context the caller
  // interpolates into. (The rendered-DOM side of this is covered by driving
  // the real page against a hostile repository fixture.)
  test('output carries no raw HTML metacharacters', () => {
    const hostile = `x" onmouseover="alert(1)" y='<b>&</b>'`;
    expect(escapeHtml(hostile)).not.toMatch(/["'<>]/);
    expect(escapeHtml(hostile)).toBe(
      'x&quot; onmouseover=&quot;alert(1)&quot; y=&#39;&lt;b&gt;&amp;&lt;/b&gt;&#39;'
    );
  });

  test('nullish input yields an empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('historical revision routing', () => {
  test('extracts full commit ids from tree and blob routes', () => {
    expect(parseViewerPath(`/tree/${REVISION}/src/main.rs`)).toEqual({
      logicalPath: 'tree/src/main.rs',
      revision: REVISION,
    });
    expect(parseViewerPath(`blob/${REVISION}/README.md`)).toEqual({
      logicalPath: 'blob/README.md',
      revision: REVISION,
    });
    expect(parseViewerPath(`tree/${REVISION}`)).toEqual({ logicalPath: '', revision: REVISION });
  });

  test('does not interpret branch names or abbreviated hashes as revisions', () => {
    expect(parseViewerPath('tree/main/src')).toEqual({
      logicalPath: 'tree/main/src',
      revision: null,
    });
    expect(parseViewerPath('tree/0123456/src')).toEqual({
      logicalPath: 'tree/0123456/src',
      revision: null,
    });
  });

  test('keeps subsequent navigation pinned to the selected revision', () => {
    expect(serializeViewerPath('', REVISION)).toBe(`tree/${REVISION}`);
    expect(serializeViewerPath('tree/src', REVISION)).toBe(`tree/${REVISION}/src`);
    expect(serializeViewerPath('blob/README.md', REVISION)).toBe(`blob/${REVISION}/README.md`);
    expect(serializeViewerPath('tree/src', null)).toBe('tree/src');
  });
});

describe('encodePathSegments', () => {
  // The main-process boundary decodeURIComponent()s each segment and 400s on
  // an invalid escape, so an unencoded `%` in a legitimate file name made the
  // viewer show "Failed to load file" for a file that exists.
  test('encodes names the API boundary would otherwise reject or truncate', () => {
    expect(encodePathSegments('100%.md')).toBe('100%25.md');
    expect(encodePathSegments('docs/notes#1.md')).toBe('docs/notes%231.md');
    expect(encodePathSegments('docs/a?b.txt')).toBe('docs/a%3Fb.txt');
    expect(encodePathSegments('src/lib/ünïcode.rs')).toBe('src/lib/%C3%BCn%C3%AFcode.rs');
  });

  test('keeps the segment separators and drops empty segments', () => {
    expect(encodePathSegments('src/main.rs')).toBe('src/main.rs');
    expect(encodePathSegments('/src//main.rs/')).toBe('src/main.rs');
    expect(encodePathSegments('')).toBe('');
    expect(encodePathSegments(null)).toBe('');
  });

  // Traversal segments stay verbatim: the main-process boundary is what
  // rejects them (encoding them here would smuggle them past that check).
  test('does not encode dot segments into something the boundary would accept', () => {
    expect(encodePathSegments('../secret')).toBe('../secret');
    expect(encodePathSegments('a/./b')).toBe('a/./b');
  });
});

describe('buildViewerHref', () => {
  const BASE = 'radapi://local';

  test('builds the internal viewer URL for a well-formed RID', () => {
    const href = buildViewerHref('z3gqcJUoA1n9HaHKufZs5FCSGazv5', BASE);
    const url = new URL(href, 'file:///app/src/renderer/pages/');
    expect(url.searchParams.get('rid')).toBe('z3gqcJUoA1n9HaHKufZs5FCSGazv5');
    expect(url.searchParams.get('base')).toBe(BASE);
  });

  // A seed node is untrusted input: an `&base=` smuggled through the RID
  // used to win URLSearchParams.get() and repoint this privileged page's
  // API reads at the attacker's origin.
  test('neutralizes a hostile RID that tries to inject its own base', () => {
    const href = buildViewerHref('zabc&base=https://evil.example', BASE);
    const url = new URL(href, 'file:///app/src/renderer/pages/');
    expect(url.searchParams.get('base')).toBe(BASE);
    expect(url.searchParams.get('rid')).toBe('zabc&base=https://evil.example');
    expect(url.searchParams.getAll('base')).toEqual([BASE]);
  });

  test('neutralizes hostile RIDs that try to add a fragment or extra params', () => {
    for (const hostile of ['zabc#/x', 'zabc?base=https://evil.example', 'zabc&status=offline']) {
      const url = new URL(buildViewerHref(hostile, BASE), 'file:///app/src/renderer/pages/');
      expect(url.searchParams.get('base')).toBe(BASE);
      expect(url.searchParams.get('status')).toBeNull();
      expect(url.hash).toBe('');
    }
  });
});

describe('resolveRevision', () => {
  test('a pinned object id wins over the repository head', () => {
    expect(resolveRevision('aaaa', REVISION)).toEqual({ sha: REVISION, pinned: true });
  });

  // The regression: the "no head → No commit history found" bail-out ran
  // before the deep link was parsed, so a valid pinned OID could not rescue
  // a repo whose head is unresolvable.
  test('a pinned object id serves a repo with no resolvable head', () => {
    expect(resolveRevision(null, REVISION)).toEqual({ sha: REVISION, pinned: true });
    expect(resolveRevision(undefined, REVISION)).toEqual({ sha: REVISION, pinned: true });
  });

  test('falls back to the repository head, unpinned, without a deep link', () => {
    expect(resolveRevision('aaaa', null)).toEqual({ sha: 'aaaa', pinned: false });
    expect(resolveRevision(null, null)).toEqual({ sha: null, pinned: false });
  });
});
