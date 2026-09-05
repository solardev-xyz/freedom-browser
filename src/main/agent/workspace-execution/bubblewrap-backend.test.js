'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH,
  BUBBLEWRAP_SUPERVISOR_SCRIPT,
  BUBBLEWRAP_SUPERVISOR_SHELL,
  BubblewrapExecutor,
  DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS,
  DESCRIPTOR_CLOSURE_PROBE_MARKER,
  PRIVATE_TEMP_SIZE_BYTES,
  SHARED_MEMORY_SIZE_BYTES,
  buildBubblewrapArguments,
  capabilityProbeArguments,
  collectStream,
  detectBubblewrapCapabilities,
  selectInitialSandboxPid,
} = require('./bubblewrap-backend');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const { resolveExecutableAccess } = require('./executable-access');

function expectArgumentSequence(args, sequence) {
  expect(args.join('\0')).toContain(sequence.join('\0'));
}

function completedChildProcess({ stdout = '', stderr = '', code = 0, status = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const statusStream = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, statusStream];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn();
  process.nextTick(() => {
    if (status) statusStream.write(`${JSON.stringify(status)}\n`);
    statusStream.end();
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.exitCode = code;
    child.emit('close', code, null);
  });
  return child;
}

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
    expect(launch.args).not.toContain('--share-net');
    expect(joined).toContain(`${fixture.workspaceRoot}\n/workspace`);
    expect(joined).toContain(`${path.join(fixture.workspaceRoot, '.git')}\n/workspace/.git`);
    expect(joined).not.toContain(`${os.homedir()}\n${os.homedir()}`);
    expect(joined).not.toContain('\n/run\n');
    expect(joined).not.toContain(`${os.tmpdir()}\n${os.tmpdir()}`);
    expect(joined).toContain('/tmp/data');
    expect(joined).toContain('XDG_DATA_HOME\n/tmp/data');
    expect(launch.exposedSystemPaths).toContain('/etc/ssl/certs');
    expect(launch.exposedSystemPaths).not.toContain('/etc/ssl');
    if (fs.existsSync('/etc/alternatives')) {
      expect(launch.exposedSystemPaths).toContain('/etc/alternatives');
    }
    expectArgumentSequence(launch.args, [
      '--ro-bind',
      path.join(launch.stagingDirectory, 'empty'),
      '/usr/local',
    ]);
    expectArgumentSequence(launch.args, [
      '--size',
      String(SHARED_MEMORY_SIZE_BYTES),
      '--perms',
      '1777',
      '--tmpfs',
      '/dev/shm',
      '--remount-ro',
      '/dev',
    ]);
    expectArgumentSequence(launch.args, [
      '--size',
      String(PRIVATE_TEMP_SIZE_BYTES),
      '--perms',
      '1777',
      '--tmpfs',
      '/tmp',
    ]);
    expectArgumentSequence(launch.args, ['--remount-ro', '/proc', '--remount-ro', '/']);
    const pathIndex = launch.args.findIndex(
      (value, index) => value === '--setenv' && launch.args[index + 1] === 'PATH'
    );
    expect(launch.args[pathIndex + 2]).toEqual(
      expect.stringMatching(new RegExp(`(?:^|:)${BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH}$`))
    );
    expect(launch.args[pathIndex + 2]).not.toContain('/usr/local');
    expect(joined).toContain('XDG_DATA_HOME\n/tmp/data');
    expect(launch.args.slice(-3)).toEqual(['/bin/sh', '-c', 'printf ok']);
    expect(joined).toContain('freedom-sandbox-supervisor');
    expect(joined).toContain(BUBBLEWRAP_SUPERVISOR_SCRIPT);
    expectArgumentSequence(launch.args, [
      '--',
      BUBBLEWRAP_SUPERVISOR_SHELL,
      '-c',
      BUBBLEWRAP_SUPERVISOR_SCRIPT,
    ]);
    expect(BUBBLEWRAP_SUPERVISOR_SCRIPT).toContain('[ -e /proc/self/fd/0 ] || exit 97');
    expect(BUBBLEWRAP_SUPERVISOR_SCRIPT).toContain('case "$descriptor" in');
    expect(BUBBLEWRAP_SUPERVISOR_SCRIPT).toContain("''|*[!0-9]*) continue");
    expect(BUBBLEWRAP_SUPERVISOR_SCRIPT).toContain('eval "exec ${descriptor}>&-" || exit 98');
    expect(BUBBLEWRAP_SUPERVISOR_SCRIPT).not.toContain('done 2>/dev/null');
    expect(BUBBLEWRAP_SUPERVISOR_SCRIPT.indexOf('done')).toBeLessThan(
      BUBBLEWRAP_SUPERVISOR_SCRIPT.indexOf('printf "%s\\n" "$1"')
    );
  });

  test('mounts approved executable roots read-only and adds only their declared PATH entries', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const packageRoot = path.join(fixture.fixtureRoot, 'toolchain');
    const bin = path.join(packageRoot, 'bin');
    await fs.promises.mkdir(bin, { recursive: true });
    await fs.promises.writeFile(path.join(bin, 'actual-tool'), '#!/bin/sh\n', { mode: 0o700 });
    await fs.promises.symlink('actual-tool', path.join(bin, 'tool'));
    const access = await resolveExecutableAccess(['tool'], {
      platform: 'linux',
      hostEnvironment: { PATH: bin },
    });
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      runtimeRoots: access.runtimeRoots,
    });

    const launch = await buildBubblewrapArguments(policy, { command: '/bin/sh' });
    fixtureRoots.push(launch.stagingDirectory);
    const root = access.runtimeRoots[0];
    expectArgumentSequence(launch.args, ['--ro-bind', root.sourcePath, root.mountPath]);
    const pathIndex = launch.args.findIndex(
      (value, index) => value === '--setenv' && launch.args[index + 1] === 'PATH'
    );
    expect(launch.args[pathIndex + 2].split(':').slice(0, 2)).toEqual([
      '/opt/freedom-toolchain/commands', `${root.mountPath}/bin`,
    ]);
    expectArgumentSequence(launch.args, [
      '--symlink', `${root.mountPath}/bin/actual-tool`, '/opt/freedom-toolchain/commands/tool',
    ]);
    expect(launch.args.join('\n')).not.toContain(`${root.sourcePath}\n${root.sourcePath}`);
  });

  test('shares the host network only for an explicit full-network policy', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      network: 'full',
    });

    const launch = await buildBubblewrapArguments(policy, { command: '/usr/bin/true' });
    fixtureRoots.push(launch.stagingDirectory);

    expectArgumentSequence(launch.args, ['--unshare-all', '--share-net', '--unshare-user']);
    if (fs.existsSync('/etc/resolv.conf')) {
      expectArgumentSequence(launch.args, [
        '--ro-bind',
        fs.realpathSync('/etc/resolv.conf'),
        '/etc/resolv.conf',
      ]);
    }
  });

  test('enables name-service DNS resolution only for the full-network posture', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const offline = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const full = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      network: 'full',
    });

    const offlineLaunch = await buildBubblewrapArguments(offline, { command: '/usr/bin/true' });
    fixtureRoots.push(offlineLaunch.stagingDirectory);
    const fullLaunch = await buildBubblewrapArguments(full, { command: '/usr/bin/true' });
    fixtureRoots.push(fullLaunch.stagingDirectory);

    const offlineSwitch = path.join(offlineLaunch.stagingDirectory, 'nsswitch.conf');
    const fullSwitch = path.join(fullLaunch.stagingDirectory, 'nsswitch.conf');
    expectArgumentSequence(offlineLaunch.args, ['--ro-bind', offlineSwitch, '/etc/nsswitch.conf']);
    expectArgumentSequence(fullLaunch.args, ['--ro-bind', fullSwitch, '/etc/nsswitch.conf']);
    await expect(fs.promises.readFile(offlineSwitch, 'utf8')).resolves.toBe(
      'passwd: files\ngroup: files\nhosts: files\n'
    );
    await expect(fs.promises.readFile(fullSwitch, 'utf8')).resolves.toBe(
      'passwd: files\ngroup: files\nhosts: files dns\n'
    );
    expect(offlineLaunch.args).not.toContain('/etc/resolv.conf');
    expect(offlineLaunch.args).not.toContain('--share-net');
  });

  test('probes every Bubblewrap primitive used for bounded writable mounts', () => {
    const args = capabilityProbeArguments();
    expectArgumentSequence(args, ['--', BUBBLEWRAP_SUPERVISOR_SHELL, '-c']);
    for (const descriptor of DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS) {
      expect(args.join('\n')).toContain(String(descriptor));
    }
    expect(args).toContain(DESCRIPTOR_CLOSURE_PROBE_MARKER);
    expectArgumentSequence(args, [
      '--size',
      String(SHARED_MEMORY_SIZE_BYTES),
      '--perms',
      '1777',
      '--tmpfs',
      '/dev/shm',
      '--remount-ro',
      '/dev',
    ]);
    expectArgumentSequence(args, [
      '--size',
      String(PRIVATE_TEMP_SIZE_BYTES),
      '--perms',
      '1777',
      '--tmpfs',
      '/tmp',
      '--remount-ro',
      '/proc',
      '--remount-ro',
      '/',
    ]);
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
    const onData = jest.fn();
    const collection = collectStream(stream, 5, onData);
    stream.write('hello');
    stream.write(' discarded');
    stream.end();
    await collection.done;
    expect(collection.result()).toEqual({ bytes: 5, text: 'hello', truncated: true });
    expect(Buffer.concat(onData.mock.calls.map(([chunk]) => chunk)).toString('utf8')).toBe(
      'hello discarded'
    );
  });

  test('accepts only the first valid Bubblewrap child PID status', () => {
    const initial = selectInitialSandboxPid(null, { 'child-pid': 1234 });
    expect(initial).toBe(1234);
    expect(selectInitialSandboxPid(initial, { 'child-pid': 1 })).toBe(1234);
    expect(selectInitialSandboxPid(null, { 'child-pid': -1 })).toBeNull();
  });

  const linuxOnlyTest = process.platform === 'linux' ? test : test.skip;

  linuxOnlyTest('reports an absent backend and never executes without Bubblewrap', async () => {
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
      backend: 'linux-bubblewrap',
      state: 'sandbox_denied',
      exitCode: null,
      terminationGuarantee: 'not_applicable',
      sideEffects: 'none',
      error: { code: 'BUBBLEWRAP_NOT_FOUND' },
    });
  });

  linuxOnlyTest('does not accept a setuid executable as a Bubblewrap fallback', async () => {
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

  linuxOnlyTest('fails closed when Bash cannot complete the descriptor probe', async () => {
    const results = [
      { stdout: 'bubblewrap 0.test\n' },
      {},
      { code: 98, stderr: 'synthetic descriptor close failure\n' },
    ];
    const spawnProcess = jest.fn(() => completedChildProcess(results.shift()));
    const capabilities = await detectBubblewrapCapabilities({
      binary: '/usr/bin/true',
      spawnProcess,
    });

    expect(capabilities).toMatchObject({
      available: false,
      denial: { code: 'BASH_DESCRIPTOR_CLOSURE_UNAVAILABLE' },
      enforcement: { closedFileDescriptors: false },
      diagnostics: {
        bashPath: BUBBLEWRAP_SUPERVISOR_SHELL,
        descriptorClosureProbeDescriptors: DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS,
        diagnostic: 'synthetic descriptor close failure\n',
      },
    });
  });

  linuxOnlyTest('emits no readiness marker when wrapper setup fails', () => {
    const readinessMarker = 'synthetic-readiness-marker';
    const result = spawnSync(
      BUBBLEWRAP_SUPERVISOR_SHELL,
      [
        '-c',
        'exec 0<&-; exec "$1" -c "$2" freedom-sandbox-supervisor "$3" /usr/bin/true',
        'freedom-wrapper-failure-test',
        BUBBLEWRAP_SUPERVISOR_SHELL,
        BUBBLEWRAP_SUPERVISOR_SCRIPT,
        readinessMarker,
      ],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(97);
    expect(result.stdout).toBe('');
    expect(result.stdout).not.toContain(readinessMarker);
  });

  linuxOnlyTest('classifies a wrapper failure before readiness as sandbox denied', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new BubblewrapExecutor({
      spawnProcess: () =>
        completedChildProcess({
          code: 98,
          stderr: 'descriptor setup failed\n',
          status: { 'child-pid': 1234 },
        }),
    });
    executor.capabilities = Object.freeze({ available: true });

    await expect(executor.execute(policy, { command: '/usr/bin/true' })).resolves.toMatchObject({
      state: 'sandbox_denied',
      exitCode: null,
      stdout: '',
      sideEffects: 'none',
      error: { code: 'SANDBOX_INITIALIZATION_FAILED' },
      diagnostics: { namespaceCreated: true },
    });
  });
});
