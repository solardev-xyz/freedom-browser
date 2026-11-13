// Third-party cookies (#474): blocked by default through Chromium's
// `--test-third-party-cookie-phaseout` switch (src/main/third-party-cookies.js).
//
// What this pins is the effect, not the switch: a tracker sets a cookie as a
// first party, is then embedded on another site, and must not see that cookie
// or set a new one there. A later Electron that drops the switch would turn the
// blocking off without a word, and this is where it would show. The second
// describe launches with blocking turned off and sees the cookie, so the
// first can't pass on a fixture that never had a cookie to see.
//
// The harness serves these https:// pages from fixtures, without the network.
// `document.cookie` still goes through Chromium's cookie store under the page's
// real URL, and that is where third-party blocking applies.

const { test, expect } = require('./fixtures');

const FIRST = 'https://tracker.test/first';
const EMBED = 'https://site.test/embed';
const FRAME = 'https://tracker.test/frame';

const page = (body) => ({ body: `<!doctype html><meta charset="utf-8">${body}` });

// The tracker as a first party sets `fp`. Embedded, it reports what it can see
// at load, then tries a cookie of its own and a partitioned one (CHIPS), which
// it may keep because it is kept per top-level site.
const FIXTURES = {
  [FIRST]: page(
    `<script>
      document.cookie = 'fp=1; SameSite=None; Secure; Path=/; Max-Age=3600';
      window.__cookies = { firstParty: document.cookie };
    </script>`
  ),
  [FRAME]: page(
    `<script>
      const atLoad = document.cookie;
      document.cookie = 'js3p=1; SameSite=None; Secure; Path=/; Max-Age=3600';
      document.cookie = 'chips=1; SameSite=None; Secure; Path=/; Max-Age=3600; Partitioned';
      window.__cookies = { atLoad, afterSetting: document.cookie };
    </script>`
  ),
};
const embedFixtures = (suffix) => ({
  [`${EMBED}${suffix}`]: page(`<iframe src="${FRAME}${suffix}"></iframe>`),
  [`${FRAME}${suffix}`]: FIXTURES[FRAME],
});

async function setFixtures(electronApp, fixtures) {
  for (const [url, fixture] of Object.entries(fixtures)) {
    await electronApp.evaluate(
      (_electron, [u, f]) => globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(u, f),
      [url, fixture]
    );
  }
}

async function navigateTo(window, url) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
}

// What the page script at `url` recorded, read from whichever guest frame
// loaded it: the embedded one is a subframe, which a webview's own
// executeJavaScript can't reach.
async function cookiesSeenAt(electronApp, url) {
  let seen;
  await expect
    .poll(
      async () => {
        seen = await electronApp.evaluate(async ({ webContents }, frameUrl) => {
          for (const wc of webContents.getAllWebContents()) {
            const frame = wc.mainFrame?.framesInSubtree.find((f) => f.url === frameUrl);
            if (!frame) continue;
            try {
              return (await frame.executeJavaScript('window.__cookies')) ?? null;
            } catch {
              return null;
            }
          }
          return null;
        }, url);
        return seen !== null;
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  return seen;
}

async function setCookieAsFirstParty(window, electronApp) {
  await navigateTo(window, FIRST);
  expect((await cookiesSeenAt(electronApp, FIRST)).firstParty).toContain('fp=1');
}

test.describe('third-party cookies, blocked (the default)', () => {
  test('an embedded tracker neither sees nor sets cookies, also after a network service restart', async ({
    window,
    electronApp,
  }) => {
    await setFixtures(electronApp, {
      [FIRST]: FIXTURES[FIRST],
      ...embedFixtures(''),
      ...embedFixtures('?again'),
    });
    await setCookieAsFirstParty(window, electronApp);

    const expectBlocked = (seen) => {
      expect(seen.atLoad).not.toContain('fp=1');
      expect(seen.afterSetting).not.toContain('js3p=1');
      // Partitioned cookies keep working, and show the frame's own script ran.
      expect(seen.afterSetting).toContain('chips=1');
    };

    await navigateTo(window, EMBED);
    expectBlocked(await cookiesSeenAt(electronApp, FRAME));

    // The cookie store lives in the network service. One that dies is started
    // again, and has to block the same way.
    await electronApp.evaluate(({ app }) => {
      const service = app
        .getAppMetrics()
        .find((m) => m.type === 'Utility' && m.serviceName === 'network.mojom.NetworkService');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ app }) =>
            app
              .getAppMetrics()
              .filter(
                (m) => m.type === 'Utility' && m.serviceName === 'network.mojom.NetworkService'
              ).length
        )
      )
      .toBe(1);
    await navigateTo(window, `${EMBED}?again`);
    expectBlocked(await cookiesSeenAt(electronApp, `${FRAME}?again`));
  });

  test('Settings shows it on, and offers a restart only while the choice differs from this launch', async ({
    window,
    electronApp,
  }) => {
    await navigateTo(window, 'freedom://settings/privacy/cookies');
    let settingsPage;
    await expect
      .poll(() => {
        settingsPage = electronApp.windows().find((p) => p.url().includes('/pages/settings.html'));
        return Boolean(settingsPage);
      })
      .toBe(true);
    const toggle = settingsPage.locator('#block-third-party-cookies');
    const restart = settingsPage.locator('#third-party-cookies-restart');
    await expect(toggle).toBeChecked();
    await expect(restart).toBeHidden();

    const stored = () =>
      settingsPage.evaluate(
        async () => (await window.freedomAPI.getSettings()).blockThirdPartyCookies
      );

    await toggle.evaluate((el) => el.click());
    await expect.poll(stored).toBe(false);
    await expect(toggle).not.toBeChecked();
    await expect(restart).toBeVisible();

    await toggle.evaluate((el) => el.click());
    await expect.poll(stored).toBe(true);
    await expect(restart).toBeHidden();
  });
});

test.describe('third-party cookies, allowed', () => {
  test.use({ seedSettings: { blockThirdPartyCookies: false } });

  test('the same embedded tracker sees and sets its cookies', async ({ window, electronApp }) => {
    await setFixtures(electronApp, { [FIRST]: FIXTURES[FIRST], ...embedFixtures('') });
    await setCookieAsFirstParty(window, electronApp);

    await navigateTo(window, EMBED);
    const seen = await cookiesSeenAt(electronApp, FRAME);
    expect(seen.atLoad).toContain('fp=1');
    expect(seen.afterSetting).toContain('js3p=1');
  });
});
