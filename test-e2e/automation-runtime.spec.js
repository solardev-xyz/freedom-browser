'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const SAMPLE_BZZ_HASH = 'a'.repeat(64);
const SAMPLE_IPFS_CID = `bafybeib${'a'.repeat(51)}`;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function connectRuntime(endpoint) {
  const socket = net.createConnection(endpoint.path);
  let buffer = '';
  const queued = new Map();
  const waiters = new Map();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const response = JSON.parse(line);
        const waiter = waiters.get(response.id);
        if (waiter) {
          waiters.delete(response.id);
          waiter(response);
        } else {
          queued.set(response.id, response);
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });

  return {
    socket,
    connected: () =>
      new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      }),
    request(payload) {
      if (waiters.has(payload.id)) throw new Error(`Duplicate in-flight request id: ${payload.id}`);
      const response = new Promise((resolve) => {
        if (queued.has(payload.id)) {
          const responseForId = queued.get(payload.id);
          queued.delete(payload.id);
          resolve(responseForId);
        } else {
          waiters.set(payload.id, resolve);
        }
      });
      socket.write(`${JSON.stringify(payload)}\n`);
      return response;
    },
  };
}

test('headless runtime publishes readiness and serves the automation controller', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-runtime-e2e-'));
  const discoveryPath = path.join(userDataDir, 'automation-runtime', 'runtime.json');
  let app;
  let client;
  try {
    app = await electron.launch({
      args: ['.', '--runtime'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });

    await expect
      .poll(() => readJson(discoveryPath), { timeout: 10_000 })
      .toMatchObject({
        state: 'ready',
        protocolVersion: 1,
        profile: { id: 'test' },
        endpoint: { path: expect.any(String) },
        tokenPath: expect.any(String),
      });
    const discovery = readJson(discoveryPath);
    expect(app.windows()).toHaveLength(0);

    const lockedLaunch = spawnSync(require('electron'), ['.', '--runtime'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(lockedLaunch.status).toBe(11);
    const lockError = lockedLaunch.stderr
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.type === 'freedom.runtime.error');
    expect(lockError).toMatchObject({
      error: { code: 'PROFILE_LOCKED' },
      profile: { id: 'test' },
      discovery: { state: 'ready', path: discoveryPath },
    });

    const token = fs.readFileSync(discovery.tokenPath, 'utf8').trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    client = connectRuntime(discovery.endpoint);
    await client.connected();
    const handshake = await client.request({
      id: 'hello',
      method: 'runtime.handshake',
      params: { protocolVersion: 1, token },
    });
    expect(handshake).toMatchObject({
      id: 'hello',
      ok: true,
      result: {
        state: 'ready',
        runtimeId: expect.any(String),
        contextId: expect.any(String),
        idle: {
          enabled: true,
          state: 'blocked',
          timeoutMs: 15 * 60 * 1000,
          blockers: [{ source: 'client', count: 1 }],
        },
      },
    });
    await expect(
      client.request({
        id: 'tabs',
        method: 'automation.execute',
        params: { operation: 'browser_list_tabs', input: {} },
      })
    ).resolves.toMatchObject({
      id: 'tabs',
      ok: true,
      result: { ok: true, result: { tabs: [] } },
    });

    const protocolCases = [
      {
        id: 'swarm',
        url: `bzz://${SAMPLE_BZZ_HASH}/runtime-protocol`,
        title: 'Swarm runtime fixture',
      },
      {
        id: 'ipfs',
        url: `ipfs://${SAMPLE_IPFS_CID}/runtime-protocol`,
        title: 'IPFS runtime fixture',
      },
      {
        id: 'ipns',
        url: 'ipns://runtime.example.test/runtime-protocol',
        title: 'IPNS runtime fixture',
      },
    ];
    await app.evaluate((_electron, cases) => {
      for (const entry of cases) {
        globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(entry.url, {
          body: `<!doctype html><title>${entry.title}</title><h1>${entry.title}</h1>`,
        });
      }
    }, protocolCases);
    for (const protocolCase of protocolCases) {
      const created = await client.request({
        id: `create-${protocolCase.id}`,
        method: 'automation.execute',
        params: { operation: 'browser_create_tab', input: { url: protocolCase.url } },
      });
      const tabId = created.result.result.tab.tabId;
      expect(created).toMatchObject({
        ok: true,
        result: {
          ok: true,
          runtimeId: handshake.result.runtimeId,
          contextId: handshake.result.contextId,
          result: {
            tab: { tabId, kind: 'headless', url: protocolCase.url, available: true },
          },
        },
      });
      await expect(
        client.request({
          id: `snapshot-${protocolCase.id}`,
          method: 'automation.execute',
          params: { operation: 'browser_snapshot', input: { tabId } },
        })
      ).resolves.toMatchObject({
        ok: true,
        result: {
          ok: true,
          runtimeId: handshake.result.runtimeId,
          contextId: handshake.result.contextId,
          tabId,
          result: {
            url: protocolCase.url,
            title: protocolCase.title,
            text: protocolCase.title,
          },
        },
      });
      await expect(
        client.request({
          id: `close-${protocolCase.id}`,
          method: 'automation.execute',
          params: { operation: 'browser_close_tab', input: { tabId } },
        })
      ).resolves.toMatchObject({
        ok: true,
        result: { ok: true, result: { closed: true, tabId } },
      });
    }
    await expect.poll(() => app.windows().length).toBe(0);

    const firstUrl = 'https://runtime.example.test/page';
    const createdFirst = await client.request({
      id: 'create-first',
      method: 'automation.execute',
      params: { operation: 'browser_create_tab', input: { url: firstUrl } },
    });
    expect(createdFirst).toMatchObject({
      id: 'create-first',
      ok: true,
      result: {
        ok: true,
        runtimeId: handshake.result.runtimeId,
        contextId: handshake.result.contextId,
        result: {
          tab: {
            tabId: expect.any(String),
            kind: 'headless',
            url: firstUrl,
            available: true,
          },
        },
      },
    });
    const firstTabId = createdFirst.result.result.tab.tabId;
    await expect.poll(() => app.windows().length).toBe(1);

    await expect(
      client.request({
        id: 'snapshot-first',
        method: 'automation.execute',
        params: {
          operation: 'browser_snapshot',
          input: { tabId: firstTabId },
        },
      })
    ).resolves.toMatchObject({
      id: 'snapshot-first',
      ok: true,
      result: {
        ok: true,
        runtimeId: handshake.result.runtimeId,
        contextId: handshake.result.contextId,
        tabId: firstTabId,
        result: {
          url: firstUrl,
          title: 'test-harness https stub',
          text: expect.stringContaining('https:// blocked in test mode'),
        },
      },
    });

    const popupUrl = 'https://runtime.example.test/popup';
    await app.windows()[0].evaluate((url) => {
      window.open(url, '_blank', 'show=yes,nodeIntegration=yes,contextIsolation=no');
    }, popupUrl);
    await expect.poll(() => app.windows().length).toBe(2);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            preferences: window.webContents.getLastWebPreferences(),
          }))
        )
      )
      .toEqual([
        expect.objectContaining({
          visible: false,
          preferences: expect.objectContaining({
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          }),
        }),
        expect.objectContaining({
          visible: false,
          preferences: expect.objectContaining({
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          }),
        }),
      ]);

    const popupTabs = await client.request({
      id: 'popup-tabs',
      method: 'automation.execute',
      params: { operation: 'browser_list_tabs', input: {} },
    });
    const popup = popupTabs.result.result.tabs.find((tab) => tab.kind === 'popup');
    expect(popup).toMatchObject({ tabId: expect.any(String), kind: 'popup', url: popupUrl });
    await expect(
      client.request({
        id: 'close-popup',
        method: 'automation.execute',
        params: { operation: 'browser_close_tab', input: { tabId: popup.tabId } },
      })
    ).resolves.toMatchObject({
      id: 'close-popup',
      ok: true,
      result: { ok: true, result: { closed: true, tabId: popup.tabId } },
    });
    await expect.poll(() => app.windows().length).toBe(1);

    const secondUrl = 'https://runtime.example.test/second';
    const createdSecond = await client.request({
      id: 'create-second',
      method: 'automation.execute',
      params: { operation: 'browser_create_tab', input: { url: secondUrl } },
    });
    const secondTabId = createdSecond.result.result.tab.tabId;
    expect(secondTabId).not.toBe(firstTabId);
    expect(createdSecond).toMatchObject({
      ok: true,
      result: {
        ok: true,
        runtimeId: handshake.result.runtimeId,
        contextId: handshake.result.contextId,
        result: { tab: { tabId: secondTabId, kind: 'headless', url: secondUrl } },
      },
    });
    await expect.poll(() => app.windows().length).toBe(2);

    const screenshot = await client.request({
      id: 'screenshot-second',
      method: 'automation.execute',
      params: {
        operation: 'browser_screenshot',
        input: { tabId: secondTabId },
      },
    });
    expect(screenshot).toMatchObject({
      ok: true,
      result: {
        ok: true,
        runtimeId: handshake.result.runtimeId,
        contextId: handshake.result.contextId,
        result: { mediaType: 'image/png', base64: expect.any(String) },
      },
    });
    expect(screenshot.result.result.base64.length).toBeGreaterThan(100);

    await expect(
      client.request({
        id: 'close-first',
        method: 'automation.execute',
        params: { operation: 'browser_close_tab', input: { tabId: firstTabId } },
      })
    ).resolves.toMatchObject({
      id: 'close-first',
      ok: true,
      result: {
        ok: true,
        runtimeId: handshake.result.runtimeId,
        contextId: handshake.result.contextId,
        tabId: firstTabId,
        result: { closed: true, tabId: firstTabId },
      },
    });
    await expect.poll(() => app.windows().length).toBe(1);
    await expect(
      client.request({
        id: 'remaining-tabs',
        method: 'automation.execute',
        params: { operation: 'browser_list_tabs', input: {} },
      })
    ).resolves.toMatchObject({
      id: 'remaining-tabs',
      ok: true,
      result: {
        ok: true,
        runtimeId: handshake.result.runtimeId,
        contextId: handshake.result.contextId,
        result: { tabs: [{ tabId: secondTabId, kind: 'headless', url: secondUrl }] },
      },
    });

    const exit = new Promise((resolve) => app.process().once('exit', resolve));
    await expect(client.request({ id: 'shutdown', method: 'runtime.shutdown' })).resolves.toEqual({
      id: 'shutdown',
      ok: true,
      result: { shuttingDown: true },
    });
    await exit;
    app = null;
    expect(readJson(discoveryPath)).toMatchObject({ state: 'stopped' });
    expect(fs.readFileSync(discovery.tokenPath, 'utf8')).toBe('');
  } finally {
    client?.socket.destroy();
    if (app) {
      try {
        await app.close();
      } catch {
        // The runtime may already be finishing its authenticated shutdown.
      }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
