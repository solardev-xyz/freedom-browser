'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { resolveMacosSupervisor } = require('./macos-supervisor-runtime');
const { resolveWindowsSandbox } = require('./windows-sandbox-runtime');
const { runWindowsSandbox } = require('./windows-sandbox-process');
const os = require('node:os');
const path = require('node:path');

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

async function readWindowsWorkspaceFile(root, relative, maximum) {
  const runtime = await resolveWindowsSandbox();
  const result = await runWindowsSandbox(runtime, { version: 1, operation: 'read-file', backend: 'elevated',
    home: path.join(process.env.LOCALAPPDATA || os.homedir(), 'FreedomBrowser', 'Sandbox'),
    workspace: root, readPath: relative, maxReadBytes: maximum },
  { stdoutBytes: Math.ceil(maximum * 4 / 3) + 4, stderrBytes: 0, timeoutMs: 15000 });
  if (result.terminal?.exitCode !== 0 || result.stdoutTruncated || result.failure) throw new Error('The workspace file could not be read safely');
  return Buffer.from(result.stdout, 'base64');
}

module.exports = { openedFilePath, readWindowsWorkspaceFile };
