'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { once } = require('events');
const {
  RUNTIME_PROTOCOL_VERSION,
  createRuntimeEndpoint,
  createRuntimeServer,
  inspectRuntimeDiscovery,
} = require('./runtime-server');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join('/tmp', prefix));
}

function createLineClient(endpoint) {
  const socket = net.createConnection(endpoint.path);
  let buffer = '';
  const responses = new Map();
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
          responses.set(response.id, response);
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });

  return {
    socket,
    async connected() {
      if (socket.readyState === 'open') return;
      await once(socket, 'connect');
    },
    request(payload) {
      if (waiters.has(payload.id)) throw new Error(`Duplicate in-flight request id: ${payload.id}`);
      const response = new Promise((resolve) => {
        if (responses.has(payload.id)) {
          const responseForId = responses.get(payload.id);
          responses.delete(payload.id);
          resolve(responseForId);
        } else {
          waiters.set(payload.id, resolve);
        }
      });
      socket.write(`${JSON.stringify(payload)}\n`);
      return response;
    },
    close() {
      socket.destroy();
    },
  };
}

describe('automation runtime server', () => {
  const cleanupPaths = [];

  afterEach(() => {
    for (const cleanupPath of cleanupPaths.splice(0)) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
  });

  function createFixture(options = {}) {
    const userDataDir = tempDir('freedom-runtime-profile-');
    const socketRoot = tempDir('freedom-runtime-sockets-');
    cleanupPaths.push(userDataDir, socketRoot);
    const controller = {
      runtimeId: 'runtime_test',
      contextId: 'context_test',
      execute: jest.fn(async (operation) => ({
        ok: true,
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        result: { operation },
      })),
    };
    const onShutdown = jest.fn();
    const server = createRuntimeServer({
      profile: {
        id: 'automation',
        displayName: 'Automation',
        userDataDir,
      },
      controller,
      token: 'a'.repeat(64),
      endpointNonce: 'test',
      socketRoot,
      appVersion: '1.2.3',
      onShutdown,
      ...options,
    });
    return { controller, onShutdown, server, userDataDir };
  }

  test('publishes private discovery and serves authenticated runtime requests', async () => {
    const { controller, onShutdown, server } = createFixture();
    const discovery = await server.start();
    const discoveryOnDisk = JSON.parse(fs.readFileSync(server.paths.discoveryPath, 'utf8'));

    expect(discovery).toMatchObject({
      state: 'ready',
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      appVersion: '1.2.3',
      runtimeId: 'runtime_test',
      contextId: 'context_test',
      profile: { id: 'automation', displayName: 'Automation' },
      endpoint: server.endpoint,
      tokenPath: server.paths.tokenPath,
    });
    expect(discoveryOnDisk).toEqual(discovery);
    expect(JSON.stringify(discovery)).not.toContain('a'.repeat(64));
    if (process.platform !== 'win32') {
      expect(fs.statSync(server.paths.discoveryPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(server.paths.tokenPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(server.endpoint.path).mode & 0o777).toBe(0o600);
    }

    const client = createLineClient(server.endpoint);
    await client.connected();
    await expect(
      client.request({
        id: 'hello',
        method: 'runtime.handshake',
        params: { protocolVersion: RUNTIME_PROTOCOL_VERSION, token: 'a'.repeat(64) },
      })
    ).resolves.toMatchObject({
      id: 'hello',
      ok: true,
      result: {
        state: 'ready',
        capabilities: ['automation.execute', 'runtime.status', 'runtime.shutdown'],
      },
    });
    await expect(client.request({ id: 0, method: 'runtime.status' })).resolves.toMatchObject({
      id: 0,
      ok: true,
      result: { state: 'ready', profile: { id: 'automation' } },
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
      result: { ok: true, result: { operation: 'browser_list_tabs' } },
    });
    expect(controller.execute).toHaveBeenCalledWith('browser_list_tabs', {});

    await expect(client.request({ id: 'shutdown', method: 'runtime.shutdown' })).resolves.toEqual({
      id: 'shutdown',
      ok: true,
      result: { shuttingDown: true },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShutdown).toHaveBeenCalledTimes(1);

    client.close();
    await server.stop();
    expect(JSON.parse(fs.readFileSync(server.paths.discoveryPath, 'utf8'))).toMatchObject({
      state: 'stopped',
      stoppedAt: expect.any(String),
    });
    expect(fs.readFileSync(server.paths.tokenPath, 'utf8')).toBe('');
  });

  test('rejects unauthenticated and invalid-token clients without exposing the token', async () => {
    const { server } = createFixture();
    await server.start();

    const unauthenticated = createLineClient(server.endpoint);
    await unauthenticated.connected();
    await expect(
      unauthenticated.request({ id: 'status', method: 'runtime.status' })
    ).resolves.toEqual({
      id: 'status',
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Runtime handshake is required' },
    });

    const invalidToken = createLineClient(server.endpoint);
    await invalidToken.connected();
    const rejection = await invalidToken.request({
      id: 'hello',
      method: 'runtime.handshake',
      params: { protocolVersion: RUNTIME_PROTOCOL_VERSION, token: 'b'.repeat(64) },
    });
    expect(rejection).toEqual({
      id: 'hello',
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Runtime authentication failed' },
    });
    expect(JSON.stringify(rejection)).not.toContain('a'.repeat(64));

    unauthenticated.close();
    invalidToken.close();
    await server.stop();
  });

  test('bounds request size before parsing JSON', async () => {
    const { server } = createFixture({ maxMessageBytes: 128 });
    await server.start();
    const client = createLineClient(server.endpoint);
    await client.connected();

    const response = new Promise((resolve) => {
      client.socket.once('data', (chunk) => resolve(JSON.parse(chunk.trim())));
    });
    client.socket.write(`${JSON.stringify({ value: 'x'.repeat(256) })}\n`);
    await expect(response).resolves.toEqual({
      id: null,
      ok: false,
      error: { code: 'MESSAGE_TOO_LARGE', message: 'Runtime request is too large' },
    });

    client.close();
    await server.stop();
  });

  test('allows control requests to interrupt an in-flight operation on one connection', async () => {
    let finishNavigation;
    const navigationPending = new Promise((resolve) => {
      finishNavigation = resolve;
    });
    const { controller, server } = createFixture();
    controller.execute.mockImplementation(async (operation) => {
      if (operation === 'browser_navigate') await navigationPending;
      return {
        ok: true,
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        result: { operation },
      };
    });
    await server.start();
    const client = createLineClient(server.endpoint);
    await client.connected();
    await client.request({
      id: 'hello',
      method: 'runtime.handshake',
      params: { protocolVersion: RUNTIME_PROTOCOL_VERSION, token: 'a'.repeat(64) },
    });

    const navigation = client.request({
      id: 'navigate',
      method: 'automation.execute',
      params: { operation: 'browser_navigate', input: { tabId: 'tab_1' } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      client.request({
        id: 'stop',
        method: 'automation.execute',
        params: { operation: 'browser_stop_loading', input: { tabId: 'tab_1' } },
      })
    ).resolves.toMatchObject({
      id: 'stop',
      ok: true,
      result: { result: { operation: 'browser_stop_loading' } },
    });
    await expect(client.request({ id: 'status', method: 'runtime.status' })).resolves.toMatchObject(
      {
        id: 'status',
        ok: true,
        result: { state: 'ready' },
      }
    );

    finishNavigation();
    await expect(navigation).resolves.toMatchObject({
      id: 'navigate',
      ok: true,
      result: { result: { operation: 'browser_navigate' } },
    });
    client.close();
    await server.stop();
  });

  test('uses a profile-derived Windows named pipe without touching the filesystem', () => {
    const profile = {
      id: 'automation',
      userDataDir: 'C:\\Users\\test\\Freedom\\Automation',
    };
    const endpoint = createRuntimeEndpoint(profile, {
      platform: 'win32',
      endpointNonce: 'abc123',
    });
    expect(endpoint.kind).toBe('named-pipe');
    expect(endpoint.path.startsWith('\\\\.\\pipe\\freedom-runtime-')).toBe(true);
    expect(endpoint.path.endsWith('-abc123')).toBe(true);
  });

  test('classifies discovery as live, stale, missing, or invalid', () => {
    const { server, userDataDir } = createFixture();
    const profile = { id: 'automation', userDataDir };
    fs.mkdirSync(server.paths.runtimeDir, { recursive: true });
    fs.writeFileSync(
      server.paths.discoveryPath,
      JSON.stringify({
        schemaVersion: 1,
        state: 'ready',
        pid: 1234,
        profile: { id: 'automation' },
        endpoint: server.endpoint,
        tokenPath: server.paths.tokenPath,
      })
    );

    expect(inspectRuntimeDiscovery(profile, { isProcessAlive: () => true })).toMatchObject({
      state: 'ready',
      advertisedState: 'ready',
      processAlive: true,
    });
    expect(inspectRuntimeDiscovery(profile, { isProcessAlive: () => false })).toMatchObject({
      state: 'stale',
      advertisedState: 'ready',
      processAlive: false,
    });
    fs.writeFileSync(server.paths.discoveryPath, '{not json');
    expect(inspectRuntimeDiscovery(profile)).toMatchObject({
      state: 'invalid',
      reason: 'invalid-json',
    });
    fs.unlinkSync(server.paths.discoveryPath);
    expect(inspectRuntimeDiscovery(profile)).toMatchObject({ state: 'missing' });
  });

  (process.platform === 'win32' ? test.skip : test)(
    'refuses to write credentials through a symbolic link',
    async () => {
      const { server, userDataDir } = createFixture();
      fs.mkdirSync(server.paths.runtimeDir, { recursive: true });
      const protectedFile = path.join(userDataDir, 'protected.txt');
      fs.writeFileSync(protectedFile, 'keep-me', 'utf8');
      fs.symlinkSync(protectedFile, server.paths.tokenPath);

      await expect(server.start()).rejects.toMatchObject({ code: 'ELOOP' });
      expect(fs.readFileSync(protectedFile, 'utf8')).toBe('keep-me');
    }
  );
});
