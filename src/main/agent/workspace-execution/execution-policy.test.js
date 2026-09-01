'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  ExecutionPolicyError,
  createWorkspaceExecutionPolicy,
  inferNodeRuntimeRoot,
  insidePath,
  validateEnvironmentName,
  validateExecutionRequest,
  validateGitConfiguration,
} = require('./execution-policy');

async function createFixture({ git = true } = {}) {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-policy-test-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
  if (git) {
    const result = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'git init failed');
  }
  await fs.promises.writeFile(path.join(workspaceRoot, 'source.js'), 'module.exports = 1;\n');
  return { fixtureRoot, workspaceRoot };
}

describe('workspace execution policy', () => {
  const fixtureRoots = [];

  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
    );
  });

  test('resolves one writable workspace with read-only Git metadata and private temporary storage', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      hostEnvironment: {
        LANG: 'C.UTF-8',
        AWS_SECRET_ACCESS_KEY: 'must-not-cross',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
      },
    });
    const canonicalWorkspace = await fs.promises.realpath(fixture.workspaceRoot);

    expect(policy).toMatchObject({
      kind: 'freedom.workspace-execution-policy',
      version: 1,
      workingDirectory: '/workspace',
      network: 'none',
      limits: {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        stdoutBytes: DEFAULT_OUTPUT_BYTES,
        stderrBytes: DEFAULT_OUTPUT_BYTES,
      },
      filesystem: {
        writableRoots: [{ sourcePath: canonicalWorkspace, mountPath: '/workspace' }],
        privateTemporaryStorage: { mountPath: '/tmp', lifecycle: 'execution' },
        protectedPaths: [
          expect.objectContaining({
            relativePath: '.git',
            access: 'read_only',
            kind: 'directory',
          }),
        ],
      },
      environment: {
        values: { LANG: 'C.UTF-8' },
        sensitiveValuesScrubbed: true,
      },
      cancellation: {
        supported: true,
        scope: 'descendant_tree',
        guarantee: 'backend_reported',
      },
    });
    expect(policy.environment.values).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(policy.environment.values).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  test('adds only one validated Electron application bundle as a read-only runtime root', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const electronRoot = path.join(fixture.fixtureRoot, 'Freedom.app');
    await fs.promises.mkdir(path.join(electronRoot, 'Contents', 'MacOS'), { recursive: true });
    const canonicalElectronRoot = await fs.promises.realpath(electronRoot);

    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      nodeRuntimeRoot: null,
      electronRuntimeRoot: electronRoot,
    });
    expect(policy.filesystem.runtimeRoots).toEqual([
      {
        id: 'electron',
        sourcePath: canonicalElectronRoot,
        mountPath: '/opt/freedom-toolchain/electron',
        access: 'read_only',
      },
    ]);

    await expect(
      createWorkspaceExecutionPolicy({
        workspaceRoot: fixture.workspaceRoot,
        nodeRuntimeRoot: null,
        electronRuntimeRoot: fixture.fixtureRoot,
      })
    ).rejects.toMatchObject({ code: 'INVALID_ELECTRON_RUNTIME' });
  });

  test('maps one trusted Linux Electron executable beneath its read-only runtime root', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const runtimeRoot = path.join(fixture.fixtureRoot, 'linux-unpacked');
    const executable = path.join(runtimeRoot, 'freedom');
    await fs.promises.mkdir(runtimeRoot);
    await fs.promises.writeFile(executable, 'fixture', { mode: 0o700 });

    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      nodeRuntimeRoot: null,
      electronRuntime: { platform: 'linux', rootPath: runtimeRoot, executablePath: executable },
    });
    expect(policy.filesystem.runtimeRoots).toEqual([
      {
        id: 'electron',
        sourcePath: await fs.promises.realpath(runtimeRoot),
        mountPath: '/opt/freedom-toolchain/electron',
        access: 'read_only',
        executablePath: await fs.promises.realpath(executable),
        relativeExecutablePath: 'freedom',
        sandboxExecutablePath: '/opt/freedom-toolchain/electron/freedom',
      },
    ]);

    await expect(
      createWorkspaceExecutionPolicy({
        workspaceRoot: fixture.workspaceRoot,
        nodeRuntimeRoot: null,
        electronRuntime: {
          platform: 'linux',
          rootPath: runtimeRoot,
          executablePath: path.join(fixture.fixtureRoot, 'source.js'),
        },
      })
    ).rejects.toMatchObject({ code: 'INVALID_ELECTRON_RUNTIME' });
  });

  test('resolves an external Git directory without treating its host path as the mount identity', async () => {
    const fixture = await createFixture({ git: false });
    fixtureRoots.push(fixture.fixtureRoot);
    const gitDirectory = path.join(fixture.fixtureRoot, 'metadata');
    const result = spawnSync(
      'git',
      ['init', '--quiet', `--separate-git-dir=${gitDirectory}`, fixture.workspaceRoot],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);

    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
    ).rejects.toMatchObject({ code: 'EXTERNAL_GIT_METADATA_DENIED' });

    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      authorizedGitMetadataPaths: [gitDirectory],
    });
    expect(policy.filesystem.protectedPaths[0]).toMatchObject({
      kind: 'git_pointer',
      gitDirectory: await fs.promises.realpath(gitDirectory),
      commonDirectory: await fs.promises.realpath(gitDirectory),
      mountPath: '/workspace/.git',
    });

    const unauthorizedCommonDirectory = path.join(fixture.fixtureRoot, 'host-secret');
    await fs.promises.mkdir(unauthorizedCommonDirectory);
    await fs.promises.writeFile(
      path.join(gitDirectory, 'commondir'),
      `${path.relative(gitDirectory, unauthorizedCommonDirectory)}\n`
    );
    await expect(
      createWorkspaceExecutionPolicy({
        workspaceRoot: fixture.workspaceRoot,
        authorizedGitMetadataPaths: [gitDirectory],
      })
    ).rejects.toMatchObject({ code: 'EXTERNAL_GIT_METADATA_DENIED' });
  });

  test('rejects unsafe worktree-specific configuration in a linked Git worktree', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const runGit = (args) => {
      const result = spawnSync('git', args, { encoding: 'utf8' });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    runGit(['-C', fixture.workspaceRoot, 'config', 'user.name', 'Freedom Test']);
    runGit(['-C', fixture.workspaceRoot, 'config', 'user.email', 'freedom@example.invalid']);
    runGit(['-C', fixture.workspaceRoot, 'add', 'source.js']);
    runGit(['-C', fixture.workspaceRoot, 'commit', '--quiet', '-m', 'fixture']);
    runGit(['-C', fixture.workspaceRoot, 'config', 'extensions.worktreeConfig', 'true']);

    const linkedWorkspace = path.join(fixture.fixtureRoot, 'linked-worktree');
    runGit([
      '-C',
      fixture.workspaceRoot,
      'worktree',
      'add',
      '--quiet',
      '--detach',
      linkedWorkspace,
    ]);
    const pointer = await fs.promises.readFile(path.join(linkedWorkspace, '.git'), 'utf8');
    const gitDirectory = await fs.promises.realpath(
      path.resolve(linkedWorkspace, /^gitdir:\s*(.+)\s*$/i.exec(pointer)[1])
    );
    const commonPointer = (
      await fs.promises.readFile(path.join(gitDirectory, 'commondir'), 'utf8')
    ).trim();
    const commonDirectory = await fs.promises.realpath(path.resolve(gitDirectory, commonPointer));
    const authorizedGitMetadataPaths = [gitDirectory, commonDirectory];

    await expect(
      createWorkspaceExecutionPolicy({
        workspaceRoot: linkedWorkspace,
        authorizedGitMetadataPaths,
      })
    ).resolves.toMatchObject({ kind: 'freedom.workspace-execution-policy' });

    runGit([
      '-C',
      linkedWorkspace,
      'config',
      '--worktree',
      'http.extraHeader',
      'Authorization: Bearer must-not-cross',
    ]);
    await expect(
      createWorkspaceExecutionPolicy({
        workspaceRoot: linkedWorkspace,
        authorizedGitMetadataPaths,
      })
    ).rejects.toMatchObject({ code: 'UNSAFE_GIT_CONFIGURATION' });
  });

  test('rejects missing or ambiguous protected metadata instead of relying on mount ordering', async () => {
    const missing = await createFixture({ git: false });
    fixtureRoots.push(missing.fixtureRoot);
    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: missing.workspaceRoot })
    ).rejects.toMatchObject({ code: 'PROTECTED_PATH_MISSING' });

    await fs.promises.symlink(
      path.join(missing.fixtureRoot, 'outside-git'),
      path.join(missing.workspaceRoot, '.git')
    );
    await fs.promises.mkdir(path.join(missing.fixtureRoot, 'outside-git'));
    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: missing.workspaceRoot })
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_PROTECTED_PATH' });
  });

  test('rejects a protected path reached through a symbolic-link parent', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const realParent = path.join(fixture.workspaceRoot, 'real-parent');
    await fs.promises.mkdir(path.join(realParent, 'vendor'), { recursive: true });
    await fs.promises.symlink(realParent, path.join(fixture.workspaceRoot, 'linked-parent'));

    await expect(
      createWorkspaceExecutionPolicy({
        workspaceRoot: fixture.workspaceRoot,
        protectedWorkspacePaths: ['.git', 'linked-parent/vendor'],
      })
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_PROTECTED_PATH' });
  });

  test('rejects a working directory that resolves through a symlink outside the workspace', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const outside = path.join(fixture.fixtureRoot, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.symlink(outside, path.join(fixture.workspaceRoot, 'escape'));
    await expect(
      createWorkspaceExecutionPolicy({
        workspaceRoot: fixture.workspaceRoot,
        workingDirectory: 'escape',
      })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
  });

  test('allows fully accounted internal hardlinks including native-module output layouts', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const releaseDirectory = path.join(
      fixture.workspaceRoot,
      'node_modules',
      'native-addon',
      'build',
      'Release'
    );
    const objectDirectory = path.join(releaseDirectory, 'obj.target');
    await fs.promises.mkdir(objectDirectory, { recursive: true });
    const objectPath = path.join(objectDirectory, 'addon.node');
    const outputPath = path.join(releaseDirectory, 'addon.node');
    await fs.promises.writeFile(objectPath, 'native-module-fixture');
    await fs.promises.link(objectPath, outputPath);

    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
    ).resolves.toMatchObject({ kind: 'freedom.workspace-execution-policy' });
    await expect(fs.promises.stat(objectPath)).resolves.toMatchObject({ nlink: 2 });
    await expect(fs.promises.stat(outputPath)).resolves.toMatchObject({ nlink: 2 });
  });

  test('rejects a workspace hardlink with an unaccounted link outside the workspace', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const outsideFile = path.join(fixture.fixtureRoot, 'outside-canary');
    await fs.promises.writeFile(outsideFile, 'outside');
    await fs.promises.link(outsideFile, path.join(fixture.workspaceRoot, 'linked-canary'));
    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_HARDLINK_DENIED',
      details: { relativePath: 'linked-canary' },
    });
    await expect(fs.promises.readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });

  test('rejects an inode shared by protected and writable workspace paths', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const protectedConfig = path.join(fixture.workspaceRoot, '.git', 'config');
    await fs.promises.link(protectedConfig, path.join(fixture.workspaceRoot, 'writable-config'));

    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
    ).rejects.toMatchObject({ code: 'WORKSPACE_HARDLINK_DENIED' });
  });

  test('rejects inconsistent link counts observed while the workspace is being scanned', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const firstPath = path.join(fixture.workspaceRoot, 'native-output.node');
    const secondPath = path.join(fixture.workspaceRoot, 'native-object.node');
    await fs.promises.writeFile(firstPath, 'native-module-fixture');
    await fs.promises.link(firstPath, secondPath);
    const canonicalSecondPath = await fs.promises.realpath(secondPath);

    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let secondPathCalls = 0;
    const lstat = jest
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (candidate, options) => {
        const stats = await originalLstat(candidate, options);
        if (candidate !== canonicalSecondPath || ++secondPathCalls !== 2) return stats;
        return new Proxy(stats, {
          get(target, property, receiver) {
            if (property === 'nlink') return target.nlink + 1n;
            return Reflect.get(target, property, receiver);
          },
        });
      });
    try {
      await expect(
        createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
      ).rejects.toMatchObject({ code: 'WORKSPACE_HARDLINK_DENIED' });
    } finally {
      lstat.mockRestore();
    }
  });

  test('rejects workspace metadata that changes between identity scans', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const sourcePath = path.join(fixture.workspaceRoot, 'source.js');
    const canonicalWorkspaceRoot = await fs.promises.realpath(fixture.workspaceRoot);
    const canonicalSourcePath = await fs.promises.realpath(sourcePath);
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let rootCalls = 0;
    const lstat = jest
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (candidate, options) => {
        if (candidate === canonicalWorkspaceRoot && ++rootCalls === 3) {
          await fs.promises.appendFile(canonicalSourcePath, '// changed during validation\n');
        }
        return originalLstat(candidate, options);
      });
    try {
      await expect(
        createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
      ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED_DURING_VALIDATION' });
    } finally {
      lstat.mockRestore();
    }
  });

  test('does not follow workspace symlinks during hardlink accounting', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const outsideFile = path.join(fixture.fixtureRoot, 'outside-symlink-target');
    await fs.promises.writeFile(outsideFile, 'outside');
    await fs.promises.symlink(outsideFile, path.join(fixture.workspaceRoot, 'outside-link'));

    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
    ).resolves.toMatchObject({ kind: 'freedom.workspace-execution-policy' });
  });

  test('rejects host IPC endpoints already present in the writable workspace', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const socketPath = path.join(fixture.workspaceRoot, 'host.sock');
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(
        createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
      ).rejects.toMatchObject({
        code: 'WORKSPACE_SPECIAL_FILE_DENIED',
        details: { relativePath: 'host.sock' },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('rejects Git configuration that can expose credentials or ambient host files', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const configPath = path.join(fixture.workspaceRoot, '.git', 'config');
    await fs.promises.appendFile(
      configPath,
      '[remote "unsafe"]\n\turl = https://user:secret@example.com/repository.git\n'
    );
    await expect(
      createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot })
    ).rejects.toMatchObject({ code: 'UNSAFE_GIT_CONFIGURATION' });

    await fs.promises.writeFile(
      configPath,
      '[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = /home/user/.gitconfig\n'
    );
    await expect(
      validateGitConfiguration(path.join(fixture.workspaceRoot, '.git'))
    ).rejects.toMatchObject({
      code: 'UNSAFE_GIT_CONFIGURATION',
    });
  });

  test('represents unavailable aggregate limits without weakening them in validation', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      limits: {
        timeoutMs: 1_000,
        stdoutBytes: 2_048,
        stderrBytes: 4_096,
        aggregate: { memoryBytes: 128 * 1024 * 1024, processCount: 32, required: true },
      },
    });
    expect(policy.limits).toMatchObject({
      timeoutMs: 1_000,
      stdoutBytes: 2_048,
      stderrBytes: 4_096,
      aggregate: {
        memoryBytes: 128 * 1024 * 1024,
        processCount: 32,
        required: true,
      },
    });
  });

  test('allows only bounded command vectors and non-sensitive environment names', () => {
    expect(validateExecutionRequest({ command: '/bin/sh', args: ['-c', 'echo ok'] })).toMatchObject(
      {
        command: '/bin/sh',
        args: ['-c', 'echo ok'],
      }
    );
    expect(() => validateExecutionRequest({ command: '/bin/sh', args: ['bad\0arg'] })).toThrow(
      ExecutionPolicyError
    );
    expect(validateEnvironmentName('LANG')).toBe('LANG');
    expect(() => validateEnvironmentName('AWS_SECRET_ACCESS_KEY')).toThrow('not eligible');
    expect(() => validateEnvironmentName('LD_PRELOAD')).toThrow('not eligible');
    expect(() => validateEnvironmentName('DYLD_INSERT_LIBRARIES')).toThrow('not eligible');
    expect(() => validateEnvironmentName('PGPASSWORD')).toThrow('not eligible');
    expect(() => validateEnvironmentName('MYSQL_PWD')).toThrow('not eligible');
    expect(() => validateEnvironmentName('NPM_CONFIG__AUTHTOKEN')).toThrow('not eligible');
  });

  test('uses path containment and Node runtime inference without widening a home directory', () => {
    expect(insidePath('/workspace', '/workspace/project/file')).toBe(true);
    expect(insidePath('/workspace', '/workspace-other/file')).toBe(false);
    const runtimeRoot = inferNodeRuntimeRoot(process.execPath);
    if (process.execPath.startsWith('/usr/') || process.execPath.startsWith('/bin/')) {
      expect(runtimeRoot).toBeNull();
    } else {
      expect(runtimeRoot).toBe(path.dirname(path.dirname(fs.realpathSync(process.execPath))));
    }
  });
});
