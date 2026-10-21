const fs = require('fs');
const path = require('path');
const os = require('os');
const { configureArguments } = require('./build-dictation-runtime');

test.each(['darwin', 'win32', 'linux'])('%s CLI builds have no downloader, server, dynamic backends or runner-specific instructions', platform => {
  const args = configureArguments('/source with spaces', '/build', platform, 'x64');
  for (const flag of ['WHISPER_CURL', 'WHISPER_BUILD_SERVER', 'GGML_BACKEND_DL', 'GGML_NATIVE', 'BUILD_SHARED_LIBS', 'GGML_AVX2'])
    expect(args).toContain(`-D${flag}=OFF`);
  expect(args).toContain('/source with spaces');
  if (platform === 'win32') expect(args).toContain('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
  if (platform === 'darwin') expect(args).toContain('-DCMAKE_OSX_ARCHITECTURES=x86_64');
});

test('packaging includes the CLI outside asar and runs its build before packing', () => {
  const pkg = require('../package.json');
  expect(pkg.build.extraResources).toContainEqual({ from: 'out/dictation-runtime/${os}-${arch}/', to: 'dictation-runtime',
    filter: ['whisper-cli', 'whisper-cli.exe', 'manifest.json', 'NOTICES.txt'] });
  expect(pkg.build.mac.binaries).toContain('Contents/Resources/dictation-runtime/whisper-cli');
  expect(pkg.build.beforePack).toBe('./scripts/prepare-native-supervisors.js');
});

test('source checksum mismatch prevents extraction or compilation', async () => {
  jest.resetModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-build-test-'));
  const actualResolve = path.resolve;
  const resolve = jest.spyOn(path, 'resolve').mockImplementation((...args) =>
    args[1] === '../out/dictation-runtime' ? actualResolve(root, ...args.slice(2)) : actualResolve(...args));
  jest.doMock('./lib/fetch-with-retry', () => ({ downloadToFile: jest.fn(async (_url, destination) => fs.writeFileSync(destination, 'wrong source')) }));
  jest.doMock('child_process', () => ({ execFileSync: jest.fn() }));
  try {
    const { buildDictationRuntime } = require('./build-dictation-runtime');
    await expect(buildDictationRuntime()).rejects.toThrow('source checksum mismatch');
    expect(require('child_process').execFileSync).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root)).toEqual([]);
  } finally {
    resolve.mockRestore(); jest.dontMock('./lib/fetch-with-retry'); jest.dontMock('child_process');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
