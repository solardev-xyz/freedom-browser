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

  test('identifies managed history for proactive milestones without saving unreviewed files', async () => {
    write('game.js', 'first version');
    expect(await review({ action: 'status' })).toMatchObject({ workspaceKind: 'managed' });
    expect((await history({ action: 'list' })).versions).toHaveLength(0);
    const saved = await checkpoint(['game.js'], 'Working first version');
    expect(saved.saved).toBe(true);
    expect(git('show', 'HEAD:game.js')).toBe('first version');
    expect((await checkpoint(['game.js'], 'Unchanged milestone')).saved).toBe(false);
  });

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

  test('compares commit changes and restores only selected files without losing other history', async () => {
    write('one.txt', 'old one'); write('two.txt', 'old two');
    const first = await checkpoint(['one.txt', 'two.txt'], 'First');
    write('one.txt', 'new one'); write('two.txt', 'new two');
    const second = await checkpoint(['one.txt', 'two.txt'], 'Second');
    const comparison = await history({ action: 'comparison', versionId: second.id });
    expect(comparison.baseId).toBe(first.id);
    expect(comparison.files.map(file => file.path)).toEqual(['one.txt', 'two.txt']);
    expect(await history({ action: 'comparison_file', versionId: second.id, path: 'one.txt' })).toMatchObject({ before: { text: 'old one' }, after: { text: 'new one' } });
    write('two.txt', 'unreviewed unrelated edit');
    const plan = await history({ action: 'prepare_restore', versionId: first.id, paths: ['one.txt'] });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ before: { text: 'new one' }, after: { text: 'old one' } });
    await history({ action: 'restore', token: plan.token });
    expect(fs.readFileSync(path.join(root, 'one.txt'), 'utf8')).toBe('old one');
    expect(fs.readFileSync(path.join(root, 'two.txt'), 'utf8')).toBe('unreviewed unrelated edit');
    expect(git('show', 'HEAD:two.txt')).toBe('new two');
    expect(await history({ action: 'recovery' })).toEqual({ pending: false });
  });

  test('durably recovers a partial restore, but refuses intervening user edits', async () => {
    write('a.txt', 'old a'); write('b.txt', 'old b');
    const first = await checkpoint(['a.txt', 'b.txt'], 'First');
    write('a.txt', 'new a'); write('b.txt', 'new b');
    await checkpoint(['a.txt', 'b.txt'], 'Second');
    const plan = await history({ action: 'prepare_restore', versionId: first.id });
    const execute = executor.execute.getMockImplementation(); let mutations = 0;
    executor.execute.mockImplementation(async (policy, request) => request.args[6] === 'history_restore' && ++mutations === 2
      ? { state: 'failed', exitCode: 73, stdout: '', stderr: 'FREEDOM_FILE_ERROR:WORKSPACE_WRITE_FAILED' }
      : execute(policy, request));
    await expect(history({ action: 'restore', token: plan.token })).rejects.toThrow('Before restore');
    executor.execute.mockImplementation(execute);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('old a');
    controller.historyNotices.clear(); controller.restorePlans.clear();
    expect(await new ManagedWorkspaceHistory(root).recovery()).toMatchObject({ pending: true });
    write('a.txt', 'user edit');
    await expect(history({ action: 'prepare_recovery' })).rejects.toThrow('outside the interrupted restore');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('user edit');
    write('a.txt', 'old a');
    const recovery = await history({ action: 'prepare_recovery' });
    await history({ action: 'restore', token: recovery.token });
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('new a');
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('new b');
    expect(await history({ action: 'recovery' })).toEqual({ pending: false });
  });

  test('working comparisons distinguish staged and unstaged content and filename search', async () => {
    write('readme.txt', 'base\n'); await checkpoint(['readme.txt'], 'Base');
    write('readme.txt', 'staged\n'); git('add', 'readme.txt'); write('readme.txt', 'working\n');
    const staged = await controller.inspectWorkspace('conversation_one', { kind: 'diff', path: 'readme.txt', scope: 'staged' });
    const unstaged = await controller.inspectWorkspace('conversation_one', { kind: 'diff', path: 'readme.txt', scope: 'unstaged' });
    expect(staged.text).toContain('+staged'); expect(staged.text).not.toContain('+working');
    expect(unstaged.text).toContain('-staged'); expect(unstaged.text).toContain('+working');
    const status = await controller.inspectWorkspace('conversation_one', { kind: 'changes', path: '.' });
    expect(status.changes[0]).toMatchObject({ staged: true, unstaged: true });
    write('src/components/Planet.js', 'export default 8;'); write('.env', 'PRIVATE=not-for-preview');
    const search = await controller.inspectWorkspace('conversation_one', { kind: 'search', path: '.', query: 'planet' });
    expect(search.entries).toEqual([{ name: 'Planet.js', path: 'src/components/Planet.js', type: 'file' }]);
    const entries = await controller.inspectWorkspace('conversation_one', { kind: 'tree', path: '.' });
    expect(entries.entries.some(file => file.name === '.env')).toBe(false);
  });

  test('working text pages reject changed content rather than mixing revisions', async () => {
    write('large.txt', 'ä'.repeat(70000));
    const page = await controller.inspectWorkspace('conversation_one', { kind: 'file', path: 'large.txt' });
    const next = await controller.inspectWorkspace('conversation_one', { kind: 'file', path: 'large.txt', offset: page.nextOffset, revision: page.revision });
    expect(page.text + next.text).toBe('ä'.repeat(70000));
    write('large.txt', 'changed');
    await expect(controller.inspectWorkspace('conversation_one', { kind: 'file', path: 'large.txt', offset: page.nextOffset, revision: page.revision })).rejects.toThrow('Refresh the viewer');
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
