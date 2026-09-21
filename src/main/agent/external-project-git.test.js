'use strict';

// Real Git fixtures: run on the designated disposable testing machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ExternalProjectGit } = require('./external-project-git');
const { workspaceGitCommand } = require('./workspace-git-command');

jest.setTimeout(30000);
const qualified = process.env.FREEDOM_PROJECT_GIT_TESTS === '1' ? describe : describe.skip;
qualified('external project Git integration', () => {
  let temporary, root, storage, authorize;
  const git = (...args) => execFileSync(workspaceGitCommand(), args, { cwd: root, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim();
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  const service = () => new ExternalProjectGit(root, { temporaryRoot: storage, authorize, globalConfigFiles: [] });
  const review = (name, content) => ({ path: name, file: content === null ? null : { path: name, mode: '100644', content: Buffer.from(content).toString('base64') } });
  const commit = async (reviews, message = 'Update selected files', recheck = async () => {}) => {
    const instance = service(); return instance.commit(reviews, await instance.baseline(), message, recheck);
  };
  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-project-git-'));
    root = path.join(temporary, 'Project ü'); storage = path.join(temporary, 'private');
    fs.mkdirSync(root); fs.mkdirSync(storage); authorize = jest.fn(async () => {});
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture Author'); git('config', 'user.email', 'fixture@example.test');
    write('README.md', 'original\n'); write('other.txt', 'original other\n');
    git('add', '.'); git('commit', '-qm', 'Initial');
  });
  afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

  test('commits in the actual branch, preserves unrelated staging and shows native history', async () => {
    const parent = git('rev-parse', 'HEAD'); const config = fs.readFileSync(path.join(root, '.git/config'));
    write('other.txt', 'staged other\n'); git('add', 'other.txt'); write('other.txt', 'unstaged other\n');
    write('new unrelated.txt', 'staged addition'); git('add', 'new unrelated.txt');
    const staged = git('ls-files', '--stage', '--', 'other.txt', 'new unrelated.txt');
    write('README.md', 'cookbook\n');
    const result = await commit([review('README.md', 'cookbook\n')]);
    expect(result).toMatchObject({ saved: true, source: 'repository', branch: 'main', id: git('rev-parse', 'HEAD') });
    expect(git('rev-parse', 'HEAD^')).toBe(parent);
    expect(git('show', 'HEAD:README.md')).toBe('cookbook');
    expect(git('show', 'HEAD:other.txt')).toBe('original other');
    expect(git('ls-files', '--stage', '--', 'other.txt', 'new unrelated.txt')).toBe(staged);
    expect(git('log', '-1', '--format=%an <%ae>')).toBe('Fixture Author <fixture@example.test>');
    expect(git('diff', '--', 'README.md')).toBe('');
    expect(fs.readFileSync(path.join(root, '.git/config'))).toEqual(config);
    expect(fs.readdirSync(storage)).toEqual([]);
    const list = await service().list();
    expect(list).toMatchObject({ restorable: false, source: 'repository' });
    expect(list.versions.map(v => v.label)).toEqual(['Update selected files', 'Initial']);
    expect(await service().inspect({ action: 'file', versionId: result.id, path: 'README.md' })).toMatchObject({ text: 'cookbook\n' });
  });

  test('supports selected additions, deletions, identical staging and a no-op', async () => {
    write('new.txt', 'new'); git('add', 'new.txt'); fs.unlinkSync(path.join(root, 'README.md'));
    const reviews = [review('new.txt', 'new'), review('README.md', null)];
    const first = await commit(reviews);
    expect(git('status', '--porcelain')).toBe('');
    expect(await commit(reviews)).toMatchObject({ saved: false, id: first.id });
  });

  test('supports a first commit on an unborn branch', async () => {
    git('checkout', '--orphan', 'fresh'); git('rm', '--cached', '-r', '.');
    expect(await commit([review('README.md', 'original\n')])).toMatchObject({ saved: true, branch: 'fresh' });
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
  });

  test.each([':(glob)literal.txt', '-leading.txt', 'space name.txt', 'unicode-ü.txt'])('commits literal filename %s', async (name) => {
    write(name, 'literal');
    await commit([review(name, 'literal')]);
    expect(git('show', `HEAD:${name}`)).toBe('literal');
  });

  test('rejects a same-OID branch switch immediately before ref dispatch', async () => {
    const instance = service(); const expected = await instance.baseline(); const real = instance.git.bind(instance);
    instance.git = async (args, options) => {
      if (args[0] === 'update-ref') { git('branch', 'other'); git('symbolic-ref', 'HEAD', 'refs/heads/other'); }
      return real(args, options);
    };
    await expect(instance.commit([review('README.md', 'changed')], expected, 'Change', async () => {})).rejects.toThrow('changed before commit dispatch');
    expect(git('rev-parse', 'main')).toBe(expected.id);
    expect(fs.existsSync(path.join(root, '.git/index.lock'))).toBe(false);
    expect(fs.readdirSync(storage)).toEqual([]);
  });

  test('refuses divergent selected staging without losing it', async () => {
    write('README.md', 'staged'); git('add', 'README.md'); write('README.md', 'working');
    const before = git('rev-parse', 'HEAD'); const index = fs.readFileSync(path.join(root, '.git/index'));
    await expect(commit([review('README.md', 'working')])).rejects.toThrow('different staged changes');
    expect(git('rev-parse', 'HEAD')).toBe(before); expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(index);
  });

  test.each(['index', 'branch', 'head'])('refuses changed %s since review', async (kind) => {
    const instance = service(); const expected = await instance.baseline();
    if (kind === 'index') { write('other.txt', 'staged'); git('add', 'other.txt'); }
    if (kind === 'branch') git('checkout', '-b', 'other');
    if (kind === 'head') git('commit', '--allow-empty', '-qm', 'Outside commit');
    await expect(instance.commit([review('README.md', 'changed')], expected, 'Change', async () => {})).rejects.toThrow('changed since review');
  });

  test.each(['pre-commit', 'reference-transaction', 'post-index-change', 'commit-msg'])('refuses active %s without running it', async (name) => {
    write(`.git/hooks/${name}`, '#!/bin/sh\ntouch "' + path.join(temporary, 'executed') + '"\n'); fs.chmodSync(path.join(root, '.git/hooks', name), 0o700);
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow('active Git hooks');
    expect(fs.existsSync(path.join(temporary, 'executed'))).toBe(false);
  });

  test.each([['commit.gpgsign', 'true'], ['core.hooksPath', '/tmp/hooks'], ['core.autocrlf', 'true'], ['core.attributesFile', '/tmp/attrs']])('refuses required %s', async (key, value) => {
    git('config', key, value);
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow(/hooks, signing|conversion/);
  });

  test.each(['text', 'filter=lfs', 'working-tree-encoding=UTF-16', 'ident'])('refuses content conversion %s', async (attribute) => {
    write('.gitattributes', `README.md ${attribute}\n`);
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow('content conversion');
  });

  test('refuses ignored additions, metadata links, unsupported includes and special index flags', async () => {
    write('.gitignore', 'private.txt\n'); write('private.txt', 'private');
    await expect(commit([review('private.txt', 'private')])).rejects.toThrow('ignored');
    fs.symlinkSync(path.join(temporary, 'canary'), path.join(root, '.git', 'bad-link'));
    await expect(service().list()).rejects.toThrow('Linked or special'); fs.unlinkSync(path.join(root, '.git', 'bad-link'));
    git('update-index', '--assume-unchanged', 'other.txt');
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow('Special index flags');
    git('config', 'include.path', '/tmp/nonexistent-config');
    await expect(service().list()).rejects.toThrow('includes');
  });

  test('denies writes after revocation and detects changed working files at final check', async () => {
    authorize.mockImplementation(async write => { if (write) throw new Error('Read only'); });
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow('Read only');
    authorize.mockImplementation(async () => {});
    await expect(commit([review('README.md', 'changed')], 'Change', async () => { throw new Error('Files changed'); })).rejects.toThrow('Files changed');
    expect(git('log', '-1', '--format=%s')).toBe('Initial'); expect(fs.existsSync(path.join(root, '.git/index.lock'))).toBe(false);
  });

  test.each(['[commit]\n gpgSign\n', '[core]\n autocrlf\n'])('recognizes implicit boolean requirements in a global config: %s', async (contents) => {
    const config = path.join(storage, 'global-config'); fs.writeFileSync(config, contents);
    const instance = new ExternalProjectGit(root, { temporaryRoot: storage, authorize, globalConfigFiles: [config] });
    await expect(instance.commit([review('README.md', 'changed')], await instance.baseline(), 'Change', async () => {})).rejects.toThrow('signing');
  });

  test('history reads cannot invoke signature verification programs', async () => {
    const marker = path.join(temporary, 'signature-program-ran');
    write('signer.sh', `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); fs.chmodSync(path.join(root, 'signer.sh'), 0o700);
    git('config', 'gpg.program', path.join(root, 'signer.sh')); git('config', 'log.showSignature', 'true');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const object = `tree ${tree}\nauthor Fixture <fixture@example.test> 1000000000 +0000\ncommitter Fixture <fixture@example.test> 1000000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n invalid\n -----END PGP SIGNATURE-----\n\nSynthetic signed history\n`;
    const id = execFileSync(workspaceGitCommand(), ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: root, input: object, encoding: 'utf8' }).trim();
    git('update-ref', 'refs/heads/main', id);
    expect((await service().list()).versions[0].label).toBe('Synthetic signed history');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('does not bypass configured global ignore rules', async () => {
    git('config', 'core.excludesFile', '/unread/global-ignore');
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow('Global Git ignore rules');
  });

  test('preserves a replaced index lock on failure', async () => {
    await expect(commit([review('README.md', 'changed')], 'Change', async () => {
      fs.renameSync(path.join(root, '.git/index.lock'), path.join(root, '.git/old-lock'));
      write('.git/index.lock', 'other writer'); throw new Error('Files changed');
    })).rejects.toThrow('Files changed');
    expect(fs.readFileSync(path.join(root, '.git/index.lock'), 'utf8')).toBe('other writer');
  });

  test('revalidates metadata identity before every Git child including object writes', async () => {
    const instance = service(); const baseline = await instance.baseline();
    const real = instance.git.bind(instance); let swapped = false;
    instance.git = async (args, options) => {
      if (!swapped && args[0] === 'hash-object') {
        swapped = true;
        fs.renameSync(path.join(root, '.git'), path.join(temporary, 'original-git'));
        fs.symlinkSync(path.join(temporary, 'original-git'), path.join(root, '.git'));
      }
      return real(args, options);
    };
    await expect(instance.commit([review('README.md', 'changed')], baseline, 'Change', async () => {})).rejects.toThrow(/Linked worktrees|metadata changed/);
    expect(swapped).toBe(true);
  });

  test('never removes an existing lock or initializes a plain folder', async () => {
    write('.git/index.lock', 'owned by other writer');
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow('Git is busy');
    expect(fs.readFileSync(path.join(root, '.git/index.lock'), 'utf8')).toBe('owned by other writer');
    const plain = path.join(temporary, 'plain'); fs.mkdirSync(plain);
    const instance = new ExternalProjectGit(plain, { temporaryRoot: storage, authorize, globalConfigFiles: [] });
    expect(await instance.list()).toMatchObject({ noRepository: true, versions: [] });
    expect(fs.readdirSync(plain)).toEqual([]);
  });

  test('retains recovery evidence when the ref update acknowledgement is lost', async () => {
    const instance = service(); const original = instance.git.bind(instance); let candidate;
    instance.git = async (args, options) => {
      const result = await original(args, options);
      if (args[0] === 'update-ref') { candidate = args[4]; throw new Error('Lost acknowledgement'); }
      return result;
    };
    await expect(instance.commit([review('README.md', 'changed')], await instance.baseline(), 'Change', async () => {})).rejects.toThrow('uncertain');
    const record = JSON.parse(fs.readFileSync(path.join(storage, 'git-commit-pending.json')));
    expect(record.candidate).toBe(git('rev-parse', 'HEAD')); expect(candidate).toBeDefined();
    expect(fs.existsSync(path.join(root, '.git/index.lock'))).toBe(true);
    await expect(commit([review('README.md', 'changed')])).rejects.toThrow('previous commit needs inspection');
  });
});
