'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ELECTRON_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const ELECTRON_RUNTIME_PROBE_MARKER = 'freedom-electron-node-runtime-v1';

function boundedText(value, maximum = 512) {
  return String(value || '').slice(0, maximum);
}

function runElectronProbe(binary, args, options = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, options, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
        signal: error?.signal || null,
        stdout: boundedText(stdout),
        stderr: boundedText(stderr),
      });
    });
  });
}

function findApplicationBundle(executablePath) {
  let current = path.dirname(executablePath);
  const root = path.parse(current).root;
  while (current !== root) {
    if (path.extname(current) === '.app') return current;
    current = path.dirname(current);
  }
  return null;
}

function unavailableRuntime(code, message, diagnostics) {
  return Object.freeze({
    available: false,
    denial: Object.freeze({ code, message }),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function detectElectronJavaScriptRuntime(options = {}) {
  const platform = options.platform || process.platform;
  const versions = options.versions || process.versions;
  const configuredExecutable = options.execPath || process.execPath;
  const run = options.run || runElectronProbe;
  const diagnostics = {
    platform,
    electronVersion: versions.electron || null,
    chromiumVersion: versions.chrome || null,
    nodeVersion: versions.node || null,
    freedomVersion: options.freedomVersion || null,
    packaged: options.packaged === true,
  };
  if (platform !== 'darwin') {
    return unavailableRuntime(
      'ELECTRON_RUNTIME_PLATFORM_UNAVAILABLE',
      'The Electron JavaScript runtime qualifier requires macOS',
      diagnostics
    );
  }
  if (!versions.electron) {
    return unavailableRuntime(
      'ELECTRON_MAIN_PROCESS_REQUIRED',
      'Runtime discovery must execute inside the Freedom Electron main process',
      diagnostics
    );
  }

  let executablePath;
  let executableStats;
  try {
    executablePath = await fs.promises.realpath(configuredExecutable);
    executableStats = await fs.promises.stat(executablePath);
  } catch (error) {
    return unavailableRuntime(
      'ELECTRON_EXECUTABLE_UNAVAILABLE',
      'The active Electron application executable is unavailable',
      { ...diagnostics, cause: error.code }
    );
  }
  const applicationBundleRoot = findApplicationBundle(executablePath);
  if (!executableStats.isFile() || !applicationBundleRoot) {
    return unavailableRuntime(
      'ELECTRON_BUNDLE_UNAVAILABLE',
      'The active Electron executable is not contained in one macOS application bundle',
      { ...diagnostics, executablePath }
    );
  }

  const probeScript = [
    `const marker = ${JSON.stringify(ELECTRON_RUNTIME_PROBE_MARKER)};`,
    'process.stdout.write(JSON.stringify({ marker, electron: process.versions.electron, node: process.versions.node }));',
  ].join(' ');
  const probe = await run(executablePath, ['-e', probeScript], {
    timeout: ELECTRON_RUNTIME_PROBE_TIMEOUT_MS,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      HOME: os.tmpdir(),
      PATH: '/usr/bin:/bin',
    },
  });
  let result;
  try {
    result = JSON.parse(probe.stdout);
  } catch {
    result = null;
  }
  if (
    probe.exitCode !== 0 ||
    result?.marker !== ELECTRON_RUNTIME_PROBE_MARKER ||
    result?.electron !== versions.electron
  ) {
    return unavailableRuntime(
      'ELECTRON_NODE_RUNTIME_UNAVAILABLE',
      'The active Electron application cannot provide the required Node-compatible helper runtime',
      {
        ...diagnostics,
        executablePath,
        applicationBundleRoot,
        probeExitCode: probe.exitCode,
        probeSignal: probe.signal,
        probeDiagnostic: boundedText(probe.stderr),
      }
    );
  }

  return Object.freeze({
    available: true,
    kind: 'electron-run-as-node',
    executablePath,
    applicationBundleRoot,
    invocationEnvironment: Object.freeze({ ELECTRON_RUN_AS_NODE: '1' }),
    diagnostics: Object.freeze({
      ...diagnostics,
      executablePath,
      applicationBundleRoot,
      helperNodeVersion: result.node,
      runtimeProbe: 'passed',
    }),
  });
}

module.exports = {
  ELECTRON_RUNTIME_PROBE_MARKER,
  ELECTRON_RUNTIME_PROBE_TIMEOUT_MS,
  detectElectronJavaScriptRuntime,
  findApplicationBundle,
  runElectronProbe,
};
