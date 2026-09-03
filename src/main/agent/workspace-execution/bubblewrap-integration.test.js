'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  BubblewrapExecutor,
  DEFAULT_BUBBLEWRAP_PATH,
  DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS,
  PRIVATE_TEMP_SIZE_BYTES,
  SHARED_MEMORY_SIZE_BYTES,
  capabilityProbeArguments,
} = require('./bubblewrap-backend');
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

function privateIpv4Address() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.promises.access(file);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for sandbox fixture ${path.basename(file)}`);
}

function preflightBubblewrap() {
  if (process.platform !== 'linux') {
    return { available: false, reason: `unsupported platform ${process.platform}` };
  }
  const result = spawnSync(DEFAULT_BUBBLEWRAP_PATH, capabilityProbeArguments(), {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 5_000,
  });
  if (result.status === 0) return { available: true, reason: null };
  const reason = result.error?.code || result.stderr?.trim() || `exit ${String(result.status)}`;
  return { available: false, reason };
}

const bubblewrapPreflight = preflightBubblewrap();
const bubblewrapRequired = process.env.FREEDOM_REQUIRE_BWRAP === '1';
const describeBubblewrap =
  bubblewrapPreflight.available || bubblewrapRequired ? describe : describe.skip;
const bubblewrapDescription = bubblewrapPreflight.available
  ? 'Bubblewrap execution boundary'
  : `Bubblewrap execution boundary (skipped: ${bubblewrapPreflight.reason})`;

describeBubblewrap(bubblewrapDescription, () => {
  const executor = new BubblewrapExecutor();
  let capabilities;
  let fixture;

  beforeAll(async () => {
    capabilities = await executor.detectCapabilities({ force: true });
    if (!capabilities.available) {
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

  async function policy(options = {}) {
    return createWorkspaceExecutionPolicy({
      workspaceRoot: fixture.workspaceRoot,
      limits: { timeoutMs: 10_000, stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024 },
      ...options,
    });
  }

  test('runs useful shell, Node, Python, Git, and descendant workloads in the workspace', async () => {
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
          'awk \'BEGIN { print "awk-ok" }\'',
          'git status --short',
          "printf 'positive-ok'",
        ].join(' && '),
      ],
    });

    expect(receipt).toMatchObject({
      backend: 'linux-bubblewrap',
      state: 'completed',
      exitCode: 0,
      terminationGuarantee: 'namespace_scoped',
      sideEffects: 'unknown',
      survivorsPossible: false,
      completeDescendantTermination: true,
      terminationScope: 'pid_namespace',
      capabilities: {
        backend: 'linux-bubblewrap',
        cancellationGuarantee: 'namespace_scoped',
        loopbackNetworking: 'private_namespace',
        survivorsPossible: false,
        completeDescendantTermination: true,
      },
    });
    expect(receipt.stdout).toContain('positive-ok');
    expect(receipt.stdout).toContain('awk-ok');
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
      "try { fs.linkSync(outside, '/workspace/dynamic-hardlink'); results.hardlink = 'unexpected'; }",
      'catch (error) { results.hardlink = error.code; }',
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
      hardlink: 'ENOENT',
      generated: 'ENOENT',
    });
    await expect(fs.promises.readFile(outsideCanary, 'utf8')).resolves.toBe('outside-canary\n');
    await expect(fs.promises.stat(outsideWrite)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('hides host processes, environment, descriptors, sockets, loopback services, and DNS', async () => {
    const tcpServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('host-tcp');
    });
    await listen(tcpServer, { host: '127.0.0.1', port: 0 });
    const tcpPort = tcpServer.address().port;
    const socketPath = path.join(fixture.outsideRoot, 'host.sock');
    const unixServer = net.createServer((socket) => socket.end('host-unix'));
    await listen(unixServer, socketPath);
    const abstractName = `freedom-host-${process.pid}-${Date.now()}`;
    const abstractServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('host-abstract');
    });
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
      "  await connect({ host: '1.1.1.1', port: 53, label: 'internet' });",
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
      tcp: 'ECONNREFUSED',
      internet: 'ENETUNREACH',
      unix: 'ENOENT',
      abstract: 'ECONNREFUSED',
      dns: 'ENOTFOUND',
      internal: 'inside',
    });
  });

  test('full networking exposes public, host-loopback, LAN, and host abstract sockets only for that policy', async () => {
    const lanAddress = process.env.FREEDOM_SANDBOX_LAN_HOST || privateIpv4Address();
    expect(lanAddress).toBeTruthy();
    const tcpServer = net.createServer((socket) => socket.end('host-tcp'));
    await listen(tcpServer, { host: '0.0.0.0', port: 0 });
    const tcpPort = tcpServer.address().port;
    const lanPort = process.env.FREEDOM_SANDBOX_LAN_PORT || String(tcpPort);
    const abstractName = `freedom-full-network-${process.pid}-${Date.now()}`;
    const abstractServer = net.createServer((socket) => socket.end('host-abstract'));
    await listen(abstractServer, `\0${abstractName}`);
    const publicHost = process.env.FREEDOM_SANDBOX_PUBLIC_HOST || '1.1.1.1';
    const publicPort = process.env.FREEDOM_SANDBOX_PUBLIC_PORT || '443';
    const childScript = [
      "const dns = require('dns');",
      "const net = require('net');",
      'const [loopPort, lanHost, lanPort, publicHost, publicPort, abstractName] = process.argv.slice(1);',
      'const connect = (target) => new Promise((resolve) => {',
      '  const socket = net.createConnection(target);',
      "  socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));",
      "  socket.once('connect', () => { socket.end(); resolve('connected'); });",
      "  socket.once('error', (error) => resolve(error.code || error.message));",
      '});',
      '(async () => {',
      "  const loopback = await connect({ host: '127.0.0.1', port: Number(loopPort) });",
      '  const lan = await connect({ host: lanHost, port: Number(lanPort) });',
      '  const internet = await connect({ host: publicHost, port: Number(publicPort) });',
      '  const abstract = await connect({ path: `\\0${abstractName}` });',
      "  const dnsResult = await new Promise((resolve) => dns.lookup('example.com', (error) => resolve(error ? error.code : 'resolved')));",
      '  process.stdout.write(JSON.stringify({ loopback, lan, internet, abstract, dns: dnsResult }));',
      '})();',
    ].join('\n');
    let fullReceipt;
    let offlineReceipt;
    try {
      fullReceipt = await executor.execute(await policy({ network: 'full' }), {
        command: 'node',
        args: [
          '-e',
          `const { spawnSync } = require('child_process'); const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(childScript)}, ...process.argv.slice(1)], { encoding: 'utf8' }); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);`,
          String(tcpPort),
          lanAddress,
          lanPort,
          publicHost,
          publicPort,
          abstractName,
        ],
      });
      offlineReceipt = await executor.execute(await policy(), {
        command: 'node',
        args: [
          '-e',
          `const net = require('net'); const socket = net.createConnection({ host: '127.0.0.1', port: ${tcpPort} }); socket.once('connect', () => process.exit(9)); socket.once('error', () => process.exit(0));`,
        ],
      });
    } finally {
      await Promise.all([closeServer(tcpServer), closeServer(abstractServer)]);
    }

    expect(fullReceipt).toMatchObject({
      state: 'completed',
      capabilities: {
        networkPosture: 'full',
        publicNetworking: 'host_network',
        loopbackNetworking: 'host_network',
        privateNetworking: 'host_network',
        hostAbstractUnixSockets: 'reachable',
      },
    });
    const result = JSON.parse(fullReceipt.stdout);
    expect(result).toMatchObject({
      loopback: 'connected',
      internet: 'connected',
      abstract: 'connected',
      dns: 'resolved',
    });
    if (process.env.FREEDOM_SANDBOX_LAN_HOST) expect(result.lan).toBe('connected');
    else expect(result.lan).not.toBe('ENETUNREACH');
    expect(offlineReceipt).toMatchObject({ state: 'completed', exitCode: 0 });
  });

  test('closes every inherited descriptor above stderr before the command starts', async () => {
    expect(capabilities).toMatchObject({
      available: true,
      diagnostics: {
        bashPath: '/bin/bash',
        descriptorClosureProbe: 'passed',
        descriptorClosureProbeDescriptors: DESCRIPTOR_CLOSURE_PROBE_DESCRIPTORS,
      },
      enforcement: { closedFileDescriptors: true },
    });
    const shellScript = [
      'for descriptor_path in /proc/self/fd/*; do',
      '  descriptor=${descriptor_path##*/}',
      '  case "$descriptor" in',
      "    ''|*[!0-9]*) continue ;;",
      '  esac',
      '  if [ "$descriptor" -gt 2 ] && target=$(readlink "$descriptor_path" 2>/dev/null); then',
      '    printf "%s=%s\\n" "$descriptor" "$target"',
      '  fi',
      'done',
    ].join('\n');
    const shellReceipt = await executor.execute(await policy(), {
      command: '/bin/bash',
      args: ['-c', shellScript],
    });
    expect(shellReceipt).toMatchObject({ state: 'completed', exitCode: 0, stdout: '' });

    const pythonScript = [
      'import json, os',
      'descriptors = []',
      "for name in os.listdir('/proc/self/fd'):",
      '    descriptor = int(name)',
      '    if descriptor <= 2:',
      '        continue',
      '    try:',
      "        target = os.readlink(f'/proc/self/fd/{descriptor}')",
      '    except FileNotFoundError:',
      '        continue',
      "    descriptors.append({'descriptor': descriptor, 'target': target})",
      'print(json.dumps(descriptors), end="")',
    ].join('\n');
    const pythonReceipt = await executor.execute(await policy(), {
      command: 'python3',
      args: ['-c', pythonScript],
    });

    expect(pythonReceipt).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(JSON.parse(pythonReceipt.stdout)).toEqual([]);
  });

  test('keeps mandatory Git metadata read-only when the caller supplies no additions', async () => {
    const gitConfig = path.join(fixture.workspaceRoot, '.git', 'config');
    const originalConfig = await fs.promises.readFile(gitConfig, 'utf8');
    const first = await executor.execute(await policy({ protectedWorkspacePaths: [] }), {
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

  test('bounds writable tmpfs mounts and keeps the remaining root view read-only', async () => {
    const script = [
      'import errno, json, os',
      'result = {"mounts": {}, "writes": {}, "usrLocal": os.listdir("/usr/local")}',
      'for target in ["/", "/etc", "/dev", "/proc", "/tmp", "/dev/shm", "/workspace"]:',
      '    stats = os.statvfs(target)',
      '    result["mounts"][target] = {',
      '        "bytes": stats.f_frsize * stats.f_blocks,',
      '        "readOnly": bool(stats.f_flag & os.ST_RDONLY),',
      '    }',
      'for name, target in {',
      '    "root": "/freedom-write-test",',
      '    "etc": "/etc/freedom-write-test",',
      '    "dev": "/dev/freedom-write-test",',
      '    "usrLocal": "/usr/local/freedom-write-test",',
      '}.items():',
      '    try:',
      '        open(target, "wb").write(b"unexpected")',
      '        result["writes"][name] = "unexpected"',
      '    except OSError as error:',
      '        result["writes"][name] = errno.errorcode.get(error.errno, str(error.errno))',
      'for target in ["/tmp/bounded", "/dev/shm/bounded", os.environ["HOME"] + "/home-file",',
      '               os.environ["XDG_CACHE_HOME"] + "/cache-file",',
      '               os.environ["XDG_CONFIG_HOME"] + "/config-file",',
      '               os.environ["XDG_DATA_HOME"] + "/data-file", "/workspace/workspace-file"]:',
      '    open(target, "wb").write(b"x" * 1024 * 1024)',
      'print(json.dumps(result), end="")',
    ].join('\n');
    const receipt = await executor.execute(await policy(), {
      command: 'python3',
      args: ['-c', script],
    });

    expect(receipt).toMatchObject({ state: 'completed', exitCode: 0 });
    const result = JSON.parse(receipt.stdout);
    expect(result.mounts['/'].readOnly).toBe(true);
    expect(result.mounts['/etc'].readOnly).toBe(true);
    expect(result.mounts['/dev'].readOnly).toBe(true);
    expect(result.mounts['/proc'].readOnly).toBe(true);
    expect(result.mounts['/tmp'].readOnly).toBe(false);
    expect(result.mounts['/dev/shm'].readOnly).toBe(false);
    expect(result.mounts['/workspace'].readOnly).toBe(false);
    expect(result.mounts['/tmp'].bytes).toBeGreaterThan(0);
    expect(result.mounts['/tmp'].bytes).toBeLessThanOrEqual(PRIVATE_TEMP_SIZE_BYTES);
    expect(result.mounts['/dev/shm'].bytes).toBeGreaterThan(0);
    expect(result.mounts['/dev/shm'].bytes).toBeLessThanOrEqual(SHARED_MEMORY_SIZE_BYTES);
    expect(result.writes).toEqual({
      root: 'EROFS',
      etc: 'EROFS',
      dev: 'EROFS',
      usrLocal: 'EROFS',
    });
    expect(result.usrLocal).toEqual([]);
  });

  test('denies creation of nested user namespaces', async () => {
    const receipt = await executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        'if /usr/bin/unshare --user /usr/bin/true 2>userns-error; then exit 9; else printf userns-denied; fi',
      ],
    });

    expect(receipt).toMatchObject({ state: 'completed', exitCode: 0, stdout: 'userns-denied' });
    await expect(
      fs.promises.readFile(path.join(fixture.workspaceRoot, 'userns-error'), 'utf8')
    ).resolves.toBe('unshare: unshare failed: No space left on device\n');
  });

  test('bounds output without killing a successful command and distinguishes ordinary failure', async () => {
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
      stderrTruncated: false,
      error: { code: 'COMMAND_FAILED' },
    });
  });

  test('times out and cancels the complete descendant process tree', async () => {
    const heartbeat = path.join(fixture.workspaceRoot, 'heartbeat');
    const timedPolicy = await policy({
      limits: { timeoutMs: 250, stdoutBytes: 4_096, stderrBytes: 4_096 },
    });
    const timedOut = await executor.execute(timedPolicy, {
      command: '/bin/sh',
      args: ['-c', '(while true; do printf x >> heartbeat; sleep 0.03; done) & wait'],
    });
    expect(timedOut).toMatchObject({
      state: 'timed_out',
      signal: 'SIGKILL',
      terminationGuarantee: 'namespace_scoped',
      sideEffects: 'unknown',
    });
    const timedSize = (await fs.promises.stat(heartbeat)).size;
    await delay(300);
    expect((await fs.promises.stat(heartbeat)).size).toBe(timedSize);

    const controller = new AbortController();
    const cancellationReady = path.join(fixture.workspaceRoot, 'cancellation-ready');
    const cancellation = executor.execute(await policy(), {
      command: '/bin/sh',
      args: [
        '-c',
        [
          "trap 'printf term > term-trap' TERM",
          '(while true; do printf y >> cancelled-heartbeat; sleep 0.03; done) &',
          "/usr/bin/setsid /bin/sh -c 'while true; do printf z >> detached-heartbeat; sleep 0.03; done' &",
          'printf ready > cancellation-ready',
          'wait',
        ].join('\n'),
      ],
      signal: controller.signal,
    });
    await waitForFile(cancellationReady);
    controller.abort();
    const cancelled = await cancellation;
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      signal: 'SIGKILL',
      terminationGuarantee: 'namespace_scoped',
      sideEffects: 'unknown',
    });
    const cancelledPath = path.join(fixture.workspaceRoot, 'cancelled-heartbeat');
    const detachedPath = path.join(fixture.workspaceRoot, 'detached-heartbeat');
    const cancelledSize = (await fs.promises.stat(cancelledPath)).size;
    const detachedSize = (await fs.promises.stat(detachedPath)).size;
    await expect(
      fs.promises.stat(path.join(fixture.workspaceRoot, 'term-trap'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await delay(300);
    expect((await fs.promises.stat(cancelledPath)).size).toBe(cancelledSize);
    expect((await fs.promises.stat(detachedPath)).size).toBe(detachedSize);
  });

  test('reports sandbox initialization failure without running the command unsandboxed', async () => {
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

  test('returns the command receipt when launcher staging cleanup fails', async () => {
    let stagingDirectory = null;
    const cleanupExecutor = new BubblewrapExecutor({
      removeStagingDirectory: async (directory) => {
        stagingDirectory = directory;
        const error = new Error('synthetic cleanup refusal');
        error.code = 'EACCES';
        throw error;
      },
    });
    let receipt;
    try {
      receipt = await cleanupExecutor.execute(await policy(), { command: '/usr/bin/true' });
    } finally {
      if (stagingDirectory) {
        await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
      }
    }
    expect(receipt).toMatchObject({
      state: 'completed',
      exitCode: 0,
      diagnostics: { stagingCleanupFailed: true, cause: 'EACCES' },
    });
  });

  test('sanitizes and protects a separate external Git directory', async () => {
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
    const receipt = await executor.execute(
      await policy({ authorizedGitMetadataPaths: [gitDirectory] }),
      {
        command: '/bin/sh',
        args: [
          '-c',
          'cat .git; cat /freedom-git-1/gitdir/gitdir; git status --short >/dev/null; if printf x >> .git 2>/dev/null; then exit 9; fi',
        ],
      }
    );
    expect(receipt.state).toBe('completed');
    expect(receipt.stdout).toBe('gitdir: /freedom-git-1/gitdir\n/workspace/.git\n');
    expect(receipt.stdout).not.toContain(fixture.fixtureRoot);
  });
});
