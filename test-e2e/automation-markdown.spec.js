'use strict';
const http = require('node:http');
const { test, expect } = require('./fixtures');

const execute = (app, operation, input) => app.evaluate((_electron, { operation, input }) =>
  globalThis.__FREEDOM_TEST_HARNESS__.automationExecute(operation, input), { operation, input });

test('native Markdown retrieval preserves the visible DOM and omits browser credentials and shared-cache writes', async ({ electronApp, window }) => {
  await expect(window.locator('[data-test="address-input"]')).toBeVisible();
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, accept: req.headers.accept, cookie: req.headers.cookie, referer: req.headers.referer, authorization: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'] });
    if (req.url === '/llms.txt') {
      res.setHeader('content-type', 'text/plain');
      return res.end('# Index\n[Guide](/guide)');
    }
    if (req.headers.accept?.startsWith('text/markdown')) {
      // Intentionally no Vary: Accept: the separate request must not poison HTML.
      res.setHeader('content-type', 'text/markdown');
      res.setHeader('cache-control', 'max-age=3600');
      res.setHeader('etag', '"markdown-only"');
      return res.end('# Site Markdown\nA concise guide.');
    }
    res.setHeader('content-type', 'text/html');
    res.setHeader('cache-control', 'max-age=3600');
    res.setHeader('set-cookie', 'private_session=fixture; Path=/');
    res.end('<!doctype html><title>Visible guide</title><p>Visible HTML guide</p><button>Keep DOM controls</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/guide`;
  let tabId;
  try {
    // Exercise Chromium's HTTP cache and credential handling directly rather
    // than the harness's synthetic HTTP responses. The only navigation in this
    // disposable fixture profile is our loopback server; HTTPS stays stubbed.
    await electronApp.evaluate(({ session }) => session.defaultSession.protocol.unhandle('http'));
    tabId = await electronApp.evaluate((_electron, url) =>
      globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url), url);
    const result = await execute(electronApp, 'browser_read_markdown', { tabId });
    expect(result, JSON.stringify({ result, requests })).toMatchObject({ ok: true, result: { available: true, text: '# Site Markdown\nA concise guide.' } });
    const fetched = requests.find(request => request.accept?.startsWith('text/markdown'));
    expect(fetched).toMatchObject({ url: '/guide', cookie: undefined, referer: undefined, authorization: undefined, ifNoneMatch: undefined });
    expect(requests.some(request => request.url === '/llms.txt')).toBe(false);
    const snapshot = await execute(electronApp, 'browser_snapshot', { tabId });
    expect(snapshot.result.text).toContain('Visible HTML guide');
    expect(snapshot.result.elements.some(element => element.name === 'Keep DOM controls')).toBe(true);
    const index = await execute(electronApp, 'browser_read_markdown', { tabId, source: 'site-index' });
    expect(index).toMatchObject({ ok: true, result: { source: 'site-index', text: '# Index\n[Guide](/guide)' } });
    await execute(electronApp, 'browser_navigate', { tabId, url });
    await execute(electronApp, 'browser_wait', { tabId, condition: 'load' });
    expect((await execute(electronApp, 'browser_snapshot', { tabId })).result.text).toContain('Visible HTML guide');
  } finally {
    if (tabId) await electronApp.evaluate((_electron, tabId) => globalThis.__FREEDOM_TEST_HARNESS__.closeHiddenAutomationPage(tabId), tabId);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('native Swarm and IPFS Markdown alternates use the existing protocol handlers', async ({ electronApp, window, harness }) => {
  await expect(window.locator('[data-test="address-input"]')).toBeVisible();
  for (const pageUrl of ['bzz://fixture.gwei/docs/', 'ipfs://bafyfixture/docs/']) {
    const target = pageUrl + 'guide.md';
    await harness.setContentFixture(pageUrl, { body: '<!doctype html><title>Native guide</title><link rel="alternate" type="text/markdown" href="guide.md"><p>Rendered guide</p>' });
    await harness.setContentFixture(target, { body: '# Native Markdown', contentType: 'text/markdown' });
    const tabId = await electronApp.evaluate((_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url), pageUrl);
    try {
      expect(await execute(electronApp, 'browser_read_markdown', { tabId })).toMatchObject({
        ok: true, result: { available: true, url: target, text: '# Native Markdown' },
      });
      expect((await execute(electronApp, 'browser_snapshot', { tabId })).result.text).toContain('Rendered guide');
    } finally {
      await electronApp.evaluate((_electron, tabId) => globalThis.__FREEDOM_TEST_HARNESS__.closeHiddenAutomationPage(tabId), tabId);
    }
  }
});
