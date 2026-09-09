'use strict';

const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH,
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
} = require('./bubblewrap-backend');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const { resolveExecutableAccess } = require('./executable-access');

function expectArgumentSequence(args, sequence) {
  expect(args.join('\0')).toContain(sequence.join('\0'));
}

function completedOwner({ stdout = '', stderr = '', code = 0, final = {} } = {}) {
  return { stdout, stderr, code, transportComplete: true, ownerExit: { code: 0, signal: null },
    final: { created: true, armed: true, released: true, observed: true, retired: true,
      reaped: true, uncertain: false, monitorObserved: true, monitorCode: code,
      monitorSignal: 0, reason: 'completed', ...final } };
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
    expect(joined).not.toContain('--ro-bind\n/run\n/run');
    expectArgumentSequence(launch.args, ['--perms', '0555', '--ro-bind-data', '8', '/run/freedom-workspace-owner']);
    expect(launch.args).not.toContain('--json-status-fd');
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
    expectArgumentSequence(launch.args, [
      '--',
      '/run/freedom-workspace-owner',
      '--gate',
      launch.readinessMarker,
    ]);
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
    expectArgumentSequence(args, ['--', '/run/freedom-workspace-owner', '--gate',
      DESCRIPTOR_CLOSURE_PROBE_MARKER, BUBBLEWRAP_SUPERVISOR_SHELL, '-c']);
    expectArgumentSequence(args, ['--perms', '0555', '--ro-bind-data', '8', '/run/freedom-workspace-owner']);
    expect(args[args.length - 1]).toContain('"$descriptor" -gt 2');
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

  linuxOnlyTest('fails closed when the native gate cannot complete the descriptor probe', async () => {
    const results = [
      { stdout: 'bubblewrap 0.test\n' },
      {},
      { code: 98, stderr: 'synthetic descriptor close failure\n' },
    ];
    const runOwner = jest.fn(async () => completedOwner(results.shift()));
    const capabilities = await detectBubblewrapCapabilities({
      binary: '/usr/bin/true',
      runOwner,
    });

    expect(capabilities).toMatchObject({
      available: false,
      denial: { code: 'NATIVE_DESCRIPTOR_CLOSURE_UNAVAILABLE' },
      enforcement: { closedFileDescriptors: false },
      diagnostics: {
        bashPath: BUBBLEWRAP_SUPERVISOR_SHELL,
        descriptorClosureProbeDescriptors: DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS,
        diagnostic: 'synthetic descriptor close failure\n',
      },
    });
  });

  linuxOnlyTest('classifies a wrapper failure before readiness as sandbox denied', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new BubblewrapExecutor({
      resolveOwner: async () => ({ executablePath: '/trusted/owner', close: async () => {} }),
      runOwner: async () =>
        completedOwner({
          code: 98,
          stderr: 'descriptor setup failed\n',
          final: { released: false, reason: 'setup_failed' },
        }),
    });
    executor.capabilities = Object.freeze({ available: true });

    await expect(executor.execute(policy, { command: '/usr/bin/true' })).resolves.toMatchObject({
      state: 'sandbox_denied',
      exitCode: 98,
      stdout: '',
      stderr: '',
      sideEffects: 'none',
      error: { code: 'SANDBOX_INITIALIZATION_FAILED' },
      diagnostics: { nativeOwner: { created: true, released: false, reaped: true } },
    });
  });
  test.each([
    [false], [true],
  ])('withholds setup output and preserves early command stderr only after the exact marker: %s', async (ready) => {
    const fixture = await createFixture(); fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const output = [];
    const executor = new BubblewrapExecutor({
      resolveOwner: async () => ({ executablePath: '/trusted/owner', close: async () => {} }),
      runOwner: async (_binary, args, options) => {
        const marker = args[args.indexOf('--gate') + 1] + '\n';
        options.onOutput('stderr', Buffer.from('early stderr\n'));
        expect(output).toEqual([]);
        const stdout = ready ? marker + 'command output\n' : 'private setup diagnostic\n';
        options.onOutput('stdout', Buffer.from(stdout.slice(0, 5)));
        expect(output).toEqual([]);
        options.onOutput('stdout', Buffer.from(stdout.slice(5)));
        return completedOwner({ stdout, stderr: 'early stderr\n' });
      },
    });
    executor.capabilities = { available: true };
    const receipt = await executor.execute(policy, { command: '/usr/bin/true',
      onOutput: (stream, chunk) => output.push([stream, chunk.toString()]) });
    expect(output).toEqual(ready ? [['stderr', 'early stderr\n'], ['stdout', 'command output\n']] : []);
    expect(receipt.stdout).toBe(ready ? 'command output\n' : '');
    expect(receipt.stderr).toBe(ready ? 'early stderr\n' : '');
    if (!ready) expect(receipt.diagnostics.initializationDiagnostic).toBe('early stderr\n');
  });
  test.each([
    ['completed', { reason: 'completed' }, 0, true],
    ['failed', { reason: 'completed' }, 7, true],
    ['cancelled', { reason: 'cancelled' }, 0, true],
    ['timed_out', { reason: 'timed_out', monitorObserved: false }, 0, true],
    ['cancelled', { reason: 'cancelled', reaped: false, observed: false, retired: false, uncertain: true }, 0, false],
  ])('reconciles %s from original native outcomes without inventing a signal %#', async (state, final, code, complete) => {
    const fixture = await createFixture(); fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new BubblewrapExecutor({
      resolveOwner: async () => ({ executablePath: '/trusted/owner', close: async () => {} }),
      runOwner: async () => completedOwner({ code, final }),
    });
    executor.capabilities = { available: true };
    const receipt = await executor.execute(policy, { command: '/usr/bin/true' });
    expect(receipt.state).toBe(state); expect(receipt.signal).toBeNull();
    expect(receipt.completeDescendantTermination).toBe(complete);
    expect(receipt.survivorsPossible).toBe(!complete);
    expect(receipt.terminationGuarantee).toBe(complete ? 'namespace_scoped' : 'unknown');
    expect(receipt.terminationScope).toBe(complete ? 'pid_namespace' : 'unknown');
    if (state === 'cancelled') expect(receipt.error?.code).toBe(complete ? undefined : 'LINUX_OWNER_INCOMPLETE');
    expect(receipt.exitCode).toBe(final.monitorObserved === false ? null : code);
  });
  test('unavailable owner denies capability without invoking an unowned fallback', async () => {
    const runOwner = jest.fn(async () => { throw new Error('missing helper'); });
    const result = await detectBubblewrapCapabilities({ binary: '/usr/bin/true', runOwner });
    expect(result.available).toBe(false); expect(result.denial.code).toBe('LINUX_OWNER_UNAVAILABLE');
    expect(runOwner).toHaveBeenCalledTimes(1);
  });
  test.each([true, false])('positive pre-spawn abort evidence versus merely lost status: %s', async (notSpawned) => {
    const fixture = await createFixture(); fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new BubblewrapExecutor({
      resolveOwner: async () => ({ executablePath: '/trusted/owner', close: async () => {} }),
      runOwner: async () => ({ stdout: '', stderr: '', requested: true, notSpawned, final: null, ownerExit: null, error: null }),
    });
    executor.capabilities = { available: true };
    const receipt = await executor.execute(policy, { command: '/usr/bin/true' });
    expect(receipt.state).toBe(notSpawned ? 'cancelled' : 'failed');
    expect(receipt.sideEffects).toBe(notSpawned ? 'none' : 'unknown');
    expect(receipt.error?.code).toBe(notSpawned ? undefined : 'LINUX_OWNER_INCOMPLETE');
    expect(receipt.terminationScope).toBe('unknown');
  });
  test('exec failure is COMMAND_FAILED127, not ownership failure', async () => {
    const fixture = await createFixture(); fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new BubblewrapExecutor({
      resolveOwner: async () => ({ executablePath: '/trusted/owner', close: async () => {} }),
      runOwner: async () => completedOwner({ code: 127, final: { reason: 'exec_failed' } }),
    });
    executor.capabilities = { available: true };
    expect(await executor.execute(policy, { command: '/usr/bin/true' })).toMatchObject({
      state: 'failed', exitCode: 127, error: { code: 'COMMAND_FAILED' }, completeDescendantTermination: true,
    });
  });
});
