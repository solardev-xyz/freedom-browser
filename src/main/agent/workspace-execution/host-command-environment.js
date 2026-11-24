'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAPTURE_TIMEOUT_MS = 10_000;
const CAPTURE_MAX_BUFFER_BYTES = 128 * 1024;
const PATH_MARKER_START = '__FREEDOM_USER_PATH_BEGIN_7D3D3A0C__';
const PATH_MARKER_END = '__FREEDOM_USER_PATH_END_7D3D3A0C__';

function runLoginShell(shellPath, args, options = {}) {
  return new Promise((resolve) => {
    execFile(shellPath, args, options, (error, stdout) => {
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
        stdout: String(stdout || ''),
      });
    });
  });
}

function boundedPathEntries(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024 || value.includes('\0')) return [];
  const entries = [];
  const seen = new Set();
  for (const entry of value.split(path.delimiter)) {
    if (!path.isAbsolute(entry) || entry.includes('\0') || seen.has(entry)) continue;
    entries.push(entry);
    seen.add(entry);
    if (entries.length >= 128) break;
  }
  return entries;
}

function mergePaths(primary, fallback) {
  const entries = [];
  const seen = new Set();
  for (const entry of [...boundedPathEntries(primary), ...boundedPathEntries(fallback)]) {
    if (seen.has(entry)) continue;
    entries.push(entry);
    seen.add(entry);
  }
  return entries.join(path.delimiter);
}

async function canonicalLoginShell(configuredShell) {
  if (typeof configuredShell !== 'string' || !path.isAbsolute(configuredShell)) return null;
  try {
    const canonical = await fs.promises.realpath(configuredShell);
    const stats = await fs.promises.stat(canonical);
    if (!stats.isFile()) return null;
    await fs.promises.access(canonical, fs.constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function capturedPath(stdout) {
  if (typeof stdout !== 'string' || stdout.length > CAPTURE_MAX_BUFFER_BYTES) return null;
  const start = stdout.lastIndexOf(PATH_MARKER_START);
  if (start < 0) return null;
  const valueStart = start + PATH_MARKER_START.length;
  const end = stdout.indexOf(PATH_MARKER_END, valueStart);
  if (end < 0) return null;
  const value = stdout.slice(valueStart, end);
  return boundedPathEntries(value).length ? value : null;
}

async function captureHostCommandEnvironment(options = {}) {
  const inheritedEnvironment = options.environment || process.env;
  const inheritedPath =
    typeof inheritedEnvironment.PATH === 'string' ? inheritedEnvironment.PATH : '';
  const platform = options.platform || process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    return Object.freeze({ PATH: mergePaths('', inheritedPath), source: 'process' });
  }

  let user;
  try {
    user = options.userInfo || os.userInfo();
  } catch {
    user = null;
  }
  const shell = await canonicalLoginShell(
    options.shell || user?.shell || inheritedEnvironment.SHELL
  );
  const home =
    typeof user?.homedir === 'string' && path.isAbsolute(user.homedir) ? user.homedir : null;
  if (!shell || !home) {
    return Object.freeze({ PATH: mergePaths('', inheritedPath), source: 'process' });
  }

  const script = `/usr/bin/printf '${PATH_MARKER_START}%s${PATH_MARKER_END}' "$PATH"`;
  const run = options.run || runLoginShell;
  let result;
  try {
    result = await run(shell, ['-ilc', script], {
      cwd: home,
      detached: true,
      env: {
        ...inheritedEnvironment,
        HOME: home,
        SHELL: shell,
        TERM: 'dumb',
      },
      encoding: 'utf8',
      timeout: CAPTURE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: CAPTURE_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    result = null;
  }
  const shellPath = result?.exitCode === 0 ? capturedPath(result.stdout) : null;
  return Object.freeze({
    PATH: mergePaths(shellPath || '', inheritedPath),
    source: shellPath ? 'login_shell' : 'process',
  });
}

module.exports = {
  CAPTURE_MAX_BUFFER_BYTES,
  CAPTURE_TIMEOUT_MS,
  captureHostCommandEnvironment,
  capturedPath,
  mergePaths,
};
