jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

const fs = require('fs');
const packageJson = require('../package.json');
const { checkBinaries } = require('./check-binaries');
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
