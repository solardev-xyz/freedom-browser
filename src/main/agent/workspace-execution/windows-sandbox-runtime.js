'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { insidePath } = require('./execution-policy');

const REVISION = '092d3acd6bec3e3a14bdc7e7a2810ab628ab759d';
const BINARIES = ['freedom-windows-workspace.exe', 'freedom-windows-sandbox-setup.exe', 'freedom-workspace-runner.exe'];

async function resolveWindowsSandbox(options = {}) {
  const arch = options.arch || process.arch;
  const packaged = options.packaged ?? __dirname.split(path.sep).includes('app.asar');
  const directory = await fs.promises.realpath(options.directory || (packaged
    ? path.join(options.resourcesPath || process.resourcesPath, 'windows-workspace')
    : path.resolve(__dirname, '../../../../out/windows-workspace', arch)));
  const manifestPath = path.join(directory, 'manifest.json');
  if ((await fs.promises.stat(manifestPath)).size > 8192) throw new Error('Invalid Windows sandbox manifest');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.backend !== 'elevated' || manifest.revision !== REVISION || manifest.arch !== arch) {
    throw new Error('Windows sandbox helper is incompatible; rebuild it');
  }
  for (const name of BINARIES) {
    const filename = path.join(directory, name);
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > 128 * 1024 * 1024) throw new Error('Invalid Windows sandbox binary');
    const bytes = await fs.promises.readFile(filename);
    const offset = bytes.readUInt32LE(60);
    if (bytes.toString('ascii', 0, 2) !== 'MZ' || offset > bytes.length - 6 ||
        bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== ({ x64: 0x8664, arm64: 0xaa64 }[arch]) ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.binaries?.[name]) {
      throw new Error('Windows sandbox binary does not match its manifest');
    }
  }
  return Object.freeze({ directory, executablePath: path.join(directory, BINARIES[0]), backend: 'elevated', revision: REVISION });
}

function assertWindowsRuntimeOutsideWrites(runtime, home, writableRoots) {
  for (const root of writableRoots) {
    if (insidePath(root, runtime.directory) || insidePath(root, home)) {
      throw new Error('Windows sandbox helpers and setup state must be outside writable project storage');
    }
  }
}

module.exports = { resolveWindowsSandbox, assertWindowsRuntimeOutsideWrites };
