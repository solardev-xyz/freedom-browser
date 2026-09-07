'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {
  SOURCE_PATH, SUPERVISOR_NAME, validMachExecutable, resolveMacosSupervisor,
  assertSupervisorOutsideWritableRoots,
} = require('./macos-supervisor-runtime');

function executable(architecture = 'arm64', minimum = 0x000c0000) {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(1, 40); bytes.writeUInt32LE(minimum, 44);
  return bytes;
}

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('fixed native supervisor artifact validation', () => {
  afterEach(() => jest.restoreAllMocks());

  function files({ binary = executable(), manifest = {}, source = Buffer.from('reviewed source'), symlink = false } = {}) {
    const values = new Map([
      ['/trusted/artifacts/' + SUPERVISOR_NAME, binary],
      ['/trusted/artifacts/manifest.json', Buffer.from(JSON.stringify({ protocol: 1,
        architecture: 'arm64', minimumMacos: '12.0', sourceSha256: hash(source),
        binarySha256: hash(binary), ...manifest }))],
      [SOURCE_PATH, source],
    ]);
    jest.spyOn(fs.promises, 'realpath').mockResolvedValue('/trusted/artifacts');
    jest.spyOn(fs.promises, 'lstat').mockImplementation(async (file) => ({
      isFile: () => true, isSymbolicLink: () => symlink, size: values.get(file)?.length, mode: 0o755,
    }));
    jest.spyOn(fs.promises, 'readFile').mockImplementation(async (file) => {
      if (!values.has(file)) throw new Error('missing');
      return values.get(file);
    });
  }

  test('resolves only a matching regular executable and source/build manifest', async () => {
    files();
    const result = await resolveMacosSupervisor({ platform: 'darwin', architecture: 'arm64', release: '24.6.0' });
    expect(result).toMatchObject({ executablePath: '/trusted/artifacts/' + SUPERVISOR_NAME, protocol: 1 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test.each([
    ['architecture', { binary: executable('x64') }],
    ['newer deployment target', { binary: executable('arm64', 0x000f0000) }],
    ['binary hash', { manifest: { binarySha256: 'wrong' } }],
    ['source version', { manifest: { sourceSha256: 'wrong' } }],
    ['protocol version', { manifest: { protocol: 2 } }],
    ['symlink', { symlink: true }],
  ])('rejects %s skew without launching an executable', async (_name, options) => {
    files(options);
    await expect(resolveMacosSupervisor({ platform: 'darwin', architecture: 'arm64', release: '24.6.0' })).rejects.toThrow();
  });

  test('a missing packaged artifact cannot fall back to development output', async () => {
    const realpath = jest.spyOn(fs.promises, 'realpath').mockRejectedValue(new Error('missing'));
    await expect(resolveMacosSupervisor({ platform: 'darwin', architecture: 'arm64', release: '24.6.0',
      packaged: true, resourcesPath: '/Applications/Freedom.app/Contents/Resources' })).rejects.toThrow('missing');
    expect(realpath.mock.calls).toEqual([['/Applications/Freedom.app/Contents/Resources/workspace-supervisor']]);
  });

  test('rejects unsupported platforms and malformed Mach-O command bounds', async () => {
    await expect(resolveMacosSupervisor({ platform: 'linux' })).rejects.toThrow('requires macOS');
    await expect(resolveMacosSupervisor({ platform: 'darwin', architecture: 'arm64', release: '20.0' })).rejects.toThrow('requires macOS');
    const bytes = executable(); bytes.writeUInt32LE(4096, 36);
    expect(validMachExecutable(bytes, 'arm64')).toBe(false);
    expect(validMachExecutable(Buffer.alloc(4), 'arm64')).toBe(false);
  });

  test('rejects a helper replaceable through any writable ancestor', () => {
    const policy = { filesystem: { writableRoots: [{ sourcePath: '/workspace' }] } };
    expect(() => assertSupervisorOutsideWritableRoots({ executablePath: '/workspace/tools/helper' }, policy, '/private/execution'))
      .toThrow(expect.objectContaining({ code: 'WORKSPACE_SUPERVISOR_INSIDE_WRITABLE_ROOT' }));
    expect(() => assertSupervisorOutsideWritableRoots({ executablePath: '/private/execution/helper' }, policy, '/private/execution')).toThrow();
    expect(() => assertSupervisorOutsideWritableRoots({ executablePath: '/workspace-other/helper' }, policy, '/private/execution')).not.toThrow();
  });
});
