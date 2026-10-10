// Error page — when the swarm probe returns `not_found`, the renderer
// routes the active webview to `pages/error.html` with the original
// URL preserved in the address bar. We assert both via the chrome and
// the webview's URL (the error page itself is loaded from the host
// pages/ directory so it's accessible to Playwright as a frame).

const { test, expect, SAMPLE_BZZ_HASH, SAMPLE_IPFS_CID } = require('./fixtures');

// A second opaque CIDv1 for the titleless fixture. All-lowercase on purpose:
// Chromium lowercases the host of a committed `ipfs://` URL, so a fixture key
// carrying uppercase never matches the request the harness sees and the test
// would silently assert against the harness's 404 fallback instead of its own
// document.
const NO_TITLE_IPFS_CID = 'bafybeic' + 'b'.repeat(51);

test('a probe-not-found bzz:// navigation lands on the error page', async ({ window, harness }) => {
  // Force the Swarm probe stub to time out for this hash so navigation
  // routes to error.html instead of the (also-stubbed) bzz:// fixture.
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found' });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}`);
  await input.press('Enter');

  // Address bar keeps the original URL so the user knows what failed.
  // The renderer's error path canonicalises to bzz://<hash>/ (trailing
  // slash); the success path strips it. Match either form.
  await expect(input).toHaveValue(new RegExp(`^bzz://${SAMPLE_BZZ_HASH}/?$`));

  // Active webview is the one whose container is visible. We poll its
  // src until it reports the error.html path; navigation is async.
  await expect
    .poll(
      async () => {
        return window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.getURL?.() || wv?.getAttribute?.('src') || '';
        });
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toMatch(/pages\/error\.html\?error=swarm_content_not_found/);
});

// #236: the error page used to declare no <title>, so Chromium never fired
// `page-title-updated` for it and the tab kept the previous page's title
// ("RPC servers disagreed" in the reported screenshot). Reproduced exactly as
// the issue describes: visit a titled fixture page, then a not-found hash.
test('the swarm error page does not inherit the previous page title', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`ipfs://${SAMPLE_IPFS_CID}`, {
    body: '<html><head><title>Alpha fixture page</title></head><body>alpha</body></html>',
  });
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found' });

  const input = window.locator('[data-test="address-input"]');
  const tabTitle = window.locator('[data-test="tab"] .tab-title').first();

  await input.click();
  await input.fill(`ipfs://${SAMPLE_IPFS_CID}`);
  await input.press('Enter');
  await expect(tabTitle).toHaveText('Alpha fixture page', { timeout: 10_000 });

  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}`);
  await input.press('Enter');

  await expect
    .poll(
      async () =>
        window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.getURL?.() || '';
        }),
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toMatch(/pages\/error\.html\?error=swarm_content_not_found/);

  // The error page names itself. A `not_found` probe renders the
  // "Content not found yet" headline and sets the document title to match.
  await expect(tabTitle).toHaveText('Content not found yet', { timeout: 10_000 });
});

// The other half of #236: the tab title is what the history entry records at
// did-stop-loading. A page that declares no <title> of its own must not have
// the previous page's title written against its URL — that is what put the
// wrong title next to the URL in the autocomplete dropdown.
test('a page without a title does not record the previous page title in history', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`ipfs://${SAMPLE_IPFS_CID}`, {
    body: '<html><head><title>Alpha fixture page</title></head><body>alpha</body></html>',
  });
  await harness.setContentFixture(`ipfs://${NO_TITLE_IPFS_CID}`, {
    body: '<html><body data-test="no-title-fixture">no title of its own</body></html>',
  });

  const input = window.locator('[data-test="address-input"]');
  const tabTitle = window.locator('[data-test="tab"] .tab-title').first();

  await input.click();
  await input.fill(`ipfs://${SAMPLE_IPFS_CID}`);
  await input.press('Enter');
  await expect(tabTitle).toHaveText('Alpha fixture page', { timeout: 10_000 });

  await input.click();
  await input.fill(`ipfs://${NO_TITLE_IPFS_CID}`);
  await input.press('Enter');

  // The titleless document under test has to be *ours*, not the harness's
  // 404 body: that fallback is only coincidentally titleless, so asserting
  // against it would stop covering this scenario the moment it grows a
  // <title>, without failing.
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            return await wv.executeJavaScript(
              'document.querySelector("[data-test=\\"no-title-fixture\\"]")?.textContent || ""'
            );
          } catch {
            return null;
          }
        }),
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toBe('no title of its own');

  const historyFor = async (urlPart) =>
    window.evaluate(async (part) => {
      const entries = await window.electronAPI.getHistory({ limit: 50 });
      return entries.find((entry) => entry.url.toLowerCase().includes(part)) || null;
    }, urlPart);

  await expect.poll(() => historyFor(NO_TITLE_IPFS_CID), { timeout: 10_000 }).not.toBeNull();
  const entry = await historyFor(NO_TITLE_IPFS_CID);
  expect(entry.title).not.toBe('Alpha fixture page');
});

// #445 R1-M3: the "node is not running" copy on a refused bzz:/ipfs: load
// used to come from a check that could never work in a tab (no
// `window.serviceRegistry` in a webview, a `bee.api` key the registry never
// had, a direct `fetch()` of the node's /health). It now reads the registry
// snapshot internal pages get through `freedomAPI.getServiceRegistry`.
test.describe('the error page reads node state from the registry', () => {
  let loads = 0;
  const descriptionFor = async (window, protocol) => {
    // A per-load marker, so the poll can never read the previous error page.
    const nonce = `load-${(loads += 1)}`;
    // A fresh window paints the address bar before the first tab's
    // `<webview>` is attached; the first load of a test must wait for it.
    await window.waitForFunction(() =>
      document.querySelector('webview.active, webview:not(.hidden)')
    );
    await window.evaluate(
      ([proto, marker]) => {
        const wv = document.querySelector('webview.active, webview:not(.hidden)');
        const page = new URL('pages/error.html', window.location.href);
        page.search = new URLSearchParams({
          error: 'net::ERR_CONNECTION_REFUSED',
          protocol: proto,
          url: proto === 'swarm' ? `bzz://${'a'.repeat(64)}/` : 'ipfs://bafyfixture/',
          n: marker,
        }).toString();
        wv.loadURL(page.href);
      },
      [protocol, nonce]
    );
    let text = null;
    await expect
      .poll(
        async () => {
          text = await window.evaluate(async (marker) => {
            const wv = document.querySelector('webview.active, webview:not(.hidden)');
            try {
              // `details` is filled last, after the registry check settled.
              if (
                !(await wv.executeJavaScript(
                  `/error\\.html/.test(location.href) &&
                   new URLSearchParams(location.search).get('n') === ${JSON.stringify(marker)} &&
                   !!document.getElementById('details').textContent`
                ))
              ) {
                return null;
              }
              return await wv.executeJavaScript(
                'document.getElementById("description").textContent'
              );
            } catch {
              return null;
            }
          }, nonce);
          return text;
        },
        { timeout: 10_000, intervals: [200, 500, 1000] }
      )
      .not.toBeNull();
    return text;
  };

  test('a running node keeps the generic copy; a stopped one says so', async ({
    electronApp,
    window,
  }) => {
    // The harness seeds a running bundled Ant and IPFS node.
    expect(await descriptionFor(window, 'swarm')).not.toMatch(/node is not running/);
    expect(await descriptionFor(window, 'ipfs')).not.toMatch(/node is not running/);

    await electronApp.evaluate(() => {
      const registry = process.mainModule.require('./src/main/service-registry');
      registry.clearService('ant');
      registry.clearService('ipfs');
    });

    expect(await descriptionFor(window, 'swarm')).toMatch(/The Swarm node is not running/);
    expect(await descriptionFor(window, 'ipfs')).toMatch(/The IPFS node is not running/);
  });
  // #445 R2-M2: the health check's soft-ERROR keeps `api`/`gateway` published
  // (so it can recover in place) and only raises the error overlay. A node in
  // that state is not serving, so the page must say so, and go back to the
  // generic copy once the node recovers.
  test('a published node that stopped answering says so, until it recovers', async ({
    electronApp,
    window,
  }) => {
    await electronApp.evaluate(() => {
      const registry = process.mainModule.require('./src/main/service-registry');
      registry.setErrorState('ant', 'Node unreachable. Retrying…');
      registry.setErrorState('ipfs', 'External node unreachable. Retrying…');
    });
    expect(await descriptionFor(window, 'swarm')).toMatch(/The Swarm node is not running/);
    expect(await descriptionFor(window, 'ipfs')).toMatch(/The IPFS node is not running/);

    await electronApp.evaluate(() => {
      const registry = process.mainModule.require('./src/main/service-registry');
      registry.clearErrorState('ant');
      registry.clearErrorState('ipfs');
    });
    expect(await descriptionFor(window, 'swarm')).not.toMatch(/node is not running/);
    expect(await descriptionFor(window, 'ipfs')).not.toMatch(/node is not running/);
  });
});

// #618: the page used to say "still connecting to peers … (timeout)" for
// every probe failure. Each reason now gets its own copy, and only the
// recoverable ones retry on their own.
const errorPageFor = async (electronApp, window, hash) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`bzz://${hash}`);
  await input.press('Enter');
  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/error.html'));
      return Boolean(page);
    })
    .toBe(true);
  return page;
};

test('a timeout on a node short of peers says so, and retries on its own', async ({
  electronApp,
  window,
  harness,
}) => {
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, {
    ok: false,
    reason: 'not_found',
    lastStatus: 404,
    peers: 3,
  });
  const page = await errorPageFor(electronApp, window, SAMPLE_BZZ_HASH);
  await expect(page.locator('#title')).toHaveText('Content not found yet');
  await expect(page.locator('#description')).toContainText('connected to only 3 peers');
  await expect(page.locator('#details')).toContainText(
    'Not found within 5 minutes (last answer: HTTP 404, 3 peers connected)'
  );
  await expect(page.locator('#auto-retry')).toHaveText(/Trying again automatically in \d+ s\./);

  await page.locator('#auto-retry-stop').click();
  await expect(page.locator('#auto-retry')).toHaveText('Stopped trying again automatically.');
  await expect(page.locator('#auto-retry-stop')).toBeHidden();
});

test('a well-connected timeout blames the content, not the peers', async ({
  electronApp,
  window,
  harness,
}) => {
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, {
    ok: false,
    reason: 'not_found',
    lastStatus: 'no_response',
    peers: 120,
  });
  const page = await errorPageFor(electronApp, window, SAMPLE_BZZ_HASH);
  await expect(page.locator('#description')).toContainText('may not have spread');
  await expect(page.locator('#description')).not.toContainText('peers');
  await expect(page.locator('#details')).toContainText('no answer within 30 seconds');
});

for (const [outcome, title] of [
  [{ ok: false, reason: 'path_not_found' }, 'Page not found'],
  [{ ok: false, reason: 'other', status: 403 }, "Couldn't load this content"],
]) {
  test(`a permanent failure (${outcome.reason}) does not retry`, async ({
    electronApp,
    window,
    harness,
  }) => {
    await harness.setProbeFixture(SAMPLE_BZZ_HASH, outcome);
    const page = await errorPageFor(electronApp, window, SAMPLE_BZZ_HASH);
    await expect(page.locator('#title')).toHaveText(title);
    await expect(page.locator('#details')).not.toContainText('timeout');
    await expect(page.locator('#auto-retry')).toBeHidden();
    await expect(page.locator('#auto-retry-stop')).toBeHidden();
  });
}

// An auto-retry that succeeds lands on a bzz:// page, which can't reach the
// error page's file:// sessionStorage to clear the streak count. So the page
// only keeps counting when the chrome says this failure follows straight on
// from an error page for the same URL (`streak=1`); otherwise it starts over.
test('the auto-retry count carries over only within a streak', async ({
  electronApp,
  window,
  harness,
}) => {
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found', peers: 50 });
  const page = await errorPageFor(electronApp, window, SAMPLE_BZZ_HASH);
  await expect(page.locator('#auto-retry')).toHaveText(/in 30 s\./);
  const pageUrl = new URL(page.url());
  expect(pageUrl.searchParams.get('retry')).toBe(`bzz://${SAMPLE_BZZ_HASH}/`);
  expect(pageUrl.searchParams.has('streak')).toBe(false);

  const exhaust = (target) =>
    page.evaluate(
      ([key, href]) => {
        sessionStorage.setItem(key, JSON.stringify({ count: 6, at: Date.now() }));
        window.location.replace(href);
      },
      [`freedom:auto-retry:bzz://${SAMPLE_BZZ_HASH}/`, target]
    );

  // Same streak: six retries already spent, so no more.
  pageUrl.searchParams.set('streak', '1');
  await exhaust(pageUrl.toString());
  await expect(page.locator('#auto-retry')).toHaveText('Stopped trying again automatically.');
  await expect(page.locator('#auto-retry-stop')).toBeHidden();

  // No streak (the content loaded in between): the old count is dropped.
  pageUrl.searchParams.delete('streak');
  await exhaust(pageUrl.toString());
  await expect(page.locator('#auto-retry')).toHaveText(/in 30 s\./);
  await expect(page.locator('#auto-retry-stop')).toBeVisible();
});

// Who started the retry decides whether the streak continues: the error
// page's own auto-retry carries an exhausted count on, but the toolbar Reload
// and the page context menu's Reload are explicit retries like Try Again and
// start over with a countdown.
test('the error page retrying itself keeps the streak; the toolbar or context-menu Reload starts a new one', async ({
  electronApp,
  window,
  harness,
}) => {
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found', peers: 50 });
  const page = await errorPageFor(electronApp, window, SAMPLE_BZZ_HASH);
  await expect(page.locator('#auto-retry')).toHaveText(/in 30 s\./);
  const key = `freedom:auto-retry:bzz://${SAMPLE_BZZ_HASH}/`;
  const spendAll = () =>
    page.evaluate(
      (k) => sessionStorage.setItem(k, JSON.stringify({ count: 6, at: Date.now() })),
      key
    );
  // Waits for the next error page to commit. Not keyed on a URL change: a
  // regression would land on a byte-identical URL, and must fail on the
  // `streak` assertion, not on a timeout here.
  const nextErrorPage = async (act) => {
    const loaded = page.waitForEvent('load');
    await act();
    await loaded;
    return new URL(page.url());
  };

  // What the auto-retry timer does: a `location.href` to the retry URL, which
  // goes through the chrome's probe and fails again.
  await spendAll();
  let url = await nextErrorPage(() =>
    page.evaluate((href) => {
      window.location.href = href;
    }, `bzz://${SAMPLE_BZZ_HASH}/`)
  );
  expect(url.searchParams.get('streak')).toBe('1');
  await expect(page.locator('#auto-retry')).toHaveText('Stopped trying again automatically.');

  // The toolbar Reload from that same exhausted error page.
  await spendAll();
  url = await nextErrorPage(() => window.locator('#reload-btn').click());
  expect(url.searchParams.has('streak')).toBe(false);
  await expect(page.locator('#auto-retry')).toHaveText(/in 30 s\./);
  await expect(page.locator('#auto-retry-stop')).toBeVisible();

  // The page context menu's Reload is the same explicit retry (R4-M1). Exhaust
  // the streak again first, then reload from the menu raised in the guest.
  await spendAll();
  url = await nextErrorPage(() =>
    page.evaluate((href) => {
      window.location.href = href;
    }, `bzz://${SAMPLE_BZZ_HASH}/`)
  );
  expect(url.searchParams.get('streak')).toBe('1');
  await expect(page.locator('#auto-retry')).toHaveText('Stopped trying again automatically.');

  await spendAll();
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
    )
  );
  const reloadItem = window.locator('#page-context-menu [data-action="reload"]');
  await expect(reloadItem).toBeVisible();
  url = await nextErrorPage(() => reloadItem.click());
  expect(url.searchParams.has('streak')).toBe(false);
  await expect(page.locator('#auto-retry')).toHaveText(/in 30 s\./);
  await expect(page.locator('#auto-retry-stop')).toBeVisible();
});

// Back onto an error page is the user reading history: a fresh countdown
// would retry unasked, and the retry (a new navigation) would drop the
// forward entry the user just came Back from.
test('going Back onto a retrying error page does not restart the countdown', async ({
  electronApp,
  window,
  harness,
}) => {
  await harness.setContentFixture(`ipfs://${SAMPLE_IPFS_CID}`, {
    body: '<html><head><title>Elsewhere</title></head><body>elsewhere</body></html>',
  });
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found', peers: 50 });
  const page = await errorPageFor(electronApp, window, SAMPLE_BZZ_HASH);
  await expect(page.locator('#auto-retry')).toHaveText(/in 30 s\./);
  const errorUrl = page.url();

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`ipfs://${SAMPLE_IPFS_CID}`);
  await input.press('Enter');
  await expect
    .poll(() => electronApp.windows().some((p) => p.url().startsWith('ipfs://')))
    .toBe(true);

  await window.locator('#back-btn').click();
  let back;
  await expect
    .poll(() => {
      back = electronApp.windows().find((p) => p.url() === errorUrl);
      return Boolean(back);
    })
    .toBe(true);
  await expect(back.locator('#auto-retry')).toHaveText(
    'Not trying again automatically. Use Try Again to retry.'
  );
  await expect(back.locator('#auto-retry-stop')).toBeHidden();
  // The forward entry is still there to go to.
  await expect(window.locator('#forward-btn')).toBeEnabled();
});
