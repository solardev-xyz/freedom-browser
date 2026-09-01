'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const {
  SeatbeltExecutor,
  buildSeatbeltProfile,
  detectSeatbeltCapabilities,
  seatbeltString,
} = require('./seatbelt-backend');

async function createFixture() {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-seatbelt-unit-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
  const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
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

  test('constructs a default-deny profile with exact workspace authority and Git precedence', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      nodeRuntimeRoot: null,
    });
    const privateDirectory = path.join(fixture.fixtureRoot, 'private');
    const profile = buildSeatbeltProfile(policy, privateDirectory);

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain(`(allow file-write* (subpath "${fixture.workspaceRoot}"))`);
    expect(profile).toContain(
      `(deny file-write* (subpath "${path.join(fixture.workspaceRoot, '.git')}"))`
    );
    expect(profile).toContain(`(allow file-write* (subpath "${privateDirectory}"))`);
    expect(profile).not.toContain(os.homedir());
    expect(profile).not.toContain('/Library');
    expect(profile).not.toContain('/Applications');
  });

  test('rejects forged policy objects', () => {
    expect(() => buildSeatbeltProfile({}, '/tmp/freedom-private')).toThrow(
      expect.objectContaining({ code: 'INVALID_POLICY' })
    );
  });

  test('treats non-macOS and unqualified builds as unavailable', async () => {
    await expect(
      detectSeatbeltCapabilities({ platform: 'linux', binary: '/usr/bin/true' })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'SEATBELT_PLATFORM_UNAVAILABLE' },
    });

    const run = async (binary, args) => ({
      exitCode: 0,
      stdout: args[0] === '-productVersion' ? '15.5\n' : '24F74\n',
      stderr: '',
    });
    await expect(
      detectSeatbeltCapabilities({
        platform: 'darwin',
        architecture: 'arm64',
        binary: '/usr/bin/true',
        run,
      })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'UNQUALIFIED_MACOS_BUILD' },
    });
  });

  test('reports confirmed setsid escape as a mandatory cancellation blocker', async () => {
    const run = async (binary, args) => {
      if (binary === '/usr/bin/sw_vers') {
        return {
          exitCode: 0,
          stdout: args[0] === '-productVersion' ? '15.6\n' : '24G84\n',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(
      detectSeatbeltCapabilities({
        platform: 'darwin',
        architecture: 'arm64',
        binary: '/usr/bin/true',
        run,
      })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'DESCENDANT_CANCELLATION_UNAVAILABLE' },
      diagnostics: { profileInitialization: 'passed', setsidEscape: 'confirmed' },
      enforcement: { cancellation: false },
    });
  });

  test('never launches an untrusted command when the mandatory boundary is unavailable', async () => {
    const fixture = await createFixture();
    fixtureRoots.push(fixture.fixtureRoot);
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: fixture.workspaceRoot });
    const executor = new SeatbeltExecutor({
      platform: 'darwin',
      architecture: 'arm64',
      binary: '/usr/bin/true',
      run: async (binary, args) => {
        if (binary === '/usr/bin/sw_vers') {
          return {
            exitCode: 0,
            stdout: args[0] === '-productVersion' ? '15.6\n' : '24G84\n',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const canary = path.join(fixture.workspaceRoot, 'must-not-exist');
    const receipt = await executor.execute(policy, {
      command: '/usr/bin/touch',
      args: [canary],
    });

    expect(receipt).toMatchObject({
      state: 'sandbox_denied',
      error: { code: 'DESCENDANT_CANCELLATION_UNAVAILABLE' },
    });
    await expect(fs.promises.stat(canary)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
