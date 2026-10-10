'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { insidePath, ExecutionPolicyError } = require('./execution-policy');
const { SUPERVISOR_PROTOCOL } = require('./macos-supervisor-process');

const SUPERVISOR_NAME = 'freedom-workspace-supervisor';
const SOURCE_PATH = path.join(__dirname, 'native', 'macos-supervisor.c');
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const MINIMUM_MACOS = '12.0';

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validMachExecutable(bytes, architecture) {
  const cpu = { arm64: 0x0100000c, x64: 0x01000007 }[architecture];
  if (!cpu || bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== cpu || bytes.readUInt32LE(12) !== 2) return false;
  const count = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  if (count > 128 || commandBytes > bytes.length - 32) return false;
  let offset = 32;
  let minimum = null;
  for (let i = 0; i < count; i += 1) {
    if (offset + 8 > 32 + commandBytes) return false;
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > 32 + commandBytes) return false;
    if (command === 0x32) {
      if (size < 24 || bytes.readUInt32LE(offset + 8) !== 1 || minimum !== null) return false;
      minimum = bytes.readUInt32LE(offset + 12);
    } else if (command === 0x24) {
      if (size < 16 || minimum !== null) return false;
      minimum = bytes.readUInt32LE(offset + 8);
    }
    offset += size;
  }
  return offset === 32 + commandBytes && minimum === 0x000c0000;
}

async function readRegular(filePath, maximum, executable = false) {
  const stats = await fs.promises.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximum ||
      (executable && !(stats.mode & 0o111))) throw new Error('Invalid supervisor artifact');
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.length !== stats.size || bytes.length > maximum) throw new Error('Supervisor artifact changed');
  return bytes;
}

async function resolveMacosSupervisor(options = {}) {
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const majorRelease = Number((options.release || os.release()).split('.')[0]);
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(architecture) ||
      !Number.isInteger(majorRelease) || majorRelease < 21) {
    throw new Error('Native workspace supervision requires macOS 12 or later on arm64 or x64');
  }
  // Source is shipped in src alongside main. An asar layout must never fall back
  // to a development artifact if its packaged helper is absent.
  const packaged = options.packaged ?? SOURCE_PATH.split(path.sep).includes('app.asar');
  const directory = packaged
    ? path.join(options.resourcesPath || process.resourcesPath || '', 'workspace-supervisor')
    : path.resolve(__dirname, '../../../../out/macos-supervisor', architecture);
  if (!path.isAbsolute(directory)) throw new Error('Invalid supervisor resource location');
  const executablePath = path.join(await fs.promises.realpath(directory), SUPERVISOR_NAME);
  const manifestPath = path.join(path.dirname(executablePath), 'manifest.json');
  const [binary, manifestBytes, source] = await Promise.all([
    readRegular(executablePath, MAX_BINARY_BYTES, true),
    readRegular(manifestPath, 4096),
    readRegular(SOURCE_PATH, 256 * 1024),
  ]);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.protocol !== SUPERVISOR_PROTOCOL || manifest.architecture !== architecture ||
      manifest.minimumMacos !== MINIMUM_MACOS || manifest.sourceSha256 !== digest(source) ||
      manifest.binarySha256 !== digest(binary) || !validMachExecutable(binary, architecture)) {
    throw new Error('Native workspace supervisor is missing, incompatible or stale; rebuild it');
  }
  return Object.freeze({ executablePath, sourceSha256: manifest.sourceSha256,
    binarySha256: manifest.binarySha256, protocol: SUPERVISOR_PROTOCOL, architecture });
}

function assertSupervisorOutsideWritableRoots(runtime, policy, privateDirectory) {
  if (!runtime || !path.isAbsolute(runtime.executablePath)) throw new Error('Invalid native supervisor');
  for (const root of [...policy.filesystem.writableRoots.map((entry) => entry.sourcePath), privateDirectory]) {
    if (insidePath(root, runtime.executablePath)) {
      throw new ExecutionPolicyError('WORKSPACE_SUPERVISOR_INSIDE_WRITABLE_ROOT',
        'Native supervisor must be outside workspace-writable storage; use a separate project workspace');
    }
  }
}

module.exports = {
  MINIMUM_MACOS, SOURCE_PATH, SUPERVISOR_NAME, MAX_BINARY_BYTES,
  validMachExecutable, resolveMacosSupervisor, assertSupervisorOutsideWritableRoots,
};
