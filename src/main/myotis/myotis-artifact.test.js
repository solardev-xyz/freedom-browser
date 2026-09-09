// Descriptor/provenance tests use tiny in-memory data; no native addon is loaded.
jest.mock('fs', () => ({ openSync: jest.fn(), fstatSync: jest.fn(), readSync: jest.fn(), closeSync: jest.fn(),
  constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 } }));
jest.mock('../../../config/myotis-integration.json', () => ({
  schema: 1, sourceCommit: '02a183d86474a263cf8e85e5c2c2399672645535',
  cargoLockSha256: 'lock', abi: 25, artifacts: { 'linux-x64': {
    sha256: require('crypto').createHash('sha256').update('data').digest('hex'), sizeBytes: 4, profile: 'debug',
  } },
}));
const fs = require('fs');
const { verifyArtifact, readPinnedBytes, expectedArtifact } = require('./myotis-artifact');
let files;
beforeEach(() => {
  jest.clearAllMocks();
  files = [Buffer.from('data'), Buffer.from(JSON.stringify(expectedArtifact('linux-x64')))];
  fs.openSync.mockImplementation((file) => file.endsWith('.json') ? 1 : 0);
  fs.fstatSync.mockImplementation((fd) => ({ isFile: () => true, size: files[fd].length, mtimeMs: 10 }));
  fs.readSync.mockImplementation((fd, buffer, offset, count, position) => files[fd].copy(buffer, offset, position, position + count));
});

test('checks exact source/lock/target/ABI/hash and reads one opened addon descriptor in bounded chunks', () => {
  expect(verifyArtifact('/owned/myotis-node.node', 'linux-x64')).toEqual(expectedArtifact('linux-x64'));
  expect(fs.openSync).toHaveBeenCalledWith('/owned/myotis-node.node', 3);
  expect(fs.closeSync).toHaveBeenCalledTimes(2);
  expect(fs.readSync.mock.calls.every(([, buffer]) => buffer.length <= 65536)).toBe(true);
});

test.each(['sourceCommit', 'cargoLockSha256', 'target', 'abi', 'sha256', 'sizeBytes'])('rejects stale manifest %s before reading addon bytes', (field) => {
  const manifest = expectedArtifact('linux-x64'); manifest[field] = 'wrong';
  files[1] = Buffer.from(JSON.stringify(manifest));
  expect(() => verifyArtifact('/owned/myotis-node.node', 'linux-x64')).toThrow('provenance');
  expect(fs.openSync).toHaveBeenCalledTimes(1);
});

test('rejects wrong bytes, sizes, nonregular descriptors and unconfigured targets without giant allocations', () => {
  files[0] = Buffer.from('evil');
  expect(() => readPinnedBytes('/owned/myotis-node.node', 'linux-x64')).toThrow('hash');
  fs.readSync.mockClear();
  fs.fstatSync.mockReturnValue({ isFile: () => true, size: 2 ** 31 });
  expect(() => readPinnedBytes('/owned/myotis-node.node', 'linux-x64')).toThrow('size');
  expect(fs.readSync).not.toHaveBeenCalled();
  fs.fstatSync.mockReturnValue({ isFile: () => false, size: 4 });
  expect(() => readPinnedBytes('/owned/myotis-node.node', 'linux-x64')).toThrow('file type');
  expect(() => readPinnedBytes('/owned/myotis-node.node', 'win32-x64')).toThrow('unconfigured');
});

test('fails closed on truncation or modification while reading the same descriptor', () => {
  fs.readSync.mockReturnValue(0);
  expect(() => readPinnedBytes('/owned/myotis-node.node', 'linux-x64')).toThrow('Truncated');
  expect(fs.closeSync).toHaveBeenCalledWith(0);
});
