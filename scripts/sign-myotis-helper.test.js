const fs = require('fs');
const path = require('path');
const plist = require('plist');

jest.mock('app-builder-lib/out/codeSign/macCodeSign', () => ({ sign: jest.fn(async () => {}) }));
const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');
const signMyotisHelper = require('./sign-myotis-helper');

test('restricts only the Myotis supervisor and preserves all other signing options', async () => {
  const app = '/packaged/Freedom.app';
  const original = {
    entitlements: 'config/entitlements.mac.plist', hardenedRuntime: true,
    timestamp: 'timestamp-server', requirements: 'designated requirement', additionalArguments: [],
  };
  const options = {
    app, identity: 'test-identity', keychain: 'test-keychain', platform: 'darwin',
    binaries: ['Contents/Resources/myotis-node/myotis-supervisor'],
    optionsForFile: jest.fn(() => original),
  };
  await signMyotisHelper(options);
  const forwarded = sign.mock.calls[0][0];
  expect(forwarded).toEqual({ ...options, optionsForFile: expect.any(Function) });
  const helperOptions = forwarded.optionsForFile(`${app}/Contents/Resources/myotis-node/myotis-supervisor`);
  expect(helperOptions).toEqual({
    ...original,
    entitlements: path.resolve(__dirname, '../config/entitlements.myotis-supervisor.plist'),
    hardenedRuntime: true,
  });
  expect(plist.parse(fs.readFileSync(helperOptions.entitlements, 'utf8'))).toEqual({});
  for (const file of [app, `${app}/Contents/MacOS/Freedom`,
    `${app}/Contents/Frameworks/Freedom Helper.app`,
    `${app}/Contents/Resources/myotis-node/myotis_node.node`,
    `${app}/Contents/Resources/other/myotis-supervisor`]) {
    expect(forwarded.optionsForFile(file)).toBe(original);
  }
  expect(original.entitlements).toBe('config/entitlements.mac.plist');
  expect(require('../package.json').build.mac.entitlementsInherit).toBe('config/entitlements.mac.plist');
  expect(require('../package.json').build.mac.sign).toBe('./scripts/sign-native-supervisors.js');
});

test('signs the bundled Whisper CLI with its own empty entitlements, not the inherited app set', async () => {
  sign.mockClear();
  const app = '/packaged/Freedom.app';
  const original = { entitlements: 'config/entitlements.mac.plist', hardenedRuntime: true, timestamp: 'timestamp-server' };
  await signMyotisHelper({ app, optionsForFile: () => original });
  const { optionsForFile } = sign.mock.calls[0][0];
  const whisper = optionsForFile(`${app}/Contents/Resources/dictation-runtime/whisper-cli`);
  expect(whisper).toEqual({ ...original, hardenedRuntime: true,
    entitlements: path.resolve(__dirname, '../config/entitlements.dictation-runtime.plist') });
  expect(plist.parse(fs.readFileSync(whisper.entitlements, 'utf8'))).toEqual({});
  // Libraries beside it and look-alike paths keep electron-builder's options.
  for (const file of [`${app}/Contents/Resources/dictation-runtime/libggml-cpu-haswell.so`,
    `${app}/Contents/Resources/dictation-runtime/libwhisper.dylib`, `${app}/Contents/Resources/other/whisper-cli`])
    expect(optionsForFile(file)).toBe(original);
  expect(require('../package.json').build.mac.binaries).toContain('Contents/Resources/dictation-runtime/whisper-cli');
});
