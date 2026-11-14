'use strict';
const { readPageMarkdown, headerLinks, sameSiteUrl } = require('./page-markdown');

const pageUrl = 'https://docs.example.test/guide';
const markdown = text => new Response(text, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });

test('negotiates without cookies, redirects, referrers or shared cache; does not fetch llms.txt implicitly', async () => {
  const fetch = jest.fn(async () => markdown('# Hello'));
  expect(await readPageMarkdown({ pageUrl, fetch })).toMatchObject({ available: true,
    format: 'markdown', source: 'site-provided-markdown', text: '# Hello', url: pageUrl });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(pageUrl, expect.objectContaining({ method: 'GET', credentials: 'omit',
    redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'text/markdown, text/plain;q=0.5' } }));
});

test('uses a same-site advertised alternate and never fetches foreign or credentialed hints', async () => {
  const fetch = jest.fn(async () => markdown('alternate'));
  const result = await readPageMarkdown({ pageUrl, links: { alternate: [
    'https://evil.test/steal', 'https://user:secret@docs.example.test/x', '/guide.md#section',
  ] }, fetch });
  expect(result.url).toBe('https://docs.example.test/guide.md');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.notice).toContain('may differ from the visible page');
});

test('follows an advertised response-header alternate after HTML negotiation, never a redirect', async () => {
  const fetch = jest.fn().mockResolvedValueOnce(new Response('<html>', { headers: {
    'content-type': 'text/html', link: '</unrelated>; rel="next", </guide.md>; rel="alternate"; type="text/markdown"',
  } })).mockResolvedValueOnce(markdown('# Guide'));
  expect((await readPageMarkdown({ pageUrl, fetch })).text).toBe('# Guide');
  expect(fetch.mock.calls.map(call => call[0])).toEqual([pageUrl, 'https://docs.example.test/guide.md']);
  const denied = jest.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }));
  expect((await readPageMarkdown({ pageUrl, fetch: denied })).available).toBe(false);
  expect(denied).toHaveBeenCalledTimes(1);
});

test.each([
  ['bzz://example.gwei/docs/', 'bzz://example.gwei/docs/page.md'],
  ['ipfs://bafyfixture/docs/', 'ipfs://bafyfixture/docs/page.md'],
  ['ipns://example.test/docs/', 'ipns://example.test/docs/page.md'],
])('keeps %s alternate retrieval on the same native content authority', async (pageUrl, url) => {
  const fetch = jest.fn(async () => markdown('native content'));
  expect((await readPageMarkdown({ pageUrl, links: { alternate: ['page.md'] }, fetch })).url).toBe(url);
  expect(fetch.mock.calls[0][0]).toBe(url);
});

test('fetches a site index only when explicitly requested and never follows its listed links', async () => {
  const fetch = jest.fn(async () => new Response('# Site\n[Secret](https://evil.test/secret)', { headers: { 'content-type': 'text/plain' } }));
  const result = await readPageMarkdown({ pageUrl, kind: 'site-index', links: { index: ['/docs/llms.txt'] }, fetch });
  expect(result).toMatchObject({ source: 'site-index', text: expect.stringContaining('Secret'), url: 'https://docs.example.test/docs/llms.txt' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(['text/html', 'application/json', 'application/octet-stream', 'text/plain'])('rejects %s as a page Markdown representation', async type => {
  const fetch = jest.fn(async () => new Response('not markdown', { headers: { 'content-type': type } }));
  expect(await readPageMarkdown({ pageUrl, fetch })).toMatchObject({ available: false, fallback: 'browser_snapshot' });
});

test('bounds streamed output and cancels the rest of the response', async () => {
  const cancel = jest.fn();
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('x'.repeat(150000)));
  }, cancel });
  const fetch = jest.fn(async () => new Response(body, { headers: { 'content-type': 'text/markdown' } }));
  const result = await readPageMarkdown({ pageUrl, fetch });
  expect(result.truncated).toBe(true);
  expect(result.text).toHaveLength(64000);
  expect(cancel).toHaveBeenCalled();
});

test('refuses stale results, cancellation and unsupported URL schemes without leaking an exception string', async () => {
  let current = true;
  const fetch = jest.fn(async () => { current = false; return markdown('stale private text'); });
  expect(await readPageMarkdown({ pageUrl, fetch, isCurrent: () => current })).toMatchObject({ available: false, reason: 'page_changed' });
  const stop = new AbortController(); stop.abort();
  await expect(readPageMarkdown({ pageUrl, fetch, signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
  fetch.mockClear();
  expect((await readPageMarkdown({ pageUrl: 'file:///etc/passwd', fetch })).reason).toBe('unsupported_page');
  expect(fetch).not.toHaveBeenCalled();
  expect((await readPageMarkdown({ pageUrl, fetch: async () => { throw new Error('credential secret'); } })).reason).toBe('markdown_unavailable');
});

test('rejects cross-site, downgrade, credentials and oversized link metadata', () => {
  for (const url of ['https://evil.test/x', '//evil.test/x', 'http://docs.example.test/x', 'file:///x', 'https://u:p@docs.example.test/x', 'x'.repeat(5000)])
    expect(sameSiteUrl(url, pageUrl)).toBeNull();
  expect(headerLinks('<https://evil.test/x>; rel="alternate"; type="text/markdown", </safe.md>; type="text/markdown"; rel="alternate canonical"', pageUrl, 'page'))
    .toEqual(['https://docs.example.test/safe.md']);
});

test('does not replay a page query URL for negotiation but still permits its advertised alternate', async () => {
  const fetch = jest.fn(async () => markdown('# Public alternate'));
  const queryUrl = pageUrl + '?confirm=token';
  expect((await readPageMarkdown({ pageUrl: queryUrl, fetch })).reason).toBe('query_requires_rendered_page');
  expect(fetch).not.toHaveBeenCalled();
  expect((await readPageMarkdown({ pageUrl: queryUrl, links: { alternate: ['/guide.md'] }, fetch })).available).toBe(true);
  expect(fetch.mock.calls[0][0]).toBe('https://docs.example.test/guide.md');
});
