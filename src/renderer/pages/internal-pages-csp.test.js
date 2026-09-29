/**
 * CSP guard for every internal page (`src/renderer/pages/*.html`), #432.
 *
 * Internal pages run in a `<webview>` with the privileged `freedomAPI` bridge,
 * and history, downloads and payments render site-controlled strings (titles,
 * URLs, filenames). So no internal page may run inline script: every page's
 * `<meta>` CSP must keep `'unsafe-inline'` (and `'unsafe-eval'`) out of the
 * directive that governs scripts, and must pin `base-uri`, `object-src` and
 * `form-action` to `'none'`. Pages load their code as `<script src>` files
 * from `scripts/` instead.
 *
 * Dropping `'unsafe-inline'` also silently kills any inline code a page still
 * carries — the page just stops working — so the markup and the page scripts
 * are swept for inline `<script>` bodies, `on*=` handler attributes (including
 * ones built into an HTML string at runtime) and `javascript:` URLs too.
 */

const fs = require('node:fs');
const path = require('node:path');

const PAGES_DIR = __dirname;
const SCRIPTS_DIR = path.join(PAGES_DIR, 'scripts');

const PAGES = fs
  .readdirSync(PAGES_DIR)
  .filter((name) => name.endsWith('.html'))
  .sort();

const PAGE_SCRIPTS = fs
  .readdirSync(SCRIPTS_DIR)
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
  .sort();

const read = (file) => fs.readFileSync(file, 'utf8');

// Drop HTML comments so commented-out markup can't satisfy or trip a check.
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

// Every `<meta http-equiv="Content-Security-Policy" content="…">` on a page,
// attribute order and quoting tolerated.
function cspMetas(html) {
  const metas = [];
  for (const [tag] of stripHtmlComments(html).matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*(["'])content-security-policy\1/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    metas.push(content ? (content[1] ?? content[2]) : '');
  }
  return metas;
}

// `{ directive: [sources…] }`, directive names lower-cased. A repeated
// directive is ignored by the browser, so only the first one counts.
function parseCsp(policy) {
  const directives = {};
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!(key in directives)) directives[key] = sources.map((s) => s.toLowerCase());
  }
  return directives;
}

// The sources that actually govern each script context, per CSP3 fallback:
// `script-src-elem` / `script-src-attr` fall back to `script-src`, which falls
// back to `default-src`. With none of them the page may run anything.
function effectiveScriptSources(directives) {
  const base = directives['script-src'] ?? directives['default-src'] ?? null;
  return {
    'script-src (elements)': directives['script-src-elem'] ?? base,
    'script-src (attributes)': directives['script-src-attr'] ?? base,
  };
}

// Inline `<script>` elements: any `<script>` with no `src` attribute, or with a
// body. JSON data blocks are not executed and stay allowed.
function inlineScripts(html) {
  const found = [];
  for (const match of stripHtmlComments(html).matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  )) {
    const [, attrs, body] = match;
    if (/\btype\s*=\s*(["'])application\/(ld\+)?json\1/i.test(attrs)) continue;
    if (!/\bsrc\s*=/.test(attrs) || body.trim() !== '') found.push(match[0].slice(0, 80));
  }
  return found;
}

// `on<event>=` attributes inside a tag, whether in page markup or in an HTML
// string a script builds (`<button onclick="…">`, `onerror=x`).
const HANDLER_ATTR = /<[a-z][^>]*?\son[a-z]+\s*=/gi;
// `javascript:` in a URL-bearing attribute, quoted or not.
const JAVASCRIPT_URL = /\b(?:href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*javascript:/gi;

describe('internal page CSP (#432)', () => {
  test('the sweep sees every page and page script', () => {
    // Guard the guard: an empty directory listing would pass everything.
    expect(PAGES).toEqual(
      expect.arrayContaining(['settings.html', 'history.html', 'downloads.html', 'error.html'])
    );
    expect(PAGES.length).toBeGreaterThanOrEqual(15);
    expect(PAGE_SCRIPTS).toEqual(expect.arrayContaining(['settings.js', 'history.js']));
  });

  test.each(PAGES)('%s declares exactly one CSP', (page) => {
    expect(cspMetas(read(path.join(PAGES_DIR, page)))).toHaveLength(1);
  });

  test.each(PAGES)('%s allows no inline or eval script', (page) => {
    const [policy] = cspMetas(read(path.join(PAGES_DIR, page)));
    const directives = parseCsp(policy);
    for (const [context, sources] of Object.entries(effectiveScriptSources(directives))) {
      // No script directive at all means no restriction on script.
      expect({ page, context, sources }).toEqual({
        page,
        context,
        sources: expect.any(Array),
      });
      for (const banned of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", '*', 'data:']) {
        expect({ page, context, has: banned, sources }).not.toEqual(
          expect.objectContaining({ sources: expect.arrayContaining([banned]) })
        );
      }
    }
  });

  test.each(PAGES)("%s pins base-uri, object-src and form-action to 'none'", (page) => {
    const [policy] = cspMetas(read(path.join(PAGES_DIR, page)));
    const directives = parseCsp(policy);
    expect({
      page,
      'base-uri': directives['base-uri'],
      'object-src': directives['object-src'],
      'form-action': directives['form-action'],
    }).toEqual({
      page,
      'base-uri': ["'none'"],
      'object-src': ["'none'"],
      'form-action': ["'none'"],
    });
  });

  test.each(PAGES)('%s carries no inline script, handler or javascript: URL', (page) => {
    const html = stripHtmlComments(read(path.join(PAGES_DIR, page)));
    expect(inlineScripts(html)).toEqual([]);
    expect(html.match(HANDLER_ATTR) || []).toEqual([]);
    expect(html.match(JAVASCRIPT_URL) || []).toEqual([]);
  });

  test.each(PAGES)('%s only loads scripts that exist, from its own tree', (page) => {
    const html = stripHtmlComments(read(path.join(PAGES_DIR, page)));
    for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      expect(src).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(fs.existsSync(path.resolve(PAGES_DIR, src))).toBe(true);
    }
  });

  test.each(PAGE_SCRIPTS)('scripts/%s builds no inline handler or javascript: URL', (file) => {
    const source = read(path.join(SCRIPTS_DIR, file));
    expect(source.match(HANDLER_ATTR) || []).toEqual([]);
    expect(source.match(JAVASCRIPT_URL) || []).toEqual([]);
  });
});

describe('the CSP guard itself', () => {
  const page = (csp, body = '') =>
    `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}" /></head><body>${body}</body></html>`;
  const scriptSources = (html) => effectiveScriptSources(parseCsp(cspMetas(html)[0]));

  test("sees 'unsafe-inline' through the default-src fallback", () => {
    const sources = scriptSources(page("default-src 'self' 'unsafe-inline'"));
    expect(sources['script-src (elements)']).toContain("'unsafe-inline'");
    expect(sources['script-src (attributes)']).toContain("'unsafe-inline'");
  });

  test("sees 'unsafe-inline' on script-src-attr even when script-src is clean", () => {
    const sources = scriptSources(page("script-src 'self'; script-src-attr 'unsafe-inline'"));
    expect(sources['script-src (attributes)']).toContain("'unsafe-inline'");
  });

  test('reports a page with no script restriction at all', () => {
    expect(scriptSources(page("style-src 'self'"))['script-src (elements)']).toBeNull();
  });

  test('finds inline scripts and handlers in any shape', () => {
    expect(inlineScripts('<script>alert(1)</script>')).toHaveLength(1);
    expect(inlineScripts('<script type="module">x()</script>')).toHaveLength(1);
    expect(inlineScripts('<script src="a.js">x()</script>')).toHaveLength(1);
    expect(inlineScripts('<script src="a.js"></script>')).toEqual([]);
    expect(inlineScripts('<!-- <script>x()</script> -->')).toEqual([]);
    expect('<button onclick="go()">'.match(HANDLER_ATTR)).toHaveLength(1);
    expect('<img\n  src="x"\n  onerror="\n  a()\n  "\n/>'.match(HANDLER_ATTR)).toHaveLength(1);
    expect('`<img src=x onerror=${f}>`'.match(HANDLER_ATTR)).toHaveLength(1);
    expect('<a href="javascript:void(0)">'.match(JAVASCRIPT_URL)).toHaveLength(1);
    expect('<a href=javascript:x>'.match(JAVASCRIPT_URL)).toHaveLength(1);
    // Not handlers: a data attribute, prose, and `button.onclick = …` in JS.
    expect('<button data-onclick="x">'.match(HANDLER_ATTR)).toBeNull();
    expect('<p>click on it</p>'.match(HANDLER_ATTR)).toBeNull();
    expect("document.getElementById('b').onclick = () => {};".match(HANDLER_ATTR)).toBeNull();
  });
});
