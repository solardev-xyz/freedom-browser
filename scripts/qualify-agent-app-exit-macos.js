#!/usr/bin/env node

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'freedom-agent-app-exit-';
const MAX_OUTPUT_BYTES = 256 * 1024;

function boundedAppend(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_OUTPUT_BYTES);
}

function childProcesses(pid) {
  const result = spawnSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : [];
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Application-exit qualification requires macOS');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), PREFIX));
  await fs.promises.chmod(root, 0o700);
  const executable = await fs.promises.realpath(
    path.join(
      __dirname,
      '..',
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron'
    )
  );
  let stdout = '';
  let stderr = '';
  let child;
  try {
    child = spawn(executable, ['.'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    const readyDeadline = Date.now() + 20_000;
    while (!stdout.includes('Setting window title') && Date.now() < readyDeadline) {
      if (child.exitCode !== null || child.signalCode) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!stdout.includes('Setting window title')) {
      throw new Error(`Freedom did not become ready: ${stderr.slice(-512)}`);
    }
    const pid = child.pid;
    const helpersBefore = childProcesses(pid);
    child.kill('SIGTERM');
    const outcome = await Promise.race([
      new Promise((resolve) =>
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Freedom did not exit within 20 seconds')), 20_000)
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const combinedOutput = `${stdout}\n${stderr}`;
    const evidence = {
      mode: 'idle',
      pid,
      helpersObservedBeforeQuit: helpersBefore.length,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      gracefulSignalLogObserved: combinedOutput.includes(
        'Received SIGTERM; starting graceful shutdown'
      ),
      agentDisposeStarted: combinedOutput.includes('agent_dispose_started'),
      agentDisposeFinished: combinedOutput.includes('agent_dispose_finished'),
      processExitObserved: combinedOutput.includes('process_exit'),
      directChildrenAfterExit: childProcesses(pid),
    };
    process.stdout.write(`${JSON.stringify({ type: 'app-exit', ...evidence })}\n`);
    if (
      outcome.exitCode !== 0 ||
      outcome.signal !== null ||
      !evidence.agentDisposeStarted ||
      !evidence.agentDisposeFinished ||
      evidence.directChildrenAfterExit.length !== 0
    ) {
      throw new Error(`Idle application exit evidence was incomplete: ${JSON.stringify(evidence)}`);
    }
  } finally {
    if (child && child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    await fs.promises.rm(root, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ type: 'app-exit-cleanup', removed: !fs.existsSync(root) })}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`macOS application-exit qualification failed: ${error.message}\n`);
  process.exitCode = 1;
});
