'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isValidatedExecutableAccessRequest,
  isValidatedExecutableRoot,
} = require('./executable-access');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const {
  PROCESS_RUNTIME_COMMANDS,
  approvedCommandPath,
  resolveProcessRuntimeAccess,
} = require('./qualification-runtime-access');

describe('qualification process runtime access', () => {
  const fixtureRoots = [];
  const originalPath = process.env.PATH;

  afterEach(async () => {
    process.env.PATH = originalPath;
    await Promise.all(
      fixtureRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
    );
  });

  async function createRuntimePrefix(commands) {
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-runtime-'));
    fixtureRoots.push(fixture);
    const prefix = path.join(fixture, 'runtime');
    const binDirectory = path.join(prefix, 'bin');
    await fs.promises.mkdir(binDirectory, { recursive: true });
    for (const name of commands) {
      await fs.promises.writeFile(path.join(binDirectory, name), '#!/bin/sh\n', { mode: 0o700 });
    }
    return { fixture, prefix: await fs.promises.realpath(prefix), binDirectory };
  }

  test('resolves node and npm beside the process executable as validated read-only roots', async () => {
    const { fixture, prefix, binDirectory } = await createRuntimePrefix(PROCESS_RUNTIME_COMMANDS);
    const workspaceRoot = path.join(fixture, 'workspace');
    await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
    const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(git.stderr || 'git init failed');

    const request = await resolveProcessRuntimeAccess({
      execPath: path.join(binDirectory, 'node'),
    });

    expect(isValidatedExecutableAccessRequest(request)).toBe(true);
    expect(request.commands.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'node', status: 'requires_permission' },
      { name: 'npm', status: 'requires_permission' },
    ]);
    expect(request.runtimeRoots).toHaveLength(1);
    const [root] = request.runtimeRoots;
    expect(isValidatedExecutableRoot(root)).toBe(true);
    expect(root).toMatchObject({
      sourcePath: prefix,
      access: 'read_execute',
      pathEntries: ['bin'],
      commands: ['node', 'npm'],
    });
    expect(root.mountPath.startsWith('/opt/freedom-toolchain/approved/')).toBe(true);
    expect(approvedCommandPath(request, 'node')).toBe(`${root.mountPath}/bin/node`);
    expect(approvedCommandPath(request, 'npm')).toBe(`${root.mountPath}/bin/npm`);

    const policy = await createWorkspaceExecutionPolicy({
      workspaceRoot,
      runtimeRoots: request.runtimeRoots,
    });
    expect(policy.filesystem.runtimeRoots).toEqual([root]);
  });

  test('follows a symlinked process executable to its real runtime prefix', async () => {
    const { fixture, prefix, binDirectory } = await createRuntimePrefix(PROCESS_RUNTIME_COMMANDS);
    const linkDirectory = path.join(fixture, 'links');
    await fs.promises.mkdir(linkDirectory);
    await fs.promises.symlink(path.join(binDirectory, 'node'), path.join(linkDirectory, 'node'));

    const request = await resolveProcessRuntimeAccess({
      execPath: path.join(linkDirectory, 'node'),
    });

    expect(request.runtimeRoots).toHaveLength(1);
    expect(request.runtimeRoots[0].sourcePath).toBe(prefix);
  });

  test('ignores the ambient host PATH and fails closed when the runtime lacks npm', async () => {
    const { fixture, binDirectory } = await createRuntimePrefix(['node']);
    const ambientDirectory = path.join(fixture, 'ambient');
    await fs.promises.mkdir(ambientDirectory);
    await fs.promises.writeFile(path.join(ambientDirectory, 'npm'), '#!/bin/sh\n', {
      mode: 0o700,
    });
    process.env.PATH = `${ambientDirectory}${path.delimiter}${originalPath}`;

    await expect(
      resolveProcessRuntimeAccess({ execPath: path.join(binDirectory, 'node') })
    ).rejects.toMatchObject({ code: 'RUNTIME_COMMAND_UNAVAILABLE' });
  });

  test('rejects an inaccessible process executable', async () => {
    const { fixture } = await createRuntimePrefix([]);

    await expect(
      resolveProcessRuntimeAccess({ execPath: path.join(fixture, 'missing', 'bin', 'node') })
    ).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
  });

  test('reports no sandbox path for commands that resolve to the system toolchain', () => {
    const request = {
      commands: [{ name: 'node', status: 'available' }],
      runtimeRoots: [],
    };

    expect(approvedCommandPath(request, 'node')).toBeNull();
  });
});
