'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const { resolveExecutableAccess } = require('./executable-access');
const {
  PRIVATE_DIRECTORY_PREFIX,
  SEATBELT_SYSCTL_READ_NAMES,
  SEATBELT_NETWORK_MACH_SERVICES,
  SeatbeltExecutor,
  buildSeatbeltProfile,
  capabilityProbeProfile,
  collectStream,
  createPrivateDirectory,
  detectSeatbeltCapabilities,
  hostWorkingDirectory,
  seatbeltString,
  signalProcessGroup,
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
    expect(profile).not.toContain('(allow process-exec)');
    expect(profile).toContain('(allow process-exec (subpath "/usr"))');
    expect(profile).toContain(`(allow process-exec (subpath "${workspace.sourcePath}"))`);
    expect(profile).toContain(`(allow process-exec (subpath "${privateDirectory}"))`);
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(allow process-info-pidinfo (target same-sandbox))');
    expect(profile).not.toContain('process-info*');
    expect(profile).not.toContain('(allow sysctl-read)');
    expect(profile).not.toContain('sysctl-name-prefix');
    expect(profile).not.toContain('kern.proc');
    expect(profile).not.toContain('net.routetable');
    expect(profile).not.toContain('vm.loadavg');
    for (const name of SEATBELT_SYSCTL_READ_NAMES) {
      expect(profile).toContain(`(sysctl-name "${name}")`);
    }
    expect(profile).toContain(`(allow file-write* (subpath "${workspace.sourcePath}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${gitMetadata.sourcePath}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${privateDirectory}"))`);
    expect(profile).not.toContain(os.homedir());
    expect(profile).not.toContain('/Applications');
    if (fs.existsSync('/usr/local')) {
      expect(profile).toContain('(deny file-read* (subpath "/usr/local"))');
    }
    expect(hostWorkingDirectory(policy, workspace)).toBe(path.join(workspace.sourcePath, 'nested'));
  });

  test('adds read and execute authority only for a Freedom-resolved executable root', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const packageRoot = path.join(fixture.fixtureRoot, 'toolchain');
    const bin = path.join(packageRoot, 'bin');
    await fs.promises.mkdir(bin, { recursive: true });
    await fs.promises.writeFile(path.join(bin, 'tool'), '#!/bin/sh\n', { mode: 0o700 });
    const access = await resolveExecutableAccess(['tool'], {
      platform: 'darwin',
      hostEnvironment: { PATH: bin },
    });
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      runtimeRoots: access.runtimeRoots,
    });
    const privateDirectory = await createPrivateDirectory();
    fixtureRoots.push(privateDirectory);
    const root = access.runtimeRoots[0];

    const profile = buildSeatbeltProfile(policy, privateDirectory);

    expect(profile).toContain(`(allow file-read* (subpath "${root.sourcePath}"))`);
    expect(profile).toContain(`(allow process-exec (subpath "${root.sourcePath}"))`);
    expect(profile).not.toContain(`(allow file-write* (subpath "${root.sourcePath}"))`);
  });

  test('adds full IP networking without granting general Unix-socket authority', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      network: 'full',
    });
    const privateDirectory = await createPrivateDirectory();
    fixtureRoots.push(privateDirectory);

    const profile = buildSeatbeltProfile(policy, privateDirectory);

    expect(profile).toContain('(allow network-outbound)');
    expect(profile).toContain('(allow network-inbound)');
    expect(profile).not.toContain('(deny network*)');
    expect(profile).not.toContain('remote unix-socket');
    expect(profile).not.toContain('local unix-socket');
    expect(profile).toContain('(sysctl-name-regex #"^net\\.routetable")');
    for (const service of SEATBELT_NETWORK_MACH_SERVICES) {
      expect(profile).toContain(`(global-name "${service}")`);
    }
  });

  test('uses the same narrow sysctl and process visibility posture in the capability probe', () => {
    const profile = capabilityProbeProfile();
    expect(profile).not.toContain('(allow process-exec)');
    expect(profile).toContain('(allow process-exec (subpath "/usr"))');
    expect(profile).toContain('(allow process-info-pidinfo (target same-sandbox))');
    expect(profile).not.toContain('process-info*');
    expect(profile).not.toContain('(allow sysctl-read)');
    expect(profile).not.toContain('sysctl-name-prefix');
    expect(profile).not.toContain('kern.proc');
    expect(profile).not.toContain('net.routetable');
    expect(profile).not.toContain('vm.loadavg');
    expect(profile.match(/\(sysctl-name /g)).toHaveLength(SEATBELT_SYSCTL_READ_NAMES.length);
  });

  test('omits absent platform system paths without dropping permissions for existing paths', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
    });
    const privateDirectory = await createPrivateDirectory();
    fixtureRoots.push(privateDirectory);
    const exists = jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((candidate) => candidate === '/usr');
    let profile;
    try {
      profile = buildSeatbeltProfile(policy, privateDirectory);
    } finally {
      exists.mockRestore();
    }

    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).not.toContain('"/System"');
    expect(profile).not.toContain('"/bin"');
    expect(profile).not.toContain('"/sbin"');
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
      diagnostics: {
        architecture: 'future-arch',
        release: 'future-release',
        profileApplicationReadiness: 'passed',
        denialSemanticsProbe: 'not_run',
      },
      enforcement: {
        cancellationGuarantee: 'best_effort',
        executableRootsScoped: true,
        survivorsPossible: true,
        completeDescendantTermination: false,
        processVisibility: 'same_sandbox_only',
      },
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

    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new SeatbeltExecutor({
      binary: '/usr/bin/true',
      capabilityOptions: { platform: 'linux' },
    });
    await expect(executor.execute(policy, { command: '/usr/bin/true' })).resolves.toMatchObject({
      backend: 'macos-seatbelt',
      state: 'sandbox_denied',
      terminationGuarantee: 'not_applicable',
      sideEffects: 'none',
      error: { code: 'SEATBELT_PLATFORM_UNAVAILABLE' },
    });
  });

  test('records process-group signal failures other than an exited group', () => {
    const success = jest.fn();
    expect(signalProcessGroup(123, 'SIGKILL', success)).toBeNull();
    expect(success).toHaveBeenCalledWith(-123, 'SIGKILL');

    expect(
      signalProcessGroup(123, 'SIGKILL', () => {
        const error = new Error('gone');
        error.code = 'ESRCH';
        throw error;
      })
    ).toBeNull();

    expect(
      signalProcessGroup(123, 'SIGKILL', () => {
        const error = new Error('not permitted');
        error.code = 'EPERM';
        throw error;
      })
    ).toEqual({ signal: 'SIGKILL', code: 'EPERM' });
  });

  test('continues draining output after the visible limit', () => {
    const stream = new PassThrough();
    const onData = jest.fn();
    const collection = collectStream(stream, 5, onData);
    stream.write('hello');
    stream.write(' discarded');
    stream.end();
    expect(collection.result()).toEqual({ text: 'hello', truncated: true });
    expect(Buffer.concat(onData.mock.calls.map(([chunk]) => chunk)).toString('utf8')).toBe(
      'hello discarded'
    );
  });
});
