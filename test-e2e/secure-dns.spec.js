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
