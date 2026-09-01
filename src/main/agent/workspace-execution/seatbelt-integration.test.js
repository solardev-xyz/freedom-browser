'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const { SeatbeltExecutor } = require('./seatbelt-backend');

jest.setTimeout(30_000);

async function createFixture() {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-seatbelt-test-'));
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const outsideRoot = path.join(fixtureRoot, 'outside');
  await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
  await fs.promises.mkdir(outsideRoot, { mode: 0o700 });
  const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
  await fs.promises.writeFile(path.join(workspaceRoot, 'source.txt'), 'source\n');
  const commit = spawnSync('git', ['-C', workspaceRoot, 'add', 'source.txt'], { encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(commit.stderr || 'git add failed');
  const committed = spawnSync(
    'git',
    [
      '-C',
      workspaceRoot,
      '-c',
      'user.name=Freedom Test',
      '-c',
      'user.email=test@invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { encoding: 'utf8' }
  );
  if (committed.status !== 0) throw new Error(committed.stderr || 'git commit failed');
  await fs.promises.writeFile(path.join(outsideRoot, 'canary.txt'), 'outside-canary\n');
  return { fixtureRoot, workspaceRoot, outsideRoot };
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size > 0) return stats;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

const requiredDescribe =
  process.platform === 'darwin' && process.env.FREEDOM_REQUIRE_SEATBELT === '1'
    ? describe
    : describe.skip;

requiredDescribe('macOS Seatbelt execution boundary', () => {
  const executor = new SeatbeltExecutor();
  let fixture;

  beforeAll(async () => {
    const capabilities = await executor.detectCapabilities({ force: true });
    expect(capabilities).toMatchObject({
      backend: 'macos-seatbelt',
      available: true,
      enforcement: {
        filesystem: true,
        networkNone: true,
        cancellationGuarantee: 'best_effort',
      },
    });
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

  function policy(options = {}) {
    return createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      limits: { timeoutMs: 10_000, stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024 },
      ...options,
    });
  }

  test('runs shell scripts, Python, Node, Git reads and nested descendants', async () => {
    const receipt = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        [
          "printf '#!/bin/sh\\nprintf nested > nested.txt\\n' > generated.sh",
          'chmod +x generated.sh',
          './generated.sh',
          "python3 -c \"from pathlib import Path; Path('python.txt').write_text('python')\"",
          "node -e \"require('fs').writeFileSync('node.txt', 'node')\"",
          'git status --short >/dev/null',
          'git diff -- source.txt >/dev/null',
          'git log -1 --oneline >/dev/null',
          "printf 'positive-ok'",
        ].join(' && '),
      ],
    });
    expect(receipt).toMatchObject({
      state: 'completed',
      exitCode: 0,
      stdout: 'positive-ok',
      terminationGuarantee: 'best_effort',
    });
    for (const [name, value] of [
      ['nested.txt', 'nested'],
      ['python.txt', 'python'],
      ['node.txt', 'node'],
    ]) {
      await expect(
        fs.promises.readFile(path.join(fixture.workspaceRoot, name), 'utf8')
      ).resolves.toBe(value);
    }
  });

  test('denies direct, encoded, generated-program and symlink filesystem escapes', async () => {
    const outsideCanary = path.join(fixture.outsideRoot, 'canary.txt');
    const outsideWrite = path.join(fixture.outsideRoot, 'written.txt');
    await fs.promises.symlink(outsideCanary, path.join(fixture.workspaceRoot, 'escape-link'));
    const script = [
      'import base64, json, pathlib, sys',
      'outside = base64.b64decode(sys.argv[1]).decode()',
      'outside_write = base64.b64decode(sys.argv[2]).decode()',
      'result = {}',
      "for name, target in [('direct', outside), ('symlink', 'escape-link')]:",
      '    try:',
      '        pathlib.Path(target).read_text()',
      "        result[name] = 'unexpected'",
      '    except OSError as error:',
      '        result[name] = error.errno',
      'try:',
      "    pathlib.Path(outside_write).write_text('escaped')",
      "    result['write'] = 'unexpected'",
      'except OSError as error:',
      "    result['write'] = error.errno",
      "pathlib.Path('generated.py').write_text('from pathlib import Path\\nPath(' + repr(outside) + ').read_text()')",
      'try:',
      "    exec(pathlib.Path('generated.py').read_text())",
      "    result['generated'] = 'unexpected'",
      'except OSError as error:',
      "    result['generated'] = error.errno",
      'print(json.dumps(result), end="")',
    ].join('\n');
    const receipt = await executor.execute(await policy(), {
      command: 'python3',
      args: [
        '-c',
        script,
        Buffer.from(outsideCanary).toString('base64'),
        Buffer.from(outsideWrite).toString('base64'),
      ],
    });

    expect(receipt.state).toBe('completed');
    expect(JSON.parse(receipt.stdout)).toEqual({ direct: 1, symlink: 1, write: 1, generated: 1 });
    await expect(fs.promises.readFile(outsideCanary, 'utf8')).resolves.toBe('outside-canary\n');
    await expect(fs.promises.stat(outsideWrite)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('keeps Git metadata read-only and uses fresh private storage', async () => {
    const gitConfig = path.join(fixture.workspaceRoot, '.git', 'config');
    const original = await fs.promises.readFile(gitConfig, 'utf8');
    const first = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        [
          'git status --short >/dev/null',
          'if printf mutation >> .git/config 2>/dev/null; then echo unexpected; else echo protected; fi',
          'printf private > "$HOME/private"',
          'printf temporary > "$TMPDIR/temporary"',
        ].join('; '),
      ],
    });
    expect(first).toMatchObject({ state: 'completed' });
    expect(first.stdout).toContain('protected');
    await expect(fs.promises.readFile(gitConfig, 'utf8')).resolves.toBe(original);

    const second = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: ['-c', 'test ! -e "$HOME/private" && test ! -e "$TMPDIR/temporary"'],
    });
    expect(second).toMatchObject({ state: 'completed', exitCode: 0 });
  });

  test('denies localhost, external network and DNS', async () => {
    const server = net.createServer((socket) => socket.end('host-service'));
    await listen(server);
    const port = server.address().port;
    const script = [
      "const dns = require('dns');",
      "const net = require('net');",
      'const port = Number(process.argv[1]);',
      'const connect = (options) => new Promise((resolve) => {',
      '  const socket = net.createConnection(options);',
      "  socket.setTimeout(1000, () => socket.destroy(new Error('timeout')));",
      "  socket.once('connect', () => { socket.destroy(); resolve('unexpected'); });",
      "  socket.once('error', (error) => resolve(error.code || error.message));",
      '});',
      '(async () => {',
      "  const localhost = await connect({ host: '127.0.0.1', port });",
      "  const external = await connect({ host: '1.1.1.1', port: 53 });",
      "  const lookup = await new Promise((resolve) => dns.lookup('example.com', (error) => resolve(error ? error.code : 'unexpected')));",
      '  process.stdout.write(JSON.stringify({ localhost, external, lookup }));',
      '})();',
    ].join('\n');
    let receipt;
    try {
      receipt = await executor.execute(await policy(), {
        command: 'node',
        args: ['-e', script, String(port)],
      });
    } finally {
      await closeServer(server);
    }
    expect(receipt.state).toBe('completed');
    const result = JSON.parse(receipt.stdout);
    expect(result.localhost).not.toBe('unexpected');
    expect(result.external).not.toBe('unexpected');
    expect(result.lookup).not.toBe('unexpected');
  });

  test('final-kills same-group background descendants after normal root exit', async () => {
    const heartbeat = path.join(fixture.workspaceRoot, 'normal-exit-heartbeat');
    const receipt = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        [
          '(trap \'\' TERM; count=0; while [ "$count" -lt 100 ]; do printf x >> normal-exit-heartbeat; count=$((count + 1)); sleep 0.03; done) </dev/null >/dev/null 2>&1 &',
          'printf \'%s\' "$!" > normal-exit.pid',
          'while [ ! -s normal-exit-heartbeat ]; do sleep 0.02; done',
        ].join('\n'),
      ],
    });

    expect(receipt).toMatchObject({
      state: 'completed',
      terminationGuarantee: 'best_effort',
      diagnostics: { processGroupFinalKillAttempted: true },
    });
    await waitForFile(path.join(fixture.workspaceRoot, 'normal-exit.pid'));
    const size = (await waitForFile(heartbeat)).size;
    await delay(300);
    expect((await fs.promises.stat(heartbeat)).size).toBe(size);
  });

  test('final-kills SIGTERM-resistant same-group descendants during cancellation', async () => {
    const heartbeat = path.join(fixture.workspaceRoot, 'cancellation-heartbeat');
    const controller = new AbortController();
    const execution = executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        [
          '(trap \'\' TERM; count=0; while [ "$count" -lt 100 ]; do printf x >> cancellation-heartbeat; count=$((count + 1)); sleep 0.03; done) </dev/null >/dev/null 2>&1 &',
          'printf \'%s\' "$!" > cancellation.pid',
          'wait',
        ].join('\n'),
      ],
      signal: controller.signal,
    });
    await Promise.all([
      waitForFile(heartbeat),
      waitForFile(path.join(fixture.workspaceRoot, 'cancellation.pid')),
    ]);
    controller.abort();
    const receipt = await execution;
    expect(receipt).toMatchObject({
      state: 'cancelled',
      terminationGuarantee: 'best_effort',
      diagnostics: { processGroupFinalKillAttempted: true },
    });
    const size = (await fs.promises.stat(heartbeat)).size;
    await delay(300);
    expect((await fs.promises.stat(heartbeat)).size).toBe(size);
  });

  test('bounds and continuously drains stdout and stderr', async () => {
    const boundedPolicy = await policy({
      limits: { timeoutMs: 10_000, stdoutBytes: 1_024, stderrBytes: 1_024 },
    });
    const receipt = await executor.execute(boundedPolicy, {
      command: 'node',
      args: [
        '-e',
        "process.stdout.write('o'.repeat(8192)); process.stderr.write('e'.repeat(8192));",
      ],
    });
    expect(receipt).toMatchObject({
      state: 'completed',
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(Buffer.byteLength(receipt.stdout)).toBe(1_024);
    expect(Buffer.byteLength(receipt.stderr)).toBe(1_024);
  });
});
