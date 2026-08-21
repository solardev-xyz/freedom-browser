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

describe('escapeHtml', () => {
  test('escapes the text-context metacharacters', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  // The regression: a textContent -> innerHTML escaper leaves quotes intact,
  // and this page interpolates httpd-supplied names into data-path="…" on a
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
  // the real page against a hostile httpd fixture.)
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
