'use strict';
jest.mock('fs', () => ({ constants: { O_RDONLY: 0, O_NOFOLLOW: 131072 }, promises: {
  realpath: jest.fn(), open: jest.fn(), lstat: jest.fn(), readFile: jest.fn(),
} }));
const fs = require('fs');
const { resolveLinuxSupervisor, assertOutsideWritableRoots, digest } = require('./linux-supervisor-runtime');
const binary = Buffer.alloc(64);
Buffer.from([127, 69, 76, 70, 2, 1]).copy(binary); binary.writeUInt16LE(3, 16); binary.writeUInt16LE(62, 18);
const source = Buffer.from('mock pinned source');
let handle, stat, manifest;
beforeEach(() => {
  jest.clearAllMocks();
  stat = { isFile: () => true, size: 64, mode: 0o100755 };
  manifest = { protocol: 1, architecture: 'x64', minimumKernel: '5.9', sourceSha256: digest(source), binarySha256: digest(binary) };
  handle = { fd: 55, stat: jest.fn(async () => stat), readFile: jest.fn(async () => binary), close: jest.fn(async () => {}) };
  fs.promises.realpath.mockResolvedValue('/immutable/canonical'); fs.promises.open.mockResolvedValue(handle);
  fs.promises.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 300, mode: 0o100644 });
  fs.promises.readFile.mockImplementation(async (p) => p.endsWith('manifest.json') ? JSON.stringify(manifest) : source);
});
test('hashes and retains the same nonsymlink executable inode with canonical location', async () => {
  const runtime = await resolveLinuxSupervisor({ platform: 'linux', architecture: 'x64', release: '6.8' });
  expect(runtime.fd).toBe(55); expect(runtime.executablePath).toBe('/immutable/canonical/freedom-linux-workspace-owner');
  expect(fs.promises.open).toHaveBeenCalledWith(runtime.executablePath, fs.constants.O_NOFOLLOW);
  expect(handle.close).not.toHaveBeenCalled(); await runtime.close(); expect(handle.close).toHaveBeenCalledTimes(1);
});
test.each(['mode', 'binary', 'source', 'architecture', 'manifest'])('rejects %s mismatch and closes original handle', async (problem) => {
  if (problem === 'mode') stat.mode = 0o104755;
  if (problem === 'binary') manifest.binarySha256 = '0'.repeat(64);
  if (problem === 'source') manifest.sourceSha256 = '0'.repeat(64);
  if (problem === 'architecture') manifest.architecture = 'arm64';
  if (problem === 'manifest') fs.promises.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => true });
  await expect(resolveLinuxSupervisor({ platform: 'linux', architecture: 'x64', release: '6.8' })).rejects.toThrow();
  expect(handle.close).toHaveBeenCalledTimes(1);
});
test('canonical helper location must be outside every payload-writable root', () => {
  const policy = { filesystem: { writableRoots: [{ sourcePath: '/workspace' }] } };
  expect(() => assertOutsideWritableRoots({ executablePath: '/workspace/out/owner' }, policy, '/private')).toThrow();
  expect(() => assertOutsideWritableRoots({ executablePath: '/private/owner' }, policy, '/private')).toThrow();
  expect(() => assertOutsideWritableRoots({ executablePath: '/immutable/owner' }, policy, '/private')).not.toThrow();
});
