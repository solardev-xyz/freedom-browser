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

// Click a control *inside* the guest document (the interstitial's own
// buttons), with a user gesture, the way the user would. The guest carries
// `.hidden` until `dom-ready`, so the element is waited for rather than
// assumed present the moment the URL poll above is satisfied.
const guestScript = (sel) =>
  `(() => { const el = document.querySelector(${JSON.stringify(sel)});` +
  ` if (!el) return 'missing'; el.click(); return 'clicked'; })()`;

const inGuest = (window, source) =>
  window.evaluate(async (js) => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    if (!wv?.executeJavaScript) return 'no-webview';
    return await wv.executeJavaScript(js, true);
  }, source);

const clickInGuest = async (window, selector) => {
  await expect
    .poll(() => inGuest(window, `!!document.querySelector(${JSON.stringify(selector)})`), {
      timeout: 15_000,
    })
    .toBe(true);
  expect(await inGuest(window, guestScript(selector))).toBe('clicked');
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

  // That badge is clickable, so the popover behind it has to agree with it.
  // A conflict has no resolved URI of its own — the RPCs returned 0xaa and
  // 0xbb — so the "Resolves to" row must not still be printing the CID the
  // *first* load resolved, which would read as this verdict's answer.
  await window.click('#trust-shield');
  await expect(window.locator('#trust-popover')).toBeVisible();
  await expect(window.locator('#trust-popover-status')).toHaveText(
    'Verification failed: RPCs disagree'
  );
  await expect(window.locator('#trust-popover')).not.toContainText('QmEnsTraversalPage');
  await window.screenshot({ path: testInfo.outputPath('4-conflict-badge-popover.png') });
  await window.click('#trust-shield');
  await expect(window.locator('#trust-popover')).toBeHidden();

  // …and one more Back reaches the page before it.
  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/start\.example/);
});

// The interstitial's own "← Go back" button, on the history shape the
// traversal refresh appends (`[…, name.eth, its-interstitial]`). Before the
// fix the button was dead: `window.history.back()` inside the page is a
// *renderer*-initiated navigation to `ipfs://traversal.eth/`, so the main
// process' `will-navigate` intercept caught it and replayed it through
// `loadTarget` — which re-resolved the name, found the same conflict and
// loaded the same interstitial again. The guest URL never changed, however
// many times it was clicked. The shell traverses now, so the blocked entry is
// restored with the refreshed verdict on its badge, exactly as the toolbar
// Back already did.
for (const blocked of [
  {
    label: 'conflict',
    page: /pages\/ens-conflict\.html/,
    trust: 'conflict',
    fixture: {
      type: 'conflict',
      trust: { level: 'conflict', block: { number: 21000000 } },
      groups: [
        { value: '0xaa', sources: ['rpc-one.test'] },
        { value: '0xbb', sources: ['rpc-two.test'] },
      ],
    },
  },
  {
    label: 'unverified',
    page: /pages\/ens-unverified\.html/,
    trust: 'unverified',
    fixture: {
      type: 'ok',
      protocol: 'ipfs',
      decoded: 'QmEnsTraversalPage',
      uri: 'ipfs://QmEnsTraversalPage',
      trust: { level: 'unverified', method: 'direct-rpc' },
    },
    // The URI the interstitial prints, byte for byte. The committed display
    // this refresh keys on always carries a path (`ipfs://traversal.eth/`),
    // so `applyEnsSuffix` resolves a non-empty suffix through `new URL()` —
    // and `ipfs` is a *standard* scheme in the renderer
    // (`registerSchemesAsPrivileged`, main/index.js), so canonicalization
    // lower-cases the host. A CIDv0 root is case-sensitive base58, which the
    // resolver preserves on purpose (ens-resolver.js), so a folded root is
    // not merely ugly: it is not a CID any more.
    expectedUri: 'ipfs://QmEnsTraversalPage/',
  },
]) {
  test(`the ${blocked.label} interstitial's own Go back button leaves it`, async ({
    window,
    harness,
  }, testInfo) => {
    await seedEnsPage(harness);

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

    // The verdict for the name flips while the user is away, so backing onto
    // it blocks (`blockUnverifiedEns` is on by default).
    await harness.setEnsFixture('traversal.eth', blocked.fixture);

    await window.click('#back-btn');
    await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toMatch(blocked.page);
    if (blocked.expectedUri) {
      expect(new URL(await webviewUrl(window)).searchParams.get('uri')).toBe(blocked.expectedUri);
    }

    // The page's own button, clicked as the user clicks it.
    await clickInGuest(window, '#back-btn');
    await expect
      .poll(() => webviewUrl(window), { timeout: 15_000 })
      .toMatch(/^ipfs:\/\/traversal\.eth/);
    // It is a real traversal, not a re-navigation: the restored entry carries
    // the refreshed verdict on its badge and the forward entry is still there.
    await expect(window.locator('#trust-shield')).toHaveAttribute('data-trust', blocked.trust, {
      timeout: 15_000,
    });
    await expect(window.locator('#forward-btn')).toBeEnabled();
    // And it stays left: nothing re-raises the interstitial behind the back of
    // the restored entry.
    await window.waitForTimeout(2_000);
    expect(await webviewUrl(window)).toMatch(/^ipfs:\/\/traversal\.eth/);
    await window.screenshot({
      path: testInfo.outputPath(`10-${blocked.label}-interstitial-go-back.png`),
    });

    // One more Back reaches the page before the name, as it did before.
    await window.click('#back-btn');
    await expect
      .poll(() => webviewUrl(window), { timeout: 15_000 })
      .toMatch(/^https:\/\/start\.example/);
  });
}

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

// The same pair again, with the History API call in the restored page's **own
// main document** rather than in a frame it embeds. Chromium reports those
// through `did-navigate-in-page` with `isMainFrame: true`, so the subframe
// gate above does not see them at all.
const seedRewritingPage = async (harness, hostUrl, heading) => {
  await harness.setContentFixture(hostUrl, {
    body:
      `<html><body><h1>${heading}</h1><script>let n = 0;` +
      "setInterval(() => { history.replaceState(null, '', '/p?n=' + ++n); }, 20);" +
      '</script></body></html>',
  });
};

test('a page rewriting its own URL does not eat the traversal', async ({
  window,
  harness,
}, testInfo) => {
  // The main-document half of the pair above, and the one the subframe gate
  // could not see: `history.replaceState` on a 20ms timer in the *restored
  // page's own document* reports as a main-frame `did-navigate-in-page`, so
  // before this fix the first of those consumed the traversal mark and the
  // real commit re-verified nothing — the shield stayed on the method
  // configured when the entry first loaded.
  await seedEnsPage(harness);
  await seedRewritingPage(harness, 'ipfs://qmspahost/', 'spa host');
  const shield = window.locator('#trust-shield');

  await navigateTo(window, 'traversal.eth');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(shield).toHaveAttribute('data-trust', 'user-configured');

  await navigateTo(window, 'ipfs://qmspahost/');
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toMatch(/^ipfs:\/\/qmspahost/);

  await harness.setEnsFixture('traversal.eth', VERIFIED_AFTER_SETTINGS_CHANGE);

  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(shield).toHaveAttribute('data-trust', 'verified', { timeout: 15_000 });
  await window.screenshot({ path: testInfo.outputPath('6-traversal-past-rewriting-page.png') });
});

test('a rewriting page cannot raise its own interstitial over a traversal away from it', async ({
  window,
  harness,
}, testInfo) => {
  // The sharper half: here the rewriting page is the ENS entry being *left*,
  // and its verdict has flipped to conflict. A main-frame in-page commit
  // consuming the mark ran the refresh against `committedDisplayUrl` — still
  // that outgoing entry — and loaded `ens-conflict.html?name=probe.eth` over
  // the pending Back, so the user landed on an interstitial for the page they
  // were walking away from with the forward history gone.
  await harness.setEnsFixture('probe.eth', UNVERIFIED_FIRST_LOAD);
  await seedRewritingPage(harness, 'ipfs://probe.eth/', 'probe.eth');

  await navigateTo(window, 'https://start.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/start\.example/);
  await navigateTo(window, 'probe.eth');
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toMatch(/^ipfs:\/\/probe\.eth/);

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
  await expect
    .poll(() => webviewUrl(window), { timeout: 2_000 })
    .not.toMatch(/pages\/ens-conflict\.html/);
  await expect(window.locator('#forward-btn')).toBeEnabled();
  await window.screenshot({ path: testInfo.outputPath('7-traversal-not-hijacked.png') });
});

test('a traversal onto about:blank cannot raise the interstitial of the entry it leaves', async ({
  window,
  harness,
}, testInfo) => {
  // `did-navigate` deliberately does not write `committedDisplayUrl` for an
  // `about:blank` commit (Chromium fires one through it during "open in new
  // window", and clobbering the commit there would lose the real page
  // identity). The refresh keys on `committedDisplayUrl`, so reporting such a
  // commit as a traversal handed it the entry the traversal had just *left*:
  // Forward onto an `about:blank` entry re-resolved the outgoing name, found
  // it now in conflict, and loaded `ens-conflict.html?name=traversal.eth`
  // over the traversal — forward history gone, address bar back on the name
  // the user had just navigated away from.
  await harness.setEnsFixture('traversal.eth', UNVERIFIED_FIRST_LOAD);
  await harness.setContentFixture('ipfs://traversal.eth/', {
    body: '<html><body><h1>traversal.eth</h1><a id="blank" href="about:blank">blank</a></body></html>',
  });

  await navigateTo(window, 'https://start.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/start\.example/);
  await navigateTo(window, 'traversal.eth');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);

  // A user-activated link to about:blank, so the blank document is a real
  // history entry between the ENS page and the forward end of the stack.
  await window.evaluate(() => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    // `userGesture: true` matters: without one Chromium treats the
    // JS-initiated hop as a client redirect and *replaces* the ENS entry
    // instead of pushing the blank one after it.
    return wv.executeJavaScript("document.getElementById('blank').click()", true);
  });
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe('about:blank');

  // Back onto the ENS entry. That traversal legitimately refreshes its trust,
  // so the fixture is swapped to a *different verified* answer first and the
  // badge flip is waited on: it is how this test knows that refresh has
  // settled before the conflict verdict below is armed, instead of racing an
  // in-flight resolution that would raise the interstitial on the entry the
  // user is actually standing on.
  await harness.setEnsFixture('traversal.eth', VERIFIED_AFTER_SETTINGS_CHANGE);
  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await expect(window.locator('#trust-shield')).toHaveAttribute('data-trust', 'verified', {
    timeout: 15_000,
  });

  // Now the verdict for that name flips to conflict.
  await harness.setEnsFixture('traversal.eth', {
    type: 'conflict',
    trust: { level: 'conflict', block: { number: 21000000 } },
    groups: [
      { value: '0xaa', sources: ['rpc-one.test'] },
      { value: '0xbb', sources: ['rpc-two.test'] },
    ],
  });

  // Forward onto the blank entry: it is what commits, and it stays committed.
  await window.click('#forward-btn');
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe('about:blank');
  // The refresh settles a beat after the commit, so the blank entry has to be
  // observed *still* standing rather than merely reached: a plain
  // `.not.toMatch()` poll is satisfied by the very first read, before the
  // interstitial this guards against could have been loaded over it.
  await window.waitForTimeout(3_000);
  expect(await webviewUrl(window)).toBe('about:blank');
  // The entry behind this one is still reachable — an interstitial load here
  // would have pushed a fresh entry over the restored one — and the address
  // bar is not showing the bare-name display an ENS interstitial paints
  // (#235), which is how the hijack read to the user.
  await expect(window.locator('#back-btn')).toBeEnabled();
  await expect(window.locator('[data-test="address-input"]')).not.toHaveValue('traversal.eth');
  await window.screenshot({ path: testInfo.outputPath('8-blank-traversal-not-hijacked.png') });
});

test('a refreshed verdict for a transport the entry did not ask for gets no badge', async ({
  window,
  harness,
}, testInfo) => {
  // `loadTarget` refuses an `ok` result whose transport contradicts the scheme
  // the entry asserts — a `bzz://name.eth/` load must resolve to a Swarm
  // contenthash — and never writes a badge over content it refused. The
  // traversal refresh has to reach the same verdict: the restored entry's
  // bytes are whatever the handler served for the *old* record, so a fresh
  // "verified" for a different transport says nothing about what is on
  // screen. Before the fix it painted the green verified shield anyway.
  await harness.setEnsFixture('traversal.eth', {
    type: 'ok',
    protocol: 'bzz',
    decoded: 'b'.repeat(64),
    uri: `bzz://${'b'.repeat(64)}`,
    trust: { level: 'user-configured', method: 'direct-rpc', agreed: ['rpc.mine.test'] },
  });
  await harness.setContentFixture('bzz://traversal.eth/', {
    body: '<html><body><h1>traversal.eth over Swarm</h1></body></html>',
  });
  const shield = window.locator('#trust-shield');

  await navigateTo(window, 'bzz://traversal.eth/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^bzz:\/\/traversal\.eth/);
  await expect(shield).toHaveAttribute('data-trust', 'user-configured');

  await navigateTo(window, 'https://example.com/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/example\.com/);

  // The contenthash has since moved to IPFS — and the new answer is verified,
  // so the only thing keeping the badge off is the transport check itself.
  await harness.setEnsFixture('traversal.eth', VERIFIED_AFTER_SETTINGS_CHANGE);

  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^bzz:\/\/traversal\.eth/);
  // The shield goes quiet rather than vouching for the Swarm bytes on screen
  // with a verdict about an IPFS contenthash…
  await expect(shield).toBeHidden({ timeout: 15_000 });
  // …and the restored entry itself stays put, with its forward history.
  expect(await webviewUrl(window)).toMatch(/^bzz:\/\/traversal\.eth/);
  await expect(window.locator('#forward-btn')).toBeEnabled();
  await window.screenshot({ path: testInfo.outputPath('9-transport-mismatch-no-badge.png') });
});

// The other half of "a refresh that settles late must not navigate the guest":
// a navigation the user has asked for but that has not *committed* yet. The
// commit counter cannot see one — nothing committed — so a blocking verdict
// settling inside that window used to `loadURL` its interstitial straight over
// the pending load, cancelling it and taking the forward history with it.
const CONFLICT_IN_FLIGHT = {
  type: 'conflict',
  trust: { level: 'conflict', block: { number: 21000000 } },
  groups: [
    { value: '0xaa', sources: ['rpc-one.test'] },
    { value: '0xbb', sources: ['rpc-two.test'] },
  ],
  // Settles well after the traversal below commits, and well before the slow
  // page the user is waiting on does. Both margins are wide (seconds, not
  // hundreds of ms) on purpose: the window being tested is bounded on one side
  // by how long the runner takes to register the *next* click, and a narrow
  // margin there flakes under load rather than failing honestly.
  delayMs: 5_000,
};

test('a verdict settling mid-traversal does not cancel the Back the user is waiting on', async ({
  window,
  harness,
}, testInfo) => {
  // Deliberately slow: the fixture delays below are what hold a navigation
  // open long enough for a verdict to settle over it, so the budget has to
  // cover them with room for a loaded runner.
  test.setTimeout(60_000);
  await seedEnsPage(harness);
  // The entry the second Back restores: genuinely still fetching when the
  // conflict verdict lands. `no-store` keeps the traversal a real fetch rather
  // than an instant cache hit, which is what makes the window observable.
  await harness.setContentFixture('ipfs://slowstart/', {
    body: '<html><body><h1>slow start</h1></body></html>',
    headers: { 'Cache-Control': 'no-store' },
  });

  await navigateTo(window, 'ipfs://slowstart/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/slowstart/);
  await navigateTo(window, 'traversal.eth');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await navigateTo(window, 'https://after.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/after\.example/);

  // The resolvers now disagree about the name, and take a beat to say so —
  // and the entry behind the ENS one is now slow to serve, so the second Back
  // below is genuinely still in flight when that verdict lands. `no-store`
  // keeps the traversal a real fetch rather than an instant cache hit, which
  // is what makes the window observable at all.
  await harness.setEnsFixture('traversal.eth', CONFLICT_IN_FLIGHT);
  await harness.setContentFixture('ipfs://slowstart/', {
    body: '<html><body><h1>slow start</h1></body></html>',
    headers: { 'Cache-Control': 'no-store' },
    delayMs: 8_000,
  });

  // Back onto the ENS entry — which starts the refresh — then Back again
  // immediately, toward the slow entry, without waiting for that refresh.
  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await window.click('#back-btn');

  // The second traversal completes: the verdict landed while it was in flight
  // and left it alone.
  await expect
    .poll(() => webviewUrl(window), { timeout: 20_000 })
    .toMatch(/^ipfs:\/\/slowstart/);
  // …and stays completed — an interstitial loaded over it would arrive after
  // this URL first reads correctly, so it has to be observed still standing.
  await window.waitForTimeout(1_500);
  expect(await webviewUrl(window)).toMatch(/^ipfs:\/\/slowstart/);
  // The forward history the traversal restored is intact (both entries ahead
  // are still reachable), and the address bar is not showing the bare-name
  // display an ENS interstitial paints.
  await expect(window.locator('#forward-btn')).toBeEnabled();
  await expect(window.locator('[data-test="address-input"]')).not.toHaveValue('traversal.eth');
  await window.screenshot({ path: testInfo.outputPath('10-pending-back-not-cancelled.png') });
});

test('a verdict settling mid-resolution does not interrupt a URL the user entered', async ({
  window,
  harness,
}, testInfo) => {
  // The same window, opened by the *chrome* rather than by Chromium: a name
  // entered in the address bar spends its resolution with no navigation
  // started yet, so `loadTarget` records the intent itself. Without that, the
  // conflict interstitial for the entry being left behind loaded over the page
  // the user was waiting on.
  test.setTimeout(60_000);
  await seedEnsPage(harness);
  await harness.setEnsFixture('other.eth', {
    type: 'ok',
    protocol: 'ipfs',
    decoded: 'QmOtherPage',
    uri: 'ipfs://QmOtherPage',
    trust: { level: 'verified', method: 'colibri', queried: ['colibri'], agreed: ['colibri'] },
    // Outlasts the conflict verdict above by a wide margin, so the check below
    // lands squarely inside this name's own resolution.
    delayMs: 9_000,
  });
  await harness.setContentFixture('ipfs://other.eth/', {
    body: '<html><body><h1>other.eth</h1></body></html>',
  });

  await navigateTo(window, 'traversal.eth');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await navigateTo(window, 'https://after.example/');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^https:\/\/after\.example/);
  await harness.setEnsFixture('traversal.eth', CONFLICT_IN_FLIGHT);

  await window.click('#back-btn');
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(/^ipfs:\/\/traversal\.eth/);
  await navigateTo(window, 'other.eth');

  // Past the conflict verdict, still inside the entered name's own
  // resolution: the guest is where the user left it, not on an interstitial.
  await window.waitForTimeout(6_500);
  expect(await webviewUrl(window)).not.toMatch(/pages\/ens-conflict\.html/);

  await expect
    .poll(() => webviewUrl(window), { timeout: 20_000 })
    .toMatch(/^ipfs:\/\/other\.eth/);
  await expect(window.locator('#trust-shield')).toHaveAttribute('data-trust', 'verified');
  await window.screenshot({ path: testInfo.outputPath('11-entered-url-not-interrupted.png') });
});
