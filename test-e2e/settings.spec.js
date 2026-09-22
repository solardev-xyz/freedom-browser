// Settings — verify that the saveSettings IPC + the renderer's
// settings:updated subscription combine to flip theme classes on the
// document. The on-disk settings page lives at freedom://settings and
// is rendered inside a webview; we drive the same IPC it would call,
// which exercises the same end-to-end pipeline without coupling the
// spec to the page's internal markup.

const { test, expect } = require('./fixtures');

const settingsEval = (window, script) =>
  window.evaluate(async (source) => {
    const webview = [...document.querySelectorAll('webview')].find((candidate) => {
      try {
        return /settings/.test(candidate.getURL() || '');
      } catch {
        return false;
      }
    });
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    return webview.executeJavaScript(source);
  }, script);

test('switching theme to "light" sets data-theme on <html>', async ({ window }) => {
  // Default theme is "system"; on macOS dark-mode CI this would be dark
  // (no data-theme attribute). Drive an explicit transition to "light".
  await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

  await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'dark' }));

  // Dark mode removes the data-theme attribute (root selector applies
  // by default). We assert that toHaveAttribute fails — the attribute
  // is absent.
  await expect(window.locator('html')).not.toHaveAttribute('data-theme', 'light');
});

test('saveSettings persists across renderer reload', async ({ window }) => {
  await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Radicle is first-class, profile-visible, and opt-in at startup', async ({
  window,
  electronApp,
}) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/startup');
  await input.press('Enter');

  let settingsPage;
  await expect
    .poll(() => {
      settingsPage = electronApp
        .windows()
        .find((page) => page.url().includes('/pages/settings.html'));
      return Boolean(settingsPage);
    })
    .toBe(true);

  await expect(settingsPage.locator('#enable-radicle-integration')).toHaveCount(0);
  await expect(settingsPage.locator('#radicle-launch-row')).toBeVisible();
  const startAtLaunch = settingsPage.locator('#start-radicle-at-launch');
  // Toggle inputs are visually hidden by the custom slider CSS. Dispatch the
  // same change events their visible labels produce.
  const setRadicleStartup = (value) =>
    settingsPage.evaluate((checked) => {
      const field = document.getElementById('start-radicle-at-launch');
      field.checked = checked;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  await setRadicleStartup(true);
  await expect(startAtLaunch).toBeChecked();

  await expect
    .poll(() =>
      window.evaluate(async () => {
        const settings = await window.electronAPI.getSettings();
        return settings.startRadicleAtLaunch;
      })
    )
    .toBe(true);

  await settingsPage.evaluate(() => {
    location.hash = '#nodes';
  });
  const radicleNodeRow = settingsPage.locator('.profile-node[data-protocol="radicle"]');
  await expect(radicleNodeRow).toHaveCount(1);
  await expect(radicleNodeRow).toBeVisible();
  // The Tor rows follow the bundled Arti binary, not the platform (#337):
  // the Experimental rows are up on any build that bundles one, and the Nodes
  // row appears once the integration is enabled — on every platform.
  const [torBundled, torEnabled] = await settingsPage.evaluate(async () => {
    const [binary, settings] = await Promise.all([
      window.freedomAPI.checkTorBinary(),
      window.freedomAPI.getSettings(),
    ]);
    return [binary?.available === true, settings?.enableTorIntegration === true];
  });
  await expect(settingsPage.locator('.profile-node[data-protocol="tor"]')).toHaveCount(
    torEnabled ? 1 : 0
  );
  await settingsPage.evaluate(() => {
    location.hash = '#experimental';
  });
  const torExperimentalRow = settingsPage.locator('[data-tor]').first();
  if (torBundled) {
    await expect(torExperimentalRow).toBeVisible();
  } else {
    await expect(torExperimentalRow).toBeHidden();
  }

  // Leave the shared fixture in its default state for later specs.
  await setRadicleStartup(false);
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const settings = await window.electronAPI.getSettings();
        return settings.startRadicleAtLaunch;
      })
    )
    .toBe(false);
});

test('name resolution methods can be reordered, enabled, and persisted as one policy', async ({
  window,
}) => {
  await window.evaluate(() => document.getElementById('settings-btn')?.click());
  await settingsEval(window, `location.hash = 'ens'`);
  await expect
    .poll(() => settingsEval(window, `document.querySelectorAll('[data-method]').length`))
    .toBe(4);

  const initial = await settingsEval(
    window,
    `({
      order: [...document.querySelectorAll('[data-method]')].map((row) => row.dataset.method),
      direct: document.querySelector('[data-method-enabled="direct"]').checked,
      preferVerified: document.getElementById('ens-prefer-verified').checked,
      draggable: document.querySelector('[data-drag-handle="colibri"]').draggable,
      moveButtons: document.querySelectorAll('[data-move]').length,
      myotisNodeSettings: document.querySelector('[data-method="myotis"] a').getAttribute('href')
    })`
  );
  expect(initial).toEqual({
    order: ['myotis', 'colibri', 'quorum', 'direct'],
    direct: false,
    preferVerified: true,
    draggable: true,
    moveButtons: 0,
    myotisNodeSettings: '#nodes',
  });

  await expect
    .poll(() =>
      settingsEval(
        window,
        `({
          badge: document.querySelector('[data-method-status="myotis"]').textContent,
          startupDisabled: document.getElementById('start-myotis-at-launch').disabled,
          startupHelp: document.getElementById('myotis-launch-help').textContent
        })`
      )
    )
    .toMatchObject({
      badge: 'Ready',
      startupDisabled: false,
    });
  const startupHelp = await settingsEval(
    window,
    `document.getElementById('myotis-launch-help').textContent`
  );
  expect(startupHelp).not.toContain('Addon not installed');

  const nodeSettingsHash = await settingsEval(
    window,
    `(() => {
      document.querySelector('[data-method="myotis"] a').click();
      return location.hash;
    })()`
  );
  expect(nodeSettingsHash).toBe('#nodes');
  await settingsEval(window, `location.hash = 'ens'`);

  await settingsEval(
    window,
    `(() => {
      const transfer = new DataTransfer();
      const handle = document.querySelector('[data-drag-handle="colibri"]');
      const target = document.querySelector('[data-method="quorum"]');
      const bounds = target.getBoundingClientRect();
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: bounds.bottom - 1,
        dataTransfer: transfer
      }));
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: bounds.bottom - 1,
        dataTransfer: transfer
      }));

      const quorumK = document.querySelector('[data-quorum-field="k"]');
      quorumK.value = '5';
      quorumK.dispatchEvent(new Event('change', { bubbles: true }));
      const quorumM = document.querySelector('[data-quorum-field="m"]');
      quorumM.value = '3';
      quorumM.dispatchEvent(new Event('change', { bubbles: true }));

      const direct = document.querySelector('[data-method-enabled="direct"]');
      direct.checked = true;
      direct.dispatchEvent(new Event('change', { bubbles: true }));
      const prefer = document.getElementById('ens-prefer-verified');
      prefer.checked = false;
      prefer.dispatchEvent(new Event('change', { bubbles: true }));
      const safety = document.getElementById('unverified-ens-action');
      safety.value = 'open';
      safety.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );

  await expect
    .poll(() =>
      settingsEval(
        window,
        `Promise.all([window.freedomAPI.getNetworkConfig(), window.freedomAPI.getSettings()])
          .then(([network, settings]) => ({
            verification: network.networks['1'].verification,
            quorum: network.networks['1'].quorum,
            blockUnverifiedEns: settings.blockUnverifiedEns
          }))`
      )
    )
    .toMatchObject({
      verification: {
        primary: 'quorum',
        order: ['myotis', 'quorum', 'colibri', 'direct'],
        preferVerified: false,
      },
      quorum: {
        k: 5,
        m: 3,
      },
      blockUnverifiedEns: false,
    });
});

test('Ethereum and Gnosis expose verified chain sources and independent Myotis startup', async ({
  window,
}) => {
  await window.evaluate(() => document.getElementById('settings-btn')?.click());
  await expect
    .poll(() => settingsEval(window, `location.hash = 'chains/100'; location.hash`))
    .toBe('#chains/100');

  await expect
    .poll(() =>
      settingsEval(
        window,
        `([...document.querySelectorAll('[data-access-kind="read"]')].map((row) => ({
          source: row.dataset.accessSource,
          status: row.querySelector('.resolver-badge').textContent
        })))`
      )
    )
    .toEqual([
      { source: 'myotis', status: 'Off' },
      { source: 'colibri', status: 'Available' },
      { source: 'quorum', status: '2 of 3 · 4 available' },
      { source: 'direct', status: '4 available' },
    ]);

  const gnosis = await settingsEval(
    window,
    `({
      prover: document.querySelector('[data-chain-prover="100"]').value,
      broadcast: [...document.querySelectorAll('[data-access-kind="broadcast"]')]
        .map((row) => row.dataset.accessSource),
      startupDisabled: document.getElementById('start-myotis-gnosis-at-launch').disabled
    })`
  );
  expect(gnosis).toEqual({
    prover: 'https://gnosis.colibri-proof.tech',
    broadcast: ['myotis', 'direct'],
    startupDisabled: false,
  });

  await settingsEval(
    window,
    `(() => {
      const toggle = document.getElementById('start-myotis-gnosis-at-launch');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    })()`
  );
  await expect
    .poll(() =>
      settingsEval(
        window,
        `window.freedomAPI.getSettings().then((settings) => settings.startMyotisGnosisAtLaunch)`
      )
    )
    .toBe(true);

  await settingsEval(
    window,
    `(() => {
      const transfer = new DataTransfer();
      const direct = document.querySelector('[data-access-kind="read"][data-access-source="direct"]');
      const myotis = document.querySelector('[data-access-kind="read"][data-access-source="myotis"]');
      direct.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      myotis.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      myotis.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    })()`
  );

  await expect
    .poll(() =>
      settingsEval(
        window,
        `window.freedomAPI.getNetworkConfig().then((result) =>
          result.networks['100'].access.readOrder)`
      )
    )
    .toEqual(['direct', 'myotis', 'colibri', 'quorum']);
});

test('custom-chain access order can be reordered from its rendered defaults', async ({ window }) => {
  await window.evaluate(() => document.getElementById('settings-btn')?.click());
  await expect
    .poll(() => settingsEval(window, `typeof window.freedomAPI?.addChain`))
    .toBe('function');
  const added = await settingsEval(
    window,
    `window.freedomAPI.addChain({
      chainId: 777,
      name: 'CustomNet',
      nativeCurrency: { name: 'Custom', symbol: 'CUS', decimals: 18 }
    }, ['https://rpc.custom.example'])`
  );
  expect(added).toMatchObject({ success: true });
  await expect
    .poll(() => settingsEval(window, `location.hash = 'chains/777'; location.hash`))
    .toBe('#chains/777');
  await expect
    .poll(() =>
      settingsEval(
        window,
        `[...document.querySelectorAll('[data-access-kind="read"]')]
          .map((row) => row.dataset.accessSource)`
      )
    )
    .toEqual(['colibri', 'quorum', 'direct']);

  await settingsEval(
    window,
    `(() => {
      const transfer = new DataTransfer();
      const direct = document.querySelector('[data-access-kind="read"][data-access-source="direct"]');
      const quorum = document.querySelector('[data-access-kind="read"][data-access-source="quorum"]');
      direct.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      quorum.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      quorum.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    })()`
  );

  await expect
    .poll(() =>
      settingsEval(
        window,
        `window.freedomAPI.getNetworkConfig().then((result) =>
          result.networks['777'].access.readOrder)`
      )
    )
    .toEqual(['colibri', 'direct', 'quorum']);
});

// The settings page loads in a webview: `settingsEval` returns null until it
// is there, so every pass below waits for the nav to render first.
const openSettings = async (window, expect) => {
  await window.evaluate(() => document.getElementById('settings-btn')?.click());
  await expect
    .poll(() => settingsEval(window, `document.querySelectorAll('.nav-item').length`), {
      timeout: 15_000,
    })
    .toBe(14);
};

// ---------------------------------------------------------------------------
// The copy and control-style findings of the 2026-09 settings UX audit, pinned
// against what the running page renders. `settings-copy.test.js` pins the same
// rules statically; these are the ones only the rendered page can answer —
// the two sections whose heading comes from a view template, the Shortcuts
// rows built from the IPC state, and the classes on a chain detail.
// ---------------------------------------------------------------------------

// #276: clicking a nav item has to land you on a page with that item's name.
test('every nav item opens a section titled with its own label', async ({ window }) => {
  await openSettings(window, expect);
  const items = await settingsEval(
    window,
    `[...document.querySelectorAll('.nav-item')].map((item) => ({
      target: item.dataset.target,
      label: item.textContent.trim()
    }))`
  );
  expect(items.length).toBe(14);

  for (const { target, label } of items) {
    await settingsEval(window, `location.hash = '${target}'`);
    await expect
      .poll(() =>
        settingsEval(
          window,
          `(() => {
            const section = document.getElementById('${target}');
            if (!section || section.classList.contains('hidden')) return null;
            const heading = section.querySelector('h2.section-title');
            return heading ? heading.textContent.trim() : null;
          })()`
        )
      )
      // Startup used to open "Automatic Startup" and Name Resolution
      // "Ethereum Name Resolution"; Chains and RPC Providers render their
      // heading from a view template, so only this pass sees them.
      .toBe(label);
  }
});

// #277: Shortcuts was the only section whose row labels were Title Case,
// because they are the registry's menu strings.
test('Shortcuts rows are sentence case, and search reads the label it shows', async ({
  window,
}) => {
  await openSettings(window, expect);
  await settingsEval(window, `location.hash = 'shortcuts'`);

  const labels = () =>
    settingsEval(
      window,
      `[...document.querySelectorAll('#shortcuts-view .row .row-label')].map((el) => el.textContent.trim())`
    );
  await expect.poll(async () => (await labels()).length).toBeGreaterThan(20);

  const rendered = await labels();
  expect(rendered).toContain('New tab');
  expect(rendered).toContain('Actual size');
  expect(rendered).toContain('App developer tools');
  // Sentence case: nothing after the first word carries a capital, the same
  // bar every other row label on the page already meets.
  const titleCased = rendered.filter((label) =>
    label
      .split(' ')
      .slice(1)
      .some((word) => /^[A-Z]/.test(word))
  );
  expect(titleCased).toEqual([]);

  // The filter has to match what the row shows, not the string it replaced.
  await settingsEval(
    window,
    `(() => {
      const search = document.getElementById('shortcut-search');
      search.value = 'new tab';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await expect.poll(labels).toEqual(['New tab']);
  await settingsEval(
    window,
    `(() => {
      const search = document.getElementById('shortcut-search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
});

// #278: a glyph inside a button's text is part of its accessible name — a
// screen reader said "plus Add a chain" and "Manage all profiles right arrow".
// #284: and one rule for which removals are red, on the chain detail too.
test('no rendered control bakes a glyph into its label, and removals follow the rule', async ({
  window,
}) => {
  await openSettings(window, expect);
  const targets = await settingsEval(
    window,
    `[...document.querySelectorAll('.nav-item')].map((item) => item.dataset.target)`
  );

  const glyphs = [];
  for (const target of targets) {
    await settingsEval(window, `location.hash = '${target}'`);
    await expect
      .poll(() =>
        settingsEval(window, `!document.getElementById('${target}').classList.contains('hidden')`)
      )
      .toBe(true);
    glyphs.push(
      ...(await settingsEval(
        window,
        `[...document.querySelectorAll('.section:not(.hidden) button, .section:not(.hidden) a')]
          .map((el) => (el.innerText || el.textContent || '').trim())
          .filter((label) => label.startsWith('+') || label.includes('→') || label.includes('✕'))`
      ))
    );
  }
  expect(glyphs).toEqual([]);

  // A custom chain is the one that can be removed, and the one that can carry
  // a custom RPC endpoint — the two controls the finding split.
  await expect
    .poll(() => settingsEval(window, `typeof window.freedomAPI?.addChain`))
    .toBe('function');
  await settingsEval(
    window,
    `window.freedomAPI.addChain({
      chainId: 424242,
      name: 'GlyphNet',
      nativeCurrency: { name: 'Glyph', symbol: 'GLY', decimals: 18 }
    }, ['https://rpc.glyph.example'])`
  );
  // A user-added endpoint is the removable one — the chain's own `rpcUrls`
  // render as built-in toggles, not as a row with a Remove.
  await settingsEval(
    window,
    `window.freedomAPI.upsertEndpointSource('user-glyph', {
      role: 'rpc',
      keyed: false,
      coverage: { '424242': 'https://rpc.glyph.example/user' }
    })`
  );
  await expect
    .poll(() => settingsEval(window, `location.hash = 'chains/424242'; location.hash`))
    .toBe('#chains/424242');

  await expect
    .poll(() =>
      settingsEval(
        window,
        `[...document.querySelectorAll('#chains-view button[data-action]')]
          .filter((btn) => ['remove-chain', 'delete-source', 'add-endpoint'].includes(btn.dataset.action))
          .map((btn) => ({ action: btn.dataset.action, cls: btn.className, label: btn.textContent.trim() }))`
      )
    )
    .toEqual(
      expect.arrayContaining([
        // Discards the chain and its endpoints, and cannot be undone here.
        { action: 'remove-chain', cls: 'btn danger', label: 'Remove this chain' },
        // One endpoint, re-addable from this same view — plain, and it says
        // the verb its six siblings say rather than a bare glyph.
        { action: 'delete-source', cls: 'btn', label: 'Remove' },
        { action: 'add-endpoint', cls: 'btn', label: 'Add RPC' },
      ])
    );

  // The chevron is decorative, so a chain row announces as the chain.
  await settingsEval(window, `location.hash = 'chains'`);
  await expect
    .poll(() =>
      settingsEval(
        window,
        `[...document.querySelectorAll('#chains-view .net-chevron')]
          .every((el) => el.getAttribute('aria-hidden') === 'true')`
      )
    )
    .toBe(true);

  // Leave the shared fixture as it was found.
  await settingsEval(window, `window.freedomAPI.removeEndpointSource('user-glyph')`);
  await settingsEval(window, `window.freedomAPI.removeChain('424242')`);
});

// ---------------------------------------------------------------------------
// #281: Settings had exactly one search field and it searched one section
// (the Shortcuts list), so a user who found it reasonably concluded Settings
// has no search. The page-wide field has to find a control by a word in its
// label wherever it lives — Tor's startup toggle is under Experimental, not
// Startup — say which section that is, take you there, and get out of the way
// on Escape. The matcher itself is unit-tested in
// `src/renderer/pages/settings-search.test.js`; this is the live DOM, which
// is the only place the sections rendered from IPC state exist.
// ---------------------------------------------------------------------------
test.describe('Search settings (#281)', () => {
  // Enabling the Tor integration is what keeps the two `[data-tor]` rows on
  // a build that bundles no Arti binary, so this leg reads the same on a
  // release checkout and on a source tree that skipped `npm run tor:download`
  // (the search index skips a row the page has switched off).
  test.use({ seedSettings: { enableTorIntegration: true } });

  test('finds a setting in a section you would not guess, reveals it, clears on Escape', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    const field = page.locator('#settings-search');
    // The house style for a search placeholder, ellipsis included (#257).
    await expect(field).toHaveAttribute('placeholder', 'Search settings…');
    // The page opens on Appearance; the Shortcuts field is untouched and
    // still the only search inside a section.
    await expect(page.locator('#appearance')).toBeVisible();
    await expect(page.locator('#settings-search-results')).toBeHidden();
    await expect(page.locator('#start-tor-row')).toBeAttached();

    await field.click();
    await field.pressSequentially('tor');

    // The results replace whichever section was open, the way Chrome's do.
    await expect(page.locator('#settings-search-results')).toBeVisible();
    await expect(page.locator('#appearance')).toBeHidden();

    const results = page.locator('#settings-search-list .settings-search-result');
    await expect(results.first()).toBeVisible();
    const startTor = results.filter({ hasText: 'Start Tor when Freedom opens' });
    await expect(startTor).toHaveCount(1);
    // Which is the whole point: the result says where the setting lives.
    await expect(startTor.locator('.settings-search-section')).toHaveText('Experimental');
    await expect(page.locator('#settings-search-summary')).toContainText('match “tor”');

    await startTor.click();

    // Clicking it opens Experimental — the section the row is really in —
    // and flashes the row itself, not just the section.
    await expect(page.locator('#experimental')).toBeVisible();
    await expect(page.locator('#settings-search-results')).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.getElementById('start-tor-row')?.classList.contains('settings-search-hit') ===
            true
        )
      )
      .toBe(true);
    expect(await page.evaluate(() => location.hash)).toBe('#experimental');
    // The row is on screen (its checkbox is the visually-hidden input behind
    // the slider, so the row is what "revealed" means here).
    await expect(page.locator('#start-tor-row')).toBeVisible();
    await expect(page.locator('#start-tor-at-launch')).toBeAttached();

    // Escape clears the field, drops the highlight, and hands back the
    // section the URL says is open.
    await field.click();
    await field.press('Escape');
    await expect(field).toHaveValue('');
    await expect(page.locator('#settings-search-results')).toBeHidden();
    await expect(page.locator('#experimental')).toBeVisible();
    expect(
      await page.evaluate(() => document.querySelectorAll('.settings-search-hit').length)
    ).toBe(0);

    // Escape works from inside the result list too, where the field's own
    // native clear-on-Escape cannot reach: ArrowDown hands the keyboard to
    // the first result, Escape hands it back to an empty field.
    await field.pressSequentially('tor');
    await expect(results.first()).toBeVisible();
    await field.press('ArrowDown');
    expect(
      await page.evaluate(() =>
        document.activeElement?.classList.contains('settings-search-result')
      )
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(field).toHaveValue('');
    await expect(page.locator('#settings-search-results')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-search');
  });

  test('Enter opens the top result, and the index reaches a section rendered from IPC state', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    // The Shortcuts rows are built from the shortcut registry over IPC, so
    // they exist only in the live DOM — the index is rebuilt from it on every
    // keystroke rather than snapshotted at load.
    await expect
      .poll(() => page.locator('#shortcuts-view .row .row-label').count())
      .toBeGreaterThan(20);

    const field = page.locator('#settings-search');
    await field.click();
    await field.pressSequentially('actual size');
    const results = page.locator('#settings-search-list .settings-search-result');
    await expect(results).toHaveCount(1);
    await expect(results.first().locator('.row-label')).toHaveText('Actual size');
    await expect(results.first().locator('.settings-search-section')).toHaveText('Shortcuts');

    await field.press('Enter');
    await expect(page.locator('#shortcuts')).toBeVisible();
    await expect(page.locator('#settings-search-results')).toBeHidden();
    expect(await page.evaluate(() => location.hash)).toBe('#shortcuts');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hit = document.querySelector('.settings-search-hit');
          return hit ? hit.querySelector('.row-label')?.textContent?.trim() : null;
        })
      )
      .toBe('Actual size');

    // A query that matches nothing says so rather than showing an empty card.
    await field.click();
    await field.fill('zzzznothing');
    await expect(page.locator('#settings-search-summary')).toHaveText(
      'No settings match “zzzznothing”.'
    );
    await expect(page.locator('#settings-search-list')).toBeHidden();

    // …and the Shortcuts section's own search still filters only that list.
    await field.press('Escape');
    await expect(page.locator('#shortcuts')).toBeVisible();
    const shortcutSearch = page.locator('#shortcut-search');
    await shortcutSearch.fill('actual size');
    await expect(page.locator('#shortcuts-view .row .row-label')).toHaveCount(1);
    await expect(page.locator('#settings-search-results')).toBeHidden();
  });

  // Name Resolution's method list and a chain's read order are drag-to-reorder
  // `.resolver-method` rows, not `.row`s, and they are where "Colibri",
  // "Myotis" and "RPC quorum" are named — the resolution policy would be
  // unsearchable if the index only read cards.
  test('a resolver method is findable by name, and reveals its own row', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    await page.evaluate(() => {
      location.hash = 'ens';
    });
    await expect.poll(() => page.locator('#ens-method-list .row-label').count()).toBeGreaterThan(2);
    // Then leave, so clicking the result is a real hash change — which is the
    // case that matters: Name Resolution rebuilds its method list from IPC
    // state on `hashchange`, *after* the jump has already run, replacing the
    // row the result was built from. The reveal has to land on the new one.
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();

    const field = page.locator('#settings-search');
    await field.click();
    await field.pressSequentially('colibri');
    const results = page.locator('#settings-search-list .settings-search-result');
    const colibri = results.filter({ hasText: 'Colibri' }).first();
    await expect(colibri.locator('.settings-search-section')).toHaveText('Name Resolution');

    await colibri.click();
    await expect(page.locator('#ens')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hit = document.querySelector('.settings-search-hit');
          return hit
            ? [hit.dataset.method, hit.querySelector('.row-label')?.textContent?.trim()]
            : null;
        })
      )
      .toEqual(['colibri', 'Colibri']);
  });

  // The two settings of the resolution policy itself — Colibri's prover
  // endpoint and the quorum agreement threshold — render as a
  // `.resolver-config` panel under the method they belong to, a third row
  // shape again. And the index has to skip a row the page switched off with
  // the `hidden` attribute (how the Myotis startup rows go on a build with no
  // Myotis support), not only one hidden through `style.display`.
  test('the resolver methods own settings are findable, and a switched-off row is not', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    await page.evaluate(() => {
      location.hash = 'ens';
    });
    await expect
      .poll(() => page.locator('#ens-method-list .resolver-config .row-label').count())
      .toBeGreaterThan(0);

    const field = page.locator('#settings-search');
    const results = page.locator('#settings-search-list .settings-search-result');

    // "Agreement threshold" is a word in no method's label — before this it
    // answered with nothing at all.
    await field.click();
    await field.pressSequentially('agreement');
    const threshold = results.filter({ hasText: 'Agreement threshold' });
    await expect(threshold).toHaveCount(1);
    await expect(threshold.locator('.settings-search-section')).toHaveText('Name Resolution');
    // The one-result summary agrees with its own count.
    await expect(page.locator('#settings-search-summary')).toHaveText(
      '1 setting matches “agreement”.'
    );
    await threshold.click();
    await expect(page.locator('#ens')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hit = document.querySelector('.settings-search-hit');
          return hit
            ? [hit.dataset.methodConfig, hit.querySelector('.row-label').textContent]
            : null;
        })
      )
      .toEqual(['quorum', 'Agreement threshold']);

    // …and "prover" reaches the endpoint field, not just the Colibri method
    // row whose help line happens to mention one.
    await field.click();
    await field.fill('');
    await field.pressSequentially('prover endpoint');
    const prover = results.filter({ hasText: 'Prover endpoint' });
    await expect(prover).toHaveCount(1);
    await prover.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('.settings-search-hit')
            ?.contains(document.getElementById('ens-prover-url'))
        )
      )
      .toBe(true);

    // The Myotis startup row, hidden the way `updateMyotis` hides it on a
    // build where Myotis is unsupported (`launchRow.hidden = !supported`): a
    // result for it would open Startup and mark a row with no box on screen.
    // Hidden, searched and read back inside one `evaluate`, because this
    // harness reports Myotis as supported and the page's own 5s status poll
    // would otherwise show the row again mid-assertion.
    expect(
      await page.evaluate(() => {
        const row = document.getElementById('myotis-launch-row');
        const search = document.getElementById('settings-search');
        row.hidden = true;
        search.value = 'start ethereum node';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const summary = document.getElementById('settings-search-summary').textContent;
        const count = document.querySelectorAll(
          '#settings-search-list .settings-search-result'
        ).length;
        row.hidden = false;
        return { summary, count };
      })
    ).toEqual({ summary: 'No settings match “start ethereum node”.', count: 0 });

    // Visible again, it is found — the skip reads the live row, and this is
    // the row the query is about.
    await field.click();
    await field.fill('');
    await field.pressSequentially('start ethereum node');
    const ethereumNode = results.filter({ hasText: 'Start Ethereum node' });
    await expect(ethereumNode).toHaveCount(1);
    await expect(ethereumNode.locator('.settings-search-section')).toHaveText('Startup');
  });

  // A label alone does not identify a row: a chain's detail page lists
  // "Direct RPC" once in its read and verification order and again in its
  // transaction broadcast order, and the reveal re-finds the row by what the
  // result carries — so both used to jump to the read-order row.
  test('two rows with the same label reveal the one that was clicked', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    await page.evaluate(() => {
      location.hash = 'chains/1';
    });
    await expect
      .poll(() => page.locator('#chains-view [data-access-kind="broadcast"]').count())
      .toBeGreaterThan(0);

    const field = page.locator('#settings-search');
    await field.click();
    await field.pressSequentially('direct rpc');
    const results = page.locator('#settings-search-list .settings-search-result');
    // Name Resolution names a "Direct RPC" method of its own; the two that
    // belong to this chain are the ambiguous pair.
    const chainResults = results.filter({
      has: page.locator('.settings-search-section', {
        hasText: 'Ethereum',
      }),
    });
    await expect(chainResults).toHaveCount(2);

    const revealed = () =>
      page.evaluate(() => {
        const hit = document.querySelector('.settings-search-hit');
        return hit ? [hit.dataset.accessKind, hit.querySelector('.row-label').textContent] : null;
      });

    // The second is the broadcast one, and clicking it marks that row.
    await chainResults.nth(1).click();
    await expect(page.locator('#chains')).toBeVisible();
    await expect.poll(revealed).toEqual(['broadcast', 'Direct RPC']);

    // …and the first still marks the read-order row, so the fix did not just
    // move the collapse onto the other one. (A jump leaves the query in the
    // field, the way Chrome does, so searching again starts by clearing it.)
    await field.click();
    await field.fill('');
    await field.pressSequentially('direct rpc');
    await expect(chainResults).toHaveCount(2);
    await chainResults.nth(0).click();
    await expect.poll(revealed).toEqual(['read', 'Direct RPC']);
  });

  // The index is built from every section's live DOM, hidden ones included —
  // which is what makes a setting findable before you have ever opened the
  // section it is in. The cost is that a section left painted in a state the
  // URL has moved on from goes on answering for itself: a visited chain's
  // detail used to sit parked in the hidden Chains section for the rest of
  // the session, offering that chain's endpoint rows as results that jump to
  // a chain list holding no such row, under an `<h2>` reading the chain's
  // name where "Chains" belongs. The section has to render itself back — and
  // so does its sibling, RPC Providers, whose own transient view state (a
  // provider's key field, opened by "Add key") was cleared on the way in but
  // not on the way out.
  test('a section you have left is not left painted in the state you left it in', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    // What a fresh page answers, before any chain detail has been opened.
    const search = (query) =>
      page.evaluate((q) => {
        const field = document.getElementById('settings-search');
        field.value = q;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return Array.from(
          document.querySelectorAll('#settings-search-list .settings-search-result'),
          (row) => [
            row.querySelector('.row-label').textContent,
            row.querySelector('.settings-search-section').textContent,
          ]
        );
      }, query);
    const control = { chains: await search('chains'), direct: await search('direct rpc') };
    expect(control.chains).toContainEqual(['Chains', 'Chains']);
    expect(control.direct).toEqual([['Direct RPC', 'Name Resolution']]);
    await page.evaluate(() => {
      const field = document.getElementById('settings-search');
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Open Ethereum's detail, wait for it to paint, then leave.
    await page.evaluate(() => {
      location.hash = 'chains/1';
    });
    await expect
      .poll(() => page.locator('#chains-view [data-access-kind="broadcast"]').count())
      .toBeGreaterThan(0);
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();

    // The hidden section is back to the list it would show if you opened it.
    await expect
      .poll(() => page.locator('#chains-view .section-title').textContent())
      .toBe('Chains');
    expect(await page.locator('#chains-view [data-access-kind]').count()).toBe(0);

    // …so the search reads exactly as it did before the detour: no stale
    // endpoint rows, and "chains" still reaches the Chains section.
    expect(await search('direct rpc')).toEqual(control.direct);
    expect(await search('chains')).toEqual(control.chains);
    expect(await search('ethereum.publicnode.com')).toEqual([]);

    // And the list is not a one-way door: the detail still opens.
    await page.evaluate(() => {
      const field = document.getElementById('settings-search');
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      location.hash = 'chains/1';
    });
    await expect
      .poll(() => page.locator('#chains-view [data-access-kind="broadcast"]').count())
      .toBeGreaterThan(0);

    // The sibling: an abandoned "Add key" edit does not stay open in the
    // hidden RPC Providers section with whatever was typed into it.
    await page.evaluate(() => {
      location.hash = 'rpc';
    });
    await expect
      .poll(() => page.locator('#rpc-view [data-action="edit-key"]').count())
      .toBeGreaterThan(0);
    await page.locator('#rpc-view [data-action="edit-key"][data-id="alchemy"]').click();
    await expect(page.locator('#pkey-alchemy')).toBeVisible();
    await page.locator('#pkey-alchemy').fill('secret-key');
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();
    await expect(page.locator('#pkey-alchemy')).toHaveCount(0);
  });

  // The same contract from the other side: Shortcuts does not park a
  // sub-route's view, it *removes rows*. Its own "Search shortcuts…" filter
  // re-renders the section with the matches alone, so a filter still applied
  // takes every shortcut it excludes out of the page-wide index — "zoom"
  // answering "No settings match" for the rest of the session, and a filter
  // that matched nothing taking the whole section with it. A filter is a
  // query, not an edit, so it goes whenever this view is not the one on
  // screen: on the way out of the section, and before the page-wide field
  // reads the page — which it can do without the hash ever changing, since
  // the results panel covers the section in place.
  test('a shortcuts filter never takes the shortcuts it hides out of the search', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    const search = (query) =>
      page.evaluate((q) => {
        const field = document.getElementById('settings-search');
        field.value = q;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return Array.from(
          document.querySelectorAll('#settings-search-list .settings-search-result'),
          (row) => [
            row.querySelector('.row-label').textContent,
            row.querySelector('.settings-search-section').textContent,
          ]
        );
      }, query);
    const clearSearch = () =>
      page.evaluate(() => {
        const field = document.getElementById('settings-search');
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const filterShortcuts = (query) =>
      page.evaluate((q) => {
        const field = document.getElementById('shortcut-search');
        field.value = q;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }, query);

    await page.evaluate(() => {
      location.hash = 'shortcuts';
    });
    await expect.poll(() => page.locator('#shortcuts-view .row').count()).toBeGreaterThan(1);
    const rows = await page.locator('#shortcuts-view .row').count();
    const control = { zoom: await search('zoom'), newTab: await search('new tab') };
    expect(control.zoom).toEqual([
      ['Zoom in', 'Shortcuts'],
      ['Zoom out', 'Shortcuts'],
    ]);
    expect(control.newTab).toContainEqual(['New tab', 'Shortcuts']);
    await clearSearch();

    // Filtered down to one row, then left behind: the hidden section is back
    // to the full list and answers as it did before.
    await filterShortcuts('find');
    expect(await page.locator('#shortcuts-view .row').count()).toBeLessThan(rows);
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();
    expect(await page.locator('#shortcuts-view .row').count()).toBe(rows);
    expect(await page.inputValue('#shortcut-search')).toBe('');
    expect(await search('zoom')).toEqual(control.zoom);
    await clearSearch();

    // A filter matching nothing renders an empty-state card in place of every
    // row, so it used to take the whole section out of the index with it.
    await page.evaluate(() => {
      location.hash = 'shortcuts';
    });
    await filterShortcuts('no shortcut is called this');
    await expect(page.locator('#shortcuts-view .profile-node-empty')).toBeVisible();
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();
    expect(await search('new tab')).toEqual(control.newTab);
    await clearSearch();

    // …and without leaving at all: the page-wide field covers the section in
    // place, changing no hash, and still reads it unfiltered.
    await page.evaluate(() => {
      location.hash = 'shortcuts';
    });
    await filterShortcuts('find');
    expect(await search('zoom')).toEqual(control.zoom);
    await clearSearch();
    await expect(page.locator('#shortcuts')).toBeVisible();
  });

  // A recording listens for `keydown` on `window` in the capture phase and
  // calls `preventDefault()` on everything it sees, so one left armed once the
  // user has moved on eats every keystroke on the page — the page-wide search
  // field included, which would then answer nothing because nothing reached
  // it.
  test('a shortcut recording left armed does not swallow the page-wide search', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    await page.evaluate(() => {
      location.hash = 'shortcuts';
    });
    await expect
      .poll(() => page.locator('#shortcuts-view .shortcut-binding').count())
      .toBeGreaterThan(0);

    // Arm a recording, then leave the section by hash (a nav click).
    await page.locator('#shortcuts-view .shortcut-binding').first().click();
    await expect(page.locator('#shortcuts-view .shortcut-binding.recording')).toHaveCount(1);
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();
    await expect(page.locator('#shortcuts-view .shortcut-binding.recording')).toHaveCount(0);

    const field = page.locator('#settings-search');
    await field.click();
    await page.keyboard.type('zoom');
    await expect(field).toHaveValue('zoom');
    await expect(
      page.locator('#settings-search-list .settings-search-result').first()
    ).toBeVisible();

    // Same again without leaving: the results panel covers the section in
    // place, so the recording has to stand down on the first key it sees
    // rather than eating it.
    await field.fill('');
    await page.evaluate(() => {
      location.hash = 'shortcuts';
    });
    await page.locator('#shortcuts-view .shortcut-binding').first().click();
    await expect(page.locator('#shortcuts-view .shortcut-binding.recording')).toHaveCount(1);
    await field.click();
    await page.keyboard.type('zoom in');
    await expect(field).toHaveValue('zoom in');
    await expect(page.locator('#shortcuts-view .shortcut-binding.recording')).toHaveCount(0);
  });

  // The results panel replaces the open section but is deliberately not one
  // of the nav's own sections, so nothing but the search itself can hide it:
  // every way of leaving for a section — a nav click, back/forward, a deep
  // link — has to close the search, or the page paints a stale result list
  // stacked above the section that just opened.
  test('leaving for a section closes the search rather than stacking it', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    const field = page.locator('#settings-search');
    const panel = page.locator('#settings-search-results');
    const navItem = (target) => page.locator(`.nav-item[data-target="${target}"]`);

    // 1. A nav item for another section: the hash changes under the results.
    await field.click();
    await field.pressSequentially('tor');
    await expect(panel).toBeVisible();
    await navItem('downloads').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#downloads')).toBeVisible();
    await expect(field).toHaveValue('');
    expect(await page.evaluate(() => location.hash)).toBe('#downloads');

    // 2. The nav item of the section the results are already covering: that
    // click changes no hash at all, so `hashchange` never fires and the
    // click itself has to close the search.
    await field.pressSequentially('tor');
    await expect(panel).toBeVisible();
    await expect(page.locator('#downloads')).toBeHidden();
    await navItem('downloads').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#downloads')).toBeVisible();
    await expect(field).toHaveValue('');
    expect(await page.evaluate(() => location.hash)).toBe('#downloads');

    // 3. Back/forward and outer-chrome deep links arrive as a bare hash
    // change with no click behind them.
    await field.pressSequentially('tor');
    await expect(panel).toBeVisible();
    await page.evaluate(() => history.back());
    await expect(panel).toBeHidden();
    await expect(page.locator('#appearance')).toBeVisible();
    await expect(field).toHaveValue('');
    expect(
      await page.evaluate(() => document.querySelectorAll('.settings-search-hit').length)
    ).toBe(0);

    // A revealed row's highlight goes with it: the answer belonged to a
    // query the user has left.
    await field.pressSequentially('tor');
    const startTor = page
      .locator('#settings-search-list .settings-search-result')
      .filter({ hasText: 'Start Tor when Freedom opens' });
    await startTor.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.getElementById('start-tor-row')?.classList.contains('settings-search-hit') ===
            true
        )
      )
      .toBe(true);
    await navItem('appearance').click();
    await expect(page.locator('#appearance')).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(field).toHaveValue('');
    expect(
      await page.evaluate(() => document.querySelectorAll('.settings-search-hit').length)
    ).toBe(0);
  });

  // Three things the index reads the page wrongly about, all in the live DOM
  // because all three are rendered from IPC state or from a controller's
  // transient view state:
  //
  //  - a chain is named only in the Chains master list, whose rows are
  //    `.net-row` buttons rather than any of the shapes above — so a chain
  //    the user added themselves was findable nowhere on this page;
  //  - Site Permissions' empty state is a status message written as a row,
  //    which the index offered as a setting to jump to and accent-mark;
  //  - the add-a-chain flow renders into the Chains section without a hash of
  //    its own, so while it is open its `<h2>` was that section's heading.
  test('a chain is findable by name, and a status message or an open form is not', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    const search = (query) =>
      page.evaluate((q) => {
        const field = document.getElementById('settings-search');
        field.value = q;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return Array.from(
          document.querySelectorAll('#settings-search-list .settings-search-result'),
          (row) => [
            row.querySelector('.row-label').textContent,
            row.querySelector('.settings-search-section').textContent,
          ]
        );
      }, query);
    const clear = () =>
      page.evaluate(() => {
        const field = document.getElementById('settings-search');
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });

    // 1. A custom chain, added the way the Chains page adds one. It exists in
    // no other section's markup, so the master list is the only thing that
    // can answer for it.
    await page.evaluate(() =>
      window.freedomAPI.addChain(
        {
          chainId: 424243,
          name: 'Searchnet',
          nativeCurrency: { name: 'Search', symbol: 'SRCH', decimals: 18 },
        },
        ['https://rpc.searchnet.example']
      )
    );
    // Added from the Chains page, the way a user adds one, then left behind:
    // the index reads each section's live markup, so this is also the search
    // asking a section the user is not on.
    await page.evaluate(() => {
      location.hash = 'chains';
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('#chains-view .net-row-name'), (el) =>
            el.textContent.trim()
          )
        )
      )
      .toContain('Searchnet');
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();

    expect(await search('searchnet')).toEqual([['Searchnet', 'Chains']]);
    // …and by its chain id, which is the sub-line under the name.
    expect(await search('chain 424243')).toEqual([['Searchnet', 'Chains']]);
    // A built-in chain answers the same way — this is the list, not the one
    // chain that happens to be custom.
    expect(await search('gnosis')).toContainEqual(['Gnosis Chain', 'Chains']);

    // Clicking it opens Chains and marks that chain's own row, with the wash
    // as well as the edge (a `.net-row` declares its own background).
    expect(await search('searchnet')).toEqual([['Searchnet', 'Chains']]);
    await page.locator('#settings-search-list .settings-search-result').first().click();
    await expect(page.locator('#chains')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hit = document.querySelector('.settings-search-hit');
          return hit ? [hit.querySelector('.net-row-name')?.textContent, hit.dataset.chain] : null;
        })
      )
      .toEqual(['Searchnet', '424243']);
    expect(
      await page.evaluate(() => {
        const hit = document.querySelector('.settings-search-hit');
        const wash = document.createElement('div');
        wash.style.background = 'var(--accent-muted)';
        hit.appendChild(wash);
        const [style, expected] = [getComputedStyle(hit), getComputedStyle(wash).backgroundColor];
        wash.remove();
        // Not `transparent`: `.net-row`'s own `background` declaration is
        // further down the sheet with the same specificity, so without
        // `.net-row.settings-search-hit` the jump lands with the edge alone.
        return [style.boxShadow.includes('inset'), style.backgroundColor === expected];
      })
    ).toEqual([true, true]);
    await clear();

    // 2. Site Permissions with nothing saved renders "No saved permissions"
    // as a row. It is a sentence, not a control: offered as a result it jumps
    // to and accent-marks a status message.
    await page.evaluate(() => {
      location.hash = 'permissions';
    });
    await expect.poll(() => page.locator('#permissions-view .row').count()).toBe(1);
    await expect(page.locator('#permissions-view .row-label')).toHaveText('No saved permissions');
    expect(await search('saved permissions')).toEqual([]);
    expect(await search('no saved')).toEqual([]);
    // The section itself is still findable — only the message is not.
    expect(await search('site permissions')).toContainEqual([
      'Site Permissions',
      'Site Permissions',
    ]);
    await clear();

    // 3. The add-a-chain flow, opened in place on #chains — no hash change,
    // so nothing else on the page knows it is up.
    await page.evaluate(() => {
      location.hash = 'chains';
    });
    await expect.poll(() => page.locator('#chains-view .net-row').count()).toBeGreaterThan(0);
    await page.locator('#chains-view button[data-action="add-chain"]').click();
    await expect(page.locator('#chains-view .section-title')).toHaveText('Add a chain');
    expect(await page.evaluate(() => location.hash)).toBe('#chains');

    // The Chains section still answers to its own name, from the nav label
    // the builder falls back to…
    expect(await search('chains')).toContainEqual(['Chains', 'Chains']);
    // …and the form is not offered as somewhere to go.
    expect(await search('add a chain')).toEqual([]);
    expect(await search('public chain catalogue')).toEqual([]);
    await clear();

    // Clearing the field hands the form back intact — the skip marker takes
    // it out of the index, not out of the page — and leaving still clears it.
    await expect(page.locator('#chain-search-input')).toBeVisible();
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();
    await expect(page.locator('#chains-view .section-title')).toHaveText('Chains');

    // 4. The scope of all of that, which docs/features.md now states and
    // `settings-search.test.js` pins the wording of: a chain is named on this
    // page only in the master list, so while Chains has a single chain's own
    // page up instead, no chain answers from there — and leaving puts the
    // list, and the rows, back.
    expect(await search('searchnet')).toEqual([['Searchnet', 'Chains']]);
    await clear();
    await page.evaluate(() => {
      location.hash = 'chains/1';
    });
    await expect.poll(() => page.locator('#chains-view .net-row').count()).toBe(0);
    expect((await search('searchnet')).filter(([, section]) => section === 'Chains')).toEqual([]);
    await clear();
    await page.evaluate(() => {
      location.hash = 'appearance';
    });
    await expect(page.locator('#appearance')).toBeVisible();
    expect(await search('searchnet')).toEqual([['Searchnet', 'Chains']]);
    await clear();

    // Leave the shared fixture as it was found.
    await page.evaluate(() => window.freedomAPI.removeChain('424243'));
  });

  // A section entry marks the whole `<section>`, and `scrollIntoView({ block:
  // 'center' })` aligns an element's middle with the viewport's — so a section
  // taller than the window landed with its own `<h2>` above the fold. Name
  // Resolution is the one that already is; the user who searched for it by
  // name arrived at a view whose title was off screen.
  test('a section taller than the window is revealed by its heading, not its middle', async ({
    window,
    electronApp,
  }) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);

    const headingTop = () =>
      page.evaluate(() =>
        Math.round(document.querySelector('#ens .section-title').getBoundingClientRect().top)
      );

    // Where clicking the nav item puts that heading — the answer the jump has
    // to match, since both are "take me to Name Resolution".
    await page.locator('.nav-item[data-target="ens"]').click();
    await expect(page.locator('#ens')).toBeVisible();
    const byNavClick = await headingTop();
    expect(byNavClick).toBeGreaterThan(0);
    await page.locator('.nav-item[data-target="appearance"]').click();
    await expect(page.locator('#appearance')).toBeVisible();

    const field = page.locator('#settings-search');
    await field.click();
    await field.pressSequentially('name resolution');
    const results = page.locator('#settings-search-list .settings-search-result');
    await expect(results.first().locator('.row-label')).toHaveText('Name Resolution');
    await field.press('Enter');
    await expect(page.locator('#ens')).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe('#ens');

    // The precondition this leg exists for: if the section ever fits, the
    // assertions below pass for a reason that has nothing to do with the fix.
    expect(
      await page.evaluate(
        () => document.getElementById('ens').getBoundingClientRect().height > window.innerHeight
      )
    ).toBe(true);

    // The section is what was marked, and its heading is on screen — at the
    // top, exactly where the nav item leaves it (`.section`'s scroll margin
    // keeps the content's own padding above it).
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.getElementById('ens').classList.contains('settings-search-hit')
        )
      )
      .toBe(true);
    expect(await headingTop()).toBe(byNavClick);
    await expect(page.locator('#ens .section-title')).toBeInViewport();
    await expect(page.locator('#ens .section-title')).toHaveText('Name Resolution');

    // A row reveal still centres: the answer wants its neighbours around it,
    // and a row always fits. Measured against what the page itself would do
    // either way rather than against a pixel count, and in Shortcuts — long
    // enough that the two alignments provably land somewhere different, so
    // the check can tell them apart rather than reading a clamped scroll.
    await field.click();
    await field.press('Escape');
    await field.pressSequentially('actual size');
    await expect(results.first().locator('.row-label')).toHaveText('Actual size');
    await field.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector('.settings-search-hit')?.querySelector('.row-label')
              ?.textContent === 'Actual size'
        )
      )
      .toBe(true);
    const scrolls = await page.evaluate(() => {
      const row = document.querySelector('.settings-search-hit');
      const revealed = Math.round(window.scrollY);
      window.scrollTo(0, 0);
      row.scrollIntoView({ block: 'center' });
      const centred = Math.round(window.scrollY);
      window.scrollTo(0, 0);
      row.scrollIntoView({ block: 'start' });
      const topped = Math.round(window.scrollY);
      return { revealed, centred, topped };
    });
    expect(scrolls.centred).not.toBe(scrolls.topped);
    expect(scrolls.revealed).toBe(scrolls.centred);
  });
});

// ---------------------------------------------------------------------------
// #280: the hash is the page's routing state *and* what the outer chrome
// renders as `freedom://settings/<section>`, so a hash the page does not
// honour is an address bar lying about what is on screen. It used to be
// normalized exactly once, on first load, and an unknown chain id was
// swallowed silently — `freedom://settings/privacy` over Appearance, or
// `#chains/9999` over the chain list with an empty status line. The routing
// helpers themselves are unit-tested in
// `src/renderer/pages/settings-hash-routing.test.js`; this is the running
// page, its chain registry and the address bar reading back from it.
// ---------------------------------------------------------------------------
test.describe('settings deep links name the view they open (#280)', () => {
  const settingsPageOf = async (window, electronApp) => {
    await openSettings(window, expect);
    let page;
    await expect
      .poll(() => {
        page = electronApp
          .windows()
          .find((candidate) => candidate.url().includes('/pages/settings.html'));
        return Boolean(page);
      })
      .toBe(true);
    return page;
  };

  test('a hash naming no section is rewritten to the section shown, in-session', async ({
    window,
    electronApp,
  }) => {
    const page = await settingsPageOf(window, electronApp);

    // Arrive somewhere real first: the reported case is a stale bookmark or
    // an old link opened in a Settings tab that is already up, which is the
    // one path the first-load normalisation never saw.
    await page.evaluate(() => {
      location.hash = 'shortcuts';
    });
    await expect(page.locator('#shortcuts')).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe('#shortcuts');

    await page.evaluate(() => {
      location.hash = 'privacy';
    });

    await expect(page.locator('#appearance')).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#appearance');
    expect(
      await page.evaluate(() => ({
        shown: [...document.querySelectorAll('.section')]
          .filter((section) => !section.classList.contains('hidden'))
          .map((section) => section.id),
        active: [...document.querySelectorAll('.nav-item.active')].map(
          (item) => item.dataset.target
        ),
      }))
    ).toEqual({ shown: ['appearance'], active: ['appearance'] });
    // The point of the fix: the chrome reads the rewritten hash back.
    await expect(window.locator('[data-test="address-input"]')).toHaveValue(
      'freedom://settings/appearance'
    );
  });

  test('every section the page ships is still reachable by its own hash', async ({
    window,
    electronApp,
  }) => {
    const page = await settingsPageOf(window, electronApp);
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll('.nav-item')].map((item) => item.dataset.target)
    );
    expect(targets.length).toBe(14);

    for (const target of targets) {
      // Leave and re-enter, so each section arrives through `hashchange` —
      // the handler the fix touched — rather than only on load.
      await page.evaluate(() => {
        location.hash = 'about';
      });
      await page.evaluate((section) => {
        location.hash = section;
      }, target);
      await expect(page.locator(`#${target}`)).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toBe(`#${target}`);
    }
  });

  test('an unknown chain deep link returns to the list, says why, and leaves real ones alone', async ({
    window,
    electronApp,
  }) => {
    const page = await settingsPageOf(window, electronApp);

    // A configured chain first: the detail view renders and the deep link
    // survives untouched, which is what must not regress.
    await page.evaluate(() => {
      location.hash = 'chains/1';
    });
    await expect(page.locator('#chains-view h2.section-title')).toHaveText('Ethereum');
    expect(await page.evaluate(() => location.hash)).toBe('#chains/1');
    await expect(page.locator('#chains-status')).toHaveText('');

    // Now the chain that is not configured — removed here or in another
    // window, or a typo.
    await page.evaluate(() => {
      location.hash = 'chains/9999';
    });

    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#chains');
    await expect(page.locator('#chains-status')).toHaveText('That chain is no longer configured.');
    await expect(page.locator('#chains-view h2.section-title')).toHaveText('Chains');
    await expect(window.locator('[data-test="address-input"]')).toHaveValue(
      'freedom://settings/chains'
    );

    // The add-chain form opens on the same `#chains` hash, so no
    // `hashchange` fires for it: the notice has to be cleared by the render
    // that replaces the view, or it sits under "Add a chain" describing a
    // list that is no longer on screen.
    await page.locator('#chains-view [data-action="add-chain"]').click();
    await expect(page.locator('#chains-view h2.section-title')).toHaveText('Add a chain');
    await expect(page.locator('#chains-status')).toHaveText('');

    // Back to the list — also on the same hash — and the notice stays gone.
    await page.locator('#chains-view [data-action="cancel-add"]').click();
    await expect(page.locator('#chains-view h2.section-title')).toHaveText('Chains');
    await expect(page.locator('#chains-status')).toHaveText('');

    // The notice explains the hash that was rewritten; navigating on is not
    // that hash any more, so it does not follow the user into a real chain.
    await page.evaluate(() => {
      location.hash = 'chains/9999';
    });
    await expect
      .poll(() => page.evaluate(() => document.getElementById('chains-status').textContent))
      .toBe('That chain is no longer configured.');
    await page.evaluate(() => {
      location.hash = 'chains/1';
    });
    await expect(page.locator('#chains-view h2.section-title')).toHaveText('Ethereum');
    expect(await page.evaluate(() => location.hash)).toBe('#chains/1');
    await expect(page.locator('#chains-status')).toHaveText('');
  });

  // The other half of the same promise: a deep link only *is* one if it can
  // arrive through the chrome. The address bar shows a chain detail as
  // `freedom://settings/chains/1`, so typing that back — or opening the
  // bookmark it makes — has to land there. The two parsers that read a
  // `freedom://` address back in — `navigation.js`'s `FREEDOM_PAGE_PATTERN`
  // and its sibling `tabs.js#freedomInternalPageTarget` — accepted a single
  // sub-path segment, so it landed nowhere: the webview stayed on the chain
  // list while the bar kept standing over it, the same shape #280 is about,
  // on a chain that exists. (`page-urls.js#getInternalPageName` is the
  // emitter of that address and was never depth-limited.)
  test('a chain detail the address bar shows can be typed back into it', async ({
    window,
    electronApp,
  }) => {
    const page = await settingsPageOf(window, electronApp);
    const input = window.locator('[data-test="address-input"]');

    // Settings already open on the chain list — the in-session case.
    await page.evaluate(() => {
      location.hash = 'chains';
    });
    await expect(page.locator('#chains-view h2.section-title')).toHaveText('Chains');
    await expect(input).toHaveValue('freedom://settings/chains');

    // The chrome's own chain-detail URL, committed through the address bar.
    await input.click();
    await input.fill('freedom://settings/chains/1');
    await input.press('Enter');

    await expect(page.locator('#chains-view h2.section-title')).toHaveText('Ethereum');
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#chains/1');
    await expect(input).toHaveValue('freedom://settings/chains/1');

    // And a chain that is not configured, which is what makes the rewrite
    // above reachable from a bookmark at all: it routes, then settles back on
    // the list with the notice.
    await input.click();
    await input.fill('freedom://settings/chains/9999');
    await input.press('Enter');

    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#chains');
    await expect(page.locator('#chains-status')).toHaveText('That chain is no longer configured.');
    await expect(input).toHaveValue('freedom://settings/chains');
  });
});
