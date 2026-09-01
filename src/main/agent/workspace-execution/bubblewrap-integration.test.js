'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { BubblewrapExecutor } = require('./bubblewrap-backend');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');

jest.setTimeout(30_000);

async function createFixture() {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-bwrap-test-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const outsideRoot = path.join(fixtureRoot, 'outside');
  await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
  await fs.promises.mkdir(outsideRoot, { mode: 0o700 });
  const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
  await fs.promises.writeFile(path.join(workspaceRoot, 'source.txt'), 'source\n');
  await fs.promises.writeFile(path.join(outsideRoot, 'canary.txt'), 'outside-canary\n');
  return { fixtureRoot, workspaceRoot, outsideRoot };
}

function listen(server, target) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('Bubblewrap execution boundary', () => {
  const executor = new BubblewrapExecutor();
  let capabilities;
  let fixture;

  beforeAll(async () => {
    capabilities = await executor.detectCapabilities({ force: true });
    if (!capabilities.available && process.env.FREEDOM_REQUIRE_BWRAP === '1') {
      throw new Error(
        `Bubblewrap qualification is required but unavailable: ${capabilities.denial.code}`
      );
    }
  });

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (fixture) {
      await fs.promises.rm(fixture.fixtureRoot, { recursive: true, force: true });
      fixture = null;
    }
  });

  function available() {
    return capabilities.available;
  }

  async function policy(options = {}) {
    return createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      limits: { timeoutMs: 10_000, stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024 },
      ...options,
    });
  }

  test('runs useful shell, Node, Python, Git, and descendant workloads in the workspace', async () => {
    if (!available()) return;
    const receipt = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        [
          "printf 'generated' > generated.txt",
          "printf '#!/bin/sh\\nprintf nested > nested.txt\\n' > generated.sh",
          'chmod +x generated.sh',
          './generated.sh',
          "node -e \"require('fs').writeFileSync('node.txt', 'node')\"",
          "python3 -c \"from pathlib import Path; Path('python.txt').write_text('python')\"",
          'git status --short',
          "printf 'positive-ok'",
        ].join(' && '),
      ],
    });

    expect(receipt).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(receipt.stdout).toContain('positive-ok');
    await expect(
      fs.promises.readFile(path.join(fixture.workspaceRoot, 'generated.txt'), 'utf8')
    ).resolves.toBe('generated');
    await expect(
      fs.promises.readFile(path.join(fixture.workspaceRoot, 'nested.txt'), 'utf8')
    ).resolves.toBe('nested');
    await expect(
      fs.promises.readFile(path.join(fixture.workspaceRoot, 'node.txt'), 'utf8')
    ).resolves.toBe('node');
    await expect(
      fs.promises.readFile(path.join(fixture.workspaceRoot, 'python.txt'), 'utf8')
    ).resolves.toBe('python');
  });

  test('denies direct, encoded, generated-script, and symlink reads and writes outside the workspace', async () => {
    if (!available()) return;
    const outsideCanary = path.join(fixture.outsideRoot, 'canary.txt');
    const outsideWrite = path.join(fixture.outsideRoot, 'written.txt');
    await fs.promises.symlink(outsideCanary, path.join(fixture.workspaceRoot, 'escape-link'));
    const script = [
      "const fs = require('fs');",
      "const outside = Buffer.from(process.argv[1], 'base64').toString('utf8');",
      "const outsideWrite = Buffer.from(process.argv[2], 'base64').toString('utf8');",
      'const results = {};',
      "for (const [name, target] of [['direct', outside], ['symlink', '/workspace/escape-link']]) {",
      "  try { fs.readFileSync(target, 'utf8'); results[name] = 'unexpected'; }",
      '  catch (error) { results[name] = error.code; }',
      '}',
      "try { fs.writeFileSync(outsideWrite, 'escaped'); results.write = 'unexpected'; }",
      'catch (error) { results.write = error.code; }',
      "fs.writeFileSync('/workspace/generated-reader.js', `require('fs').readFileSync(${JSON.stringify(outside)})`);",
      "try { require('/workspace/generated-reader.js'); results.generated = 'unexpected'; }",
      'catch (error) { results.generated = error.code; }',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n');
    const receipt = await executor.execute(await policy(), {
      command: 'node',
      args: [
        '-e',
        script,
        Buffer.from(outsideCanary).toString('base64'),
        Buffer.from(outsideWrite).toString('base64'),
      ],
    });

    expect(receipt.state).toBe('completed');
    expect(JSON.parse(receipt.stdout)).toEqual({
      direct: 'ENOENT',
      symlink: 'ENOENT',
      write: 'ENOENT',
      generated: 'ENOENT',
    });
    await expect(fs.promises.readFile(outsideCanary, 'utf8')).resolves.toBe('outside-canary\n');
    await expect(fs.promises.stat(outsideWrite)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('hides host processes, environment, descriptors, sockets, loopback services, and DNS', async () => {
    if (!available()) return;
    const tcpServer = net.createServer((socket) => socket.end('host-tcp'));
    await listen(tcpServer, { host: '127.0.0.1', port: 0 });
    const tcpPort = tcpServer.address().port;
    const socketPath = path.join(fixture.outsideRoot, 'host.sock');
    const unixServer = net.createServer((socket) => socket.end('host-unix'));
    await listen(unixServer, socketPath);
    const abstractName = `freedom-host-${process.pid}-${Date.now()}`;
    const abstractServer = net.createServer((socket) => socket.end('host-abstract'));
    await listen(abstractServer, `\0${abstractName}`);
    const descriptors = [];
    for (let index = 0; index < 48; index += 1) {
      descriptors.push(fs.openSync(path.join(fixture.outsideRoot, 'canary.txt'), 'r'));
    }
    const inheritedDescriptor = descriptors.at(-1);
    const script = [
      "const dns = require('dns');",
      "const fs = require('fs');",
      "const net = require('net');",
      'const [hostPid, hostFd, tcpPort, socketPath, abstractName] = process.argv.slice(1);',
      'const result = {};',
      'const connect = (target) => new Promise((resolve) => {',
      '  const socket = net.createConnection(target);',
      "  socket.setTimeout(1000, () => socket.destroy(new Error('timeout')));",
      "  socket.once('connect', () => { result[target.label] = 'unexpected'; socket.destroy(); resolve(); });",
      "  socket.once('error', (error) => { result[target.label] = error.code || error.message; resolve(); });",
      '});',
      '(async () => {',
      "  result.secret = process.env.AWS_SECRET_ACCESS_KEY || 'absent';",
      "  try { process.kill(Number(hostPid), 0); result.process = 'unexpected'; } catch (error) { result.process = error.code; }",
      "  try { fs.readFileSync(`/proc/self/fd/${hostFd}`); result.fd = 'unexpected'; } catch (error) { result.fd = error.code; }",
      "  await connect({ host: '127.0.0.1', port: Number(tcpPort), label: 'tcp' });",
      "  await connect({ path: socketPath, label: 'unix' });",
      "  await connect({ path: `\\0${abstractName}`, label: 'abstract' });",
      "  result.dns = await new Promise((resolve) => dns.lookup('example.com', (error) => resolve(error ? error.code : 'unexpected')));",
      "  const internalPath = '/tmp/internal.sock';",
      "  const internalServer = net.createServer((socket) => socket.end('inside'));",
      '  await new Promise((resolve, reject) => internalServer.once("error", reject).listen(internalPath, resolve));',
      '  result.internal = await new Promise((resolve) => {',
      "    let body = ''; const socket = net.createConnection({ path: internalPath });",
      "    socket.on('data', (chunk) => { body += chunk; });",
      "    socket.on('end', () => resolve(body));",
      "    socket.on('error', (error) => resolve(error.code));",
      '  });',
      '  await new Promise((resolve) => internalServer.close(resolve));',
      '  process.stdout.write(JSON.stringify(result));',
      '})().catch((error) => { console.error(error); process.exit(1); });',
    ].join('\n');
    let receipt;
    try {
      receipt = await executor.execute(
        await policy({
          hostEnvironment: { LANG: 'C.UTF-8', AWS_SECRET_ACCESS_KEY: 'must-not-leak' },
        }),
        {
          command: 'node',
          args: [
            '-e',
            script,
            String(process.pid),
            String(inheritedDescriptor),
            String(tcpPort),
            socketPath,
            abstractName,
          ],
        }
      );
    } finally {
      for (const descriptor of descriptors) fs.closeSync(descriptor);
      await Promise.all([
        closeServer(tcpServer),
        closeServer(unixServer),
        closeServer(abstractServer),
      ]);
    }

    expect(receipt.state).toBe('completed');
    const result = JSON.parse(receipt.stdout);
    expect(result).toMatchObject({
      secret: 'absent',
      process: 'ESRCH',
      fd: 'ENOENT',
      internal: 'inside',
    });
    expect(result.tcp).not.toBe('unexpected');
    expect(result.unix).not.toBe('unexpected');
    expect(result.abstract).not.toBe('unexpected');
    expect(result.dns).not.toBe('unexpected');
  });

  test('keeps Git metadata read-only and gives every command a fresh private home and tmp', async () => {
    if (!available()) return;
    const gitConfig = path.join(fixture.workspaceRoot, '.git', 'config');
    const originalConfig = await fs.promises.readFile(gitConfig, 'utf8');
    const first = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        [
          'git status --short >/dev/null',
          'test ! -e /etc/ssl/private',
          'if printf mutation >> .git/config 2>/dev/null; then echo git-write-unexpected; else echo git-protected; fi',
          'if mv .git .git-moved 2>/dev/null; then echo git-rename-unexpected; else echo git-rename-protected; fi',
          'mkdir -p "$HOME/.config"',
          'printf private > "$HOME/.config/tool"',
          'printf temporary > /tmp/tool-output',
        ].join('; '),
      ],
    });
    expect(first).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(first.stdout).toContain('git-protected');
    expect(first.stdout).toContain('git-rename-protected');
    await expect(fs.promises.readFile(gitConfig, 'utf8')).resolves.toBe(originalConfig);

    const second = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        'test ! -e "$HOME/.config/tool" && test ! -e /tmp/tool-output && printf fresh-private-storage',
      ],
    });
    expect(second).toMatchObject({ state: 'completed', stdout: 'fresh-private-storage' });
  });

  test('bounds output without killing a successful command and distinguishes ordinary failure', async () => {
    if (!available()) return;
    const boundedPolicy = await policy({
      limits: { timeoutMs: 10_000, stdoutBytes: 1_024, stderrBytes: 1_024 },
    });
    const output = await executor.execute(boundedPolicy, {
      command: 'node',
      args: [
        '-e',
        "process.stdout.write('o'.repeat(8192)); process.stderr.write('e'.repeat(8192));",
      ],
    });
    expect(output).toMatchObject({
      state: 'completed',
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(Buffer.byteLength(output.stdout)).toBe(1_024);
    expect(Buffer.byteLength(output.stderr)).toBe(1_024);

    const failure = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: ['-c', 'printf ordinary-failure >&2; exit 7'],
    });
    expect(failure).toMatchObject({
      state: 'failed',
      exitCode: 7,
      stderr: 'ordinary-failure',
      error: { code: 'COMMAND_FAILED' },
    });
  });

  test('times out and cancels the complete descendant process tree', async () => {
    if (!available()) return;
    const heartbeat = path.join(fixture.workspaceRoot, 'heartbeat');
    const timedPolicy = await policy({
      limits: { timeoutMs: 250, stdoutBytes: 4_096, stderrBytes: 4_096 },
    });
    const timedOut = await executor.execute(timedPolicy, {
      command: '/bin/sh',
      args: ['-c', '(while true; do printf x >> heartbeat; sleep 0.03; done) & wait'],
    });
    expect(timedOut.state).toBe('timed_out');
    const timedSize = (await fs.promises.stat(heartbeat)).size;
    await delay(300);
    expect((await fs.promises.stat(heartbeat)).size).toBe(timedSize);

    const controller = new AbortController();
    const cancellation = executor.execute(await policy(), {
      command: '/bin/sh',
      args: ['-c', '(while true; do printf y >> cancelled-heartbeat; sleep 0.03; done) & wait'],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    const cancelled = await cancellation;
    expect(cancelled.state).toBe('cancelled');
    const cancelledPath = path.join(fixture.workspaceRoot, 'cancelled-heartbeat');
    const cancelledSize = (await fs.promises.stat(cancelledPath)).size;
    await delay(300);
    expect((await fs.promises.stat(cancelledPath)).size).toBe(cancelledSize);
  });

  test('reports sandbox initialization failure without running the command unsandboxed', async () => {
    if (!available()) return;
    const preparedPolicy = await policy();
    const movedWorkspace = `${fixture.workspaceRoot}-moved`;
    await fs.promises.rename(fixture.workspaceRoot, movedWorkspace);
    let receipt;
    try {
      receipt = await executor.execute(preparedPolicy, {
        command: '/bin/sh',
        args: ['-c', `printf escaped > ${path.join(fixture.outsideRoot, 'unsandboxed')}`],
      });
    } finally {
      await fs.promises.rename(movedWorkspace, fixture.workspaceRoot);
    }
    expect(receipt).toMatchObject({
      state: 'sandbox_denied',
      exitCode: null,
      error: { code: 'SANDBOX_INITIALIZATION_FAILED' },
    });
    await expect(
      fs.promises.stat(path.join(fixture.outsideRoot, 'unsandboxed'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('sanitizes and protects a separate external Git directory', async () => {
    if (!available()) return;
    await fs.promises.rm(path.join(fixture.workspaceRoot, '.git'), {
      recursive: true,
      force: true,
    });
    const gitDirectory = path.join(fixture.fixtureRoot, 'external-git');
    const git = spawnSync(
      'git',
      ['init', '--quiet', `--separate-git-dir=${gitDirectory}`, fixture.workspaceRoot],
      { encoding: 'utf8' }
    );
    expect(git.status).toBe(0);
    await fs.promises.writeFile(
      path.join(gitDirectory, 'gitdir'),
      `${path.join(fixture.workspaceRoot, '.git')}\n`
    );
    const receipt = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        'cat .git; cat /freedom-git-1/gitdir/gitdir; git status --short >/dev/null; if printf x >> .git 2>/dev/null; then exit 9; fi',
      ],
    });
    expect(receipt.state).toBe('completed');
    expect(receipt.stdout).toBe('gitdir: /freedom-git-1/gitdir\n/workspace/.git\n');
    expect(receipt.stdout).not.toContain(fixture.fixtureRoot);
  });
});
