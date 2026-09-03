'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_WORKSPACE_PUBLICATION_FILES,
  ManagedWorkspaceSourceReader,
  validateWorkspacePublicationPath,
} = require('./managed-workspace-source-reader');

describe('ManagedWorkspaceSourceReader', () => {
  let workspaceRoot;
  let reader;

  beforeEach(async () => {
    workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-workspace-source-'));
    await fs.promises.mkdir(path.join(workspaceRoot, '.git'));
    await fs.promises.writeFile(path.join(workspaceRoot, '.git', 'config'), 'private metadata');
    reader = new ManagedWorkspaceSourceReader({
      workspaceController: {
        resolveWorkspacePath: jest.fn(async () => ({
          workspace: { workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa', enabled: true },
          path: workspaceRoot,
        })),
      },
    });
  });

  afterEach(async () => {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  });

  test('reads a project subtree as exact relative file content and excludes Git metadata', async () => {
    await fs.promises.mkdir(path.join(workspaceRoot, 'dist', 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(workspaceRoot, 'dist', 'index.html'), '<h1>Hello</h1>');
    await fs.promises.writeFile(path.join(workspaceRoot, 'dist', 'assets', 'app.js'), 'ready();');

    await expect(reader.describe('conversation_test', 'dist')).resolves.toEqual({
      sourceType: 'workspace',
      kind: 'folder',
      name: 'dist',
      workspacePath: 'dist',
    });
    const source = await reader.read('conversation_test', 'dist');

    expect(source).toMatchObject({
      sourceType: 'workspace',
      kind: 'folder',
      name: 'dist',
      workspacePath: 'dist',
      bytes: Buffer.byteLength('<h1>Hello</h1>ready();'),
    });
    expect(source.files.map((file) => file.path)).toEqual(['assets/app.js', 'index.html']);
    expect(source.files.map((file) => file.bytes.toString('utf8'))).toEqual([
      'ready();',
      '<h1>Hello</h1>',
    ]);
    expect(JSON.stringify(source)).not.toContain('private metadata');
    expect(JSON.stringify(source)).not.toContain(workspaceRoot);
  });

  test('reads one workspace file without turning it into model-visible text', async () => {
    await fs.promises.writeFile(path.join(workspaceRoot, 'index.html'), '<p>Exact bytes</p>');

    const source = await reader.read('conversation_test', 'index.html');

    expect(source).toMatchObject({
      sourceType: 'workspace',
      kind: 'file',
      name: 'index.html',
      workspacePath: 'index.html',
      bytes: Buffer.byteLength('<p>Exact bytes</p>'),
      contentType: 'text/html; charset=utf-8',
    });
    expect(source.data).toEqual(Buffer.from('<p>Exact bytes</p>'));
  });

  test('reads the current ordinary file content without enforcing a pre-approval snapshot', async () => {
    const filePath = path.join(workspaceRoot, 'message.txt');
    await fs.promises.writeFile(filePath, 'before');
    await reader.describe('conversation_test', 'message.txt');
    await fs.promises.writeFile(filePath, 'after');

    const source = await reader.read('conversation_test', 'message.txt');

    expect(source.data.toString('utf8')).toBe('after');
  });

  test('uses a binary media type for an unknown single-file format', async () => {
    await fs.promises.writeFile(path.join(workspaceRoot, 'artifact.bin'), Buffer.from([0, 1, 2]));

    const source = await reader.read('conversation_test', 'artifact.bin');

    expect(source.contentType).toBe('application/octet-stream');
    expect(source.data).toEqual(Buffer.from([0, 1, 2]));
  });

  test('rejects protected paths, symbolic links, and hard links', async () => {
    await fs.promises.writeFile(path.join(workspaceRoot, 'outside.txt'), 'outside');
    await fs.promises.symlink('outside.txt', path.join(workspaceRoot, 'link.txt'));
    await fs.promises.link(
      path.join(workspaceRoot, 'outside.txt'),
      path.join(workspaceRoot, 'hard-link.txt')
    );
    await fs.promises.mkdir(path.join(workspaceRoot, 'unsafe'));
    await fs.promises.symlink('../outside.txt', path.join(workspaceRoot, 'unsafe', 'escape.txt'));

    expect(() => validateWorkspacePublicationPath('.git/config')).toThrow(
      'protected workspace metadata'
    );
    await expect(reader.read('conversation_test', 'link.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PUBLICATION_UNSAFE',
    });
    await expect(reader.read('conversation_test', 'hard-link.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_PUBLICATION_UNSAFE',
    });
    await expect(reader.read('conversation_test', 'unsafe')).rejects.toMatchObject({
      code: 'WORKSPACE_PUBLICATION_UNSAFE',
    });
  });

  test('fails closed when a folder exceeds the bounded file count', async () => {
    await fs.promises.mkdir(path.join(workspaceRoot, 'large'));
    await Promise.all(
      Array.from({ length: MAX_WORKSPACE_PUBLICATION_FILES + 1 }, (_value, index) =>
        fs.promises.writeFile(path.join(workspaceRoot, 'large', `${index}.txt`), 'x')
      )
    );

    await expect(reader.read('conversation_test', 'large')).rejects.toMatchObject({
      code: 'WORKSPACE_PUBLICATION_TOO_LARGE',
    });
  });

  test('publishes the workspace root under a safe display name', async () => {
    await fs.promises.writeFile(path.join(workspaceRoot, 'index.html'), '<main>Root</main>');

    await expect(reader.describe('conversation_test', '.')).resolves.toEqual({
      sourceType: 'workspace',
      kind: 'folder',
      name: 'Project workspace',
      workspacePath: '.',
    });
    const source = await reader.read('conversation_test', '.');
    expect(source.files.map((file) => file.path)).toEqual(['index.html']);
  });
});
