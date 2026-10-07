// Profile lifecycle E2E — create, use (switch), manage (list/rename), delete.
//
// Runs against the in-process harness in *catalog* mode (see
// profiles-fixtures.js) across macOS / Linux / Windows in CI. Profile "open"
// normally spawns a detached second Electron process; the harness records the
// intended launch instead (globalThis.__FREEDOM_TEST_HARNESS__.profileLaunches),
// so "use"/switch is asserted without a second window appearing.
//
// The chrome (index.html) is a trusted profile-mutation sender, so its exposed
// electronAPI can create/list/open profiles directly. Rename/delete are only
// exposed to the profiles manager page (freedom://profiles), so those steps
// drive that page's real markup + IPC inside its <webview>.

const { test, expect } = require('./profiles-fixtures');
const { clickOverGuest, hoverOverGuest } = require('./fixtures');

// --- helpers ---------------------------------------------------------------

const listProfiles = (window) => window.evaluate(() => window.electronAPI.listProfiles());

const profileNames = async (window) => {
  const result = await listProfiles(window);
  return (result?.profiles || []).map((p) => p.displayName);
};

const findProfile = async (window, predicate) => {
  const result = await listProfiles(window);
  return (result?.profiles || []).find(predicate) || null;
};

const recordedLaunches = (electronApp) =>
  electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.profileLaunches());

const recordedLaunchIds = (electronApp) =>
  electronApp.evaluate(() =>
    globalThis.__FREEDOM_TEST_HARNESS__.profileLaunches().map((l) => l.profileId)
  );

const clearLaunches = (electronApp) =>
  electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.clearProfileLaunches());

// Create a profile directly via the chrome's trusted IPC (faster than the modal
// when the spec only needs a fixture profile to act on).
const createProfileViaApi = async (window, displayName) => {
  const result = await window.evaluate(
    (name) => window.electronAPI.createProfile({ displayName: name }),
    displayName
  );
  expect(result?.success, `createProfile(${displayName}) should succeed`).toBe(true);
  return result.profile;
};

test('node config: Myotis is embedded per profile and can be disabled', async ({ window }) => {
  const active = await window.evaluate(() => window.electronAPI.getActiveProfile());
  expect(active.nodes.myotis).toEqual({ mode: 'managed', backend: 'myotis-native' });

  const created = await createProfileViaApi(window, 'QA Myotis');
  expect(created.nodes.myotis).toEqual({ mode: 'managed', backend: 'myotis-native' });

  await window.evaluate(() => document.getElementById('settings-btn')?.click());
  await expect
    .poll(() => settingsEval(window, `typeof window.freedomAPI?.updateProfileNodeConfig`))
    .toBe('function');
  const result = await settingsEval(
    window,
    `window.freedomAPI.updateProfileNodeConfig('myotis', { mode: 'disabled' })`
  );
  expect(result?.success).toBe(true);
  expect(result.profile.nodes.myotis).toEqual({
    mode: 'disabled',
    backend: 'myotis-native',
  });

  const updated = await window.evaluate(() => window.electronAPI.getActiveProfile());
  expect(updated.nodes.myotis).toEqual({ mode: 'disabled', backend: 'myotis-native' });
});

// Settings → Nodes commits on change like every other section (#271). Lives
// here rather than in settings.spec.js because node config is only editable on
// a catalog profile, which is what these fixtures launch. No
// Save buttons; the mode select commits on change, the endpoint fields on
// focusout/Enter; "Use external node" with an empty endpoint never reaches the
// stored profile — the row flags the field and says nothing was saved.
test('Nodes commit on change, and an external switch waits for its endpoint (#271)', async ({
  window,
  electronApp,
}) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/nodes');
  await input.press('Enter');

  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/settings.html'));
      return Boolean(page);
    })
    .toBe(true);

  const storedBee = () =>
    page.evaluate(() => window.freedomAPI.getActiveProfile().then((p) => p?.nodes?.bee || {}));
  const row = page.locator('.profile-node[data-protocol="bee"]');
  const mode = row.locator('[data-node-mode]');
  const api = row.locator('[data-endpoint-field="externalApi"]');
  const error = row.locator('[data-node-error]');

  await expect(row).toBeVisible();
  await expect(page.locator('#profile-nodes-card button')).toHaveCount(0);
  expect((await storedBee()).mode || 'managed').toBe('managed');

  // Clear any stored endpoint so the external switch has nothing to fall back on.
  if ((await storedBee()).externalApi) {
    await page.evaluate(() =>
      window.freedomAPI.updateProfileNodeConfig('bee', { mode: 'managed', externalApi: '' })
    );
  }
  await page.evaluate(() => (location.hash = '#nodes'));
  await expect(api).toHaveValue('');

  // External with no endpoint: inline error, flagged field, nothing stored.
  await mode.selectOption('external');
  await expect(api).toBeVisible();
  await expect(error).toBeVisible();
  await expect(error).toHaveText(
    /Enter the API endpoint .* Not saved — Swarm is still set to Managed by Freedom\./
  );
  await expect(api).toHaveAttribute('aria-invalid', 'true');
  expect((await storedBee()).mode || 'managed').toBe('managed');

  // The draft survives a forced re-render (the 5s refresh / profile broadcast).
  await page.locator('#profile-nodes-status').click();
  await page.evaluate(() => window.freedomAPI.updateProfileNodeConfig('ipfs', { mode: 'managed' }));
  await expect(mode).toHaveValue('external');
  await expect(error).toBeVisible();
  expect((await storedBee()).mode || 'managed').toBe('managed');

  // Filling the endpoint and leaving the field commits the switch.
  await api.fill('http://127.0.0.1:1733');
  await api.press('Tab');
  await expect.poll(async () => (await storedBee()).mode).toBe('external');
  expect((await storedBee()).externalApi).toBe('http://127.0.0.1:1733');
  await expect(error).toBeHidden();
  await expect(api).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#profile-nodes-status')).toHaveText(/Swarm saved\. Restart the node/);

  // Editing the endpoint commits on Enter.
  await api.fill('http://127.0.0.1:1833');
  await api.press('Enter');
  await expect.poll(async () => (await storedBee()).externalApi).toBe('http://127.0.0.1:1833');

  // A refused endpoint stays a draft: the stored config keeps the old one.
  await api.fill('not a url');
  await api.press('Tab');
  await expect(error).toBeVisible();
  await expect(error).toHaveText(
    /Invalid profile node endpoint\. Not saved — the saved Swarm endpoint is unchanged\./
  );
  expect((await storedBee()).externalApi).toBe('http://127.0.0.1:1833');

  // Switching back to managed commits immediately, without the endpoint.
  await mode.selectOption('managed');
  await expect.poll(async () => (await storedBee()).mode).toBe('managed');
  await expect(api).toBeHidden();
  await expect(error).toBeHidden();

  // Two quick edits land in order: the second is compared with the stored
  // config only after the first one lands, so it isn't skipped as a no-op.
  // Both changes are dispatched in one task so neither reply can land between.
  await page.evaluate(() => {
    const select = document.querySelector('.profile-node[data-protocol="bee"] [data-node-mode]');
    for (const value of ['disabled', 'managed']) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.evaluate('nodeSave');
  expect((await storedBee()).mode).toBe('managed');
  await expect(mode).toHaveValue('managed');
});

// Three edges of the Nodes commit path: a write that landed but whose apply
// step threw is reported as saved, a refusal that isn't about the endpoint
// doesn't flag the endpoint field, and an older refresh landing after a
// commit's refresh can't repaint the stored mode back.
test('Nodes: apply failure reads as saved, non-endpoint refusals flag nothing, stale refreshes are dropped', async ({
  window,
  electronApp,
}) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/nodes');
  await input.press('Enter');

  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/settings.html'));
      return Boolean(page);
    })
    .toBe(true);

  const stored = (protocol) =>
    page.evaluate(
      (p) => window.freedomAPI.getActiveProfile().then((profile) => profile?.nodes?.[p] || {}),
      protocol
    );
  const status = page.locator('#profile-nodes-status');

  // 1. The catalog write lands, then applying it (radicle-manager) throws.
  const radicle = page.locator('.profile-node[data-protocol="radicle"]');
  await expect(radicle).toBeVisible();
  await electronApp.evaluate(() => {
    const manager = process.mainModule.require('./src/main/radicle-manager');
    globalThis.__nodesSpecSync = manager.syncProfileMode;
    manager.syncProfileMode = async () => {
      // Ends in a period, as most error messages do: the status line must
      // not double it.
      throw new Error('radicle apply exploded.');
    };
  });
  try {
    await radicle.locator('[data-node-mode]').selectOption('disabled');
    await expect.poll(async () => (await stored('radicle')).mode).toBe('disabled');
    await expect(status).toHaveText(
      /Radicle saved, but applying it failed: radicle apply exploded\. Restart/
    );
    await expect(radicle.locator('[data-node-error]')).toBeHidden();
    await expect(radicle.locator('[data-node-mode]')).toHaveValue('disabled');
  } finally {
    await electronApp.evaluate(() => {
      const manager = process.mainModule.require('./src/main/radicle-manager');
      manager.syncProfileMode = globalThis.__nodesSpecSync;
    });
  }

  // The page's freedomAPI is frozen by contextBridge, so the remaining cases
  // swap the main-process invoke handler behind it and put it back after.
  const swapHandler = (channel, kind) =>
    electronApp.evaluate(
      ({ ipcMain }, [ch, k]) => {
        const handlers = ipcMain._invokeHandlers;
        const real = handlers.get(ch);
        globalThis.__nodesSpecReal = globalThis.__nodesSpecReal || {};
        globalThis.__nodesSpecReal[ch] = real;
        if (k === 'refuse') {
          handlers.set(ch, async () => ({
            success: false,
            error: {
              code: 'PROFILE_UPDATE_FAILED',
              message: 'Profile node config was not updated',
            },
          }));
        } else if (k === 'late-first') {
          // The settings page's first answer is the snapshot taken now,
          // delivered 1.5s late. Other callers (the chrome) pass through.
          let first = true;
          handlers.set(ch, async (event, ...args) => {
            const live = await real(event, ...args);
            if (!first || !/settings\.html/.test(event.sender.getURL())) return live;
            first = false;
            // Snapshot now: the handler's reply can share objects the commit
            // mutates before this late answer is serialised.
            const reply = JSON.parse(JSON.stringify(live));
            return new Promise((resolve) => setTimeout(() => resolve(reply), 1500));
          });
        } else if (k === 'later-each-time') {
          // The settings page's first four answers come back 1s, 2s, 3s and
          // 4s late, so each lands after every earlier one. Later calls and
          // other callers (the chrome) pass through.
          globalThis.__nodesSpecCalls = 0;
          handlers.set(ch, async (event, ...args) => {
            const live = await real(event, ...args);
            if (!/settings\.html/.test(event.sender.getURL())) return live;
            const call = ++globalThis.__nodesSpecCalls;
            if (call > 4) return live;
            const reply = JSON.parse(JSON.stringify(live));
            return new Promise((resolve) => setTimeout(() => resolve(reply), call * 1000));
          });
        }
        return typeof real === 'function';
      },
      [channel, kind]
    );
  const restoreHandler = (channel) =>
    electronApp.evaluate(({ ipcMain }, ch) => {
      ipcMain._invokeHandlers.set(ch, globalThis.__nodesSpecReal[ch]);
    }, channel);

  // 2. A refusal that says nothing about the endpoint leaves the field alone.
  const bee = page.locator('.profile-node[data-protocol="bee"]');
  const beeMode = bee.locator('[data-node-mode]');
  const beeError = bee.locator('[data-node-error]');
  const api = bee.locator('[data-endpoint-field="externalApi"]');
  await status.click(); // keyboard focus into the settings webview
  expect(await swapHandler('profile:update-node-config', 'refuse')).toBe(true);
  try {
    await beeMode.selectOption('external');
    await api.fill('http://127.0.0.1:1933');
    await api.press('Tab');
    await expect(beeError).toHaveText(/Profile node config was not updated\. Not saved/);
    await expect(api).not.toHaveAttribute('aria-invalid', 'true');
    expect((await stored('bee')).mode || 'managed').toBe('managed');
  } finally {
    await restoreHandler('profile:update-node-config');
  }
  await beeMode.selectOption('managed');
  await expect(beeError).toBeHidden();

  // 3. A refresh that started before a commit but answers after it is dropped.
  await status.click(); // focus out of the card
  // Pause the 5s timer so the delayed first answer is this refresh's, not a
  // timer tick's (settings.js is a classic script: its top-level bindings
  // are reachable from a string expression).
  await page.evaluate('setProfileRefreshActive(false)');
  expect(await swapHandler('profile:get-active', 'late-first')).toBe(true);
  try {
    // Don't return the promise: evaluate would wait for it.
    await page.evaluate('window.__staleRefresh = refreshProfileSection(true); undefined');
    await beeMode.selectOption('disabled');
    await expect.poll(async () => (await stored('bee')).mode).toBe('disabled');
    await page.evaluate(() => window.__staleRefresh);
  } finally {
    await restoreHandler('profile:get-active');
  }
  // Read once, right after the late answer landed: the next 5s refresh would
  // repaint the right value and hide a stale render from a polling assertion.
  expect(
    await page.evaluate(
      `[document.querySelector('.profile-node[data-protocol="bee"] [data-node-mode]').value,
        storedProfileNodes.bee?.mode]`
    )
  ).toEqual(['disabled', 'disabled']);

  // 4. Two quick commits whose first one's forced refresh is superseded by
  // a newer, slower refresh: the second commit must still compare against
  // what the first one stored, not the snapshot from before it. Bee is
  // stored as disabled; pick managed then disabled again.
  expect(await swapHandler('profile:get-active', 'later-each-time')).toBe(true);
  try {
    await page.evaluate(() => {
      const select = document.querySelector('.profile-node[data-protocol="bee"] [data-node-mode]');
      for (const value of ['managed', 'disabled']) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    // The first commit's profile-updated broadcast asks twice (the Radicle
    // launch row and the Nodes card); its own forced refresh is the third.
    // Start a fourth, slower still, so that forced refresh is superseded and
    // returns without rendering before the second commit's no-op check.
    await expect.poll(() => electronApp.evaluate(() => globalThis.__nodesSpecCalls)).toBe(3);
    await page.evaluate('refreshProfileSection(true); undefined');
    await page.evaluate('nodeSave');
    expect((await stored('bee')).mode).toBe('disabled');
  } finally {
    await restoreHandler('profile:get-active');
  }
  await page.evaluate('refreshProfileSection(true)');
  await expect(beeMode).toHaveValue('disabled');
  await page.evaluate('setProfileRefreshActive(true)');
});

const settingsEval = (window, script) =>
  window.evaluate(async (s) => {
    const webview = [...document.querySelectorAll('webview')].find((candidate) => {
      try {
        return /settings/.test(candidate.getURL() || '');
      } catch {
        return false;
      }
    });
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    return webview.executeJavaScript(s);
  }, script);

// Run JS inside the profiles manager page (it loads in a <webview>; the chrome
// can only reach it via executeJavaScript). `script` must be an expression; a
// returned promise is awaited by Electron before resolving.
const managerEval = (window, script) =>
  window.evaluate(async (s) => {
    const wvs = [...document.querySelectorAll('webview')];
    const wv =
      wvs.find((w) => {
        try {
          return /profiles/.test(w.getURL() || '');
        } catch {
          return false;
        }
      }) ||
      document.querySelector('webview.active') ||
      document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return null;
    return wv.executeJavaScript(s);
  }, script);

// Open the profiles manager tab (the "Manage Profiles…" menu item) and wait for
// its cards to render. Programmatic .click() fires the real handler regardless
// of the flyout's hover state, keeping this robust across platforms.
const openManager = async (window) => {
  // The manager loads in a <webview> navigating to freedom://profiles; on cold
  // CI runners the tab can be slow to attach/render and the very first click can
  // land before the button's handler is wired. Re-click the (idempotent) "Manage
  // Profiles" button each poll until its webview renders cards — focusing an
  // already-open manager tab is a no-op, so repeated clicks are safe.
  await expect
    .poll(
      async () => {
        const count = await managerEval(
          window,
          `document.querySelectorAll('[data-profile-id]').length`
        );
        if (count > 0) return count;
        await window.evaluate(() => document.getElementById('profile-manage-btn')?.click());
        return count ?? 0;
      },
      { message: 'waiting for the profiles manager to render cards', timeout: 30_000 }
    )
    .toBeGreaterThan(0);
};

// --- create ----------------------------------------------------------------

test('create: a new profile via the chrome modal lands in the catalog and is opened', async ({
  window,
  electronApp,
}) => {
  const name = 'QA Personal';

  expect(await profileNames(window)).not.toContain(name);
  await clearLaunches(electronApp);

  // Drive the real create-profile modal the menu item opens.
  await window.evaluate(() => document.getElementById('profile-create-btn')?.click());
  await expect(window.locator('#profile-create-modal')).toBeVisible();
  await window.fill('#profile-create-name', name);
  // The dialog sits over the tab's <webview>. Until its frame is presented,
  // the browser hands a synthetic click at Create to the guest underneath and
  // the form is never submitted (#539).
  await clickOverGuest(window.locator('#profile-create-submit'));

  // On success the modal closes itself.
  await expect(window.locator('#profile-create-modal')).toBeHidden();

  // It now exists in the catalog.
  await expect.poll(() => profileNames(window)).toContain(name);

  // Creating via the modal also opens (switches to) the new profile, so a
  // launch must have been recorded for its id.
  const created = await findProfile(window, (p) => p.displayName === name);
  expect(created).not.toBeNull();
  await expect.poll(() => recordedLaunchIds(electronApp)).toContain(created.id);
});

// --- use / switch ----------------------------------------------------------

test('use: switching to another profile via the chrome menu records a launch', async ({
  window,
  electronApp,
}) => {
  const target = await createProfileViaApi(window, 'QA Work');
  await clearLaunches(electronApp);

  // Open the hamburger first — the profile flyout only renders its list when
  // its wrapper is laid out (offsetParent guard), i.e. the menu is open.
  await window.click('#menu-button');
  // Then open the profile flyout (its list renders async from listProfiles).
  await window.evaluate(() => document.getElementById('profile-menu-btn')?.click());

  // Wait for the (enabled, non-active) target row to render, then activate it
  // programmatically. A real mouse click would move the cursor and trip the
  // submenu's hover open/close timers, which can hide the list mid-click.
  await expect
    .poll(() =>
      window.evaluate((name) => {
        const items = [...document.querySelectorAll('#profile-menu-list [role="menuitem"]')];
        return items.some((b) => b.textContent.includes(name) && !b.disabled);
      }, 'QA Work')
    )
    .toBe(true);
  await window.evaluate((name) => {
    const items = [...document.querySelectorAll('#profile-menu-list [role="menuitem"]')];
    items.find((b) => b.textContent.includes(name) && !b.disabled)?.click();
  }, 'QA Work');

  await expect.poll(() => recordedLaunchIds(electronApp)).toContain(target.id);

  // Sanity: the chrome itself stays on the original (default) profile — the
  // harness recorded the switch instead of cold-starting the target's window.
  const active = await window.evaluate(() => window.electronAPI.getActiveProfile());
  expect(active.id).not.toBe(target.id);
});

// --- flyout dismissal ------------------------------------------------------

// #301: the flyout used to stay up while the pointer walked down the rest of
// the hamburger. Chrome keeps one submenu open at a time and closes it as soon
// as a sibling row is hovered, with a short grace period so a diagonal move
// into the submenu isn't cut off.
test('menu: hovering another hamburger row closes the profiles flyout', async ({ window }) => {
  const flyout = window.locator('#profile-menu');
  const hamburger = window.locator('#menu-dropdown');

  await window.click('#menu-button');
  await window.evaluate(() => document.getElementById('profile-menu-btn')?.click());
  await expect(flyout).toBeVisible();

  // The "New Tab" row sits over the tab's <webview>, and the hamburger has only
  // just opened. Until its frame is presented, the browser routes the hover's
  // mousemove to the guest, so the chrome sees no mouseover (#537).
  // Hovering a sibling row ("New Tab") dismisses it …
  await hoverOverGuest(window.locator('#new-tab-menu-btn'));
  await expect(flyout).toBeHidden();
  // … and only the flyout: the hamburger it lives in stays open.
  await expect(hamburger).toHaveClass(/\bopen\b/);
  await expect(window.locator('#profile-menu-btn')).toHaveAttribute('aria-expanded', 'false');

  // Hovering back on the Profiles row reopens it (the hover-open delay).
  await window.hover('#profile-menu-btn');
  await expect(flyout).toBeVisible();

  // Keyboard navigation is unaffected: focus moving through the flyout's own
  // rows keeps it open, focus landing on a sibling row closes it.
  await window.locator('#profile-create-btn').focus();
  await expect(flyout).toBeVisible();
  await window.locator('#new-tab-menu-btn').focus();
  await expect(flyout).toBeHidden();
  await expect(hamburger).toHaveClass(/\bopen\b/);
});

// --- use / focus fast path -------------------------------------------------

test('use: opening an already-running profile focuses it without recording a launch', async ({
  window,
  electronApp,
}) => {
  const target = await createProfileViaApi(window, 'QA Running');

  // Mark the target as already running so openOrFocusProfile takes the focus
  // fast path (focus its window) instead of cold-starting a second process.
  await electronApp.evaluate(
    // electronApp.evaluate calls back with the Electron module as the first arg;
    // the spec's value (target.id) arrives as the second.
    (_electron, id) =>
      globalThis.__FREEDOM_TEST_HARNESS__.simulateProfileFocus(id, { focused: true }),
    target.id
  );
  await clearLaunches(electronApp);

  // Drive the same trusted IPC the flyout invokes; it resolves once the focus
  // decision is made, so the no-launch assertion below isn't racy.
  const result = await window.evaluate((id) => window.electronAPI.openProfile(id), target.id);
  expect(result?.success).toBe(true);
  expect(result?.focused).toBe(true);

  // Focus fast path: no second process was launched for the target…
  expect(await recordedLaunchIds(electronApp)).not.toContain(target.id);
  // …and the chrome stayed on its own (default) profile.
  const active = await window.evaluate(() => window.electronAPI.getActiveProfile());
  expect(active.id).not.toBe(target.id);
});

// --- manage / rename -------------------------------------------------------

test('manage: the manager lists profiles and a rename updates the catalog', async ({ window }) => {
  const original = 'QA Manage';
  const renamed = 'QA Renamed';
  const created = await createProfileViaApi(window, original);

  await openManager(window);

  // The created profile's card is present in the manager.
  expect(
    await managerEval(window, `!!document.querySelector('[data-profile-id="${created.id}"]')`)
  ).toBe(true);

  // Rename through the manager page's real (guarded) IPC path.
  const result = await managerEval(
    window,
    `window.freedomAPI.renameProfile(${JSON.stringify(created.id)}, ${JSON.stringify(renamed)})`
  );
  expect(result?.success).toBe(true);

  // The catalog reflects the new name…
  await expect
    .poll(async () => (await findProfile(window, (p) => p.id === created.id))?.displayName)
    .toBe(renamed);

  // …and the manager card's stored display name updates (broadcast-driven).
  await expect
    .poll(() =>
      managerEval(
        window,
        `document.querySelector('[data-profile-id="${created.id}"]')?.dataset.profileDisplayName || null`
      )
    )
    .toBe(renamed);
});

// --- edit (open settings deep link) ----------------------------------------

test('edit: the pencil opens a non-active profile on its Settings page (openSettings deep link)', async ({
  window,
  electronApp,
}) => {
  const created = await createProfileViaApi(window, 'QA Edit');
  await clearLaunches(electronApp);

  await openManager(window);
  await expect
    .poll(() =>
      managerEval(window, `!!document.querySelector('[data-profile-id="${created.id}"]')`)
    )
    .toBe(true);

  // Click the card's pencil. For a non-active profile this routes through
  // openProfileSettings → profile:open with openSettings:true, which (since the
  // target isn't running here) cold-starts it — recorded by the harness with
  // the openSettings flag set.
  await managerEval(
    window,
    `document.querySelector('[data-profile-id="${created.id}"] [data-edit-profile]').click(); true`
  );

  await expect
    .poll(async () =>
      (await recordedLaunches(electronApp)).some(
        (l) => l.profileId === created.id && l.openSettings === true
      )
    )
    .toBe(true);
});

// --- delete ----------------------------------------------------------------

test('delete: confirming in the manager dialog removes the profile from the catalog', async ({
  window,
}) => {
  const name = 'QA Delete';
  const created = await createProfileViaApi(window, name);

  await openManager(window);
  await expect
    .poll(() =>
      managerEval(window, `!!document.querySelector('[data-profile-id="${created.id}"]')`)
    )
    .toBe(true);

  // Click the card's trash button → the delete-confirm dialog opens.
  await managerEval(
    window,
    `document.querySelector('[data-profile-id="${created.id}"] [data-delete-profile]').click(); true`
  );
  await expect
    .poll(() => managerEval(window, `document.getElementById('delete-modal').hidden === false`))
    .toBe(true);

  // The destructive button is inert immediately (guards against reflex clicks)…
  expect(
    await managerEval(window, `document.querySelector('[data-delete-confirm]').disabled`)
  ).toBe(true);
  // …and arms after the deliberate delay.
  await expect
    .poll(
      () =>
        managerEval(window, `document.querySelector('[data-delete-confirm]').disabled === false`),
      {
        message: 'waiting for the delete-confirm button to arm',
        timeout: 5_000,
      }
    )
    .toBe(true);

  await managerEval(window, `document.querySelector('[data-delete-confirm]').click(); true`);

  // Gone from the catalog…
  await expect
    .poll(async () => (await findProfile(window, (p) => p.id === created.id)) !== null)
    .toBe(false);
  // …and removed from the manager DOM.
  await expect
    .poll(() => managerEval(window, `!document.querySelector('[data-profile-id="${created.id}"]')`))
    .toBe(true);
});

test('delete: a failed delete restores the card and surfaces the error toast', async ({
  window,
  electronApp,
}) => {
  const created = await createProfileViaApi(window, 'QA Delete Fail');

  // Force the delete IPC to fail as if the profile were open elsewhere and
  // couldn't be closed (PROFILE_CLOSE_FAILED) — the renderer can't be made to
  // fail from the page (freedomAPI is a read-only contextBridge object), so the
  // failure is injected in the main process.
  await electronApp.evaluate(
    // electronApp.evaluate calls back with the Electron module as the first arg;
    // the spec's value (created.id) arrives as the second.
    (_electron, id) => globalThis.__FREEDOM_TEST_HARNESS__.simulateProfileDelete(id),
    created.id
  );

  await openManager(window);
  await expect
    .poll(() =>
      managerEval(window, `!!document.querySelector('[data-profile-id="${created.id}"]')`)
    )
    .toBe(true);

  // Open the confirm dialog and confirm once it arms.
  await managerEval(
    window,
    `document.querySelector('[data-profile-id="${created.id}"] [data-delete-profile]').click(); true`
  );
  await expect
    .poll(
      () =>
        managerEval(window, `document.querySelector('[data-delete-confirm]').disabled === false`),
      { message: 'waiting for the delete-confirm button to arm', timeout: 5_000 }
    )
    .toBe(true);
  await managerEval(window, `document.querySelector('[data-delete-confirm]').click(); true`);

  // The toast appears with the failure reason…
  await expect
    .poll(() =>
      managerEval(
        window,
        `(() => { const t = document.getElementById('profile-toast'); return t && t.hidden === false ? t.textContent : null; })()`
      )
    )
    .toContain('could not be closed');

  // …and the optimistically-removed card is restored (still in the catalog).
  await expect
    .poll(() =>
      managerEval(window, `!!document.querySelector('[data-profile-id="${created.id}"]')`)
    )
    .toBe(true);
  expect(await findProfile(window, (p) => p.id === created.id)).not.toBeNull();
});

// --- delete the default profile (#124) -------------------------------------

const hasTrash = (window, id) =>
  managerEval(
    window,
    `!!document.querySelector('[data-profile-id="${id}"] [data-delete-profile]')`
  );

test('delete: the active default profile offers no trash, a second profile does', async ({
  window,
}) => {
  const created = await createProfileViaApi(window, 'QA Other');
  await openManager(window);
  await expect.poll(() => hasTrash(window, created.id)).toBe(true);
  // `default` is the active profile here — switch away first to delete it.
  expect(await hasTrash(window, 'default')).toBe(false);
});

test.describe('with another profile active', () => {
  test.use({ launchProfile: 'work' });

  test('delete: the default profile can be deleted from the manager and its data is removed', async ({
    window,
    devHome,
  }) => {
    const path = require('path');
    const fs = require('fs');
    const defaultDir = path.join(devHome, 'Profiles', 'default');

    // First run as `work` still registered `default` alongside it.
    expect(await findProfile(window, (p) => p.id === 'work' && p.isActive)).not.toBeNull();
    expect(await findProfile(window, (p) => p.id === 'default' && !p.isActive)).not.toBeNull();
    expect(fs.existsSync(defaultDir)).toBe(true);

    await openManager(window);
    await expect.poll(() => hasTrash(window, 'default')).toBe(true);
    // The active profile never offers delete.
    expect(await hasTrash(window, 'work')).toBe(false);

    await managerEval(
      window,
      `document.querySelector('[data-profile-id="default"] [data-delete-profile]').click(); true`
    );
    await expect
      .poll(() => managerEval(window, `document.getElementById('delete-modal').hidden === false`))
      .toBe(true);
    await expect
      .poll(
        () =>
          managerEval(window, `document.querySelector('[data-delete-confirm]').disabled === false`),
        { message: 'waiting for the delete-confirm button to arm', timeout: 5_000 }
      )
      .toBe(true);
    await managerEval(window, `document.querySelector('[data-delete-confirm]').click(); true`);

    // Gone from the catalog, the manager, and the disk.
    await expect
      .poll(async () => (await findProfile(window, (p) => p.id === 'default')) !== null)
      .toBe(false);
    await expect
      .poll(() => managerEval(window, `!document.querySelector('[data-profile-id="default"]')`))
      .toBe(true);
    expect(fs.existsSync(defaultDir)).toBe(false);

    // `work` is now the only profile: still active, still no trash — the app
    // can never be left with zero profiles.
    expect(await profileNames(window)).toEqual(['Work']);
    expect(await hasTrash(window, 'work')).toBe(false);
  });
});
