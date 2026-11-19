// Secure DNS (#472): Settings → Privacy and security → Secure DNS reaches
// Chromium's resolver (main's app.configureHostResolver, read back through the
// harness) as it is changed, and Chromium then looks names up the way it says.
//
// The second test needs no internet: Strict with a DoH server on a closed
// loopback port can only fail, and Chromium's own net log shows how. A lookup
// that went out as a DoH request to that server, and never through the system
// resolver, is what Strict promises; a fallback to plaintext DNS would show
// up there as a system task.

const fs = require('fs');
const { test, expect } = require('./fixtures');

const QUAD9 = 'https://dns.quad9.net/dns-query';
const MULLVAD = 'https://dns.mullvad.net/dns-query';
const CUSTOM = 'https://doh.example.org/dns-query';
const DEAD = 'https://127.0.0.1:59999/dns-query';

const applied = (app) => app.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.secureDnsConfig());

async function openSecureDns(window, electronApp) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/privacy/dns');
  await input.press('Enter');
  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/settings.html'));
      return Boolean(page);
    })
    .toBe(true);
  await page.waitForSelector('#secure-dns-mode');
  // The panel paints from getSettings; wait for it before changing anything.
  await expect(page.locator('#secure-dns-provider')).toHaveValue(/./);
  return page;
}

// Set the address and fire the field's change event, as Enter or leaving the
// field does. Typed keys would go to whichever frame has focus, and that is
// the address bar here.
const enterCustom = (page, value) =>
  page.evaluate((address) => {
    const field = document.getElementById('secure-dns-custom');
    field.value = address;
    field.dispatchEvent(new Event('change'));
  }, value);

test('Secure DNS settings reach the resolver as they are changed', async ({
  window,
  electronApp,
}) => {
  // Applied at startup, before the first window's lookups.
  expect(await applied(electronApp)).toEqual({
    secureDnsMode: 'automatic',
    secureDnsServers: [QUAD9],
  });

  const page = await openSecureDns(window, electronApp);
  await expect(page.locator('#secure-dns-mode')).toHaveValue('automatic');
  await expect(page.locator('#secure-dns-provider')).toHaveValue('quad9');
  await expect(page.locator('#secure-dns-custom-row')).toBeHidden();

  await page.selectOption('#secure-dns-mode', 'secure');
  await expect
    .poll(() => applied(electronApp))
    .toEqual({ secureDnsMode: 'secure', secureDnsServers: [QUAD9] });
  await expect(page.locator('#secure-dns-mode-help')).toHaveText(/won't load/);

  await page.selectOption('#secure-dns-provider', 'mullvad');
  await expect
    .poll(() => applied(electronApp))
    .toEqual({ secureDnsMode: 'secure', secureDnsServers: [MULLVAD] });

  // Custom waits for a usable address, and Mullvad stays in use meanwhile.
  const status = page.locator('#secure-dns-custom-status');
  await page.selectOption('#secure-dns-provider', 'custom');
  await expect(page.locator('#secure-dns-custom-row')).toBeVisible();
  await expect(status).toHaveText(
    "Enter the provider's address to switch to it. Mullvad stays in use until then."
  );
  await enterCustom(page, 'http://doh.example.org/dns-query');
  await expect(page.locator('#secure-dns-custom')).toHaveAttribute('aria-invalid', 'true');
  await expect(status).toHaveText(
    "That isn't an https:// address Freedom can use. Mullvad stays in use."
  );
  expect(await applied(electronApp)).toEqual({
    secureDnsMode: 'secure',
    secureDnsServers: [MULLVAD],
  });

  await enterCustom(page, CUSTOM);
  await expect
    .poll(() => applied(electronApp))
    .toEqual({ secureDnsMode: 'secure', secureDnsServers: [CUSTOM] });
  await expect(page.locator('#secure-dns-custom')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(status).toHaveText('');

  // Off: no DoH at all, and the provider rows wait greyed out.
  await page.selectOption('#secure-dns-mode', 'off');
  await expect
    .poll(() => applied(electronApp))
    .toEqual({ secureDnsMode: 'off', secureDnsServers: [] });
  await expect(page.locator('#secure-dns-provider')).toBeDisabled();
  await expect(page.locator('#secure-dns-custom')).toBeDisabled();

  expect(await window.evaluate(() => window.electronAPI.getSettings())).toMatchObject({
    secureDnsMode: 'off',
    secureDnsProvider: 'custom',
    secureDnsCustomTemplate: CUSTOM,
  });
});

// A save main refuses (a disk or permission error) must say so where it can
// be seen. The read-back repaint puts the controls back to what is stored, and
// the custom row, with its own status line, is hidden unless the provider is
// Custom, so the error goes in a line that is always shown.
test('a failed save says so, whichever control made it', async ({ window, electronApp }) => {
  const page = await openSecureDns(window, electronApp);
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__secureDnsSaveResult = false;
    ipcMain.removeHandler('settings:save');
    ipcMain.handle('settings:save', () => globalThis.__secureDnsSaveResult);
  });
  const saveStatus = page.locator('#secure-dns-status');
  const failed = "Couldn't save the change. Try again.";
  await expect(saveStatus).toBeHidden();

  // Mode: the select snaps back, and the error is in view with Quad9 chosen.
  await page.selectOption('#secure-dns-mode', 'secure');
  await expect(saveStatus).toHaveText(failed);
  await expect(saveStatus).toBeVisible();
  await expect(page.locator('#secure-dns-mode')).toHaveValue('automatic');
  await expect(page.locator('#secure-dns-custom-row')).toBeHidden();

  // Provider: the same.
  await page.selectOption('#secure-dns-provider', 'mullvad');
  await expect(page.locator('#secure-dns-provider')).toHaveValue('quad9');
  await expect(saveStatus).toBeVisible();

  // A first custom address: the row stays open with what was typed, so it can
  // be tried again, rather than closing on the stored provider.
  await page.selectOption('#secure-dns-provider', 'custom');
  await enterCustom(page, CUSTOM);
  await expect(saveStatus).toHaveText(failed);
  await expect(saveStatus).toBeVisible();
  await expect(page.locator('#secure-dns-custom-row')).toBeVisible();
  await expect(page.locator('#secure-dns-provider')).toHaveValue('custom');
  await expect(page.locator('#secure-dns-custom')).toHaveValue(CUSTOM);
  // And the row still says which provider is in use meanwhile.
  const status = page.locator('#secure-dns-custom-status');
  const waiting = (name) =>
    `Enter the provider's address to switch to it. ${name} stays in use until then.`;
  await expect(status).toHaveText(waiting('Quad9'));
  await page.screenshot({ path: test.info().outputPath('secure-dns-save-failed.png') });

  // A save that goes through clears it. The repaint after it keeps the
  // unsaved address and the in-use line: nothing else holds what was typed.
  await page.evaluate(() => document.activeElement?.blur());
  await electronApp.evaluate(() => {
    globalThis.__secureDnsSaveResult = true;
  });
  await page.selectOption('#secure-dns-mode', 'secure');
  await expect(saveStatus).toHaveText('');
  await expect(saveStatus).toBeHidden();
  await expect(page.locator('#secure-dns-custom-row')).toBeVisible();
  await expect(page.locator('#secure-dns-custom')).toHaveValue(CUSTOM);
  await expect(status).toHaveText(waiting('Quad9'));
  expect(await applied(electronApp)).toEqual({
    secureDnsMode: 'automatic',
    secureDnsServers: [QUAD9],
  });

  // A Secure DNS change saved in another window clears a failed save's error
  // here too (the controls now show what is stored), and the draft row follows
  // the provider now in use.
  await electronApp.evaluate(() => {
    globalThis.__secureDnsSaveResult = false;
  });
  await page.selectOption('#secure-dns-mode', 'off');
  await expect(saveStatus).toHaveText(failed);
  const elsewhere = await page.evaluate(() => window.freedomAPI.getSettings());
  await electronApp.evaluate(
    ({ webContents }, settings) => {
      for (const wc of webContents.getAllWebContents()) wc.send('settings:updated', settings);
    },
    { ...elsewhere, secureDnsProvider: 'cloudflare' }
  );
  await expect(saveStatus).toHaveText('');
  await expect(page.locator('#secure-dns-provider')).toHaveValue('custom');
  await expect(page.locator('#secure-dns-custom')).toHaveValue(CUSTOM);
  await expect(status).toHaveText(waiting('Cloudflare'));
});

// "Try again" after a failed custom address means Enter on the same address
// again. Chromium fires no `change` for a value it already committed, so the
// field's Enter handler has to retry it; and an Enter that does fire `change`
// (an edited address) must still save once, not twice.
test('Enter on the same address retries a failed custom save', async ({ window, electronApp }) => {
  const page = await openSecureDns(window, electronApp);
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__secureDnsSaveResult = false;
    globalThis.__secureDnsSaves = [];
    ipcMain.removeHandler('settings:save');
    ipcMain.handle('settings:save', (_event, patch) => {
      globalThis.__secureDnsSaves.push(patch);
      return globalThis.__secureDnsSaveResult;
    });
  });
  const saves = () => electronApp.evaluate(() => globalThis.__secureDnsSaves.length);
  const saveStatus = page.locator('#secure-dns-status');
  const failed = "Couldn't save the change. Try again.";
  // Enter as Chromium delivers it: keydown, then `change` in the same task
  // only if the value differs from the last one committed. Typed keys would
  // go to the address bar (see enterCustom), so the events are dispatched.
  const pressEnter = (page, { change }) =>
    page.evaluate((fireChange) => {
      const field = document.getElementById('secure-dns-custom');
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      if (fireChange) field.dispatchEvent(new Event('change'));
    }, change);

  await page.selectOption('#secure-dns-provider', 'custom');
  await enterCustom(page, CUSTOM);
  await expect(saveStatus).toHaveText(failed);
  expect(await saves()).toBe(1);

  // Enter again on the unchanged address: no `change` fires, and the retry
  // still goes out (and fails again, still saying so).
  await page.evaluate(() => {
    document.getElementById('secure-dns-status').textContent = '';
  });
  await pressEnter(page, { change: false });
  await expect.poll(saves).toBe(2);
  await expect(saveStatus).toHaveText(failed);
  await expect(page.locator('#secure-dns-custom')).toHaveValue(CUSTOM);

  // This time it is stored.
  await electronApp.evaluate(() => {
    globalThis.__secureDnsSaveResult = true;
  });
  await pressEnter(page, { change: false });
  await expect.poll(saves).toBe(3);
  await expect(saveStatus).toHaveText('');
  expect(await electronApp.evaluate(() => globalThis.__secureDnsSaves.at(-1))).toEqual({
    secureDnsProvider: 'custom',
    secureDnsCustomTemplate: CUSTOM,
  });
  // Nothing failed, so a further Enter has nothing to retry.
  await pressEnter(page, { change: false });
  await page.waitForTimeout(300);
  expect(await saves()).toBe(3);

  // An edited address after a failure: Enter fires `change`, which saves it
  // once; the retry handler leaves that Enter alone.
  await electronApp.evaluate(() => {
    globalThis.__secureDnsSaveResult = false;
  });
  await enterCustom(page, MULLVAD);
  await expect.poll(saves).toBe(4);
  await page.evaluate((address) => {
    document.getElementById('secure-dns-custom').value = address;
  }, QUAD9);
  await pressEnter(page, { change: true });
  await expect.poll(saves).toBe(5);
  await page.waitForTimeout(300);
  expect(await saves()).toBe(5);
});

// Look `host` up through Chromium with its net log running, and return the
// answer plus every logged event, by name.
async function lookUpLogged(electronApp, host, logPath) {
  await electronApp.evaluate(
    ({ netLog }, file) => netLog.startLogging(file, { captureMode: 'includeSensitive' }),
    logPath
  );
  const result = await electronApp.evaluate(
    ({ session }, name) =>
      session.defaultSession.resolveHost(name).then(
        () => 'resolved',
        (err) => err.message
      ),
    host
  );
  await electronApp.evaluate(({ netLog }) => netLog.stopLogging());
  const text = fs.readFileSync(logPath, 'utf8');
  const log = JSON.parse(text);
  const typeNames = Object.fromEntries(
    Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name])
  );
  const events = log.events.map((event) => ({
    type: typeNames[event.type],
    params: event.params || {},
  }));
  return { result, events, text };
}

// What Strict promises, read from the net log: the lookup failed (nobody
// answers on the dead server's port and there is no fallback), it went out as
// DoH requests for `host` to that server, as a secure DNS task, and nothing
// was looked up through the system resolver.
function expectDohOnly({ result, events, text }, host) {
  expect(result).toMatch(/^net::ERR_/);
  expect(events.some((e) => e.type === 'DOH_URL_REQUEST' && e.params.hostname === host)).toBe(true);
  expect(text).toContain('127.0.0.1:59999/dns-query');
  const dnsTasks = events.filter(
    (e) => e.type === 'HOST_RESOLVER_DNS_TASK' && 'secure' in e.params
  );
  expect(dnsTasks.length).toBeGreaterThan(0);
  expect(dnsTasks.every((e) => e.params.secure === true)).toBe(true);
  expect(events.filter((e) => e.type === 'HOST_RESOLVER_SYSTEM_TASK')).toEqual([]);
}

test('with Strict, Chromium looks names up over DNS over HTTPS only', async ({
  window,
  electronApp,
}, testInfo) => {
  const page = await openSecureDns(window, electronApp);
  await page.selectOption('#secure-dns-mode', 'secure');
  await page.selectOption('#secure-dns-provider', 'custom');
  await enterCustom(page, DEAD);
  await expect
    .poll(() => applied(electronApp))
    .toEqual({ secureDnsMode: 'secure', secureDnsServers: [DEAD] });

  expectDohOnly(
    await lookUpLogged(electronApp, 'example.com', testInfo.outputPath('netlog.json')),
    'example.com'
  );

  // Chromium keeps the resolver config in its network service process. One
  // that dies is replaced on Electron's defaults, and Freedom hands Secure DNS
  // to the new one (secure-dns.js); without that, Strict would go on looking
  // names up through the system resolver from here.
  const applies = await electronApp.evaluate(() =>
    globalThis.__FREEDOM_TEST_HARNESS__.secureDnsApplyCount()
  );
  await electronApp.evaluate(({ app }) => {
    const service = app
      .getAppMetrics()
      .find((m) => m.type === 'Utility' && m.serviceName === 'network.mojom.NetworkService');
    process.kill(service.pid, 'SIGKILL');
  });
  await expect
    .poll(() =>
      electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.secureDnsApplyCount())
    )
    .toBe(applies + 1);
  expectDohOnly(
    await lookUpLogged(electronApp, 'example.org', testInfo.outputPath('netlog-restarted.json')),
    'example.org'
  );
});
