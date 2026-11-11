// Gateway response headers: the page-state headers a dweb page never gets,
// the navigation check, and the Markdown relabel for Swarm and IPFS (#1035).

const {
  stripPageStateHeaders,
  isDocumentRequest,
  labelMarkdownDocument,
} = require('./gateway-response-headers');

// Chromium's fixed navigation Accept header (see isDocumentRequest).
const NAVIGATION_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
  'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

const navigation = (url, accept = NAVIGATION_ACCEPT) =>
  new Request(url, { headers: accept ? { accept } : {} });

// Bytes, not a string: a string body makes Response add a text/plain type of
// its own, and "no type at all" is one of the cases under test.
const upstream = (headers = {}, { status = 200, body = '# Notes\n' } = {}) =>
  new Response(new TextEncoder().encode(body), { status, headers });

describe('stripPageStateHeaders', () => {
  test('drops cookies and the service-worker scope, keeps the rest', () => {
    const headers = stripPageStateHeaders(
      new Headers({
        'set-cookie': 'a=1',
        'service-worker-allowed': '/',
        'content-type': 'text/html',
      })
    );
    expect(headers.has('set-cookie')).toBe(false);
    expect(headers.has('service-worker-allowed')).toBe(false);
    expect(headers.get('content-type')).toBe('text/html');
  });
});

describe('isDocumentRequest', () => {
  test('a navigation leads its Accept with text/html', () => {
    expect(isDocumentRequest(navigation('bzz://x/'))).toBe(true);
  });

  test.each([['*/*'], ['text/css,*/*;q=0.1'], ['']])('a subresource (%p) is not', (accept) => {
    expect(isDocumentRequest(navigation('bzz://x/', accept))).toBe(false);
  });
});

describe('labelMarkdownDocument', () => {
  const HASH = 'a'.repeat(64);

  test.each([
    ['octet-stream', { 'content-type': 'application/octet-stream' }],
    ['no content type', {}],
    ['binary/octet-stream', { 'content-type': 'binary/octet-stream' }],
  ])('a .md file served as %s opens as Markdown', async (_label, headers) => {
    const response = upstream({ 'x-extra': 'kept', ...headers });
    const result = labelMarkdownDocument(response, navigation(`bzz://${HASH}/notes/post.md`));
    expect(result.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(result.headers.get('x-extra')).toBe('kept');
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('# Notes\n');
  });

  test.each(['README.MD', 'notes.markdown'])('%s counts as Markdown', (name) => {
    const result = labelMarkdownDocument(
      upstream({ 'content-type': 'application/octet-stream' }),
      navigation(`ipfs://${HASH}/${name}`)
    );
    expect(result.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  test.each([
    ['text/plain', 'text/plain; charset=utf-8'],
    ['text/markdown', 'text/markdown; charset=utf-8'],
    ['text/x-markdown', 'text/x-markdown; charset=utf-8'],
  ])('%s without a charset gets UTF-8', (type, expected) => {
    const result = labelMarkdownDocument(
      upstream({ 'content-type': type }),
      navigation(`bzz://${HASH}/post.md`)
    );
    expect(result.headers.get('content-type')).toBe(expected);
  });

  test.each([
    ['text/plain', 'text/markdown; charset=utf-8'],
    ['text/plain; charset=utf-8', 'text/markdown; charset=utf-8'],
    ['text/plain; charset=ISO-8859-1', 'text/markdown; charset=ISO-8859-1'],
    ['application/octet-stream; charset=binary', 'text/markdown; charset=utf-8'],
  ])('a root index.md served as %s opens as Markdown', (type, expected) => {
    const result = labelMarkdownDocument(
      upstream({ 'content-type': type, 'content-disposition': 'inline; filename="index.md"' }),
      navigation(`bzz://${HASH}/`)
    );
    expect(result.headers.get('content-type')).toBe(expected);
  });

  test('a site root whose node names the file index.md opens as Markdown', () => {
    for (const disposition of [
      'inline; filename="index.md"',
      "inline; filename*=UTF-8''README.md",
    ]) {
      const result = labelMarkdownDocument(
        upstream({
          'content-type': 'application/octet-stream',
          'content-disposition': disposition,
        }),
        navigation(`bzz://${HASH}/`)
      );
      expect(result.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    }
  });

  test.each([
    ['a declared charset', { 'content-type': 'text/markdown; charset=iso-8859-1' }, 'post.md'],
    ['another type', { 'content-type': 'text/html' }, 'post.md'],
    ['an image', { 'content-type': 'image/png' }, 'post.md'],
    ['a file that is not .md', { 'content-type': 'application/octet-stream' }, 'post.txt'],
    ['.md only in the query', { 'content-type': 'application/octet-stream' }, 'file?name=x.md'],
    [
      'an explicit download',
      {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="post.md"',
      },
      'post.md',
    ],
  ])('leaves %s alone', (_label, headers, path) => {
    const response = upstream(headers);
    expect(labelMarkdownDocument(response, navigation(`bzz://${HASH}/${path}`))).toBe(response);
  });

  test('leaves a subresource alone: the page decides what a fetched file is', () => {
    const response = upstream({ 'content-type': 'application/octet-stream' });
    expect(labelMarkdownDocument(response, navigation(`bzz://${HASH}/post.md`, '*/*'))).toBe(
      response
    );
  });

  test('leaves errors, redirects and bodiless answers alone', () => {
    const request = navigation(`bzz://${HASH}/post.md`);
    for (const response of [
      upstream({ 'content-type': 'application/octet-stream' }, { status: 404 }),
      new Response(null, { status: 301, headers: { location: '/x.md' } }),
      new Response(null, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    ]) {
      expect(labelMarkdownDocument(response, request)).toBe(response);
    }
  });
});
