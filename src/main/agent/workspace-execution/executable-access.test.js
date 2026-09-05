'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  executableCommandEntries,
  mergeExecutableRoots,
  isValidatedExecutableAccessRequest,
  isValidatedExecutableRoot,
  resolveExecutableAccess,
  validateExecutableNames,
} = require('./executable-access');

describe('approved executable access', () => {
  const fixtureRoots = [];

  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
    );
  });

  test('resolves a host PATH command to one narrow attested package root', async () => {
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-executable-'));
    fixtureRoots.push(fixture);
    const packageRoot = path.join(fixture, 'runtime');
    const binaryDirectory = path.join(packageRoot, 'bin');
    const executablePath = path.join(binaryDirectory, 'tool');
    await fs.promises.mkdir(binaryDirectory, { recursive: true });
    await fs.promises.writeFile(executablePath, '#!/bin/sh\n', { mode: 0o700 });

    const request = await resolveExecutableAccess(['tool', 'tool'], {
      platform: 'linux',
      hostEnvironment: { PATH: binaryDirectory },
    });
    const canonicalPackageRoot = await fs.promises.realpath(packageRoot);
    const canonicalExecutablePath = await fs.promises.realpath(executablePath);

    expect(request.commands).toEqual([
      {
        name: 'tool',
        status: 'requires_permission',
        executablePath: canonicalExecutablePath,
        rootPath: canonicalPackageRoot,
      },
    ]);
    expect(request.runtimeRoots).toEqual([
      expect.objectContaining({
        sourcePath: canonicalPackageRoot,
        access: 'read_execute',
        pathEntries: ['bin'],
        executablePaths: [canonicalExecutablePath],
        commands: ['tool'],
      }),
    ]);
    expect(isValidatedExecutableAccessRequest(request)).toBe(true);
    expect(isValidatedExecutableRoot(request.runtimeRoots[0])).toBe(true);
    expect(isValidatedExecutableAccessRequest(JSON.parse(JSON.stringify(request)))).toBe(false);
    expect(isValidatedExecutableRoot({ ...request.runtimeRoots[0] })).toBe(false);
  });

  test('reports unavailable commands without inventing a grant', async () => {
    const request = await resolveExecutableAccess(['definitely-not-installed'], {
      platform: 'darwin',
      hostEnvironment: { PATH: '/nonexistent' },
    });

    expect(request.commands).toEqual([{ name: 'definitely-not-installed', status: 'unavailable' }]);
    expect(request.runtimeRoots).toEqual([]);
  });

  test.each([['tool', 'runtime'], ['runtime', 'tool']])(
    'preserves symlinked command targets with %s requested before %s',
    async (first, second) => {
      const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-executable-'));
      fixtureRoots.push(fixture);
      const bin = path.join(fixture, 'runtime', 'bin');
      const packageBin = path.join(fixture, 'runtime', 'lib', 'package', 'bin');
      await fs.promises.mkdir(bin, { recursive: true });
      await fs.promises.mkdir(packageBin, { recursive: true });
      await fs.promises.writeFile(path.join(bin, 'runtime'), '#!/bin/sh\n', { mode: 0o700 });
      await fs.promises.writeFile(path.join(packageBin, 'cli.js'), '#!/bin/sh\nprintf correct', { mode: 0o700 });
      await fs.promises.writeFile(path.join(packageBin, 'tool'), '#!/bin/sh\nprintf wrong', { mode: 0o700 });
      await fs.promises.symlink('../lib/package/bin/cli.js', path.join(bin, 'tool'));
      const request = await resolveExecutableAccess([first, second], { hostEnvironment: { PATH: bin } });
      const target = await fs.promises.realpath(path.join(packageBin, 'cli.js'));
      const entries = executableCommandEntries(request.runtimeRoots, 'darwin');
      expect(entries.find((entry) => entry.name === 'tool').executablePath).toBe(target);
      const root = request.runtimeRoots.find((entry) => entry.commands.includes('tool'));
      expect(executableCommandEntries(request.runtimeRoots, 'linux')).toContainEqual({
        name: 'tool', executablePath: `${root.mountPath}/bin/cli.js`,
      });
      expect(Object.isFrozen(root.commandEntries)).toBe(true);
      expect(Object.isFrozen(root.commandEntries[0])).toBe(true);
      // A serialized descriptor cannot create a command mapping.
      expect(executableCommandEntries(JSON.parse(JSON.stringify(request.runtimeRoots)), 'darwin')).toEqual([]);
    }
  );

  test('rejects conflicting command targets and untrusted root merges', async () => {
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-executable-'));
    fixtureRoots.push(fixture);
    const roots = [];
    for (const name of ['first', 'second']) {
      const bin = path.join(fixture, name, 'bin');
      await fs.promises.mkdir(bin, { recursive: true });
      await fs.promises.writeFile(path.join(bin, 'tool'), '#!/bin/sh\n', { mode: 0o700 });
      const access = await resolveExecutableAccess(['tool'], { hostEnvironment: { PATH: bin } });
      roots.push(access.runtimeRoots[0]);
    }
    expect(() => executableCommandEntries(roots, 'linux')).toThrow(
      expect.objectContaining({ code: 'AMBIGUOUS_EXECUTABLE_COMMAND' })
    );
    expect(() => mergeExecutableRoots(roots[0], roots[1])).toThrow(
      expect.objectContaining({ code: 'INVALID_EXECUTABLE_ROOT' })
    );
    expect(() => mergeExecutableRoots(roots[0], { ...roots[0] })).toThrow(
      expect.objectContaining({ code: 'INVALID_EXECUTABLE_ROOT' })
    );
  });

  test('finds a baseline command even when the host PATH omits system directories', async () => {
    const request = await resolveExecutableAccess(['sh'], {
      hostEnvironment: { PATH: '/nonexistent' },
    });
    expect(request.commands).toEqual([{ name: 'sh', status: 'available' }]);
    expect(request.runtimeRoots).toEqual([]);
  });

  test('does not call an out-of-PATH alias available merely because it resolves to a system binary', async () => {
    const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-executable-'));
    fixtureRoots.push(fixture);
    await fs.promises.symlink('/bin/sh', path.join(fixture, 'freedom-shell-alias'));
    const request = await resolveExecutableAccess(['freedom-shell-alias'], {
      hostEnvironment: { PATH: fixture },
    });
    expect(request.commands).toEqual([{ name: 'freedom-shell-alias', status: 'unavailable' }]);
    expect(request.runtimeRoots).toEqual([]);
  });

  test('rejects paths and unbounded executable requests', () => {
    expect(() => validateExecutableNames(['../node'])).toThrow(
      expect.objectContaining({ code: 'INVALID_EXECUTABLE_REQUEST' })
    );
    expect(() => validateExecutableNames([])).toThrow(
      expect.objectContaining({ code: 'INVALID_EXECUTABLE_REQUEST' })
    );
  });
});
