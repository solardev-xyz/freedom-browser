'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { resolveMacosSupervisor } = require('./macos-supervisor-runtime');
const { resolveWindowsSandbox } = require('./windows-sandbox-runtime');
const { runWindowsSandbox } = require('./windows-sandbox-process');
const os = require('node:os');
const path = require('node:path');

async function checkedWorkspaceRoot(root, expected) {
  const before = await fs.promises.lstat(root);
  const canonical = await fs.promises.realpath(root);
  const actual = await fs.promises.stat(canonical);
  const after = await fs.promises.lstat(root);
  const matches = entry => entry.isDirectory() && !entry.isSymbolicLink() &&
    String(entry.dev) === String(before.dev) && String(entry.ino) === String(before.ino);
  if (!matches(before) || !matches(actual) || !matches(after) ||
      expected && (String(before.dev) !== String(expected.dev) || String(before.ino) !== String(expected.ino) ||
        expected.root && canonical !== expected.root)) {
    throw Object.assign(new Error('The authorized workspace root changed'), { code: 'WORKSPACE_ROOT_CHANGED' });
  }
  return Object.freeze({ root: canonical, dev: String(before.dev), ino: String(before.ino) });
}

// Ask the kernel about the already-open object. Rechecking a pathname is not
// sufficient: a writer can swap an intermediate directory between checks.
async function openedFilePath(handle) {
  if (process.platform === 'linux') return fs.promises.readlink(`/proc/self/fd/${handle.fd}`);
  if (process.platform !== 'darwin') throw new Error('Opened file identity is unavailable');
  const runtime = await resolveMacosSupervisor();
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executablePath, ['--file-path'], {
      stdio: ['ignore', 'pipe', 'ignore', handle.fd], env: {}, timeout: 5000,
    });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 4096) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', code => code === 0 && size > 0 && size <= 4096
      ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('Opened file identity is unavailable')));
  });
}

// `options` reaches resolveWindowsSandbox (e.g. an installed build's helper
// directory for scripts/qualify-windows-workspace.js --runtime).
async function readWindowsWorkspaceFile(root, relative, maximum, options = {}) {
  const runtime = await resolveWindowsSandbox(options);
  const result = await runWindowsSandbox(runtime, { version: 1, operation: 'read-file', backend: 'elevated',
    home: path.join(process.env.LOCALAPPDATA || os.homedir(), 'FreedomBrowser', 'Sandbox'),
    workspace: root, readPath: relative, maxReadBytes: maximum },
  { stdoutBytes: Math.ceil(maximum * 4 / 3) + 4, stderrBytes: 0, timeoutMs: 15000 });
  if (result.terminal?.exitCode !== 0 || result.stdoutTruncated || result.failure) throw new Error('The workspace file could not be read safely');
  return Buffer.from(result.stdout, 'base64');
}

module.exports = { openedFilePath, readWindowsWorkspaceFile, checkedWorkspaceRoot };
