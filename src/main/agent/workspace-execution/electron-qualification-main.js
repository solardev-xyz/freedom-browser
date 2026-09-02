'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { version: freedomVersion } = require('../../../../package.json');
const { BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH } = require('./bubblewrap-backend');
const { detectElectronJavaScriptRuntime } = require('./electron-runtime');
const { createWorkspaceExecutionPolicy, insidePath } = require('./execution-policy');
const { configurePackagedQualificationUserData } = require('./qualification-user-data');
const { createWorkspaceExecutor } = require('./workspace-executor');

const QUALIFICATION_PREFIX = 'freedom-electron-sandbox-qualification-';
const DESTRUCTIVE_PREFIX = 'freedom-electron-sandbox-destructive-';
const packagedUserDataRoot = configurePackagedQualificationUserData(app);

function emit(type, value = {}) {
  process.stdout.write(`${JSON.stringify({ type, ...value })}\n`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function runGit(args) {
  const result = spawnSync('/usr/bin/git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Git fixture command failed');
}

function validateFixtureRoot(fixtureRoot, prefix) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const canonical = fs.realpathSync(fixtureRoot);
  if (
    canonical === temporaryRoot ||
    !insidePath(temporaryRoot, canonical) ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith(prefix)
  ) {
    throw new Error('Refusing Electron qualification outside its validated temporary fixture');
  }
  return canonical;
}

function validateShortIpcRoot(ipcRoot) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const canonical = fs.realpathSync(ipcRoot);
  if (
    canonical === temporaryRoot ||
    !insidePath(temporaryRoot, canonical) ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith('freedom-e-ipc-')
  ) {
    throw new Error('Refusing Electron IPC qualification outside its validated temporary fixture');
  }
  return canonical;
}

async function waitForFile(filePath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size > 0) return stats;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}

function enumerateProcessDescriptors() {
  if (process.platform !== 'linux') return [];
  const descriptors = [];
  for (const name of fs.readdirSync('/proc/self/fd')) {
    if (!/^\d+$/.test(name)) continue;
    const descriptor = Number.parseInt(name, 10);
    if (!Number.isSafeInteger(descriptor) || descriptor <= 2) continue;
    try {
      descriptors.push({
        descriptor,
        target: fs.readlinkSync(`/proc/self/fd/${descriptor}`),
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return descriptors.sort((left, right) => left.descriptor - right.descriptor);
}

function receiptEvidence(name, receipt) {
  emit('receipt', {
    name,
    backend: receipt.backend,
    state: receipt.state,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    stdoutBytes: Buffer.byteLength(receipt.stdout),
    stderrBytes: Buffer.byteLength(receipt.stderr),
    stderrDiagnostic: receipt.stderr ? receipt.stderr.slice(0, 256) : null,
    stdoutTruncated: receipt.stdoutTruncated,
    stderrTruncated: receipt.stderrTruncated,
    terminationGuarantee: receipt.terminationGuarantee,
    sideEffects: receipt.sideEffects,
    survivorsPossible: receipt.survivorsPossible,
    completeDescendantTermination: receipt.completeDescendantTermination,
    terminationScope: receipt.terminationScope || null,
    capabilities: receipt.capabilities || null,
    diagnostics: receipt.diagnostics || null,
  });
}

function assertExecutionReceipt(name, receipt, state) {
  receiptEvidence(name, receipt);
  const expectedBackend = process.platform === 'linux' ? 'linux-bubblewrap' : 'macos-seatbelt';
  const expectedGuarantee = process.platform === 'linux' ? 'namespace_scoped' : 'best_effort';
  assertCondition(receipt.backend === expectedBackend, `${name} reported the wrong backend`);
  assertCondition(
    receipt.state === state,
    `${name} finished as ${receipt.state}: ${receipt.stderr}`
  );
  assertCondition(
    receipt.terminationGuarantee === expectedGuarantee,
    `${name} reported the wrong termination guarantee`
  );
  assertCondition(
    receipt.sideEffects === 'unknown',
    `${name} overstated the side effects of a spawned command`
  );
  assertCondition(
    receipt.capabilities?.backend === expectedBackend,
    `${name} omitted backend capability metadata`
  );
  assertCondition(
    receipt.capabilities?.cancellationGuarantee === expectedGuarantee,
    `${name} omitted cancellation capability metadata`
  );
  if (process.platform === 'linux') {
    assertCondition(
      receipt.survivorsPossible === false &&
        receipt.completeDescendantTermination === true &&
        receipt.terminationScope === 'pid_namespace',
      `${name} omitted namespace-scoped descendant termination metadata`
    );
    assertCondition(
      receipt.capabilities?.survivorsPossible === false &&
        receipt.capabilities?.completeDescendantTermination === true,
      `${name} omitted namespace-scoped capability metadata`
    );
  } else {
    assertCondition(
      receipt.survivorsPossible === true &&
        receipt.completeDescendantTermination === false &&
        receipt.terminationScope === 'original_process_group',
      `${name} omitted the machine-readable surviving-descendant warning`
    );
    assertCondition(
      receipt.capabilities?.survivorsPossible === true &&
        receipt.capabilities?.completeDescendantTermination === false,
      `${name} omitted surviving-descendant capability metadata`
    );
    assertCondition(
      receipt.diagnostics?.processGroupFinalKillAttempted === true,
      `${name} omitted final process-group cleanup diagnostics`
    );
  }
}

async function createWebsiteFixture(prefix = QUALIFICATION_PREFIX) {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  let completed = false;
  try {
    validateFixtureRoot(fixtureRoot, prefix);
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    const outsideRoot = path.join(fixtureRoot, 'outside');
    await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
    await fs.promises.mkdir(outsideRoot, { mode: 0o700 });
    const files = {
      'index.html':
        '<!doctype html>\n<html><head><link rel="stylesheet" href="style.css"></head><body><h1>Sandbox Fixture</h1><script src="app.js"></script></body></html>\n',
      'style.css': 'body{font-family:sans-serif;color:#123456}\n',
      'app.js': "document.documentElement.dataset.ready = 'true';\n",
      'package.json': `${JSON.stringify(
        {
          name: 'freedom-managed-sandbox-fixture',
          private: true,
          scripts: { build: 'node build.js' },
        },
        null,
        2
      )}\n`,
      'build.js': [
        "'use strict';",
        "const assert = require('assert');",
        "const fs = require('fs');",
        "const path = require('path');",
        "const html = fs.readFileSync('index.html', 'utf8').replace('Sandbox Fixture', 'Qualified Sandbox Fixture');",
        "const css = fs.readFileSync('style.css', 'utf8').replace('body{', 'body {\\n  ').replace(';color:', ';\\n  color:').replace('}', ';\\n}');",
        "const javascript = fs.readFileSync('app.js', 'utf8') + \"document.documentElement.dataset.built = 'true';\\n\";",
        "fs.writeFileSync('index.html', html);",
        "fs.writeFileSync('style.css', css);",
        "fs.writeFileSync('app.js', javascript);",
        "fs.mkdirSync('dist', { recursive: true });",
        "for (const name of ['index.html', 'style.css', 'app.js']) fs.copyFileSync(name, path.join('dist', name));",
        "assert.match(fs.readFileSync('dist/index.html', 'utf8'), /Qualified Sandbox Fixture/);",
        "assert.match(fs.readFileSync('dist/style.css', 'utf8'), /body \\{/);",
        "assert.match(fs.readFileSync('dist/app.js', 'utf8'), /dataset.built/);",
        "fs.writeFileSync('dist/validation.json', JSON.stringify({ files: fs.readdirSync('dist').sort(), valid: true }));",
        "process.stdout.write(JSON.stringify({ inspected: ['index.html', 'style.css', 'app.js'], modified: true, built: true, validated: true }));",
      ].join('\n'),
    };
    for (const [name, contents] of Object.entries(files)) {
      await fs.promises.writeFile(path.join(workspaceRoot, name), contents);
    }
    runGit(['init', '--quiet', workspaceRoot]);
    runGit(['-C', workspaceRoot, 'add', '.']);
    runGit([
      '-C',
      workspaceRoot,
      '-c',
      'user.name=Freedom Qualification',
      '-c',
      'user.email=qualification@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'managed website fixture',
    ]);
    const outsideCanary = path.join(outsideRoot, 'canary.txt');
    await fs.promises.writeFile(outsideCanary, 'outside-canary\n');
    await fs.promises.symlink(outsideCanary, path.join(workspaceRoot, 'escape-link'));
    completed = true;
    return { fixtureRoot, workspaceRoot, outsideRoot, outsideCanary };
  } finally {
    if (!completed) {
      validateFixtureRoot(fixtureRoot, prefix);
      await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    }
  }
}

function createPolicy(fixture, runtime, limits = {}) {
  return createWorkspaceExecutionPolicy({
    workspaceRoot: fixture.workspaceRoot,
    nodeRuntimeRoot: null,
    electronRuntime: runtime,
    environment: {
      set: {
        ELECTRON_RUN_AS_NODE: '1',
        FREEDOM_JAVASCRIPT_RUNTIME: runtime.sandboxExecutablePath,
      },
    },
    limits: {
      timeoutMs: limits.timeoutMs || 10_000,
      stdoutBytes: limits.stdoutBytes || 64 * 1024,
      stderrBytes: limits.stderrBytes || 64 * 1024,
    },
  });
}

async function qualifyWebsiteWorkload(executor, policy, runtime, fixture) {
  const gitConfig = path.join(fixture.workspaceRoot, '.git', 'config');
  const originalGitConfig = await fs.promises.readFile(gitConfig, 'utf8');
  const receipt = await executor.execute(policy, {
    command: runtime.sandboxExecutablePath,
    args: ['build.js'],
  });
  assertExecutionReceipt('website-build', receipt, 'completed');
  const result = JSON.parse(receipt.stdout);
  assertCondition(
    result.modified && result.built && result.validated,
    'Website workload was incomplete'
  );
  const validation = JSON.parse(
    await fs.promises.readFile(path.join(fixture.workspaceRoot, 'dist', 'validation.json'), 'utf8')
  );
  assertCondition(validation.valid === true, 'Website validation output was not produced');

  const gitReceipt = await executor.execute(policy, {
    command: '/bin/sh',
    args: [
      '-c',
      'git status --short >/dev/null; if printf mutation >> .git/config 2>/dev/null; then printf unexpected; else printf protected; fi',
    ],
  });
  assertExecutionReceipt('git-protection', gitReceipt, 'completed');
  assertCondition(gitReceipt.stdout === 'protected', 'Git metadata write unexpectedly succeeded');
  assertCondition(
    (await fs.promises.readFile(gitConfig, 'utf8')) === originalGitConfig,
    'Git configuration changed during qualification'
  );
  emit('website-workload', { result, validation });
}

async function qualifyInheritedDescriptorClosure(executor, policy) {
  if (process.platform !== 'linux') return;
  const electronMainDescriptors = enumerateProcessDescriptors();
  assertCondition(
    electronMainDescriptors.length > 0,
    'Electron main did not expose any Chromium descriptors to the qualification probe'
  );
  emit('electron-main-descriptors', { descriptors: electronMainDescriptors });

  const shellScript = [
    'for descriptor_path in /proc/self/fd/*; do',
    '  descriptor=${descriptor_path##*/}',
    '  case "$descriptor" in',
    "    ''|*[!0-9]*) continue ;;",
    '  esac',
    '  if [ "$descriptor" -gt 2 ] && target=$(readlink "$descriptor_path" 2>/dev/null); then',
    '    printf "%s\\t%s\\n" "$descriptor" "$target"',
    '  fi',
    'done',
  ].join('\n');
  const shellReceipt = await executor.execute(policy, {
    command: '/bin/bash',
    args: ['-c', shellScript],
  });
  assertExecutionReceipt('inherited-descriptor-closure-shell', shellReceipt, 'completed');
  const shellDescriptors = shellReceipt.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [descriptor, ...target] = line.split('\t');
      return { descriptor: Number.parseInt(descriptor, 10), target: target.join('\t') };
    });
  assertCondition(
    shellDescriptors.length === 0,
    `Electron qualification shell inherited host descriptors: ${JSON.stringify(shellDescriptors).slice(0, 512)}`
  );

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
  const pythonReceipt = await executor.execute(policy, {
    command: '/usr/bin/python3',
    args: ['-c', pythonScript],
  });
  assertExecutionReceipt('inherited-descriptor-closure-python', pythonReceipt, 'completed');
  const pythonDescriptors = JSON.parse(pythonReceipt.stdout);
  assertCondition(
    Array.isArray(pythonDescriptors) && pythonDescriptors.length === 0,
    `Electron qualification Python inherited host descriptors: ${JSON.stringify(pythonDescriptors).slice(0, 512)}`
  );
  emit('inherited-descriptor-closure', {
    electronMainDescriptors,
    shellDescriptors,
    pythonDescriptors,
  });
}

async function qualifyBoundary(executor, policy, runtime, fixture) {
  const tcpServer = net.createServer((socket) => socket.end('host-service'));
  const ipcRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-e-ipc-'));
  validateShortIpcRoot(ipcRoot);
  const socketPath = path.join(ipcRoot, 'host.sock');
  const socketServer = net.createServer((socket) => socket.end('host-ipc'));
  const abstractName = `freedom-electron-${crypto.randomUUID()}`;
  const abstractServer = net.createServer((socket) => socket.end('host-abstract-ipc'));
  const outsideWrite = path.join(fixture.outsideRoot, 'written.txt');
  const appImagePath = runtime.diagnostics.appImage?.appImagePath;
  const appImageBefore = appImagePath ? await fs.promises.stat(appImagePath) : null;
  const forbiddenNode =
    process.env.FREEDOM_QUALIFICATION_FORBIDDEN_NODE || process.env.npm_node_execpath;
  assertCondition(forbiddenNode, 'Qualification did not identify a forbidden host Node runtime');
  const script = [
    "const dns = require('dns');",
    "const fs = require('fs');",
    "const net = require('net');",
    "const { spawnSync } = require('child_process');",
    'const [outside, outsideWrite, socketPath, port, forbiddenNode, runtimePath, packageFile, abstractName] = process.argv.slice(1);',
    'const result = { environment: {}, path: process.env.PATH, activeRuntime: process.execPath };',
    "for (const [name, target] of [['directRead', outside], ['symlinkRead', 'escape-link']]) {",
    "  try { fs.readFileSync(target); result[name] = 'unexpected'; } catch (error) { result[name] = error.code; }",
    '}',
    "try { fs.writeFileSync(outsideWrite, 'escaped'); result.outsideWrite = 'unexpected'; } catch (error) { result.outsideWrite = error.code; }",
    "try { fs.linkSync(outside, 'dynamic-hardlink'); result.hardlink = 'unexpected'; } catch (error) { result.hardlink = error.code; }",
    "try { fs.appendFileSync(runtimePath, 'mutation'); result.runtimeWrite = 'unexpected'; } catch (error) { result.runtimeWrite = error.code; }",
    'result.packageVisible = fs.existsSync(packageFile);',
    "try { fs.appendFileSync(packageFile, 'mutation'); result.packageWrite = result.packageVisible ? 'unexpected' : 'private-shadow'; if (!result.packageVisible) fs.unlinkSync(packageFile); } catch (error) { result.packageWrite = error.code; }",
    "const subprocess = spawnSync('/bin/sh', ['-c', 'cat \"$1\" >/dev/null', 'sh', outside]);",
    "result.subprocessRead = subprocess.status === 0 ? 'unexpected' : (subprocess.error?.code || subprocess.status);",
    "const fallbackNode = spawnSync(forbiddenNode, ['-e', 'process.stdout.write(\"unexpected\")']);",
    "result.fallbackNode = fallbackNode.status === 0 ? 'unexpected' : (fallbackNode.error?.code || fallbackNode.signal || 'not-started');",
    "for (const name of ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {",
    '  result.environment[name] = process.env[name];',
    "  fs.writeFileSync(require('path').join(process.env[name], 'qualification-private'), name);",
    '}',
    'const connect = (options) => new Promise((resolve) => {',
    '  const socket = net.createConnection(options);',
    "  socket.setTimeout(750, () => socket.destroy(new Error('timeout')));",
    "  socket.once('connect', () => { socket.destroy(); resolve('unexpected'); });",
    "  socket.once('error', (error) => resolve(error.code || error.message));",
    '});',
    '(async () => {',
    "  result.localhost = await connect({ host: '127.0.0.1', port: Number(port) });",
    "  result.external = await connect({ host: '1.1.1.1', port: 53 });",
    '  result.unixSocket = await connect(socketPath);',
    "  result.abstractSocket = abstractName ? await connect('\\0' + abstractName) : 'not-applicable';",
    "  result.dns = await new Promise((resolve) => dns.lookup('example.com', (error) => resolve(error ? error.code : 'unexpected')));",
    '  process.stdout.write(JSON.stringify(result));',
    '})();',
  ].join('\n');
  let receipt;
  try {
    await listen(tcpServer, { host: '127.0.0.1', port: 0 });
    await listen(socketServer, socketPath);
    if (process.platform === 'linux') await listen(abstractServer, `\0${abstractName}`);
    receipt = await executor.execute(policy, {
      command: runtime.sandboxExecutablePath,
      args: [
        '-e',
        script,
        fixture.outsideCanary,
        outsideWrite,
        socketPath,
        String(tcpServer.address().port),
        forbiddenNode,
        runtime.sandboxExecutablePath,
        runtime.diagnostics.appImage?.appImagePath || fixture.outsideCanary,
        process.platform === 'linux' ? abstractName : '',
      ],
    });
  } finally {
    await Promise.all([
      closeServer(tcpServer),
      closeServer(socketServer),
      closeServer(abstractServer),
    ]);
    validateShortIpcRoot(ipcRoot);
    await fs.promises.rm(ipcRoot, { recursive: true, force: true });
  }
  assertExecutionReceipt('boundary-denials', receipt, 'completed');
  const result = JSON.parse(receipt.stdout);
  for (const field of [
    'directRead',
    'symlinkRead',
    'outsideWrite',
    'hardlink',
    'runtimeWrite',
    'packageWrite',
    'subprocessRead',
    'fallbackNode',
    'localhost',
    'external',
    'unixSocket',
    'dns',
  ]) {
    assertCondition(result[field] !== 'unexpected', `${field} escaped the workspace boundary`);
  }
  if (process.platform === 'linux') {
    assertCondition(result.abstractSocket !== 'unexpected', 'abstractSocket escaped the boundary');
  }
  assertCondition(
    result.activeRuntime === runtime.sandboxExecutablePath,
    `JavaScript used ${result.activeRuntime} instead of the mounted packaged runtime`
  );
  if (appImageBefore) {
    const appImageAfter = await fs.promises.stat(appImagePath);
    assertCondition(
      result.packageVisible === false &&
        appImageAfter.size === appImageBefore.size &&
        appImageAfter.mtimeMs === appImageBefore.mtimeMs,
      'Host AppImage was visible or changed through the sandbox'
    );
  }
  assertCondition(
    result.path ===
      (process.platform === 'linux' ? BUBBLEWRAP_SYSTEM_TOOLCHAIN_PATH : '/usr/bin:/bin'),
    `Electron qualification received an unexpected toolchain PATH: ${result.path}`
  );
  assertCondition(
    (await fs.promises.readFile(fixture.outsideCanary, 'utf8')) === 'outside-canary\n',
    'Outside canary changed'
  );
  await fs.promises.stat(outsideWrite).then(
    () => {
      throw new Error('Outside write artifact exists');
    },
    (error) => assertCondition(error.code === 'ENOENT', 'Outside write check failed')
  );
  if (process.platform === 'darwin') {
    const privateRoots = new Set(
      Object.values(result.environment).map((value) => path.dirname(value))
    );
    assertCondition(
      privateRoots.size === 1,
      'Private environment paths did not share one execution root'
    );
    const [privateRoot] = privateRoots;
    assertCondition(
      !insidePath(os.homedir(), privateRoot),
      'Private environment reused the host home'
    );
    await fs.promises.stat(privateRoot).then(
      () => {
        throw new Error('Private execution root survived receipt cleanup');
      },
      (error) => assertCondition(error.code === 'ENOENT', 'Private execution cleanup check failed')
    );
  } else {
    assertCondition(
      result.environment.HOME === '/tmp/home' &&
        result.environment.TMPDIR === '/tmp' &&
        result.environment.XDG_CACHE_HOME === '/tmp/cache' &&
        result.environment.XDG_CONFIG_HOME === '/tmp/config' &&
        result.environment.XDG_DATA_HOME === '/tmp/data',
      'Bubblewrap did not use its private temporary mount'
    );
  }
  emit('boundary-denials', { result });
}

async function qualifyLifecycle(executor, runtime, fixture) {
  const outputPolicy = await createPolicy(fixture, runtime, {
    stdoutBytes: 512,
    stderrBytes: 512,
  });
  const outputReceipt = await executor.execute(outputPolicy, {
    command: runtime.sandboxExecutablePath,
    args: ['-e', "process.stdout.write('o'.repeat(4096)); process.stderr.write('e'.repeat(4096));"],
  });
  assertExecutionReceipt('bounded-output', outputReceipt, 'completed');
  assertCondition(outputReceipt.stdoutTruncated, 'stdout was not truncated');
  assertCondition(outputReceipt.stderrTruncated, 'stderr was not truncated');
  assertCondition(Buffer.byteLength(outputReceipt.stdout) === 512, 'stdout limit was inaccurate');
  assertCondition(Buffer.byteLength(outputReceipt.stderr) === 512, 'stderr limit was inaccurate');

  const failedReceipt = await executor.execute(await createPolicy(fixture, runtime), {
    command: runtime.sandboxExecutablePath,
    args: ['-e', "process.stderr.write('ordinary-failure'); process.exit(7)"],
  });
  assertExecutionReceipt('failed-command', failedReceipt, 'failed');
  assertCondition(failedReceipt.exitCode === 7, 'Failed command exit code was inaccurate');
  assertCondition(failedReceipt.stderrTruncated === false, 'Failed command stderr was truncated');
  assertCondition(
    failedReceipt.stderr.endsWith('ordinary-failure'),
    'Failed command stderr marker was lost'
  );
  assertCondition(
    failedReceipt.error?.code === 'COMMAND_FAILED',
    'Failed command error was omitted'
  );

  const timeoutPolicy = await createPolicy(fixture, runtime, { timeoutMs: 250 });
  const timeoutReceipt = await executor.execute(timeoutPolicy, {
    command: runtime.sandboxExecutablePath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  });
  assertExecutionReceipt('timeout', timeoutReceipt, 'timed_out');

  const runtimeLifetimeMarker = path.join(fixture.workspaceRoot, 'runtime-lifetime-ready');
  const runtimeController = new AbortController();
  const runtimeExecution = executor.execute(await createPolicy(fixture, runtime), {
    command: runtime.sandboxExecutablePath,
    args: [
      '-e',
      "require('fs').writeFileSync('runtime-lifetime-ready', process.execPath); setInterval(() => {}, 1000)",
    ],
    signal: runtimeController.signal,
  });
  await waitForFile(runtimeLifetimeMarker);
  assertCondition(
    (await fs.promises.realpath(runtime.executablePath)) === runtime.executablePath,
    'Packaged runtime disappeared during sandbox execution'
  );
  runtimeController.abort();
  const runtimeLifetimeReceipt = await runtimeExecution;
  assertExecutionReceipt('runtime-mount-lifetime', runtimeLifetimeReceipt, 'cancelled');
  await fs.promises.stat(runtime.runtimeRoot);
  emit('runtime-mount-lifetime', {
    remainedAvailableThroughChildCompletion: true,
    observedSandboxExecutable: await fs.promises.readFile(runtimeLifetimeMarker, 'utf8'),
  });

  const normalHeartbeat = path.join(fixture.workspaceRoot, 'electron-normal-heartbeat');
  const normalReceipt = await executor.execute(await createPolicy(fixture, runtime), {
    command: '/bin/sh',
    args: [
      '-c',
      [
        '(trap \'\' TERM; count=0; while [ "$count" -lt 100 ]; do printf x >> electron-normal-heartbeat; count=$((count + 1)); sleep 0.03; done) </dev/null >/dev/null 2>&1 &',
        'printf \'%s\' "$!" > electron-normal.pid',
        'while [ ! -s electron-normal-heartbeat ]; do sleep 0.02; done',
      ].join('\n'),
    ],
  });
  assertExecutionReceipt('normal-descendant-cleanup', normalReceipt, 'completed');
  const normalSize = (await waitForFile(normalHeartbeat)).size;
  await delay(300);
  assertCondition(
    (await fs.promises.stat(normalHeartbeat)).size === normalSize,
    'Normal-exit same-group descendant survived final cleanup'
  );

  const cancellationHeartbeat = path.join(fixture.workspaceRoot, 'electron-cancellation-heartbeat');
  const controller = new AbortController();
  const cancellation = executor.execute(await createPolicy(fixture, runtime), {
    command: '/bin/sh',
    args: [
      '-c',
      [
        "trap '' TERM",
        '(trap \'\' TERM; count=0; while [ "$count" -lt 100 ]; do printf x >> electron-cancellation-heartbeat; count=$((count + 1)); sleep 0.03; done) </dev/null >/dev/null 2>&1 &',
        'printf \'%s\' "$!" > electron-cancellation.pid',
        'wait',
      ].join('\n'),
    ],
    signal: controller.signal,
  });
  await Promise.all([
    waitForFile(cancellationHeartbeat),
    waitForFile(path.join(fixture.workspaceRoot, 'electron-cancellation.pid')),
  ]);
  const abortedAt = Date.now();
  controller.abort();
  const cancellationReceipt = await cancellation;
  assertExecutionReceipt('cancellation', cancellationReceipt, 'cancelled');
  const cancellationDuration = Date.now() - abortedAt;
  assertCondition(
    process.platform === 'linux'
      ? cancellationDuration < 2_500
      : cancellationDuration >= 800 && cancellationDuration < 2_500,
    `Cancellation took ${cancellationDuration}ms outside its backend bound`
  );
  emit('cancellation-escalation', { durationMs: cancellationDuration });
  const cancellationSize = (await fs.promises.stat(cancellationHeartbeat)).size;
  await delay(300);
  assertCondition(
    (await fs.promises.stat(cancellationHeartbeat)).size === cancellationSize,
    'Cancelled same-group descendant survived final cleanup'
  );
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
      throw new Error('Refusing to signal a detached PID without its qualification token');
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
  throw new Error('Detached qualification process did not exit within the cleanup bound');
}

async function runDetachedQualification(executor, runtime) {
  const fixture = await createWebsiteFixture(DESTRUCTIVE_PREFIX);
  validateFixtureRoot(fixture.fixtureRoot, DESTRUCTIVE_PREFIX);
  const token = `freedom-electron-detached-${crypto.randomUUID()}`;
  const pidFile = path.join(fixture.workspaceRoot, 'detached.pid');
  const resultFile = path.join(fixture.workspaceRoot, 'detached-result.json');
  const heartbeat = path.join(fixture.workspaceRoot, 'detached-heartbeat');
  let detachedPid = null;
  let controller = null;
  let execution = null;
  let watchdogError = null;
  try {
    const script = [
      'import json, os, pathlib, socket, sys, time',
      'outside, pid_file, result_file, heartbeat, token = sys.argv[1:]',
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
      '    for name, address in [("localhost", ("127.0.0.1", 9)), ("external", ("1.1.1.1", 53))]:',
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
    controller = new AbortController();
    execution = executor.execute(await createPolicy(fixture, runtime), {
      command: '/usr/bin/python3',
      args: ['-c', script, fixture.outsideCanary, pidFile, resultFile, heartbeat, token],
      signal: controller.signal,
    });
    await waitForFile(pidFile);
    detachedPid = Number.parseInt(await fs.promises.readFile(pidFile, 'utf8'), 10);
    assertCondition(Number.isSafeInteger(detachedPid) && detachedPid > 1, 'Invalid detached PID');
    await waitForFile(resultFile);
    const result = JSON.parse(await fs.promises.readFile(resultFile, 'utf8'));
    controller.abort();
    const receipt = await execution;
    assertExecutionReceipt('detached-setsid-cancellation', receipt, 'cancelled');
    if (process.platform === 'darwin') {
      assertCondition(
        processCommand(detachedPid).includes(token),
        'setsid descendant did not survive best-effort group cancellation'
      );
    }
    assertCondition(result.outsideRead !== 'unexpected', 'Detached child read outside boundary');
    assertCondition(result.localhost !== 0, 'Detached child reached localhost');
    assertCondition(result.external !== 0, 'Detached child reached external network');
    assertCondition(result.dns !== 'unexpected', 'Detached child resolved DNS');
    const size = (await waitForFile(heartbeat)).size;
    await delay(150);
    const laterSize = (await fs.promises.stat(heartbeat)).size;
    assertCondition(
      process.platform === 'linux' ? laterSize === size : laterSize > size,
      process.platform === 'linux'
        ? 'Detached descendant continued after namespace teardown'
        : 'Detached descendant did not remain operational after group cancellation'
    );
    emit('detached-descendant', {
      survived: process.platform !== 'linux',
      containment: result,
      pidRecorded: true,
    });
  } finally {
    controller?.abort();
    if (execution) {
      try {
        await Promise.race([
          execution,
          delay(3_000).then(() => {
            throw new Error('Detached qualification root did not stop within its watchdog bound');
          }),
        ]);
      } catch (error) {
        watchdogError = error;
      }
    }
    if (detachedPid && process.platform === 'darwin') {
      await cleanupRecordedProcess(detachedPid, token);
    }
    validateFixtureRoot(fixture.fixtureRoot, DESTRUCTIVE_PREFIX);
    await fs.promises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
  if (watchdogError) throw watchdogError;
}

async function runQualification() {
  const requiredGate =
    process.platform === 'linux'
      ? process.env.FREEDOM_REQUIRE_BWRAP === '1'
      : process.platform === 'darwin' && process.env.FREEDOM_REQUIRE_SEATBELT === '1';
  if (!requiredGate) {
    throw new Error(
      'Electron qualification requires Linux/Bubblewrap or macOS/Seatbelt with its explicit gate'
    );
  }
  const runtime = await detectElectronJavaScriptRuntime({
    freedomVersion,
    packaged: app.isPackaged,
  });
  emit('electron-runtime', runtime);
  if (!runtime.available) throw new Error(runtime.denial.code);
  const entryPath = await fs.promises.realpath(__filename);
  if (app.isPackaged) {
    assertCondition(
      entryPath.includes(`${path.sep}app.asar${path.sep}`),
      'Packaged entry did not load from app.asar'
    );
    if (process.platform === 'darwin') {
      assertCondition(
        runtime.applicationBundleRoot ===
          (await fs.promises.realpath(path.dirname(path.dirname(path.dirname(process.execPath))))),
        'Runtime detector did not select the packaged Freedom application'
      );
    } else {
      assertCondition(
        runtime.runtimeRoot === (await fs.promises.realpath(path.dirname(process.resourcesPath))),
        'Runtime detector did not select the packaged Linux application tree'
      );
    }
  }
  emit('qualification-context', {
    packaged: app.isPackaged,
    entryPath,
    processExecPath: process.execPath,
    runtimeRoot: runtime.runtimeRoot,
    applicationBundleRoot: runtime.applicationBundleRoot,
    sandboxExecutablePath: runtime.sandboxExecutablePath,
    layout: runtime.layout,
    userDataRoot: packagedUserDataRoot,
  });

  const executor = createWorkspaceExecutor({ platform: process.platform });
  const capabilities = await executor.detectCapabilities({ force: true });
  emit('capabilities', capabilities);
  if (!capabilities.available) throw new Error(capabilities.denial.code);

  if (process.env.FREEDOM_SANDBOX_DESTRUCTIVE === '1') {
    await runDetachedQualification(executor, runtime);
    emit('qualification-complete', { mode: 'destructive', passed: true });
    return;
  }

  const fixture = await createWebsiteFixture();
  try {
    const policy = await createPolicy(fixture, runtime);
    assertCondition(
      policy.filesystem.runtimeRoots.length === 1 &&
        policy.filesystem.runtimeRoots[0].id === 'electron' &&
        policy.filesystem.runtimeRoots[0].sourcePath === runtime.runtimeRoot &&
        policy.filesystem.runtimeRoots[0].sandboxExecutablePath === runtime.sandboxExecutablePath,
      'Electron qualification exposed a fallback JavaScript runtime'
    );
    await qualifyInheritedDescriptorClosure(executor, policy);
    await qualifyWebsiteWorkload(executor, policy, runtime, fixture);
    await qualifyBoundary(executor, policy, runtime, fixture);
    await qualifyLifecycle(executor, runtime, fixture);
    emit('capability-matrix', {
      electronMainProcess: true,
      electronRunAsNode: true,
      exactPackagedRuntimeReadOnly: true,
      workspaceReadWrite: true,
      gitMetadataReadOnly: true,
      outsideFilesystemDenied: true,
      inheritedFileDescriptorsClosed: process.platform === 'linux' ? true : 'not_applicable',
      privateExecutionStorage: true,
      networkDnsLocalhostDenied: true,
      unixSocketDenied: true,
      outputLimits: true,
      wallTimeout: true,
      descendantCleanup: process.platform === 'linux' ? 'namespace_scoped' : 'best_effort',
      completeDescendantTermination: process.platform === 'linux',
      survivorsPossible: process.platform !== 'linux',
    });
    emit('qualification-complete', { mode: 'ordinary', passed: true });
  } finally {
    validateFixtureRoot(fixture.fixtureRoot, QUALIFICATION_PREFIX);
    await fs.promises.rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

app
  .whenReady()
  .then(runQualification)
  .then(
    () => app.exit(0),
    (error) => {
      emit('qualification-error', {
        code: error?.code || 'ELECTRON_QUALIFICATION_FAILED',
        message: String(error?.message || error),
      });
      app.exit(1);
    }
  );

module.exports = {
  cleanupRecordedProcess,
  createWebsiteFixture,
  validateFixtureRoot,
  validateShortIpcRoot,
};
