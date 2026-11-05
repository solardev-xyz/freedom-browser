'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createWorkspaceExecutionPolicy, insidePath } = require('./execution-policy');
const { SeatbeltExecutor } = require('./seatbelt-backend');

jest.setTimeout(30_000);

function validateDestructiveFixtureRoot(fixtureRoot) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const canonical = fs.realpathSync(fixtureRoot);
  if (
    !insidePath(temporaryRoot, canonical) ||
    canonical === temporaryRoot ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith('freedom-seatbelt-destructive-')
  ) {
    throw new Error('Refusing macOS destructive qualification outside a validated synthetic root');
  }
  return canonical;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filename, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.promises.readFile(filename, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for synthetic result ${path.basename(filename)}`);
}

function processCommand(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function cleanupRecordedProcess(pid, token) {
  const signalIfOwned = (signal) => {
    const command = processCommand(pid);
    if (!command) return false;
    if (!command.includes(token)) {
      throw new Error('Refusing to signal a detached PID without the synthetic ownership token');
    }
    process.kill(pid, signal);
    return true;
  };
  if (!signalIfOwned('SIGTERM')) return;
  const termDeadline = Date.now() + 1_000;
  while (Date.now() < termDeadline) {
    if (!processCommand(pid)) return;
    await delay(25);
  }
  if (signalIfOwned('SIGKILL')) {
    const killDeadline = Date.now() + 1_000;
    while (Date.now() < killDeadline) {
      if (!processCommand(pid)) return;
      await delay(25);
    }
  }
  throw new Error('Detached synthetic process did not exit within the cleanup bound');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const destructiveTest =
  process.platform === 'darwin' &&
  process.env.FREEDOM_SANDBOX_DESTRUCTIVE === '1' &&
  process.env.FREEDOM_REQUIRE_SEATBELT === '1'
    ? test
    : test.skip;

describe('gated detached-descendant macOS Seatbelt qualification', () => {
  destructiveTest('contains a setsid descendant after best-effort group cancellation', async () => {
    const fixtureRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'freedom-seatbelt-destructive-')
    );
    validateDestructiveFixtureRoot(fixtureRoot);
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    const outsideRoot = path.join(fixtureRoot, 'outside');
    await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
    await fs.promises.mkdir(outsideRoot, { mode: 0o700 });
    const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
    const outsideCanary = path.join(outsideRoot, 'outside-canary');
    await fs.promises.writeFile(outsideCanary, 'outside-canary');
    const pidFile = path.join(workspaceRoot, 'detached.pid');
    const resultFile = path.join(workspaceRoot, 'detached-result.json');
    const heartbeat = path.join(workspaceRoot, 'detached-heartbeat');
    const token = `freedom-detached-${crypto.randomUUID()}`;
    const server = net.createServer((socket) => socket.end('host-service'));
    await listen(server);
    const port = server.address().port;
    let detachedPid = null;

    try {
      const policy = await createWorkspaceExecutionPolicy({
        workspaceRoot,
        limits: { timeoutMs: 10_000, stdoutBytes: 16_384, stderrBytes: 16_384 },
      });
      const script = [
        'import json, os, pathlib, socket, sys, time',
        'outside, pid_file, result_file, heartbeat, port, token = sys.argv[1:]',
        'if os.fork() == 0:',
        '    os.setsid()',
        "    devnull = os.open('/dev/null', os.O_RDWR)",
        '    for descriptor in (0, 1, 2): os.dup2(devnull, descriptor)',
        '    pathlib.Path(pid_file).write_text(str(os.getpid()))',
        '    result = {}',
        '    try:',
        '        pathlib.Path(outside).read_text()',
        "        result['outsideRead'] = 'unexpected'",
        '    except OSError as error:',
        "        result['outsideRead'] = error.errno",
        '    for name, address in [("localhost", ("127.0.0.1", int(port))), ("external", ("1.1.1.1", 53))]:',
        '        sock = socket.socket()',
        '        try:',
        '            result[name] = sock.connect_ex(address)',
        '        finally:',
        '            sock.close()',
        '    try:',
        "        socket.getaddrinfo('example.com', 443)",
        "        result['dns'] = 'unexpected'",
        '    except OSError as error:',
        "        result['dns'] = getattr(error, 'errno', None) or type(error).__name__",
        '    pathlib.Path(result_file).write_text(json.dumps(result))',
        '    while True:',
        "        with open(heartbeat, 'a') as stream: stream.write('x')",
        '        time.sleep(0.03)',
        'while True: time.sleep(1)',
      ].join('\n');
      const controller = new AbortController();
      const execution = new SeatbeltExecutor().execute(policy, {
        command: 'python3',
        args: ['-c', script, outsideCanary, pidFile, resultFile, heartbeat, String(port), token],
        signal: controller.signal,
      });
      detachedPid = Number.parseInt(await waitForFile(pidFile), 10);
      if (!Number.isSafeInteger(detachedPid) || detachedPid <= 1) {
        throw new Error('Detached qualification produced an invalid PID');
      }
      const result = JSON.parse(await waitForFile(resultFile));
      controller.abort();
      const receipt = await execution;
      expect(receipt).toMatchObject({
        state: 'cancelled',
        terminationGuarantee: 'best_effort',
        survivorsPossible: true,
        completeDescendantTermination: false,
        terminationScope: 'original_process_group',
      });
      expect(processCommand(detachedPid)).toContain(token);
      expect(result.outsideRead).not.toBe('unexpected');
      expect(result.localhost).not.toBe(0);
      expect(result.external).not.toBe(0);
      expect(result.dns).not.toBe('unexpected');
      const heartbeatSize = (await fs.promises.stat(heartbeat)).size;
      await delay(150);
      expect((await fs.promises.stat(heartbeat)).size).toBeGreaterThan(heartbeatSize);
      await expect(fs.promises.readFile(outsideCanary, 'utf8')).resolves.toBe('outside-canary');
    } finally {
      await closeServer(server);
      if (detachedPid) await cleanupRecordedProcess(detachedPid, token);
      validateDestructiveFixtureRoot(fixtureRoot);
      await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  destructiveTest('records and cleans a job-control process-group survivor', async () => {
    const fixtureRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'freedom-seatbelt-destructive-')
    );
    validateDestructiveFixtureRoot(fixtureRoot);
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
    const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
    const pidFile = path.join(workspaceRoot, 'job-control.pid');
    const heartbeat = path.join(workspaceRoot, 'job-control-heartbeat');
    const token = `freedom-job-control-${crypto.randomUUID()}`;
    let survivorPid = null;

    try {
      const policy = await createWorkspaceExecutionPolicy({
        workspaceRoot,
        limits: { timeoutMs: 10_000, stdoutBytes: 16_384, stderrBytes: 16_384 },
      });
      const survivorScript = [
        'import os, pathlib, signal, sys, time',
        'pid_file, heartbeat, token = sys.argv[1:]',
        'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
        'pathlib.Path(pid_file).write_text(str(os.getpid()))',
        'while True:',
        "    with open(heartbeat, 'a') as stream: stream.write('x')",
        '    time.sleep(0.03)',
      ].join('\n');
      const controller = new AbortController();
      const execution = new SeatbeltExecutor().execute(policy, {
        command: '/bin/sh',
        args: [
          '-c',
          [
            'set -m',
            'python3 -c "$1" "$2" "$3" "$4" </dev/null >/dev/null 2>&1 &',
            'wait',
          ].join('\n'),
          'freedom-job-control-root',
          survivorScript,
          pidFile,
          heartbeat,
          token,
        ],
        signal: controller.signal,
      });
      survivorPid = Number.parseInt(await waitForFile(pidFile), 10);
      if (!Number.isSafeInteger(survivorPid) || survivorPid <= 1) {
        throw new Error('Job-control qualification produced an invalid PID');
      }
      const processGroup = spawnSync('/bin/ps', ['-p', String(survivorPid), '-o', 'pgid='], {
        encoding: 'utf8',
      });
      expect(processGroup.status).toBe(0);
      expect(Number.parseInt(processGroup.stdout, 10)).toBe(survivorPid);
      controller.abort();
      const receipt = await execution;
      expect(receipt).toMatchObject({
        state: 'cancelled',
        terminationGuarantee: 'best_effort',
        survivorsPossible: true,
        completeDescendantTermination: false,
        terminationScope: 'original_process_group',
      });
      expect(processCommand(survivorPid)).toContain(token);
      const heartbeatSize = (await fs.promises.stat(heartbeat)).size;
      await delay(150);
      expect((await fs.promises.stat(heartbeat)).size).toBeGreaterThan(heartbeatSize);
    } finally {
      if (survivorPid) await cleanupRecordedProcess(survivorPid, token);
      validateDestructiveFixtureRoot(fixtureRoot);
      await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

module.exports = { cleanupRecordedProcess, validateDestructiveFixtureRoot };
