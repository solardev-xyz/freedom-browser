'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { insidePath } = require('./execution-policy');

const SOURCE_PATH = path.join(__dirname, 'native/linux-supervisor.c');
const SUPERVISOR_NAME = 'freedom-linux-workspace-owner';
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function validElf(bytes) {
  return bytes.length >= 64 && bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
    [2, 3].includes(bytes.readUInt16LE(16)) && bytes.readUInt16LE(18) === 62;
}
function supported(platform, architecture, release) {
  const [major, minor] = release.split('.').map(Number);
  return platform === 'linux' && architecture === 'x64' &&
    (major > 5 || (major === 5 && minor >= 9));
}
async function resolveLinuxSupervisor(options = {}) {
  if (!supported(options.platform || process.platform, options.architecture || process.arch,
    options.release || os.release())) throw new Error('LINUX_OWNER_FACILITIES_REQUIRED');
  const packaged = options.packaged ?? SOURCE_PATH.split(path.sep).includes('app.asar');
  const directory = packaged
    ? path.join(options.resourcesPath || process.resourcesPath || '', 'linux-workspace-owner')
    : path.resolve(__dirname, '../../../../out/linux-workspace-owner/x64');
  const executablePath = path.join(await fs.promises.realpath(directory), SUPERVISOR_NAME);
  // Open, hash and execute the SAME inode via inherited fd5, not a reopened path.
  const handle = await fs.promises.open(executablePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o6022) ||
        stat.size < 64 || stat.size > 8 * 1024 * 1024) throw new Error('LINUX_OWNER_INVALID');
    const binary = await handle.readFile();
    const manifestPath = path.join(path.dirname(executablePath), 'manifest.json');
    const meta = await fs.promises.lstat(manifestPath);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 4096 || (meta.mode & 0o022))
      throw new Error('LINUX_OWNER_INVALID_MANIFEST');
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const source = await fs.promises.readFile(SOURCE_PATH);
    if (!validElf(binary) || binary.length !== stat.size || manifest.protocol !== 1 ||
        manifest.architecture !== 'x64' || manifest.minimumKernel !== '5.9' ||
        manifest.sourceSha256 !== digest(source) || manifest.binarySha256 !== digest(binary))
      throw new Error('LINUX_OWNER_STALE');
    return { executablePath, fd: handle.fd, sourceSha256: manifest.sourceSha256,
      binarySha256: manifest.binarySha256, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}
function assertOutsideWritableRoots(runtime, policy, privateDirectory) {
  const roots = [...policy.filesystem.writableRoots.map((root) => root.sourcePath), privateDirectory];
  if (!path.isAbsolute(runtime.executablePath) || roots.some((root) => insidePath(root, runtime.executablePath)))
    throw new Error('LINUX_OWNER_INSIDE_WRITABLE_ROOT');
}
module.exports = { SOURCE_PATH, SUPERVISOR_NAME, digest, validElf, supported,
  resolveLinuxSupervisor, assertOutsideWritableRoots };
