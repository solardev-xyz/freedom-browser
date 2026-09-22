// Back/forward onto an ENS-backed history entry re-verifies the name under
// today's verification settings (#86). Before the fix, traversal handed the
// restored entry to Chromium and nothing re-entered the resolution path, so
// the trust badge kept painting whatever method was configured when the entry
// first loaded — visible to the user as a shield that still claims
// "user-configured" after they switched the app to a verifying resolver.
//
// Driven through the real chrome (the toolbar buttons, the real
// `ens:resolve` IPC via the harness fixture map) so what is asserted is the
// badge a user would see. The fixture swap between the two loads stands in
// for the settings flip: the main process re-resolves on a settings change,
// which is exactly what the traversal refresh triggers.

const { test, expect } = require('./fixtures');

const UNVERIFIED_FIRST_LOAD = {
  type: 'ok',
  protocol: 'ipfs',
  decoded: 'QmEnsTraversalPage',
  uri: 'ipfs://QmEnsTraversalPage',
  trust: { level: 'user-configured', method: 'direct-rpc', agreed: ['rpc.mine.test'] },
};

const VERIFIED_AFTER_SETTINGS_CHANGE = {
  type: 'ok',
  protocol: 'ipfs',
  decoded: 'QmEnsTraversalPage',
  uri: 'ipfs://QmEnsTraversalPage',
  trust: {
    level: 'verified',
    method: 'colibri',
    block: { number: 21000000 },
    queried: ['colibri'],
    agreed: ['colibri'],
  },
};

const webviewUrl = (window) =>
  window.evaluate(() => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    return wv?.getURL?.() || '';
  });

const seedEnsPage = async (harness) => {
  await harness.setEnsFixture('traversal.eth', UNVERIFIED_FIRST_LOAD);
  await harness.setContentFixture('ipfs://traversal.eth/', {
    body: '<html><body><h1>traversal.eth</h1></body></html>',
  });
};

const navigateTo = async (window, value) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(value);
  await input.press('Enter');
};

// The acceptance walk-through of issue #86, in both themes: this is a
// `src/renderer/` change, and the shield is one of the surfaces whose colour
// carries meaning, so the before/after evidence is captured in each.
for (const theme of ['dark', 'light']) {
  test.describe(`ENS history traversal ${theme}`, () => {
    test.use({ seedSettings: { theme } });
    test('Back onto an ENS page refreshes the trust badge under the new settings', async ({
      window,
      harness,
    }, testInfo) => {
      await seedEnsPage(harness);
      const shield = window.locator('#trust-shield');

      // 1. First load, while the app is configured to resolve through the user's
      //    own RPC: the name resolves but nothing verified it.
      await navigateTo(window, 'traversal.eth');
      await expect
        .poll(() => webviewUrl(window), { timeout: 15_000 })
        .toMatch(/^ipfs:\/\/traversal\.eth/);
      await expect(shield).toBeVisible();
      await expect(shield).toHaveAttribute('data-trust', 'user-configured');
      // The popover is where the method itself is spelled out, so it is the
      // surface that makes "which verification method is this badge claiming?"
      // legible in the acceptance screenshots.
      await shield.click();
      await expect(window.locator('#trust-popover-status')).toHaveText(
        'Resolved with your configured RPC'
      );
      await window.screenshot({
        path: testInfo.outputPath(`${theme}-1-before-settings-change.png`),
      });
      await shield.click();
      await expect(window.locator('#trust-popover')).toBeHidden();

      // 2. Navigate away to a non-ENS page.
      await navigateTo(window, 'https://example.com/');
      await expect
        .poll(() => webviewUrl(window), { timeout: 15_000 })
        .toMatch(/^https:\/\/example\.com/);
      await expect(shield).toBeHidden();

      // 3. The user switches the ENS verification method, so the next resolution
      //    comes back verified.
      await harness.setEnsFixture('traversal.eth', VERIFIED_AFTER_SETTINGS_CHANGE);

      // 4. Back. Pre-fix the shield stayed on `user-configured` here until the
      //    page was reloaded or the name re-typed.
      await window.click('#back-btn');
      await expect
        .poll(() => webviewUrl(window), { timeout: 15_000 })
        .toMatch(/^ipfs:\/\/traversal\.eth/);
      await expect(shield).toHaveAttribute('data-trust', 'verified', { timeout: 15_000 });
      await shield.click();
      await expect(window.locator('#trust-popover-status')).toHaveText('ENS resolution verified');
      // …and the method behind it is the new one, not the RPC the entry was
      // first loaded with.
      await expect(window.locator('#trust-popover-trust-fields')).toContainText('Colibri');
      await window.screenshot({ path: testInfo.outputPath(`${theme}-2-after-back-traversal.png`) });
      await shield.click();
      await expect(window.locator('#trust-popover')).toBeHidden();

      // The refresh must not have re-navigated over the restored entry: doing so
      // would have dropped the forward history the user just came from.
      await expect(window.locator('#forward-btn')).toBeEnabled();
      await window.click('#forward-btn');
      await expect
        .poll(() => webviewUrl(window), { timeout: 15_000 })
        .toMatch(/^https:\/\/example\.com/);
    });
  });
}

test('Forward onto an ENS page refreshes the trust badge too', async ({ window, harness }) => {
  await seedEnsPage(harness);
  const shield = window.locator('#trust-shield');

  await navigateTo(window, 'https://example.com/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/example\.com/);

  await navigateTo(window, 'traversal.eth');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(shield).toHaveAttribute('data-trust', 'user-configured');

  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/example\.com/);

  await harness.setEnsFixture('traversal.eth', VERIFIED_AFTER_SETTINGS_CHANGE);

  await window.click('#forward-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(shield).toHaveAttribute('data-trust', 'verified', { timeout: 15_000 });
});

test('Back between two non-ENS pages is unchanged', async ({ window }) => {
  // The regression control for the branch above: a traversal whose restored
  // entry is not ENS-backed must behave exactly as it did before — the entry
  // is restored, no interstitial is raised over it, and no badge appears.
  await navigateTo(window, 'https://first.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/first\.example/);

  await navigateTo(window, 'https://second.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/second\.example/);

  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/first\.example/);
  await expect(window.locator('#trust-shield')).toBeHidden();
  await expect(window.locator('[data-test="address-input"]')).toHaveValue('https://first.example/');
});

test('a conflict under the new settings blocks once, without trapping Back', async ({
  window,
  harness,
}, testInfo) => {
  // A blocking verdict on a restored entry routes to the app's existing
  // conflict interstitial rather than a new surface. That interstitial is a
  // real navigation, so it appends a history entry — and pressing Back out of
  // it lands on the blocked entry again. Without the "the user is leaving this
  // name's interstitial" guard, the refresh re-raised it every time and the
  // user could not get back past it (reproduced in a real run before the
  // guard existed; this spec is that reproduction, inverted).
  await harness.setEnsFixture('traversal.eth', UNVERIFIED_FIRST_LOAD);
  await harness.setContentFixture('ipfs://traversal.eth/', {
    body: '<html><body><h1>traversal.eth</h1></body></html>',
  });

  await navigateTo(window, 'https://start.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/start\.example/);
  await navigateTo(window, 'traversal.eth');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await navigateTo(window, 'https://after.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/after\.example/);

  // The resolvers now disagree about this name.
  await harness.setEnsFixture('traversal.eth', {
    type: 'conflict',
    trust: { level: 'conflict', block: { number: 21000000 } },
    groups: [
      { value: '0xaa', sources: ['rpc-one.test'] },
      { value: '0xbb', sources: ['rpc-two.test'] },
    ],
  });

  // Back onto the ENS entry: blocked, on the existing interstitial.
  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/pages\/ens-conflict\.html/);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue('traversal.eth');
  await window.screenshot({ path: testInfo.outputPath('3-conflict-on-traversal.png') });

  // Back again: the user is leaving the interstitial, so the restored entry
  // stands with the refreshed (conflict) badge instead of bouncing back in…
  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(window.locator('#trust-shield')).toHaveAttribute('data-trust', 'conflict');

  // …and one more Back reaches the page before it.
  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/start\.example/);
});

// A frame that rewrites its own URL every 20ms through the History API.
// Chromium reports each of those through the *same* `did-navigate-in-page`
// event as a main-frame same-document commit, with `isMainFrame: false`, so
// one of them reliably lands in the window between a Back press and the
// restored entry committing.
const seedRewritingFrame = async (harness, hostUrl, heading) => {
  await harness.setContentFixture(hostUrl, {
    body: `<html><body><h1>${heading}</h1><iframe src="ipfs://qmframechild/"></iframe></body></html>`,
  });
  await harness.setContentFixture('ipfs://qmframechild/', {
    body:
      '<html><body>frame<script>let n = 0;' +
      "setInterval(() => { history.replaceState(null, '', '/f?n=' + ++n); }, 20);" +
      '</script></body></html>',
  });
};

test('an iframe rewriting its own URL does not eat the traversal', async ({
  window,
  harness,
}, testInfo) => {
  // Before the main-frame gate in `tabs.js`, the subframe report consumed the
  // traversal mark and the restored entry was never re-verified — the shield
  // stayed on the method configured when it first loaded, which is the bug
  // this PR exists to fix, reappearing on any page with a live iframe.
  await seedEnsPage(harness);
  await seedRewritingFrame(harness, 'ipfs://qmiframehost/', 'host');
  const shield = window.locator('#trust-shield');

  await navigateTo(window, 'traversal.eth');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(shield).toHaveAttribute('data-trust', 'user-configured');

  await navigateTo(window, 'ipfs://qmiframehost/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/qmiframehost/);

  // The verification method is switched while the iframe keeps rewriting.
  await harness.setEnsFixture('traversal.eth', VERIFIED_AFTER_SETTINGS_CHANGE);

  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(shield).toHaveAttribute('data-trust', 'verified', { timeout: 15_000 });
  await window.screenshot({ path: testInfo.outputPath('4-traversal-past-live-iframe.png') });
});

test('a rewriting iframe cannot raise its own page over a traversal away from it', async ({
  window,
  harness,
}, testInfo) => {
  // The sharper half of the same bug. Here the ENS page carrying the frame is
  // the one being *left*: a subframe report consuming the mark made the
  // refresh run against `committedDisplayUrl` — still the outgoing entry —
  // so the conflict verdict for the page the user was walking away from was
  // raised as an interstitial over the traversal itself. The user pressed
  // Back and landed on `ens-conflict.html` for the page they were leaving,
  // with the forward history gone.
  await harness.setEnsFixture('probe.eth', UNVERIFIED_FIRST_LOAD);
  await seedRewritingFrame(harness, 'ipfs://probe.eth/', 'probe.eth');

  await navigateTo(window, 'https://start.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/start\.example/);
  await navigateTo(window, 'probe.eth');
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toMatch(/^ipfs:\/\/probe\.eth/);

  // The resolvers now disagree about the name of the page being left.
  await harness.setEnsFixture('probe.eth', {
    type: 'conflict',
    trust: { level: 'conflict', block: { number: 21000000 } },
    groups: [
      { value: '0xaa', sources: ['rpc-one.test'] },
      { value: '0xbb', sources: ['rpc-two.test'] },
    ],
  });

  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/start\.example/);
  // The Back the user pressed still works, and the traversal was not
  // overwritten by an interstitial for the entry they left.
  await expect
    .poll(() => webviewUrl(window), { timeout: 2_000 })
    .not.toMatch(/pages\/ens-conflict\.html/);
  await expect(window.locator('#forward-btn')).toBeEnabled();
  await window.screenshot({ path: testInfo.outputPath('5-traversal-not-hijacked.png') });
});
