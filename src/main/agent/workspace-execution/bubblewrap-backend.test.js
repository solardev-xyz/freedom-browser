'use strict';

const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BubblewrapExecutor,
  buildBubblewrapArguments,
  collectStream,
  detectBubblewrapCapabilities,
  selectInitialSandboxPid,
} = require('./bubblewrap-backend');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');

async function createFixture() {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-backend-test-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
  const result = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git init failed');
  await fs.promises.writeFile(path.join(workspaceRoot, 'file.txt'), 'hello\n');
  return { fixtureRoot, workspaceRoot };
}

describe('Bubblewrap backend contract', () => {
  const fixtureRoots = [];

  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
    );
  });

  test('generates a fail-closed namespace invocation with no host home, run, or tmp mount', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const launch = await buildBubblewrapArguments(policy, {
      command: '/bin/sh',
      args: ['-c', 'printf ok'],
    });
    fixtureRoots.push(launch.stagingDirectory);
    const joined = launch.args.join('\n');
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--unshare-all',
        '--unshare-user',
        '--disable-userns',
        '--assert-userns-disabled',
        '--die-with-parent',
        '--new-session',
        '--cap-drop',
        'ALL',
        '--clearenv',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
      ])
    );
    expect(joined).toContain(`${fixture.workspaceRoot}\n/workspace`);
    expect(joined).toContain(`${path.join(fixture.workspaceRoot, '.git')}\n/workspace/.git`);
    expect(joined).not.toContain(`${os.homedir()}\n${os.homedir()}`);
    expect(joined).not.toContain('\n/run\n');
    expect(joined).not.toContain(`${os.tmpdir()}\n${os.tmpdir()}`);
    expect(launch.exposedSystemPaths).toContain('/etc/ssl/certs');
    expect(launch.exposedSystemPaths).not.toContain('/etc/ssl');
    expect(launch.args.slice(-3)).toEqual(['/bin/sh', '-c', 'printf ok']);
    expect(joined).toContain('freedom-sandbox-supervisor');
    expect(joined).toContain('printf "%s\\n" "$1"; shift; exec 3>&-; exec "$@"');
  });

  test('refuses unsupported network, seccomp, and required aggregate-limit policies', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const brokered = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      network: 'brokered',
    });
    await expect(
      buildBubblewrapArguments(brokered, { command: '/usr/bin/true' })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_NETWORK_POSTURE' });

    const seccomp = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      requireCustomSeccomp: true,
    });
    await expect(
      buildBubblewrapArguments(seccomp, { command: '/usr/bin/true' })
    ).rejects.toMatchObject({ code: 'SECCOMP_UNAVAILABLE' });

    const resourceLimited = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      limits: { aggregate: { memoryBytes: 1024, required: true } },
    });
    await expect(
      buildBubblewrapArguments(resourceLimited, { command: '/usr/bin/true' })
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_UNAVAILABLE' });
  });

  test('refuses a forged policy object even when its public fields look valid', async () => {
    const forged = {
      kind: 'freedom.workspace-execution-policy',
      version: 1,
      network: 'none',
      filesystem: {
        exposeSystemToolchain: true,
        runtimeRoots: [],
        writableRoots: [{ id: 'workspace', sourcePath: '/tmp', mountPath: '/workspace' }],
        protectedPaths: [],
      },
      environment: { values: {} },
      limits: { aggregate: { required: false } },
      seccomp: { requireCustomFilter: false },
      workingDirectory: '/workspace',
    };

    await expect(
      buildBubblewrapArguments(forged, { command: '/usr/bin/true' })
    ).rejects.toMatchObject({ code: 'INVALID_POLICY' });
  });

  test('continues draining after a visible output limit', async () => {
    const stream = new PassThrough();
    const collection = collectStream(stream, 5);
    stream.write('hello');
    stream.write(' discarded');
    stream.end();
    await collection.done;
    expect(collection.result()).toEqual({ bytes: 5, text: 'hello', truncated: true });
  });

  test('accepts only the first valid Bubblewrap child PID status', () => {
    const initial = selectInitialSandboxPid(null, { 'child-pid': 1234 });
    expect(initial).toBe(1234);
    expect(selectInitialSandboxPid(initial, { 'child-pid': 1 })).toBe(1234);
    expect(selectInitialSandboxPid(null, { 'child-pid': -1 })).toBeNull();
  });

  test('reports an absent backend and never executes without Bubblewrap', async () => {
    const missingBinary = path.join(os.tmpdir(), 'freedom-definitely-missing-bwrap');
    const capabilities = await detectBubblewrapCapabilities({ binary: missingBinary });
    expect(capabilities).toMatchObject({
      available: false,
      denial: { code: 'BUBBLEWRAP_NOT_FOUND' },
      enforcement: { filesystem: false, networkNone: false },
    });

    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new BubblewrapExecutor({ binary: missingBinary });
    await expect(executor.execute(policy, { command: '/usr/bin/true' })).resolves.toMatchObject({
      state: 'sandbox_denied',
      exitCode: null,
      error: { code: 'BUBBLEWRAP_NOT_FOUND' },
    });
  });

  test('does not accept a setuid executable as a Bubblewrap fallback', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const fakeBinary = path.join(fixture.fixtureRoot, 'bwrap');
    await fs.promises.copyFile('/usr/bin/true', fakeBinary);
    await fs.promises.chmod(fakeBinary, 0o4755);
    const capabilities = await detectBubblewrapCapabilities({ binary: fakeBinary });
    expect(capabilities).toMatchObject({
      available: false,
      denial: { code: 'SETUID_BUBBLEWRAP_DENIED' },
    });
  });
});
