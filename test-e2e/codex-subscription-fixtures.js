const { spawn } = require('child_process');
const net = require('net');
const { test: base, expect, chromium } = require('@playwright/test');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const electronExecutable = require('electron');
const profileId = process.env.FREEDOM_CODEX_TEST_PROFILE?.trim() || '';

function validatedProfileArg(value) {
  if (!/^[a-z0-9_-]+$/i.test(value)) {
    throw new Error('FREEDOM_CODEX_TEST_PROFILE must be a named Freedom profile ID');
  }
  return `--profile=${value}`;
}

async function reserveDebugPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDebugEndpoint(port, processExited) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (processExited()) throw new Error('Freedom exited before its debug endpoint was ready');
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // The normal Electron launch is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Freedom debug endpoint did not become ready');
}

const test = base.extend({
  codexProfile: [profileId, { option: true }],

  freedomProcess: async ({ codexProfile }, use) => {
    const debugPort = await reserveDebugPort();
    const child = spawn(
      electronExecutable,
      [
        '.',
        validatedProfileArg(codexProfile),
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${debugPort}`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FREEDOM_TEST_MODE: '0',
          FREEDOM_TEST_USER_DATA: '',
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
          LANG: 'en_US.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let exit = null;
    child.once('exit', (code, signal) => {
      exit = { code, signal };
    });
    const captureDiagnostic = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line.includes('[agent] Model resolution failed:')) console.log(line.trim());
      }
    };
    child.stderr.on('data', captureDiagnostic);
    const endpoint = await waitForDebugEndpoint(debugPort, () => exit !== null);

    await use({ child, endpoint });

    child.stderr.off('data', captureDiagnostic);
    if (exit === null) child.kill('SIGINT');
    await new Promise((resolve) => {
      if (exit !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(resolve, 15_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  },

  codexBrowser: async ({ freedomProcess }, use) => {
    const browser = await chromium.connectOverCDP(freedomProcess.endpoint);
    await use(browser);
    await browser.close().catch(() => {});
  },

  window: async ({ codexBrowser }, use) => {
    const deadline = Date.now() + 60_000;
    let win;
    while (!win && Date.now() < deadline) {
      const pages = codexBrowser.contexts().flatMap((context) => context.pages());
      for (const page of pages) {
        if (await page.locator('[data-test="address-input"]').isVisible().catch(() => false)) {
          win = page;
          break;
        }
      }
      if (!win) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!win) throw new Error('Freedom browser chrome did not become ready');
    await use(win);
  },
});

module.exports = {
  test,
  expect,
  profileId,
};
