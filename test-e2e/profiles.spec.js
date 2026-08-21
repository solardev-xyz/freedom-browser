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
  await window.click('#profile-create-submit');

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
    (_electron, id) => globalThis.__FREEDOM_TEST_HARNESS__.simulateProfileFocus(id, { focused: true }),
    target.id
  );
  await clearLaunches(electronApp);

  // Drive the same trusted IPC the flyout invokes; it resolves once the focus
  // decision is made, so the no-launch assertion below isn't racy.
  const result = await window.evaluate(
    (id) => window.electronAPI.openProfile(id),
    target.id
  );
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
    .poll(() => managerEval(window, `!!document.querySelector('[data-profile-id="${created.id}"]')`))
    .toBe(true);
  expect(await findProfile(window, (p) => p.id === created.id)).not.toBeNull();
});
