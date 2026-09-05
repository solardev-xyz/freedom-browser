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

  const review = (request) => controller.reviewWorkspaceHistory('conversation_one', request);
  const checkpoint = async (paths, label) => {
    const reviewIds = [];
    for (const filePath of paths)
      reviewIds.push((await review({ action: 'review', path: filePath })).reviewId);
    return review({ action: 'checkpoint', reviewIds, label });
  };

  test('saves only reviewed revisions and retains prior versions of unselected changes', async () => {
    write('game.js', 'one');
    write('style.css', 'first');
    write('customer-export.csv', 'private customer rows');
    const first = await checkpoint(['game.js', 'style.css'], 'First game');
    expect(first.saved).toBe(true);
    expect(git('ls-tree', '--name-only', 'HEAD')).not.toContain('customer-export');
    write('game.js', 'two');
    write('style.css', 'unreviewed edit');
    await checkpoint(['game.js'], 'New mechanics');
    expect(git('show', 'HEAD:game.js')).toBe('two');
    expect(git('show', 'HEAD:style.css')).toBe('first');
    await history({ action: 'save', label: 'Named latest checkpoint' });
    expect(git('show', 'HEAD:style.css')).toBe('first');
    expect(git('fsck', '--no-reflogs')).not.toContain('error');
  });

  test('rejects changed, replayed, foreign and cancelled reviews', async () => {
    write('game.js', 'one');
    const token = (await review({ action: 'review', path: 'game.js' })).reviewId;
    write('game.js', 'two');
    await expect(
      review({ action: 'checkpoint', reviewIds: [token], label: 'Stale' })
    ).rejects.toThrow('changed');
    const fresh = (await review({ action: 'review', path: 'game.js' })).reviewId;
    controller.historyReviews.get(fresh).conversationId = 'other';
    await expect(
      review({ action: 'checkpoint', reviewIds: [fresh], label: 'Foreign' })
    ).rejects.toThrow('conversation');
    const selected = (await review({ action: 'review', path: 'game.js' })).reviewId;
    await review({ action: 'checkpoint', reviewIds: [selected], label: 'Reviewed' });
    await expect(
      review({ action: 'checkpoint', reviewIds: [selected], label: 'Replay' })
    ).rejects.toThrow('expired');
    const abort = new AbortController();
    abort.abort();
    await expect(
      controller.reviewWorkspaceHistory(
        'conversation_one',
        { action: 'review', path: 'game.js' },
        { signal: abort.signal }
      )
    ).rejects.toThrow();
  });

  test('persists contextual exclusions and does not allow an include to approve bytes', async () => {
    write('customer-export.csv', 'private customer rows');
    const token = (await review({ action: 'review', path: 'customer-export.csv' })).reviewId;
    await review({
      action: 'exclude',
      path: 'customer-export.csv',
      reason: 'Private customer data',
    });
    await expect(review({ action: 'checkpoint', reviewIds: [token], label: 'No' })).rejects.toThrow(
      'excluded'
    );
    expect((await history({ action: 'list' })).exclusions).toEqual([
      { path: 'customer-export.csv', reason: 'Private customer data' },
    ]);
    await expect(review({ action: 'review', path: 'customer-export.csv' })).rejects.toThrow(
      'excluded'
    );
    await history({
      action: 'include',
      path: 'customer-export.csv',
      reason: 'User removed private data',
    });
    expect(await new ManagedWorkspaceHistory(root).currentId()).toBe(null);
  });

  test('mandatory exclusions and secret detection cannot be overridden by the agent', async () => {
    write('.gitignore', '!node_modules/\n!node_modules/**\n!.env\n');
    write('node_modules/lib.js', 'generated');
    write('.env', 'private');
    write('config.js', 'const apiKey = "this-is-a-real-looking-credential";');
    write('settings.yml', 'password: sensitive-value\n');
    write('huge.txt', 'a'.repeat(65537));
    for (const name of ['node_modules/lib.js', '.env', 'config.js', 'settings.yml', 'huge.txt']) {
      await expect(review({ action: 'review', path: name })).rejects.toThrow();
    }
    await expect(review({ action: 'include', path: '.env', reason: 'Bypass' })).rejects.toThrow();
    expect(await new ManagedWorkspaceHistory(root).currentId()).toBe(null);
  });

  test('restore never saves or overwrites unreviewed changes and leaves unrelated files alone', async () => {
    write('game.js', 'one');
    const first = await checkpoint(['game.js'], 'One');
    write('game.js', 'private notes appended');
    write('customer-export.csv', 'private customer rows');
    await expect(history({ action: 'prepare_restore', versionId: first.id })).rejects.toThrow(
      'Unreviewed'
    );
    expect((await history({ action: 'list' })).versions).toHaveLength(1);
    write('game.js', 'two');
    await checkpoint(['game.js'], 'Two');
    const plan = await history({ action: 'prepare_restore', versionId: first.id });
    const result = await history({ action: 'restore', token: plan.token });
    expect(fs.readFileSync(path.join(root, 'game.js'), 'utf8')).toBe('one');
    expect(fs.readFileSync(path.join(root, 'customer-export.csv'), 'utf8')).toBe(
      'private customer rows'
    );
    expect(git('show', `${result.backupId}:game.js`)).toBe('two');
    expect(git('rev-list', '--objects', '--all')).not.toContain('customer-export');
    await expect(history({ action: 'restore', token: plan.token })).rejects.toThrow('expired');
  });

  test('restores reviewed additions and deletions, rejects stale plans and unreviewed collisions', async () => {
    write('old.txt', 'old');
    const first = await checkpoint(['old.txt'], 'Old');
    fs.unlinkSync(path.join(root, 'old.txt'));
    write('new.txt', 'new');
    await checkpoint(['old.txt', 'new.txt'], 'New');
    write('old.txt', 'private collision');
    await expect(history({ action: 'prepare_restore', versionId: first.id })).rejects.toThrow(
      'Unreviewed'
    );
    fs.unlinkSync(path.join(root, 'old.txt'));
    const plan = await history({ action: 'prepare_restore', versionId: first.id });
    write('new.txt', 'changed');
    await expect(history({ action: 'restore', token: plan.token })).rejects.toThrow('changed');
    write('new.txt', 'new');
    const next = await history({ action: 'prepare_restore', versionId: first.id });
    await history({ action: 'restore', token: next.token });
    expect(fs.readFileSync(path.join(root, 'old.txt'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false);
  });

  test('retains a reviewed backup after partial failure and requires stopped processes', async () => {
    write('game.js', 'one');
    const first = await checkpoint(['game.js'], 'One');
    write('game.js', 'two');
    await checkpoint(['game.js'], 'Two');
    const running = jest.spyOn(controller, 'listProcesses').mockReturnValue([{ state: 'running' }]);
    await expect(history({ action: 'prepare_restore', versionId: first.id })).rejects.toThrow(
      'Stop'
    );
    running.mockRestore();
    const plan = await history({ action: 'prepare_restore', versionId: first.id });
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
    expect(git('show', 'HEAD:game.js')).toBe('two');
    expect((await history({ action: 'list' })).versions[0].kind).toBe('backup');
  });

  test('missing installed Git disables history while ordinary file editing still works', async () => {
    const access = jest.spyOn(fs, 'accessSync').mockImplementation(() => { throw new Error('Git unavailable'); });
    try {
      await expect(history({ action: 'list' })).rejects.toThrow('Project editing remains available');
      await controller.writeFile('conversation_one', 'game.js', 'still editable');
      expect(fs.readFileSync(path.join(root, 'game.js'), 'utf8')).toBe('still editable');
    } finally { access.mockRestore(); }
  });

  test('does not silently inherit or restore unreviewed automatic snapshots from older builds', async () => {
    write('game.js', 'game'); write('private-notes.txt', 'contextually private');
    const older = await checkpoint(['game.js', 'private-notes.txt'], 'Old build fixture');
    const filename = path.join(root, '.git/freedom-history', `${older.id}.json`);
    const record = JSON.parse(fs.readFileSync(filename)); delete record.reviewed; record.kind = 'automatic';
    fs.writeFileSync(filename, JSON.stringify(record));
    await expect(history({ action: 'prepare_restore', versionId: older.id })).rejects.toThrow('not reviewed');
    const reviewed = await checkpoint(['game.js'], 'Reviewed game');
    expect(git('ls-tree', '--name-only', 'HEAD')).not.toContain('private-notes');
    expect(fs.readFileSync(path.join(root, 'private-notes.txt'), 'utf8')).toBe('contextually private');
    const secondFile = path.join(root, '.git/freedom-history', `${reviewed.id}.json`);
    const second = JSON.parse(fs.readFileSync(secondFile)); delete second.reviewed;
    fs.writeFileSync(secondFile, JSON.stringify(second));
    await expect(history({ action: 'save', label: 'Name old automatic snapshot' })).rejects.toThrow('review');
    expect((await checkpoint(['game.js'], 'Review unchanged legacy contents')).saved).toBe(true);
  });

  test('reopens saved versions but preserves external Git configuration', async () => {
    write('game.js', 'one');
    const first = await checkpoint(['game.js'], 'One');
    expect((await new ManagedWorkspaceHistory(root).list()).versions[0].id).toBe(first.id);
    fs.appendFileSync(path.join(root, '.git/config'), '[include]\npath=/etc/other\n');
    await expect(history({ action: 'list' })).rejects.toThrow('externally configured');
  });
});
