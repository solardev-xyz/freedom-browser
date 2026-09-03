'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_PREVIEW_FILE_BYTES,
  PREVIEW_CSP,
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
