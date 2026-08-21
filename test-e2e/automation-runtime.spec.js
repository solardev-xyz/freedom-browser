'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

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
  const queued = [];
  const waiters = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const response = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) waiter(response);
        else queued.push(response);
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
      const response = new Promise((resolve) => {
        if (queued.length) resolve(queued.shift());
        else waiters.push(resolve);
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

    const token = fs.readFileSync(discovery.tokenPath, 'utf8').trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    client = connectRuntime(discovery.endpoint);
    await client.connected();
    await expect(
      client.request({
        id: 'hello',
        method: 'runtime.handshake',
        params: { protocolVersion: 1, token },
      })
    ).resolves.toMatchObject({
      id: 'hello',
      ok: true,
      result: { state: 'ready', runtimeId: expect.any(String), contextId: expect.any(String) },
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
