'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_PREVIEW_FILE_BYTES,
  PREVIEW_CSP,
  SERVER_PREVIEW_CSP,
  WorkspacePreviewController,
} = require('./workspace-preview-controller');

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
