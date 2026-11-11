// The `markdown:get-view` answer (#1035): the scripts a tab renders Markdown
// with, and the theme it opens in. The sources are evaluated here exactly as
// the preload does it, so a vendored bundle that stops exporting itself to
// `exports` / `module` fails this rather than every Markdown page.

const {
  READER_POLICY,
  makeMarkdownViewHandler,
  getMarkdownViewSources,
  markdownDocumentHeaders,
} = require('./markdown-view');

function evaluateLikeThePreload(source) {
  const module = { exports: {} };
  new Function('exports', 'module', 'define', source)(module.exports, module, undefined);
  return module.exports;
}

describe('markdown:get-view', () => {
  test('answers with the three sources and the Appearance setting', () => {
    const answer = makeMarkdownViewHandler({ loadSettings: () => ({ theme: 'light' }) })();
    expect(answer.theme).toBe('light');
    expect(answer.marked).toBe(getMarkdownViewSources().marked);
    expect(answer.purify).toBe(getMarkdownViewSources().purify);
    expect(answer.view).toBe(getMarkdownViewSources().view);
  });

  test.each([
    ['no theme set', () => ({})],
    [
      'unreadable settings',
      () => {
        throw new Error('EACCES');
      },
    ],
  ])('follows the system scheme with %s', (_label, loadSettings) => {
    expect(makeMarkdownViewHandler({ loadSettings })().theme).toBe('system');
  });

  test('each source hands its API back to the preload without globals', () => {
    const { marked, purify, view } = getMarkdownViewSources();
    const before = Object.keys(globalThis).length;

    const markedApi = evaluateLikeThePreload(marked);
    expect(typeof markedApi.Marked).toBe('function');
    // Without a DOM (here, in Node) DOMPurify comes back as its factory; in
    // the tab it binds itself to the page's window.
    const purifyApi = evaluateLikeThePreload(purify);
    expect(typeof purifyApi).toBe('function');
    expect(purifyApi.version).toMatch(/^3\./);
    const viewApi = evaluateLikeThePreload(view);
    expect(typeof viewApi.createMarkdownView).toBe('function');

    expect(Object.keys(globalThis).length).toBe(before);
    expect(globalThis.marked).toBeUndefined();
    expect(globalThis.DOMPurify).toBeUndefined();

    const rendered = viewApi.createMarkdownView({ marked: markedApi, DOMPurify: purifyApi });
    expect(rendered.renderBody('# Hi')).toBe('<h1>Hi</h1>\n');
  });
});

describe('markdownDocumentHeaders: charset', () => {
  const response = (
    contentType,
    { url = 'https://notes.example.org/post.md', resourceType = 'mainFrame', extra = {} } = {}
  ) => ({
    url,
    resourceType,
    responseHeaders: { 'Content-Type': [contentType], 'X-Kept': ['yes'], ...extra },
  });

  test.each([
    ['text/markdown', 'text/markdown; charset=utf-8'],
    ['text/x-markdown', 'text/x-markdown; charset=utf-8'],
    ['text/markdown; variant=GFM', 'text/markdown; variant=GFM; charset=utf-8'],
    ['text/markdown;', 'text/markdown; charset=utf-8'],
  ])('%s with no charset is read as UTF-8', (type, expected) => {
    const result = markdownDocumentHeaders(response(type));
    expect(result.responseHeaders['Content-Type']).toEqual([expected]);
    expect(result.responseHeaders['X-Kept']).toEqual(['yes']);
  });

  test('text/plain counts at a .md path, as in the tab', () => {
    expect(
      markdownDocumentHeaders(
        response('text/plain', { url: 'https://raw.example.org/a/README.md?x=1' })
      ).responseHeaders['Content-Type']
    ).toEqual(['text/plain; charset=utf-8']);
    expect(
      markdownDocumentHeaders(
        response('text/plain', { url: 'https://raw.example.org/a/notes.txt' })
      )
    ).toBeNull();
  });

  test('finds the header whatever its case', () => {
    const details = {
      url: 'https://x.org/a.md',
      resourceType: 'mainFrame',
      responseHeaders: { 'content-type': ['text/markdown'] },
    };
    expect(markdownDocumentHeaders(details).responseHeaders['content-type']).toEqual([
      'text/markdown; charset=utf-8',
    ]);
  });

  test.each([
    [
      'a declared charset, kept as the server said',
      response('text/markdown; charset=windows-1252'),
    ],
    ['a declared charset in any case', response('text/markdown;Charset="ISO-8859-1"')],
    ['another type', response('text/html')],
    ['a subresource', response('text/markdown', { resourceType: 'xhr' })],
    ['a sub-frame', response('text/markdown', { resourceType: 'subFrame' })],
    [
      'no content type',
      { url: 'https://x.org/a.md', resourceType: 'mainFrame', responseHeaders: {} },
    ],
    ['no headers at all', { url: 'https://x.org/a.md', resourceType: 'mainFrame' }],
    [
      'two content types',
      {
        url: 'https://x.org/a.md',
        resourceType: 'mainFrame',
        responseHeaders: { 'Content-Type': ['text/markdown', 'text/html'] },
      },
    ],
  ])('leaves %s alone', (_label, details) => {
    expect(markdownDocumentHeaders(details)).toBeNull();
  });
});

describe("markdownDocumentHeaders: Freedom's reader policy", () => {
  // GitHub's raw files, exactly.
  const GITHUB_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  const response = (
    policies,
    {
      type = 'text/plain; charset=utf-8',
      url = 'https://raw.githubusercontent.com/o/r/main/README.md',
    } = {}
  ) => ({
    url,
    resourceType: 'mainFrame',
    responseHeaders: { 'Content-Type': [type], 'Content-Security-Policy': [].concat(policies) },
  });
  const policiesOf = (result) => result.responseHeaders['Content-Security-Policy'];

  test('nothing may run, embed, frame, submit or connect; images load', () => {
    expect(READER_POLICY).toBe(
      "default-src 'none'; img-src * data: bzz: ipfs: ipns: web3:; " +
        "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    );
  });

  test("replaces GitHub's policy, keeping its sandbox with room for the preload", () => {
    const result = markdownDocumentHeaders(response(GITHUB_POLICY));
    expect(policiesOf(result)).toEqual([`${READER_POLICY}; sandbox allow-scripts`]);
    expect(result.responseHeaders['Content-Type']).toEqual(['text/plain; charset=utf-8']);
  });

  test("a server's sandbox allowances do not carry over", () => {
    const result = markdownDocumentHeaders(
      response([
        "img-src 'self'; sandbox allow-forms allow-popups allow-same-origin",
        "frame-ancestors 'none'",
      ])
    );
    expect(policiesOf(result)).toEqual([`${READER_POLICY}; sandbox allow-scripts`]);
  });

  test('a policy without a sandbox is replaced without adding one', () => {
    expect(policiesOf(markdownDocumentHeaders(response("default-src 'none'")))).toEqual([
      READER_POLICY,
    ]);
  });

  test('finds a sandbox among several policies in one value, in any case', () => {
    const result = markdownDocumentHeaders(response("default-src 'none', SANDBOX"));
    expect(policiesOf(result)).toEqual([`${READER_POLICY}; sandbox allow-scripts`]);
  });

  test('replaces every CSP header, whatever its case, with one policy', () => {
    const result = markdownDocumentHeaders({
      url: 'https://raw.example.org/a.md',
      resourceType: 'mainFrame',
      responseHeaders: {
        'Content-Type': ['text/markdown; charset=utf-8'],
        'Content-Security-Policy': ["default-src 'none'"],
        'content-security-policy': ['sandbox'],
        'Content-Security-Policy-Report-Only': ["default-src 'self'"],
      },
    });
    expect(result.responseHeaders).toEqual({
      'Content-Type': ['text/markdown; charset=utf-8'],
      'Content-Security-Policy': [`${READER_POLICY}; sandbox allow-scripts`],
      'Content-Security-Policy-Report-Only': ["default-src 'self'"],
    });
  });

  test("keeps the server's upgrade-insecure-requests, so newly allowed images stay on HTTPS", () => {
    const result = markdownDocumentHeaders(
      response(["default-src 'none'; upgrade-insecure-requests", 'sandbox'])
    );
    expect(policiesOf(result)).toEqual([
      `${READER_POLICY}; upgrade-insecure-requests; sandbox allow-scripts`,
    ]);
  });

  test('touches nothing when Content-Type is sent twice, in different case', () => {
    // Chromium could read the second (HTML) where this would read the first.
    expect(
      markdownDocumentHeaders({
        url: 'https://files.example/file.md',
        resourceType: 'mainFrame',
        responseHeaders: {
          'Content-Type': ['text/plain'],
          'content-type': ['text/html'],
          'Content-Security-Policy': [GITHUB_POLICY],
        },
      })
    ).toBeNull();
  });

  test('also gets UTF-8 when it names no charset', () => {
    const result = markdownDocumentHeaders(response('sandbox', { type: 'text/markdown' }));
    expect(result.responseHeaders['Content-Type']).toEqual(['text/markdown; charset=utf-8']);
    expect(policiesOf(result)).toEqual([`${READER_POLICY}; sandbox allow-scripts`]);
  });

  test('a directive that only starts with the word is not a sandbox', () => {
    expect(policiesOf(markdownDocumentHeaders(response("sandboxed-thing 'none'")))).toEqual([
      READER_POLICY,
    ]);
  });

  test('leaves a page that is not Markdown alone', () => {
    expect(
      markdownDocumentHeaders(
        response(GITHUB_POLICY, { url: 'https://raw.githubusercontent.com/o/r/main/notes.txt' })
      )
    ).toBeNull();
    expect(
      markdownDocumentHeaders(response(GITHUB_POLICY, { type: 'text/html; charset=utf-8' }))
    ).toBeNull();
  });

  test('a Markdown page with a charset and no policy is left alone', () => {
    expect(
      markdownDocumentHeaders({
        url: 'https://x.org/a.md',
        resourceType: 'mainFrame',
        responseHeaders: { 'Content-Type': ['text/markdown; charset=utf-8'] },
      })
    ).toBeNull();
  });
});
