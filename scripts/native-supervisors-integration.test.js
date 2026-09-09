// Pure orchestration checks: no compiler, codesign, native process or app runs.
jest.mock('electron-builder', () => ({ Arch: { 1: 'x64', 3: 'arm64' } }));
jest.mock('./build-macos-workspace-supervisor', () => ({
  default: jest.fn(), buildMacosWorkspaceSupervisor: jest.fn(),
}));
jest.mock('./build-myotis-supervisor', () => ({ buildSupervisor: jest.fn(), buildForTargets: jest.fn() }));
jest.mock('./sign-macos-workspace-supervisor', () => ({ createSupervisorSigner: jest.fn(({ sign }) => sign) }));
jest.mock('./sign-myotis-helper', () => jest.fn());
const workspace = require('./build-macos-workspace-supervisor');
const myotis = require('./build-myotis-supervisor');
const prepare = require('./prepare-native-supervisors');

afterEach(() => jest.clearAllMocks());

test('composes workspace manifest sealing with Myotis per-file signing', () => {
  const signer = require('./sign-native-supervisors');
  const inner = require('./sign-myotis-helper');
  expect(require('./sign-macos-workspace-supervisor').createSupervisorSigner).toHaveBeenCalledWith({ sign: inner });
  const options = { app: '/task/Freedom.app', identity: 'identity', ignore: () => false };
  signer(options);
  expect(inner).toHaveBeenCalledWith(options);
  const config = require('../package.json');
  expect(config.build.mac.sign).toBe('./scripts/sign-native-supervisors.js');
  expect(config.build.mac.binaries).toContain('Contents/Resources/myotis-node/myotis-supervisor');
  expect(config.build.mac.extraResources).toContainEqual(expect.objectContaining({
    to: 'workspace-supervisor', filter: ['freedom-workspace-supervisor', 'manifest.json'],
  }));
});

test.each(['arm64', 'x64'])('prepares both packaging helpers for macOS %s', async (arch) => {
  const context = { electronPlatformName: 'darwin', arch };
  await prepare.default(context);
  expect(workspace.default).toHaveBeenCalledWith(context);
  expect(myotis.buildForTargets).toHaveBeenCalledWith('mac', [arch]);
});

test('macOS development preserves workspace preparation alongside Myotis', () => {
  prepare.prepareDevelopment('darwin');
  expect(workspace.buildMacosWorkspaceSupervisor).toHaveBeenCalledTimes(1);
  expect(myotis.buildSupervisor).toHaveBeenCalledTimes(1);
  expect(require('../package.json').scripts.prestart).toBe('node scripts/prepare-native-supervisors.js');
  expect(require('../package.json').build.beforePack).toBe('./scripts/prepare-native-supervisors.js');
});


test.each(['linux', 'win32'])('%s prestart invokes neither native compiler', (platform) => {
  prepare.prepareDevelopment(platform);
  expect(workspace.buildMacosWorkspaceSupervisor).not.toHaveBeenCalled();
  expect(myotis.buildSupervisor).not.toHaveBeenCalled();
});
