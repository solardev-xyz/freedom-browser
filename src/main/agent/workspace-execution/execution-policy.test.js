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
        writableRoots: [{ sourcePath: fixture.workspaceRoot, mountPath: '/workspace' }],
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
    });
    expect(policy.environment.values).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(policy.environment.values).not.toHaveProperty('SSH_AUTH_SOCK');
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

    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    expect(policy.filesystem.protectedPaths[0]).toMatchObject({
      kind: 'git_pointer',
      gitDirectory: await fs.promises.realpath(gitDirectory),
      commonDirectory: await fs.promises.realpath(gitDirectory),
      mountPath: '/workspace/.git',
    });
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

  test('rejects writable hardlinks because mount isolation cannot contain their inode', async () => {
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
