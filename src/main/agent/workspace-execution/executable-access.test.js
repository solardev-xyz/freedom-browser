'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
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
