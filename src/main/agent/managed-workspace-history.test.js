'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { initializeWorkspaceGit } = require('./managed-workspace-git');
const { ManagedWorkspaceController } = require('./managed-workspace-controller');
const { ManagedWorkspaceHistory } = require('./managed-workspace-history');

jest.setTimeout(30000);

describe('managed workspace checkpoints and restore', () => {
  let root;
  let controller;
  let workspace;
  let executor;
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  const history = (request) => controller.workspaceHistory('conversation_one', request);
  const git = (...args) =>
    execFileSync(
      process.platform === 'darwin'
        ? '/Library/Developer/CommandLineTools/usr/bin/git'
        : '/usr/bin/git',
      args,
      {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }
    );

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-history-'));
    fs.mkdirSync(path.join(root, '.git'));
    await initializeWorkspaceGit(root);
    workspace = {
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      enabled: true,
      conversationId: 'conversation_one',
    };
    executor = {
      detectCapabilities: async () => ({
        available: true,
        backend: 'macos-seatbelt',
        enforcement: {},
      }),
      execute: jest.fn(async (_policy, request) => {
        try {
          const stdout = execFileSync(process.execPath, ['-e', ...request.args.slice(5)], {
            cwd: root,
            encoding: 'utf8',
            timeout: 15000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { state: 'completed', exitCode: 0, stdout, stdoutTruncated: false };
        } catch (error) {
          return {
            state: 'failed',
            exitCode: 73,
            stdout: '',
            stderr: error.stderr?.toString() || '',
          };
        }
      }),
    };
    controller = new ManagedWorkspaceController({
      store: {
        ensureForConversation: async () => workspace,
        getForConversation: (id) => (id === 'conversation_one' ? workspace : null),
        resolvePath: async () => root,
        listCommands: () => [],
      },
      executor,
      detectRuntime: async () => ({ available: true, sandboxExecutablePath: process.execPath }),
      createPolicy: async () => ({}),
      restrictPolicy: (policy) => policy,
    });
  });
  afterEach(() => {
    controller.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates a real baseline, checkpoints changes once, and labels interrupted turns', async () => {
    write('game.js', 'before\n');
    await controller.prepareWorkspaceHistory('conversation_one');
    expect((await history({ action: 'list' })).versions[0]).toMatchObject({
      kind: 'baseline',
      fileCount: 1,
    });
    expect(git('status', '--porcelain')).toBe('');
    expect((await controller.checkpointWorkspace('conversation_one')).saved).toBe(false);
    write('game.js', 'after\n');
    expect((await controller.checkpointWorkspace('conversation_one', 'cancelled')).saved).toBe(
      true
    );
    const versions = (await history({ action: 'list' })).versions;
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ kind: 'interrupted', label: 'After interrupted turn' });
    expect(git('show', `${versions[1].id}:game.js`)).toBe('before\n');
    expect(git('show', 'HEAD:game.js')).toBe('after\n');
    await controller.prepareWorkspaceHistory('conversation_one');
    expect((await history({ action: 'list' })).versions).toHaveLength(2);
    write('game.js', 'edited between turns\n');
    await controller.prepareWorkspaceHistory('conversation_one');
    expect((await history({ action: 'list' })).versions[0]).toMatchObject({
      kind: 'automatic', label: 'Before agent turn',
    });
    expect(git('show', 'HEAD:game.js')).toBe('edited between turns\n');
    expect(git('fsck', '--no-reflogs')).not.toContain('error');
  });

  test('immutable exclusions and content screening cannot be bypassed with gitignore negations', async () => {
    write('.gitignore', '!node_modules/\n!node_modules/**\n!.env\n');
    write('node_modules/lib.js', 'generated');
    write('.env', 'actual-private-value');
    write('config.js', 'const apiKey = "this-is-a-real-looking-credential";');
    write('settings.yml', 'password: sensitive-value\n');
    write('secrets/unusual-name.txt', 'private content');
    write('image.png', Buffer.from([137, 80, 78, 71, 0, 1]));
    write('game.js', 'const score = 1;');
    write('huge.txt', 'a'.repeat(65537));
    const saved = await history({ action: 'save', label: 'Playable game' });
    expect(saved.excludedCount).toBeGreaterThanOrEqual(3);
    const names = git('ls-tree', '-r', '--name-only', 'HEAD');
    expect(names).toContain('game.js');
    expect(names).toContain('image.png');
    expect(names).not.toMatch(/node_modules|\.env|config.js|huge.txt|settings.yml|secrets\//);
    const allObjects = git('rev-list', '--objects', '--all');
    expect(allObjects).not.toContain('config.js');
    expect((await history({ action: 'file', versionId: saved.id, path: 'image.png' })).binary).toBe(
      true
    );
  });

  test('restores additions, modifications and deletions only after saving a recoverable backup', async () => {
    write('src/game.js', 'old game\n');
    write('old.txt', 'old file\n');
    const old = await history({ action: 'save', label: 'Working game' });
    write('src/game.js', 'new game\n');
    fs.unlinkSync(path.join(root, 'old.txt'));
    write('new.txt', 'new file\n');
    write('.env', 'untouched secret');
    write('node_modules/library.js', 'untouched dependency');
    const plan = await history({ action: 'prepare_restore', versionId: old.id });
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        { path: 'new.txt', action: 'remove' },
        { path: 'old.txt', action: 'write' },
      ])
    );
    const result = await history({ action: 'restore', token: plan.token });
    expect(fs.readFileSync(path.join(root, 'src/game.js'), 'utf8')).toBe('old game\n');
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('untouched secret');
    expect(fs.readFileSync(path.join(root, 'node_modules/library.js'), 'utf8')).toBe(
      'untouched dependency'
    );
    expect(git('show', `${result.backupId}:src/game.js`)).toBe('new game\n');
    expect(git('show', `${result.backupId}:new.txt`)).toBe('new file\n');
    expect(git('status', '--porcelain')).toBe('');
    const restoreBackup = await history({ action: 'prepare_restore', versionId: result.backupId });
    await history({ action: 'restore', token: restoreBackup.token });
    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toBe('new file\n');
  });

  test('rejects stale or replayed plans and foreign conversations without changing files', async () => {
    write('game.js', 'before');
    const version = await history({ action: 'save', label: 'Before' });
    write('game.js', 'after');
    const plan = await history({ action: 'prepare_restore', versionId: version.id });
    write('game.js', 'newer');
    await expect(history({ action: 'restore', token: plan.token })).rejects.toThrow('changed');
    await expect(history({ action: 'restore', token: plan.token })).rejects.toThrow('expired');
    await expect(
      controller.workspaceHistory('conversation_other', { action: 'list' })
    ).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, 'game.js'), 'utf8')).toBe('newer');
  });

  test('does not overwrite excluded content and refuses restore while a process is running', async () => {
    write('config.js', 'const visible = true;');
    const saved = await history({ action: 'save', label: 'Before' });
    write('config.js', 'const password = "sensitive-production-password";');
    await expect(history({ action: 'prepare_restore', versionId: saved.id })).rejects.toThrow();
    write('config.js', 'const visible = false;');
    jest.spyOn(controller, 'listProcesses').mockReturnValue([{ state: 'running' }]);
    await expect(history({ action: 'prepare_restore', versionId: saved.id })).rejects.toThrow(
      'Stop workspace processes'
    );
  });

  test('retains backup and reports a partially interrupted restore', async () => {
    write('game.js', 'one');
    const old = await history({ action: 'save', label: 'One' });
    write('game.js', 'two');
    const plan = await history({ action: 'prepare_restore', versionId: old.id });
    const execute = executor.execute.getMockImplementation();
    executor.execute.mockImplementation(async (policy, request) =>
      request.args[6] === 'history_restore'
        ? {
            state: 'failed',
            exitCode: 73,
            stdout: '',
            stderr: 'FREEDOM_FILE_ERROR:WORKSPACE_WRITE_FAILED',
          }
        : execute(policy, request)
    );
    await expect(history({ action: 'restore', token: plan.token })).rejects.toThrow(
      'Before restore'
    );
    const listing = await history({ action: 'list' });
    expect(listing.notice).toContain('did not finish');
    expect(listing.versions[0].kind).toBe('backup');
    expect(git('show', 'HEAD:game.js')).toBe('two');
  });

  test('survives reopening and rejects foreign or redirected Git metadata', async () => {
    write('game.js', 'saved');
    const saved = await history({ action: 'save', label: 'Saved' });
    const reopened = new ManagedWorkspaceHistory(root);
    expect((await reopened.list()).versions[0].id).toBe(saved.id);
    expect((await reopened.snapshot(saved.id)).files[0].content).toBe(
      Buffer.from('saved').toString('base64')
    );
    fs.appendFileSync(path.join(root, '.git/config'), '\n[include]\npath=/private/config\n');
    await expect(
      reopened.save({ files: [], excludedCount: 0 }, { label: 'Unsafe' })
    ).rejects.toThrow('externally configured');
  });
});
