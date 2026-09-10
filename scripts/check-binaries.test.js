jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');
const { checkBinaries, ensureOptionalArti } = require('./check-binaries');
const { platformKey } = require('./fetch-radicle-addon');

describe('Radicle build inputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['mac', 'arm64'],
    ['linux', 'x64'],
    ['win', 'x64'],
    ['win', 'arm64'],
  ])('requires the embedded addon for %s-%s', (os, arch) => {
    fs.existsSync.mockImplementation((target) => !target.endsWith('libradicle.node'));

    expect(checkBinaries([{ os, arch }])).toEqual([
      expect.stringContaining(`libradicle embedded addon for ${os}-${arch}`),
    ]);
  });

  test('the standard download installs the addon only', () => {
    expect(packageJson.scripts['radicle:download']).toBe('node scripts/fetch-radicle-addon.js');
    expect(packageJson.scripts['radicle:download-addon']).toBeUndefined();
  });

  test.each(['mac', 'linux', 'win'])('packages only the embedded addon on %s', (target) => {
    const resource = packageJson.build[target].extraResources.find(
      ({ to }) => to === 'radicle-bin'
    );

    expect(resource).toMatchObject({
      from: 'radicle-bin/${os}-${arch}/',
      filter: ['libradicle.node'],
    });
  });

  test('can download the Windows x64 addon while cross-building from macOS', () => {
    expect(platformKey(['--win', '--x64'], 'darwin', 'arm64')).toBe('win-x64');
  });

  test('defaults Windows downloads to the published x64 artifact', () => {
    expect(platformKey(['--win'], 'darwin', 'arm64')).toBe('win-x64');
    expect(platformKey([], 'win32', 'x64')).toBe('win-x64');
  });

  test('selects the native Windows ARM64 addon', () => {
    expect(platformKey(['--win', '--arm64'], 'darwin', 'arm64')).toBe('win-arm64');
    expect(platformKey([], 'win32', 'arm64')).toBe('win-arm64');
  });
});


describe('Myotis supervisor build inputs', () => {
  test.each([['mac', 'arm64'], ['linux', 'x64'], ['win', 'x64']])(
    'requires a source-built helper on %s-%s', (os, arch) => {
      fs.existsSync.mockImplementation((target) => !target.includes('myotis-supervisor'));
      expect(checkBinaries([{ os, arch }])).toEqual([
        expect.stringContaining(`myotis supervisor for ${os}-${arch}`),
      ]);
    }
  );
  test('packages both helper names and only adds the mac helper to explicit signing', () => {
    const resource = packageJson.build.extraResources.find(({ to }) => to === 'myotis-node');
    expect(resource.filter).toEqual(['myotis-node.node', 'myotis-supervisor', 'myotis-supervisor.exe']);
    expect(packageJson.build.mac.binaries).toEqual(['Contents/Resources/myotis-node/myotis-supervisor']);
  });
});

// Arti is optional everywhere (it is compiled, not downloaded), but every
// target we ship packages it the same way — including Windows since #337.
describe('Arti (Tor) build inputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(['mac', 'linux', 'win'])('packages the built binary on %s', (target) => {
    const resource = packageJson.build[target].extraResources.find(({ to }) => to === 'arti-bin');

    expect(resource).toMatchObject({
      from: 'arti-bin/${os}-${arch}/',
      filter: ['**/*'],
    });
  });

  test('never blocks a build when the binary is missing', () => {
    fs.existsSync.mockReturnValue(false);

    expect(checkBinaries([{ os: 'win', arch: 'x64' }])).not.toContainEqual(
      expect.stringContaining('arti')
    );
  });

  // electron-builder resolves `from` before it copies, so the per-platform
  // directory has to exist even for a build that bundles no Tor. Windows was
  // skipped here while it shipped no Arti at all.
  test.each([
    ['mac', 'arm64', 'arti'],
    ['linux', 'x64', 'arti'],
    ['win', 'x64', 'arti.exe'],
  ])('creates the %s-%s resource dir and looks for %s', (os, arch, binName) => {
    fs.existsSync.mockReturnValue(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    ensureOptionalArti([{ os, arch }]);

    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining(`${os}-${arch}`));
    const probed = fs.existsSync.mock.calls.flat();
    // ensureOptionalArti builds the probe with path.join, so the separator is
    // the *host's* — `\` on a Windows contributor's machine. Join the expected
    // tail the same way rather than hard-coding `/`, the way
    // tor-manager.test.js already does with path.sep.
    const expectedTail = path.join(`${os}-${arch}`, binName);
    expect(probed.some((target) => target.endsWith(expectedTail))).toBe(true);
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining(`${os}-${arch}`), {
      recursive: true,
    });
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test('leaves an already built binary alone', () => {
    fs.existsSync.mockReturnValue(true);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    ensureOptionalArti([{ os: 'win', arch: 'x64' }]);

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
