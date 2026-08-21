'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CliError } = require('./errors');
const { EXIT_CODES } = require('./exit-codes');
const { connectRuntime } = require('./runtime-client');

const DEFAULT_START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 100;

function resolveRuntimeExecutable(options = {}) {
  const env = options.env || process.env;
  const explicit = options.runtimeExecutable || env.FREEDOM_RUNTIME_EXECUTABLE;
  if (explicit) return path.resolve(explicit);
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const executable = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  return path.join(repoRoot, 'node_modules', '.bin', executable);
}

function launchRuntime(profile, options = {}) {
  const env = options.env || process.env;
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const executable = resolveRuntimeExecutable(options);
  if (!fs.existsSync(executable)) {
    throw new CliError('RUNTIME_EXECUTABLE_NOT_FOUND', 'Freedom runtime executable was not found', {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      details: { executable },
    });
  }
  const args = [repoRoot, '--runtime'];
  if (options.persistent) args.push('--persistent');
  const childEnv = { ...env };
  if (!env.FREEDOM_TEST_USER_DATA) {
    if (profile.source === 'profile-dir') {
      args.push('--profile-dir', profile.userDataDir);
    } else {
      args.push('--profile', profile.id);
      childEnv.FREEDOM_DEV_HOME = profile.appRoot;
    }
  }
  const child = spawn(executable, args, {
    cwd: repoRoot,
    env: childEnv,
    detached: true,
    stdio: 'ignore',
  });
  child.launchError = null;
  child.once('error', (error) => {
    child.launchError = error;
  });
  child.unref();
  return child;
}

async function waitForRuntime(profile, options = {}) {
  const timeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (options.child?.launchError) {
      throw new CliError('RUNTIME_START_FAILED', 'Freedom runtime could not be launched', {
        exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
        cause: options.child.launchError,
      });
    }
    if (options.child && (options.child.exitCode !== null || options.child.signalCode !== null)) {
      const exitCode = options.child.exitCode;
      if (exitCode === EXIT_CODES.PROFILE_LOCKED) {
        throw new CliError('PROFILE_LOCKED', 'The selected Freedom profile is already in use', {
          exitCode: EXIT_CODES.PROFILE_LOCKED,
          details: { profileId: profile.id },
        });
      }
      throw new CliError('RUNTIME_START_FAILED', 'Freedom runtime exited before becoming ready', {
        exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
        details: { runtimeExitCode: exitCode },
      });
    }
    try {
      return await connectRuntime(profile, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
  }
  throw new CliError('RUNTIME_START_TIMEOUT', 'Freedom runtime did not become ready in time', {
    exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
    cause: lastError,
  });
}

async function ensureRuntime(profile, options = {}) {
  try {
    return await connectRuntime(profile, options);
  } catch (error) {
    if (error?.exitCode !== EXIT_CODES.RUNTIME_UNAVAILABLE) throw error;
  }
  const child = launchRuntime(profile, options);
  return waitForRuntime(profile, { ...options, child });
}

module.exports = {
  DEFAULT_START_TIMEOUT_MS,
  ensureRuntime,
  launchRuntime,
  resolveRuntimeExecutable,
  waitForRuntime,
};
