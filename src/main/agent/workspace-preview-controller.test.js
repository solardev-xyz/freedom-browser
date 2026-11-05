'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_CONCURRENT_PREVIEW_CREATIONS,
  MAX_CONCURRENT_PREVIEW_REQUESTS,
  MAX_PREVIEW_FILE_BYTES,
  PREVIEW_CSP,
  SERVER_PREVIEW_CSP,
  WorkspacePreviewController,
} = require('./workspace-preview-controller');

const fifoTest = process.platform === 'win32' ? test.skip : test;

function makeFifo(target) {
  const result = spawnSync('mkfifo', [target]);
  if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);
  return target;
}

// Wakes any reader still parked in open(2) on the FIFO so a failing run cannot
// leave a libuv thread blocked after the test.
function releaseFifo(target) {
  try { fs.closeSync(fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); }
  catch { /* No reader is waiting. */ }
}

function within(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`stalled for ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe('WorkspacePreviewController', () => {
  let temporaryRoot;
  let workspaceRoot;
  let workspaceController;

  beforeEach(async () => {
    temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-preview-'));
    workspaceRoot = path.join(temporaryRoot, 'workspace');
    await fs.promises.mkdir(path.join(workspaceRoot, '.git'), { recursive: true });
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'index.html'),
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Hello</h1>'
    );
    await fs.promises.writeFile(path.join(workspaceRoot, 'style.css'), 'h1 { color: red; }');
    workspaceController = {
      getWorkspace: jest.fn(() => ({
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
        enabled: true,
      })),
      resolveWorkspacePath: jest.fn(async () => ({
        workspace: {
          workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
          enabled: true,
        },
        path: workspaceRoot,
      })),
    };
  });

  afterEach(async () => {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  });

  test('serves live static files with an isolated no-network policy', async () => {
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => 'a'.repeat(40),
    });
    const preview = await controller.createPreview('conversation_one', '.');

    expect(preview).toEqual({
      url: `freedom-preview://${'a'.repeat(40)}/index.html`,
      entryPath: 'index.html',
    });
    const html = await controller.handleRequest({ method: 'GET', url: preview.url });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
    expect(html.headers.get('cache-control')).toBe('no-store');
    expect(await html.text()).toContain('<h1>Hello</h1>');

    await fs.promises.writeFile(path.join(workspaceRoot, 'style.css'), 'h1 { color: blue; }');
    const css = await controller.handleRequest({
      method: 'GET',
      url: `freedom-preview://${'a'.repeat(40)}/style.css`,
    });
    expect(await css.text()).toBe('h1 { color: blue; }');
    const head = await controller.handleRequest({ method: 'HEAD', url: preview.url });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await controller.handleRequest({ method: 'POST', url: preview.url })).status).toBe(405);
  });

  test('supports an HTML entry point and reuses its opaque preview origin', async () => {
    await fs.promises.mkdir(path.join(workspaceRoot, 'site'));
    await fs.promises.writeFile(path.join(workspaceRoot, 'site', 'app.html'), '<h1>App</h1>');
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => 'b'.repeat(40),
    });

    const first = await controller.createPreview('conversation_one', 'site/app.html');
    const second = await controller.createPreview('conversation_one', 'site/app.html');
    expect(second).toEqual(first);
    expect(first.entryPath).toBe('site/app.html');
    expect(await (await controller.handleRequest({ method: 'GET', url: first.url })).text()).toBe(
      '<h1>App</h1>'
    );
  });

  test('proxies a declared running server through an isolated same-origin preview', async () => {
    const processId = 'workspace_process_bbbbbbbbbbbbbbbbbbbbbbbb';
    workspaceController.inspectProcess = jest.fn(() => ({
      processId,
      state: 'running',
      workspace: {
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
        processId,
        state: 'running',
        networkPosture: 'full',
        previewPort: 4_173,
      },
    }));
    const fetch = jest.fn(async () =>
      new Response('<h1>Live server</h1>', {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'secret=value',
        },
      })
    );
    const controller = new WorkspacePreviewController({
      workspaceController,
      fetch,
      tokenFactory: () => '1'.repeat(40),
    });

    const preview = controller.createProcessPreview('conversation_one', processId);
    expect(preview).toEqual({
      kind: 'server',
      url: `freedom-preview://${'1'.repeat(40)}/`,
      processId,
      port: 4_173,
      entryPath: 'server on port 4173',
    });
    expect(controller.createProcessPreview('conversation_one', processId)).toEqual(preview);

    const response = await controller.handleRequest({
      method: 'GET',
      url: `${preview.url}api/items?q=one`,
      headers: new Headers({
        accept: 'application/json',
        authorization: 'Bearer secret',
        cookie: 'private=value',
      }),
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4173/api/items?q=one'),
      expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) })
    );
    const upstreamHeaders = fetch.mock.calls[0][1].headers;
    expect(upstreamHeaders.get('accept')).toBe('application/json');
    expect(upstreamHeaders.has('authorization')).toBe(false);
    expect(upstreamHeaders.has('cookie')).toBe(false);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(SERVER_PREVIEW_CSP);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.text()).toContain('Live server');
  });

  test('bounds server traffic, blocks external redirects, and revokes a stopped process', async () => {
    const processId = 'workspace_process_cccccccccccccccccccccccc';
    const workspace = {
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      processId,
      state: 'running',
      networkPosture: 'full',
      previewPort: 4_174,
    };
    workspaceController.inspectProcess = jest.fn(() => ({
      processId,
      state: workspace.state,
      workspace: { ...workspace },
    }));
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://example.com/private' } })
      )
      .mockResolvedValueOnce(
        new Response('small', {
          headers: { 'content-length': String(MAX_PREVIEW_FILE_BYTES + 1) },
        })
      );
    const controller = new WorkspacePreviewController({
      workspaceController,
      fetch,
      tokenFactory: () => '2'.repeat(40),
    });
    const preview = controller.createProcessPreview('conversation_one', processId);

    expect((await controller.handleRequest({ method: 'GET', url: preview.url })).status).toBe(403);
    expect((await controller.handleRequest({ method: 'GET', url: preview.url })).status).toBe(413);
    expect(
      (
        await controller.handleRequest({
          method: 'POST',
          url: preview.url,
          headers: new Headers({ 'content-length': String(1024 * 1024 + 1) }),
          body: new Blob(['x']).stream(),
        })
      ).status
    ).toBe(413);

    workspace.state = 'cancelled';
    expect((await controller.handleRequest({ method: 'GET', url: preview.url })).status).toBe(410);
    expect((await controller.handleRequest({ method: 'GET', url: preview.url })).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('injects the socket adapter before application scripts and reattaches a saved origin to a fresh generation', async () => {
    const serverId = `workspace_server_${'a'.repeat(24)}`;
    let processId = `workspace_process_${'a'.repeat(24)}`;
    const saved = { serverId, previewToken: 'b'.repeat(40), state: 'running' };
    workspaceController.listServers = () => [{ ...saved, processId }];
    workspaceController.getServer = () => ({ ...saved, processId });
    workspaceController.inspectProcess = (_owner, id) => ({ workspace: {
      processId: id, workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa', state: id === processId ? 'running' : 'cancelled',
      networkPosture: 'full', previewPort: 5173,
    } });
    const fetch = jest.fn(async () => new Response('<!doctype html><html><head><script type="module" src="/app.js"></script></head></html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    const controller = new WorkspacePreviewController({ workspaceController, fetch });
    controller.maxPreviews = 1;
    const preview = controller.createProcessPreview('conversation_one', processId);
    const oldKey = controller.previews.get('b'.repeat(40)).socketKey;
    const response = await controller.handleRequest({ method: 'GET', url: preview.url });
    const html = await response.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.indexOf('/.freedom-preview/client.js')).toBeLessThan(html.indexOf('/app.js'));
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(html)));
    const client = await controller.handleRequest({ method: 'GET', url: preview.url + '.freedom-preview/client.js' });
    expect(await client.text()).toContain('window.WebSocket = PreviewWebSocket');
    expect(fetch).toHaveBeenCalledTimes(1);
    processId = `workspace_process_${'c'.repeat(24)}`;
    const status = await controller.handleRequest({ method: 'GET', url: preview.url + '.freedom-preview/status' });
    expect(await status.json()).toEqual({ processId });
    expect(controller.createProcessPreview('conversation_one', processId).url).toBe(preview.url);
    const endpoint = preview.url + '.freedom-preview/socket';
    const socketRequest = key => new Request(endpoint, { method: 'POST', body: JSON.stringify({ key, action: 'open', url: 'ws://localhost:9999/' }) });
    expect((await controller.handleRequest(socketRequest(oldKey))).status).toBe(403);
    controller.socketRequests = 96;
    expect((await controller.handleRequest(socketRequest(oldKey))).status).toBe(503);
    controller.socketRequests = 0;
    expect((await controller.handleRequest(socketRequest(controller.previews.get('b'.repeat(40)).socketKey))).status).toBe(403);
    await controller.dispose();
  });

  test('disables DNS prefetch on every static, server, socket and error response', async () => {
    const seen = [];
    const record = controller => async request => {
      const response = await controller.handleRequest(request);
      seen.push([request.method, request.url, response.status, response.headers.get('x-dns-prefetch-control')]);
      return response;
    };
    await fs.promises.mkdir(path.join(workspaceRoot, 'nested'));
    await fs.promises.writeFile(path.join(workspaceRoot, 'nested', 'index.html'), '<p>nested</p>');
    await fs.promises.writeFile(path.join(workspaceRoot, 'large.css'), 'x');
    await fs.promises.truncate(path.join(workspaceRoot, 'large.css'), MAX_PREVIEW_FILE_BYTES + 1);
    await fs.promises.symlink(path.join(workspaceRoot, 'style.css'), path.join(workspaceRoot, 'linked.css'));
    const staticController = new WorkspacePreviewController({ workspaceController, tokenFactory: () => '3'.repeat(40) });
    const staticRequest = record(staticController);
    const origin = `freedom-preview://${'3'.repeat(40)}`;
    await staticController.createPreview('conversation_one');
    for (const [method, pathname] of [['GET', '/index.html'], ['HEAD', '/index.html'], ['POST', '/index.html'],
      ['GET', '/nested'], ['GET', '/missing.css'], ['GET', '/linked.css'], ['GET', '/large.css']]) {
      await staticRequest({ method, url: `${origin}${pathname}` });
    }
    await staticRequest({ method: 'GET', url: `freedom-preview://${'4'.repeat(40)}/index.html` });
    staticController.activeRequests = MAX_CONCURRENT_PREVIEW_REQUESTS;
    await staticRequest({ method: 'GET', url: `${origin}/index.html` });
    staticController.activeRequests = 0;

    const processId = `workspace_process_${'e'.repeat(24)}`;
    const workspace = { workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa', processId, state: 'running', networkPosture: 'full', previewPort: 4_175 };
    workspaceController.inspectProcess = jest.fn(() => ({ workspace: { ...workspace } }));
    const fetch = jest.fn()
      .mockResolvedValueOnce(new Response('<h1>Live</h1>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://example.com/' } }))
      .mockRejectedValueOnce(new Error('refused'))
      .mockRejectedValueOnce(new Error('refused'));
    const serverController = new WorkspacePreviewController({ workspaceController, fetch, tokenFactory: () => '8'.repeat(40) });
    const serverRequest = record(serverController);
    const preview = serverController.createProcessPreview('conversation_one', processId);
    await serverRequest({ method: 'GET', url: `${preview.url}page` });
    await serverRequest({ method: 'GET', url: `${preview.url}redirect` });
    await serverRequest({ method: 'GET', url: `${preview.url}external` });
    await serverRequest({ method: 'GET', url: `${preview.url}down`, headers: new Headers({ accept: 'text/html' }) });
    await serverRequest({ method: 'GET', url: `${preview.url}down` });
    await serverRequest({ method: 'TRACE', url: preview.url });
    await serverRequest({ method: 'GET', url: `${preview.url}.freedom-preview/status` });
    await serverRequest({ method: 'GET', url: `${preview.url}.freedom-preview/client.js` });
    await serverRequest(new Request(`${preview.url}.freedom-preview/socket`, { method: 'POST', body: '{}' }));
    serverController.socketRequests = 96;
    await serverRequest(new Request(`${preview.url}.freedom-preview/socket`, { method: 'POST', body: '{}' }));
    serverController.socketRequests = 0;
    workspace.state = 'cancelled';
    await serverRequest({ method: 'GET', url: `${preview.url}page` });

    expect(new Set(seen.map(entry => entry[2]))).toEqual(
      new Set([200, 302, 307, 403, 404, 405, 410, 413, 429, 502, 503])
    );
    expect(seen.filter(entry => entry[3] !== 'off')).toEqual([]);
  });

  test('refuses server previews without a conversation-owned full-network process', () => {
    const processId = 'workspace_process_dddddddddddddddddddddddd';
    workspaceController.inspectProcess = jest.fn(() => ({
      processId,
      state: 'running',
      workspace: {
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
        processId,
        state: 'running',
        networkPosture: 'none',
        previewPort: 4_173,
      },
    }));
    const controller = new WorkspacePreviewController({ workspaceController, fetch: jest.fn() });

    let error;
    try {
      controller.createProcessPreview('conversation_one', processId);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'WORKSPACE_PREVIEW_UNAVAILABLE' });
  });

  test('rejects traversal, Git metadata, symlinks, hard links, and oversized files', async () => {
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => 'c'.repeat(40),
    });
    await expect(
      controller.createPreview('conversation_one', '../outside.html')
    ).rejects.toMatchObject({
      code: 'WORKSPACE_PREVIEW_UNSAFE',
    });
    await expect(controller.createPreview('conversation_one', '.git')).rejects.toMatchObject({
      code: 'WORKSPACE_PREVIEW_UNSAFE',
    });

    await fs.promises.symlink(
      path.join(workspaceRoot, 'index.html'),
      path.join(workspaceRoot, 'link.html')
    );
    await expect(controller.createPreview('conversation_one', 'link.html')).rejects.toMatchObject({
      code: 'WORKSPACE_PREVIEW_UNSAFE',
    });

    await fs.promises.link(
      path.join(workspaceRoot, 'index.html'),
      path.join(workspaceRoot, 'hard.html')
    );
    await expect(controller.createPreview('conversation_one', 'hard.html')).rejects.toMatchObject({
      code: 'WORKSPACE_PREVIEW_UNAVAILABLE',
    });

    await fs.promises.writeFile(path.join(workspaceRoot, 'large.html'), 'x');
    await fs.promises.truncate(path.join(workspaceRoot, 'large.html'), MAX_PREVIEW_FILE_BYTES + 1);
    await expect(controller.createPreview('conversation_one', 'large.html')).rejects.toMatchObject({
      code: 'WORKSPACE_PREVIEW_TOO_LARGE',
    });
  });

  fifoTest('refuses a FIFO index.html promptly instead of parking the open', async () => {
    const site = path.join(workspaceRoot, 'site');
    await fs.promises.mkdir(site);
    const fifo = makeFifo(path.join(site, 'index.html'));
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => '7'.repeat(40),
    });
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await expect(within(controller.createPreview('conversation_one', 'site'), 2_000))
          .rejects.toMatchObject({ code: 'WORKSPACE_PREVIEW_UNSAFE' });
      }
      await expect(within(fs.promises.readFile(path.join(workspaceRoot, 'style.css'), 'utf8'), 2_000))
        .resolves.toBe('h1 { color: red; }');
      await expect(within(controller.createPreview('conversation_one', '.'), 2_000)).resolves.toMatchObject({
        entryPath: 'index.html',
      });
    } finally {
      releaseFifo(fifo);
    }
  });

  fifoTest('refuses a FIFO asset promptly and keeps serving other files', async () => {
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => '6'.repeat(40),
    });
    const preview = await controller.createPreview('conversation_one');
    const fifo = makeFifo(path.join(workspaceRoot, 'pipe.css'));
    const origin = new URL(preview.url);
    try {
      // Each round fills every request slot; a parked open would never free them.
      for (let round = 0; round < 3; round += 1) {
        const responses = await within(Promise.all(
          Array.from({ length: MAX_CONCURRENT_PREVIEW_REQUESTS }, () =>
            controller.handleRequest({ method: 'GET', url: `${origin.protocol}//${origin.host}/pipe.css` })
          )
        ), 2_000);
        expect(responses.map(response => response.status)).toEqual(
          Array(MAX_CONCURRENT_PREVIEW_REQUESTS).fill(403)
        );
        expect(controller.activeRequests).toBe(0);
      }
      const css = await within(controller.handleRequest({
        method: 'GET',
        url: `${origin.protocol}//${origin.host}/style.css`,
      }), 2_000);
      expect(css.status).toBe(200);
      expect(await css.text()).toBe('h1 { color: red; }');
    } finally {
      releaseFifo(fifo);
    }
  });

  test('refuses createPreview beyond its concurrency limit instead of queueing work', async () => {
    const releases = [];
    const resolved = {
      workspace: { workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa', enabled: true },
      path: workspaceRoot,
    };
    workspaceController.resolveWorkspacePath = jest.fn(() => new Promise(resolve => {
      releases.push(() => resolve(resolved));
    }));
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => '5'.repeat(40),
    });
    const pending = Array.from({ length: MAX_CONCURRENT_PREVIEW_CREATIONS }, () =>
      controller.createPreview('conversation_one'));
    await expect(controller.createPreview('conversation_one')).rejects.toMatchObject({
      code: 'WORKSPACE_PREVIEW_UNAVAILABLE',
    });
    expect(workspaceController.resolveWorkspacePath).toHaveBeenCalledTimes(MAX_CONCURRENT_PREVIEW_CREATIONS);
    for (const release of releases) release();
    await Promise.all(pending);
    workspaceController.resolveWorkspacePath = jest.fn(async () => resolved);
    await expect(controller.createPreview('conversation_one')).resolves.toMatchObject({ entryPath: 'index.html' });
  });

  test('does not serve unsafe subresources introduced after preview creation', async () => {
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => '9'.repeat(40),
    });
    const preview = await controller.createPreview('conversation_one');
    const outside = path.join(temporaryRoot, 'outside.css');
    await fs.promises.writeFile(outside, 'body { display: none; }');
    await fs.promises.symlink(outside, path.join(workspaceRoot, 'linked.css'));
    await fs.promises.link(outside, path.join(workspaceRoot, 'hard-linked.css'));

    const origin = new URL(preview.url);
    expect(
      (
        await controller.handleRequest({
          method: 'GET',
          url: `${origin.protocol}//${origin.host}/linked.css`,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await controller.handleRequest({
          method: 'GET',
          url: `${origin.protocol}//${origin.host}/hard-linked.css`,
        })
      ).status
    ).toBe(403);
  });

  test('rejects unknown origins and revokes a conversation immediately', async () => {
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => 'd'.repeat(40),
    });
    const preview = await controller.createPreview('conversation_one');
    await expect(controller.revokeConversation('conversation_one')).resolves.toBe(1);
    expect((await controller.handleRequest({ method: 'GET', url: preview.url })).status).toBe(404);
    expect(
      (
        await controller.handleRequest({
          method: 'GET',
          url: `freedom-preview://${'e'.repeat(40)}/index.html`,
        })
      ).status
    ).toBe(404);
  });

  test('registers and removes the protocol handler and clears preview storage', async () => {
    const protocol = { handle: jest.fn(), unhandle: jest.fn(async () => {}) };
    const clearStorageData = jest.fn(async () => {});
    const controller = new WorkspacePreviewController({
      workspaceController,
      tokenFactory: () => 'f'.repeat(40),
    });
    controller.register({ protocol, clearStorageData });
    expect(protocol.handle).toHaveBeenCalledWith('freedom-preview', expect.any(Function));
    await controller.createPreview('conversation_one');
    await controller.dispose();
    expect(protocol.unhandle).toHaveBeenCalledWith('freedom-preview');
    expect(clearStorageData).toHaveBeenCalledWith(
      expect.objectContaining({ origin: `freedom-preview://${'f'.repeat(40)}` })
    );
  });
});
