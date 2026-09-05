'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { WORKSPACE_FILE_HELPER } = require('./managed-workspace-controller');
const { initializeWorkspaceGit } = require('./managed-workspace-git');

describe('sandboxed workspace inspection', () => {
  let fixture;
  let workspace;
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, {
      cwd: workspace,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  const inspect = (kind, relative = '.', options = {}) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          WORKSPACE_FILE_HELPER,
          'workspace_inspect',
          relative,
          Buffer.from(JSON.stringify({ kind, ...options })).toString('base64'),
        ],
        { cwd: workspace, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    );

  beforeEach(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-inspection-'));
    workspace = path.join(fixture, 'workspace');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace, '.git'));
    await initializeWorkspaceGit(workspace);
  });
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

  test('initializes a valid repository without inheriting templates or changing existing metadata', async () => {
    expect(git('rev-parse', '--is-inside-work-tree').trim()).toBe('true');
    expect(git('symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    fs.writeFileSync(path.join(workspace, 'game.js'), 'game');
    const config = fs.readFileSync(path.join(workspace, '.git/config'));
    await initializeWorkspaceGit(workspace);
    expect(fs.readFileSync(path.join(workspace, '.git/config'))).toEqual(config);
    expect(fs.readFileSync(path.join(workspace, 'game.js'), 'utf8')).toBe('game');
  });

  test('lists folders first, hides Git metadata and toggles generated files', () => {
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.mkdirSync(path.join(workspace, 'node_modules'));
    fs.writeFileSync(path.join(workspace, 'index.html'), '<script>untrusted</script>');
    expect(inspect('tree')).toEqual({
      entries: [
        { name: 'src', type: 'directory' },
        { name: 'index.html', type: 'file' },
      ],
      hiddenCount: 1,
      limitReached: false,
    });
    expect(
      inspect('tree', '.', { showGenerated: true }).entries.map((entry) => entry.name)
    ).toEqual(['node_modules', 'src', 'index.html']);
    expect(inspect('file', 'index.html').text).toBe('<script>untrusted</script>');
  });

  test('shows untracked additions while excluding dependencies, build output and secrets', () => {
    for (const name of ['node_modules', 'dist']) {
      fs.mkdirSync(path.join(workspace, name));
      fs.writeFileSync(path.join(workspace, name, 'output.js'), 'generated');
    }
    for (const name of ['.env', '.env.local', 'secret.pem', 'secret.key'])
      fs.writeFileSync(path.join(workspace, name), 'private');
    fs.writeFileSync(path.join(workspace, 'game.js'), 'hello\nworld\n');
    expect(inspect('changes')).toEqual({
      available: true,
      branch: 'main',
      changes: [{ path: 'game.js', status: 'added' }],
      limitReached: false,
    });
    expect(inspect('diff', 'game.js').text).toContain('+hello\n+world');
    expect(inspect('diff', '.env').text).toBe('');
  });

  test('shows tracked modifications, deletions and staged additions against HEAD without updating the index', () => {
    fs.writeFileSync(path.join(workspace, 'game.js'), 'before\n');
    fs.writeFileSync(path.join(workspace, 'old.txt'), 'old\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Freedom Test',
      '-c',
      'user.email=test@invalid',
      'commit',
      '-qm',
      'baseline'
    );
    fs.writeFileSync(path.join(workspace, 'game.js'), 'after\n');
    fs.unlinkSync(path.join(workspace, 'old.txt'));
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'new\n');
    git('add', 'new.txt');
    const index = fs.readFileSync(path.join(workspace, '.git/index'));
    expect(inspect('changes').changes).toEqual([
      { path: 'game.js', status: 'modified' },
      { path: 'new.txt', status: 'added' },
      { path: 'old.txt', status: 'deleted' },
    ]);
    expect(inspect('diff', 'game.js').text).toContain('-before\n+after');
    expect(inspect('diff', 'old.txt').text).toContain('-old');
    expect(inspect('diff', 'new.txt').text).toContain('+new');
    expect(fs.readFileSync(path.join(workspace, '.git/index'))).toEqual(index);
  });

  test('bounds binary and large file previews and refuses their diffs', () => {
    fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(workspace, 'large.txt'), 'a'.repeat(100000));
    expect(inspect('file', 'binary.bin')).toMatchObject({ binary: true, text: '' });
    expect(inspect('file', 'large.txt')).toMatchObject({ truncated: true });
    expect(inspect('file', 'large.txt').text).toHaveLength(65536);
    expect(inspect('diff', 'large.txt').text).toBe('');
  });

  test('rejects traversal, protected metadata, symlinks and hardlinks without exposing outside data', () => {
    fs.writeFileSync(path.join(fixture, 'outside'), 'outside-secret');
    fs.symlinkSync(fixture, path.join(workspace, 'link'));
    fs.linkSync(path.join(fixture, 'outside'), path.join(workspace, 'hardlink'));
    for (const candidate of [
      '../outside',
      '/etc/passwd',
      '.git/config',
      'link/outside',
      'hardlink',
    ]) {
      expect(() => inspect('file', candidate)).toThrow();
    }
    expect(inspect('tree').entries.every((entry) => entry.type === 'other')).toBe(true);
    expect(() => inspect('diff', 'link')).toThrow();
  });

  test('treats metacharacters as literal filenames', () => {
    const name = ':(glob)* $x " odd\nname.txt';
    fs.writeFileSync(path.join(workspace, name), 'literal\n');
    expect(inspect('changes').changes).toEqual([{ path: name, status: 'added' }]);
    expect(inspect('diff', name).text).toContain('+literal');
    expect(inspect('file', name).text).toBe('literal\n');
  });

  test('does not execute workspace-configured filters and keeps files usable if Git is unavailable', () => {
    fs.appendFileSync(
      path.join(workspace, '.git/config'),
      '\n[filter "evil"]\n clean = touch marker\n'
    );
    fs.writeFileSync(path.join(workspace, 'game.js'), 'hello');
    expect(inspect('changes').available).toBe(false);
    expect(inspect('file', 'game.js').text).toBe('hello');
    expect(fs.existsSync(path.join(workspace, 'marker'))).toBe(false);
  });
});
