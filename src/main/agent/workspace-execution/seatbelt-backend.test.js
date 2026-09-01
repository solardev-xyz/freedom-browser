'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const {
  PRIVATE_DIRECTORY_PREFIX,
  buildSeatbeltProfile,
  collectStream,
  createPrivateDirectory,
  detectSeatbeltCapabilities,
  hostWorkingDirectory,
  seatbeltString,
} = require('./seatbelt-backend');

async function createFixture() {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-seatbelt-unit-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
  const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
  await fs.promises.mkdir(path.join(workspaceRoot, 'nested'));
  await fs.promises.writeFile(path.join(workspaceRoot, 'source.txt'), 'source\n');
  return { fixtureRoot, workspaceRoot };
}

describe('macOS Seatbelt backend contract', () => {
  const fixtureRoots = [];

  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
    );
  });

  test('escapes profile strings rather than accepting injected forms', () => {
    expect(seatbeltString('/tmp/a"b\\c')).toBe('"/tmp/a\\"b\\\\c"');
  });

  test('constructs a default-deny profile with exact canonical authority and Git precedence', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      nodeRuntimeRoot: '/usr',
      workingDirectory: 'nested',
    });
    const privateDirectory = await createPrivateDirectory();
    fixtureRoots.push(privateDirectory);
    const workspace = policy.filesystem.writableRoots.find((root) => root.id === 'workspace');
    const gitMetadata = policy.filesystem.protectedPaths.find(
      (protectedPath) => protectedPath.relativePath === '.git'
    );
    const profile = buildSeatbeltProfile(policy, privateDirectory);

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain(`(allow file-write* (subpath "${workspace.sourcePath}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${gitMetadata.sourcePath}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${privateDirectory}"))`);
    expect(profile).not.toContain(os.homedir());
    expect(profile).not.toContain('/Applications');
    expect(hostWorkingDirectory(policy, workspace)).toBe(path.join(workspace.sourcePath, 'nested'));
  });

  test('creates canonical mode-0700 private storage with isolated subdirectories', async () => {
    const directory = await createPrivateDirectory();
    fixtureRoots.push(directory);
    expect(path.basename(directory)).toMatch(new RegExp(`^${PRIVATE_DIRECTORY_PREFIX}`));
    expect((await fs.promises.stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of ['home', 'tmp', 'cache', 'config', 'data']) {
      await expect(fs.promises.stat(path.join(directory, name))).resolves.toMatchObject({});
    }
  });

  test('rejects forged policy objects and unvalidated private paths', async () => {
    expect(() => buildSeatbeltProfile({}, '/tmp/freedom-seatbelt-forged')).toThrow(
      expect.objectContaining({ code: 'INVALID_POLICY' })
    );
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    expect(() => buildSeatbeltProfile(policy, '/tmp/not-freedom-storage')).toThrow(
      expect.objectContaining({ code: 'INVALID_PRIVATE_DIRECTORY' })
    );
  });

  test('uses capability-based detection and fails closed on initialization errors', async () => {
    await expect(
      detectSeatbeltCapabilities({ platform: 'linux', binary: '/usr/bin/true' })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'SEATBELT_PLATFORM_UNAVAILABLE' },
    });
    await expect(
      detectSeatbeltCapabilities({
        platform: 'darwin',
        architecture: 'future-arch',
        release: 'future-release',
        binary: '/usr/bin/true',
        run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      })
    ).resolves.toMatchObject({
      available: true,
      diagnostics: { architecture: 'future-arch', release: 'future-release' },
      enforcement: { cancellationGuarantee: 'best_effort' },
    });
    await expect(
      detectSeatbeltCapabilities({
        platform: 'darwin',
        binary: '/usr/bin/true',
        run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'denied' }),
      })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'SEATBELT_INITIALIZATION_FAILED' },
      diagnostics: { initializationDiagnostic: 'denied' },
    });
  });

  test('continues draining output after the visible limit', () => {
    const stream = new PassThrough();
    const collection = collectStream(stream, 5);
    stream.write('hello');
    stream.write(' discarded');
    stream.end();
    expect(collection.result()).toEqual({ text: 'hello', truncated: true });
  });
});
