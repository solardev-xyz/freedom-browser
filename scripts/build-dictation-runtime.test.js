const fs = require('fs');
const path = require('path');
const os = require('os');
const { configureArguments } = require('./build-dictation-runtime');

test.each(['darwin', 'win32', 'linux'])('%s CLI builds disable networking and use portable runtime CPU dispatch', platform => {
  const args = configureArguments('/source with spaces', '/build', platform, 'x64');
  for (const flag of ['WHISPER_CURL', 'WHISPER_BUILD_SERVER', 'GGML_NATIVE', 'GGML_AVX2'])
    expect(args).toContain(`-D${flag}=OFF`);
  expect(args).toContain('/source with spaces');
  expect(args).toContain('-DGGML_CPU_ALL_VARIANTS=ON');
  expect(args).toContain('-DGGML_BACKEND_DL=ON');
  if (platform === 'win32') expect(args).toContain('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
  if (platform === 'darwin') expect(args).toContain('-DCMAKE_OSX_ARCHITECTURES=x86_64');
});

test('packaging includes the CLI outside asar and runs its build before packing', () => {
  const pkg = require('../package.json');
  expect(pkg.build.extraResources).toContainEqual({ from: 'out/dictation-runtime/${os}-${arch}/', to: 'dictation-runtime',
    filter: ['whisper-cli', 'whisper-cli.exe', '*.dll', '*.dylib', '*.so*', 'manifest.json', 'NOTICES.txt'] });
  expect(pkg.build.mac.binaries).toContain('Contents/Resources/dictation-runtime/whisper-cli');
  expect(pkg.build.beforePack).toBe('./scripts/prepare-native-supervisors.js');
});

test('ARM64 keeps the single CPU backend without shared dispatch libraries', () => {
  const args = configureArguments('/source', '/build', 'darwin', 'arm64');
  expect(args).toContain('-DGGML_BACKEND_DL=OFF');
  expect(args).toContain('-DBUILD_SHARED_LIBS=OFF');
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
