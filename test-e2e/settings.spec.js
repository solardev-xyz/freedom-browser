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
