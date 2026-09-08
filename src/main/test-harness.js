/**
 * Renderer E2E test harness (Playwright integration)
 *
 * Activated only when `process.env.FREEDOM_TEST_MODE === '1'`. The harness
 * is fully inert otherwise — `installTestHarness` is a no-op when test
 * mode is off, and nothing in this file runs at require time.
 *
 * Responsibilities:
 *   1. Register stub `bzz:` / `ipfs:` / `ipns:` protocol handlers backed by
 *      an in-memory fixture map, so tests can assert against deterministic
 *      content without spinning up Bee or Kubo.
 *   2. Override the ENS resolver IPC handlers with a fixture-driven stub
 *      (real ENS resolution would need network and an Ethereum RPC).
 *   3. Override the Swarm content-probe IPCs so navigation gating doesn't
 *      try to HEAD-poll a non-existent Bee gateway.
 *   4. Override Bee / IPFS / Radicle start/stop IPCs to no-ops, so a
 *      misclick in a test doesn't spawn the real binaries against a temp
 *      `userData` directory.
 *   5. Seed `service-registry` with a "running" status for Bee and IPFS so
 *      the chrome doesn't spend the test session in a "Stopped" UI state.
 *   6. Register `test:*` IPC channels and a `globalThis.__FREEDOM_TEST_HARNESS__`
 *      shim so the Playwright runner can drive fixtures via either
 *      `electronApp.evaluate(...)` or `page.evaluate(... ipcRenderer ...)`.
 *
 * Architectural placement: this lives in `src/main/` because every
 * function it touches (protocol handlers, IPC handlers, service registry)
 * is main-process state. A `src/main/testing/` subdirectory would be
 * justified once the harness grows additional helpers; for now a single
 * file matches the conventions in `src/main/`.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const log = require('./logger');
const {
  runWithPrivateLogContext,
  redactUrlForLog,
} = require('./private/private-log-context');
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const IPC = require('../shared/ipc-channels');
const { success, failure } = require('./ipc-contract');
const { updateService, MODE, setStatusMessage } = require('./service-registry');
const {
  automationController,
  registerAutomationWebContents,
  automationTabIdForRenderer,
} = require('./automation/runtime');

const TEST_MODE_ENABLED = process.env.FREEDOM_TEST_MODE === '1';
const APP_EXIT_FIXTURE_PREFIX = 'freedom-agent-app-exit-';
const APP_EXIT_MODES = new Set(['idle', 'running', 'detached']);
const APP_EXIT_TOKEN_PATTERN = /^freedom-agent-app-exit-[a-f0-9]{24}$/;
const APP_EXIT_FAILURE_INJECTIONS = new Set([null, 'after_detached_process_created']);

function isTestMode() {
  return TEST_MODE_ENABLED;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPath(candidate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(candidate)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for Agent exit fixture ${path.basename(candidate)}`);
}

async function pickAgentExitPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function validatedAgentExitRoot() {
  const root = fs.realpathSync(app.getPath('userData'));
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (
    path.dirname(root) !== temporaryRoot ||
    !path.basename(root).startsWith(APP_EXIT_FIXTURE_PREFIX)
  ) {
    throw new Error('Agent application-exit fixture requires an owned temporary user-data root');
  }
  return root;
}

function writeAgentExitEvidence(target, value) {
  try {
    const captured = { ...value };
    if (value.receipt) {
      captured.receipt = { ...value.receipt };
      captured.outputCapture = {};
      for (const field of ['stdout', 'stderr']) {
        const bytes = Buffer.from(value.receipt[field] || '');
        if (bytes.length > 4096) {
          captured.receipt[field] = bytes.subarray(0, 4096).toString('utf8');
          captured.outputCapture[`${field}BytesOmitted`] = bytes.length - 4096;
        }
      }
    }
    const bytes = Buffer.from(JSON.stringify({ recordedAt: Date.now(), ...captured }));
    if (bytes.length > 256 * 1024) throw new Error('Agent exit evidence exceeded its byte limit');
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  } catch {
    // An observation failure must not change native execution or its result.
    // The external driver requires these files and reports missing evidence.
    log.warn('[TestHarness] Could not persist Agent exit evidence');
  }
}

function observeAgentExitExecution(executor, command, receiptPath, supervisorPath) {
  const originalExecute = executor.execute;
  const originalSpawn = executor.spawnProcess;
  const restore = () => {
    if (executor.execute === execute) executor.execute = originalExecute;
    if (executor.spawnProcess === spawn) executor.spawnProcess = originalSpawn;
  };
  function spawn(executable, args, options) {
    const child = originalSpawn.call(this, executable, args, options);
    if (args.includes(command) && args[0] === '--supervise') {
      if (executor.spawnProcess === spawn) executor.spawnProcess = originalSpawn;
      writeAgentExitEvidence(supervisorPath, { pid: child.pid ?? null, executable });
    }
    return child;
  }
  async function execute(policy, request) {
    const target = request.command === '/bin/sh' && request.args?.[2] === 'freedom-workspace' &&
      request.args?.[4] === command;
    if (!target) return originalExecute.call(this, policy, request);
    try {
      const receipt = await originalExecute.call(this, policy, request);
      writeAgentExitEvidence(receiptPath, { receipt });
      return receipt;
    } finally {
      restore();
    }
  }
  executor.execute = execute;
  if (typeof originalSpawn === 'function') executor.spawnProcess = spawn;
  return restore;
}

async function prepareAgentExitScenario(agentRuntime, request) {
  if (!isTestMode()) throw new Error('Agent exit fixture requires test mode');
  const mode = request?.mode;
  const token = request?.token;
  const expirySeconds = request?.expirySeconds ?? 15;
  if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds > 15) {
    throw new Error('Agent exit fixture expiry must be an integer from 1 to 15 seconds');
  }
  const failureInjection = request?.failureInjection ?? null;
  if (!APP_EXIT_MODES.has(mode)) throw new Error('Unknown Agent application-exit mode');
  if (!APP_EXIT_TOKEN_PATTERN.test(token || '')) {
    throw new Error('Agent application-exit fixture requires a valid cleanup token');
  }
  if (!APP_EXIT_FAILURE_INJECTIONS.has(failureInjection)) {
    throw new Error('Unknown Agent application-exit failure injection');
  }
  if (failureInjection && mode !== 'detached') {
    throw new Error('Agent application-exit failure injection requires detached mode');
  }
  if (
    !agentRuntime?.service ||
    !agentRuntime?.workspaceController ||
    !agentRuntime?.workspacePreviewController
  ) {
    throw new Error('Agent application-exit fixture requires the app-owned Agent runtime');
  }
  const root = validatedAgentExitRoot();
  const controller = agentRuntime.workspaceController;
  const base = {
    mode,
    token,
    appOwnedService: agentRuntime.service.workspaceController === controller,
    appOwnedWorkspaceController: agentRuntime.workspacePreviewController.workspaceController === controller,
    appOwnedProcessManager: Boolean(controller.processManager) &&
      agentRuntime.service.workspaceController?.processManager === controller.processManager,
  };
  if (mode === 'idle') return base;

  const receiptPath = path.join(root, `${token}-executor.json`);
  const terminalPath = path.join(root, `${token}-terminal.json`);
  const supervisorPath = path.join(root, `${token}-supervisor.json`);
  const intentPath = path.join(root, `${token}-intent.json`);
  if (mode === 'running') {
    if ([intentPath, receiptPath, terminalPath, supervisorPath].some((file) => fs.existsSync(file))) {
      throw new Error('Agent exit fixture token has already been used');
    }
    // Reserve the token before workspace preparation or any command launch.
    fs.writeFileSync(intentPath, JSON.stringify({ mode, token, expirySeconds, recordedAt: Date.now() }),
      { mode: 0o600, flag: 'wx' });
  }
  const conversationId = `app_exit_${crypto.randomBytes(10).toString('hex')}`;
  await controller.enable(conversationId);
  const workspace = controller.getWorkspace(conversationId);
  const workspaceRoot = controller.leases.get(workspace.workspaceId).workspaceRoot;

  if (mode === 'running') {
    const port = await pickAgentExitPort();
    const scriptName = 'app-exit-running.py';
    const pidPath = path.join(workspaceRoot, 'running.pid');
    const readyPath = path.join(workspaceRoot, 'running.ready');
    const heartbeatPath = path.join(workspaceRoot, 'running-heartbeat');
    const expiryPath = path.join(workspaceRoot, 'running-expiry.json');
    const source = [
      'import signal, time',
      'signal.signal(signal.SIGALRM, signal.SIG_DFL)',
      'alarm_before = time.clock_gettime_ns(time.CLOCK_MONOTONIC)',
      'wall_before = time.time_ns()',
      `signal.alarm(${expirySeconds})`,
      'wall_after = time.time_ns()',
      'alarm_after = time.clock_gettime_ns(time.CLOCK_MONOTONIC)',
      'import http.server, json, os, pathlib, sys, threading, time',
      `pathlib.Path('running-expiry.json').write_text(json.dumps({'pid': os.getpid(), 'parentPid': os.getppid(), 'clockDomain': 'clock_gettime:CLOCK_MONOTONIC', 'alarmArmedBeforeMonotonicNs': alarm_before, 'alarmArmedAfterMonotonicNs': alarm_after, 'alarmArmedBeforeWallNs': wall_before, 'alarmArmedAfterWallNs': wall_after, 'expirySeconds': ${expirySeconds}}))`,
      'port = int(sys.argv[1])',
      "pathlib.Path('running.pid').write_text(str(__import__('os').getpid()))",
      "heartbeat = pathlib.Path('running-heartbeat')",
      'def beat():',
      '    while True:',
      "        with heartbeat.open('a') as stream: stream.write('x')",
      '        time.sleep(0.03)',
      'class Handler(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      "        body = b'agent-exit-preview'",
      '        self.send_response(200)',
      "        self.send_header('Content-Type', 'text/plain')",
      "        self.send_header('Content-Length', str(len(body)))",
      '        self.end_headers()',
      '        self.wfile.write(body)',
      '    def log_message(self, *_args): pass',
      'threading.Thread(target=beat, daemon=True).start()',
      "server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)",
      "pathlib.Path('running.ready').write_text('ready')",
      'server.serve_forever()',
    ].join('\n');
    await fs.promises.writeFile(path.join(workspaceRoot, scriptName), source);
    const command = `exec python3 ${scriptName} ${port} ${token}`;
    const permission = await controller.prepareCommandPermissions(
      conversationId,
      { network: 'full' },
      { command, workingDirectory: '.' }
    );
    controller.grantCommandPermissions(conversationId, permission.prepared, 'once');
    const restoreObserver = observeAgentExitExecution(controller.executor, command, receiptPath, supervisorPath);
    let started;
    try {
      started = await controller.startProcess(conversationId, {
        command,
        previewPort: port,
        yieldMs: 500,
        onTerminal: (terminal) => writeAgentExitEvidence(terminalPath, { terminal }),
      });
    } catch (error) {
      restoreObserver();
      throw error;
    }
    // Yielding is not terminal: preserve observation until the actual execution
    // settles, including when readiness fails and the driver initiates cleanup.
    await waitForPath(readyPath);
    const preview = agentRuntime.workspacePreviewController.createProcessPreview(
      conversationId,
      started.processId
    );
    const response = await agentRuntime.workspacePreviewController.handleRequest(
      new Request(preview.url)
    );
    return {
      ...base,
      conversationId,
      workspaceRoot,
      processId: started.processId,
      runningProjection: started.workspace,
      ownedProcesses: [{ role: 'managed-server', pid: Number(fs.readFileSync(pidPath, 'utf8')) }],
      heartbeatPath,
      expirySeconds,
      expiryPath,
      receiptPath,
      // This mapped observer is suppressed after a controller shutdown deadline.
      // Its absence must be judged alongside raw receipt and shutdown-log evidence.
      terminalPath,
      supervisorPath,
      intentPath,
      preview: {
        port,
        url: preview.url,
        statusBeforeQuit: response.status,
        bodyBeforeQuit: await response.text(),
      },
    };
  }

  const outsideCanary = path.join(root, 'detached-outside-canary');
  await fs.promises.writeFile(outsideCanary, 'outside-canary');
  const scriptName = 'app-exit-detached.py';
  const managedPidPath = path.join(workspaceRoot, 'managed.pid');
  const detachedPidPath = path.join(workspaceRoot, 'detached.pid');
  const resultPath = path.join(workspaceRoot, 'detached-result.json');
  const managedHeartbeatPath = path.join(workspaceRoot, 'managed-heartbeat');
  const detachedHeartbeatPath = path.join(workspaceRoot, 'detached-heartbeat');
  const source = [
    'import json, os, pathlib, socket, sys, time',
    'token, outside = sys.argv[1:3]',
    "pathlib.Path('managed.pid').write_text(str(os.getpid()))",
    'if os.fork() == 0:',
    '    os.setsid()',
    "    pathlib.Path('detached.pid').write_text(str(os.getpid()))",
    '    result = {}',
    '    try:',
    '        pathlib.Path(outside).read_text()',
    "        result['outsideRead'] = 'unexpected'",
    "    except OSError as error: result['outsideRead'] = error.errno",
    '    sock = socket.socket()',
    '    try:',
    "        result['loopback'] = sock.connect_ex(('127.0.0.1', 9))",
    '    finally: sock.close()',
    '    try:',
    "        socket.getaddrinfo('example.com', 443)",
    "        result['dns'] = 'unexpected'",
    "    except OSError as error: result['dns'] = getattr(error, 'errno', None) or type(error).__name__",
    "    pathlib.Path('detached-result.json').write_text(json.dumps(result))",
    "    heartbeat = pathlib.Path('detached-heartbeat')",
    '    while True:',
    "        with heartbeat.open('a') as stream: stream.write('x')",
    '        time.sleep(0.03)',
    "heartbeat = pathlib.Path('managed-heartbeat')",
    'while True:',
    "    with heartbeat.open('a') as stream: stream.write('x')",
    '    time.sleep(0.03)',
  ].join('\n');
  await fs.promises.writeFile(path.join(workspaceRoot, scriptName), source);
  const command = `python3 ${scriptName} ${token} ${outsideCanary}`;
  const started = await controller.startProcess(conversationId, { command, yieldMs: 500 });
  await Promise.all([waitForPath(managedPidPath), waitForPath(detachedPidPath)]);
  if (failureInjection === 'after_detached_process_created') {
    throw new Error('Injected Agent exit failure after detached process creation');
  }
  await waitForPath(resultPath);
  return {
    ...base,
    conversationId,
    workspaceRoot,
    processId: started.processId,
    runningProjection: started.workspace,
    ownedProcesses: [
      { role: 'managed-parent', pid: Number(fs.readFileSync(managedPidPath, 'utf8')) },
      { role: 'detached-descendant', pid: Number(fs.readFileSync(detachedPidPath, 'utf8')) },
    ],
    heartbeatPath: managedHeartbeatPath,
    detachedHeartbeatPath,
    outsideCanary,
    confinement: JSON.parse(fs.readFileSync(resultPath, 'utf8')),
  };
}

// In-memory fixtures. Maps are keyed lower-case for ENS / hashes; content
// fixtures are keyed by exact URL or URL prefix (longest-match wins).
const contentFixtures = new Map();
const contentFixtureActivity = new Map();
const ensFixtures = new Map();
const probeFixtures = new Map();
const automationWindows = new Map();
let agentWalletTransaction = null;
const DEFAULT_AGENT_NODE_LIFECYCLE_STATES = Object.freeze([
  ['ant', 'running'],
  ['ipfs', 'running'],
  ['radicle', 'running'],
  ['tor', 'running'],
  ['myotis-ethereum', 'ready'],
  ['myotis-gnosis', 'ready'],
]);
const agentNodeLifecycleStates = new Map(DEFAULT_AGENT_NODE_LIFECYCLE_STATES);

// Records profile "open" launches instead of cold-starting a real second
// Electron instance. See installProfileLaunchRecorder / profile-launcher.js.
const profileLaunches = [];

function resetProfileLaunches() {
  profileLaunches.length = 0;
}

// Simulated focus results keyed by profileId: lets E2E exercise the
// focus-fast-path (target already running → focus it, no new launch) without a
// second process. See installProfileFocusSimulator / profile-launcher.js.
const profileFocusSims = new Map();

function resetProfileFocusSims() {
  profileFocusSims.clear();
}

// Simulated delete outcomes keyed by profileId: lets E2E exercise the manager's
// delete failure handling (PROFILE_CLOSE_FAILED → restore card + toast) without
// a second process holding the lock. See installProfileDeleteSimulator /
// ipc-handlers.js (deleteProfileFromIpc).
const profileDeleteSims = new Map();

function resetProfileDeleteSims() {
  profileDeleteSims.clear();
}

function resetFixtures() {
  contentFixtures.clear();
  contentFixtureActivity.clear();
  ensFixtures.clear();
  probeFixtures.clear();
  agentWalletTransaction = null;
  agentNodeLifecycleStates.clear();
  for (const [service, state] of DEFAULT_AGENT_NODE_LIFECYCLE_STATES) {
    agentNodeLifecycleStates.set(service, state);
  }
}

function createAgentWalletTestOptions() {
  if (!TEST_MODE_ENABLED) return undefined;
  const gnoAddress = '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb';
  return {
    estimateGas: async () => ({ gasLimit: '21000' }),
    getGasPrices: async () => ({ type: 'legacy', gasPrice: '1000000000' }),
    getTokens: () => ({
      '100:native': {
        chainId: 100,
        address: null,
        symbol: 'xDAI',
        name: 'xDAI',
        decimals: 18,
      },
      [`100:${gnoAddress.toLowerCase()}`]: {
        chainId: 100,
        address: gnoAddress,
        symbol: 'GNO',
        name: 'Gnosis',
        decimals: 18,
      },
    }),
    getAllBalances: async () => ({
      '100:native': { raw: '10000000000000000000', formatted: '10.0', decimals: 18 },
      [`100:${gnoAddress.toLowerCase()}`]: {
        raw: '5000000000000000000',
        formatted: '5.0',
        decimals: 18,
      },
    }),
    clearBalanceCache: () => {},
    signAndRecord: async (transaction, _signer, context) => {
      agentWalletTransaction = {
        transaction: { ...transaction },
        context: { ...context },
      };
      return {
        hash: `0x${'ab'.repeat(32)}`,
        paymentId: 'payment_agent_wallet_test',
        recorded: true,
      };
    },
  };
}

function createAgentNodeRequestTestOptions() {
  if (!TEST_MODE_ENABLED) return undefined;
  return {
    interactiveTimeoutMs: 20,
    mutationTimeoutMs: 2_000,
    fetch: async (url, options = {}) => {
      const target = url instanceof URL ? url : new URL(url);
      if (target.origin !== 'http://127.0.0.1:11633') {
        throw new Error('Test node requests must use the registry-selected Ant endpoint');
      }
      if (options.method === 'GET' && target.pathname === '/health') {
        return new Response('{"status":"ok","version":"test-ant"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (options.method === 'POST' && target.pathname === '/stamps/100/20') {
        return new Response('{"batchID":"test-postage-batch"}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (options.method === 'POST' && target.pathname === '/test/slow-write') {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return new Response('{"operation":"settled"}', {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"message":"not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

function createAgentNodeLifecycleTestOptions() {
  if (!TEST_MODE_ENABLED) return undefined;
  const start = (service, state = 'running') => agentNodeLifecycleStates.set(service, state);
  const stop = (service) => agentNodeLifecycleStates.set(service, 'stopped');
  return {
    nodeStatusController: {
      status: async () => ({
        nodes: [...agentNodeLifecycleStates].map(([id, state]) => ({ id, state })),
      }),
    },
    dependencies: {
      startAnt: () => start('ant'),
      stopAnt: () => stop('ant'),
      startIpfs: () => start('ipfs'),
      stopIpfs: () => stop('ipfs'),
      startRadicle: () => start('radicle'),
      stopRadicle: () => stop('radicle'),
      startTor: () => start('tor'),
      stopTor: () => stop('tor'),
      startMyotis: (chainId) => start(chainId === 100 ? 'myotis-gnosis' : 'myotis-ethereum', 'ready'),
      stopMyotis: (chainId) => stop(chainId === 100 ? 'myotis-gnosis' : 'myotis-ethereum'),
    },
    verifyTimeoutMs: 0,
  };
}

// Longest-prefix match so a fixture for `bzz://<hash>/` answers for
// every sub-resource fetched while loading that page. Exact match wins
// over prefix match by virtue of the length sort.
function pickContentFixture(url) {
  if (contentFixtures.has(url)) return contentFixtures.get(url);
  let best = null;
  let bestLen = -1;
  for (const [prefix, value] of contentFixtures.entries()) {
    if (url.startsWith(prefix) && prefix.length > bestLen) {
      best = value;
      bestLen = prefix.length;
    }
  }
  return best;
}

function buildResponse(fixture, url) {
  const status = fixture.status ?? 200;
  const headers = {
    'Content-Type': fixture.contentType ?? 'text/html; charset=utf-8',
  };
  if (fixture.holdOpen === true) {
    const activity = contentFixtureActivity.get(url) || { started: 0, cancelled: 0 };
    activity.started += 1;
    contentFixtureActivity.set(url, activity);
    const body = new TextEncoder().encode(fixture.body ?? '');
    const stream = new ReadableStream({
      start(controller) {
        if (body.byteLength) controller.enqueue(body);
      },
      cancel() {
        activity.cancelled += 1;
      },
    });
    return new Response(stream, { status, headers });
  }
  return new Response(fixture.body ?? '', { status, headers });
}

function notFoundResponse(url) {
  const body = JSON.stringify({
    code: 404,
    message: `[test-harness] no fixture for ${url}`,
  });
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function makeProtocolHandler(scheme) {
  return async (request) => {
    const fixture = pickContentFixture(request.url);
    if (!fixture) {
      log.info(`[test-harness] ${scheme}: 404 (no fixture) for ${redactUrlForLog(request.url)}`);
      return notFoundResponse(request.url);
    }
    return buildResponse(fixture, request.url);
  };
}

function makeHttpStubHandler(scheme) {
  return async (request) => {
    log.info(`[test-harness] stubbed ${scheme}: ${redactUrlForLog(request.url)}`);
    const fixture = pickContentFixture(request.url);
    if (fixture) return buildResponse(fixture, request.url);
    const body =
      `<!doctype html>` +
      `<title>test-harness ${scheme} stub</title>` +
      `<h1>${scheme}:// blocked in test mode</h1>` +
      `<p data-test="harness-http-stub-url">${request.url}</p>`;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
}

function registerStubProtocols(targetSession, { privatePartition = null } = {}) {
  if (!targetSession?.protocol?.handle) {
    log.warn('[test-harness] session.protocol.handle unavailable — skipping protocol stubs');
    return;
  }
  // PRIVATE MODE GUARD (request logging): the stubs stand in for the real
  // bzz/ipfs/ipns (and http/https) handlers on private sessions too, so they
  // redact request URLs exactly as those do — otherwise the e2e assertion
  // that a private navigation leaves no trace in main.log would be testing
  // the harness instead of the app.
  const isPrivate = !!privatePartition;
  // bzz/ipfs/ipns: harness owns these outright (custom standard schemes
  // we register in production too — see src/main/swarm/bzz-protocol.js
  // etc.). Specs drive content via setContentFixture().
  for (const scheme of ['bzz', 'ipfs', 'ipns']) {
    try {
      const handler = makeProtocolHandler(scheme);
      targetSession.protocol.handle(scheme, (request) =>
        runWithPrivateLogContext(isPrivate, () => handler(request))
      );
      log.info(`[test-harness] registered stub ${scheme}: handler`);
    } catch (err) {
      log.error(`[test-harness] failed to register stub ${scheme}: handler`, err);
    }
  }
  // http/https: harness owns these too while in test mode, so a spec
  // that exercises a path which calls `webview.loadURL('https://...')`
  // (typing `example.com`, an embedded analytics beacon, an ENS RPC
  // fallback, …) doesn't reach the network. Using `protocol.handle`
  // instead of `webRequest.onBeforeRequest` redirects means we own the
  // scheme — the request never enters Chromium's network stack at all,
  // no DNS lookup, no TCP/TLS handshake. Electron 30+ allows
  // overriding built-in standard schemes; previous handlers are
  // replaced. The webview tag in tabs.js doesn't set a `partition`
  // attribute, which per Electron's <webview> docs means it uses the
  // app default session — i.e. this same one we're attaching to.
  for (const scheme of ['http', 'https']) {
    try {
      const handler = makeHttpStubHandler(scheme);
      targetSession.protocol.handle(scheme, (request) =>
        runWithPrivateLogContext(isPrivate, () => handler(request))
      );
      log.info(`[test-harness] registered stub ${scheme}: handler (owns scheme)`);
    } catch (err) {
      log.error(`[test-harness] failed to register stub ${scheme}: handler`, err);
    }
  }
}

// Replace a previously-registered ipcMain.handle entry. ipcMain.handle
// throws if the channel is already registered, so removal must happen
// before re-registration. Safe to call when the channel was never
// registered (removeHandler is a no-op then).
function replaceHandler(channel, handler) {
  ipcMain.removeHandler?.(channel);
  ipcMain.handle(channel, handler);
}

function overrideEnsIpc() {
  replaceHandler(IPC.ENS_RESOLVE, async (_event, payload = {}) => {
    const name = (payload?.name || '').trim().toLowerCase();
    if (!name) {
      return { type: 'not_found', name: '', reason: 'EMPTY' };
    }
    if (ensFixtures.has(name)) {
      return ensFixtures.get(name);
    }
    return { type: 'not_found', name, reason: 'NO_FIXTURE' };
  });

  replaceHandler(IPC.ENS_RESOLVE_ADDRESS, async (_event, payload = {}) => {
    const name = (payload?.name || '').trim().toLowerCase();
    return { success: false, name, reason: 'TEST_MODE_NOT_IMPLEMENTED' };
  });

  replaceHandler(IPC.ENS_RESOLVE_REVERSE, async (_event, payload = {}) => {
    const address = typeof payload?.address === 'string' ? payload.address.toLowerCase() : null;
    return { success: false, address, reason: 'TEST_MODE_NOT_IMPLEMENTED' };
  });

  replaceHandler(IPC.ENS_INVALIDATE_CONTENT, async () => true);

  // Tezos Domains shares the ENS fixture map — `.tez` and `.eth` names can
  // never collide — so a spec drives both name systems through
  // `setEnsFixture`. Without this override a harness spec that navigates to
  // a `.tez` name would reach out to the real public Tezos RPCs.
  replaceHandler(IPC.TEZOS_DOMAINS_RESOLVE, async (_event, payload = {}) => {
    const name = (payload?.name || '').trim().toLowerCase();
    if (!name) {
      return { type: 'not_found', reason: 'EMPTY', system: 'tezos' };
    }
    if (ensFixtures.has(name)) {
      return ensFixtures.get(name);
    }
    return { type: 'not_found', reason: 'NO_FIXTURE', system: 'tezos' };
  });

  replaceHandler(IPC.TEZOS_DOMAINS_INVALIDATE, async () => ({ ok: true }));
}

function overrideProbeIpc() {
  const stubProbes = new Map();
  let nextId = 1;

  replaceHandler(IPC.BZZ_START_PROBE, (_event, payload = {}) => {
    const { hash } = payload;
    if (typeof hash !== 'string' || !hash) {
      return failure('INVALID_HASH', 'Missing hash');
    }
    const id = `test-probe-${nextId++}`;
    const outcome = probeFixtures.get(hash) ?? { ok: true };
    stubProbes.set(id, outcome);
    return success({ id });
  });

  replaceHandler(IPC.BZZ_AWAIT_PROBE, (_event, payload = {}) => {
    const { id } = payload;
    if (typeof id !== 'string' || !stubProbes.has(id)) {
      return failure('UNKNOWN_PROBE', 'Unknown probe id', { id });
    }
    const outcome = stubProbes.get(id);
    stubProbes.delete(id);
    return success({ outcome });
  });

  replaceHandler(IPC.BZZ_CANCEL_PROBE, (_event, payload = {}) => {
    const { id } = payload;
    const cancelled = stubProbes.delete(id);
    return success({ cancelled });
  });
}

// Bee / IPFS / Myotis / Radicle managers are still loaded so their `getStatus`
// handlers respond, but we replace start/stop with no-ops so a stray
// click in a spec can't spawn the real binaries against the test
// `userData` directory. The fake status is also tracked in-memory so
// the corresponding `*_GET_STATUS` handler reports it (otherwise the
// real manager would still reply with "stopped" and the renderer
// would think the toggle silently failed).
//
// Stub responses match the production IPC shape `{ status, error }`
// — the renderer destructures these fields directly
// (`src/renderer/lib/bee-ui.js`, `src/renderer/lib/ipfs-ui.js`).
const stubNodeStatus = { ant: 'running', ipfs: 'running', radicle: 'running' };
const stubMyotisStatuses = new Map([
  [1, {
    supported: true, available: true, version: '0.1.7', chainId: 1,
    network: 'mainnet', displayName: 'Ethereum', running: true, state: 'ready',
    beaconState: 'SYNCED', peerCount: 2, snapPeers: 1, finalizedBlockNumber: 25684159,
  }],
  [100, {
    supported: true, available: true, version: '0.1.7', chainId: 100,
    network: 'gnosis', displayName: 'Gnosis', running: false, state: 'off',
    beaconState: 'STARTING', peerCount: 0, snapPeers: 0, finalizedBlockNumber: 0,
  }],
]);

function overrideNodeIpc() {
  const setStatus = (service, status) => {
    stubNodeStatus[service] = status;
    return { status, error: null };
  };

  replaceHandler(IPC.ANT_START, async () => {
    log.info('[test-harness] ignored ant:start (test mode)');
    return setStatus('ant', 'running');
  });
  replaceHandler(IPC.ANT_STOP, async () => {
    log.info('[test-harness] ignored ant:stop (test mode)');
    return setStatus('ant', 'stopped');
  });
  replaceHandler(IPC.ANT_GET_STATUS, async () => ({
    status: stubNodeStatus.ant,
    error: null,
  }));

  replaceHandler(IPC.IPFS_START, async () => {
    log.info('[test-harness] ignored ipfs:start (test mode)');
    return setStatus('ipfs', 'running');
  });
  replaceHandler(IPC.IPFS_STOP, async () => {
    log.info('[test-harness] ignored ipfs:stop (test mode)');
    return setStatus('ipfs', 'stopped');
  });
  replaceHandler(IPC.IPFS_GET_STATUS, async () => ({
    status: stubNodeStatus.ipfs,
    error: null,
  }));

  const stubMyotisStatus = (chainId) => {
    const status = stubMyotisStatuses.get(Number(chainId));
    if (!status) throw new Error(`Unsupported Myotis chain ID: ${chainId}`);
    return status;
  };

  replaceHandler(IPC.MYOTIS_START, async (_event, chainId = 1) => {
    log.info('[test-harness] ignored myotis:start (test mode)');
    const status = stubMyotisStatus(chainId);
    Object.assign(status, { running: true, state: 'ready' });
    return { ...status };
  });
  replaceHandler(IPC.MYOTIS_STOP, async (_event, chainId = 1) => {
    log.info('[test-harness] ignored myotis:stop (test mode)');
    const status = stubMyotisStatus(chainId);
    Object.assign(status, { running: false, state: 'off' });
    return { ...status };
  });
  replaceHandler(IPC.MYOTIS_GET_STATUS, async (_event, chainId = 1) => ({
    ...stubMyotisStatus(chainId),
  }));

  replaceHandler(IPC.RADICLE_START, async () => {
    log.info('[test-harness] ignored radicle:start (test mode)');
    return setStatus('radicle', 'running');
  });
  replaceHandler(IPC.RADICLE_STOP, async () => {
    log.info('[test-harness] ignored radicle:stop (test mode)');
    return setStatus('radicle', 'stopped');
  });
  replaceHandler(IPC.RADICLE_GET_STATUS, async () => ({
    status: stubNodeStatus.radicle,
    error: null,
  }));
}

function seedRegistry() {
  updateService('ant', {
    api: 'http://127.0.0.1:11633',
    gateway: 'http://127.0.0.1:11633',
    mode: MODE.BUNDLED,
  });
  setStatusMessage('ant', 'Test mode (Swarm stub)');
  updateService('ipfs', {
    api: null,
    gateway: null,
    mode: MODE.BUNDLED,
    backend: 'freedom-ipfs',
  });
  setStatusMessage('ipfs', 'Test mode (IPFS stub)');
}

// `test:*` IPC operations the Playwright runner can invoke from the
// renderer (page.evaluate(() => ipcRenderer.invoke('test:...')) won't
// work because contextIsolation hides ipcRenderer — the runner uses
// electronApp.evaluate(...) and calls these via ipcMain.emit instead,
// or the global shim below).
function registerTestOps() {
  replaceHandler('test:ping', () => ({ ok: true, pid: process.pid }));

  replaceHandler('test:reset-fixtures', () => {
    resetFixtures();
    return { ok: true };
  });

  replaceHandler('test:set-content-fixture', (_event, payload = {}) => {
    const { url, status, contentType, body } = payload;
    if (typeof url !== 'string' || !url) {
      return { ok: false, error: 'missing url' };
    }
    contentFixtures.set(url, { status, contentType, body });
    return { ok: true };
  });

  replaceHandler('test:set-ens-fixture', (_event, payload = {}) => {
    const { name, result } = payload;
    if (typeof name !== 'string' || !name) {
      return { ok: false, error: 'missing name' };
    }
    ensFixtures.set(name.trim().toLowerCase(), result);
    return { ok: true };
  });

  replaceHandler('test:set-probe-fixture', (_event, payload = {}) => {
    const { hash, outcome } = payload;
    if (typeof hash !== 'string' || !hash) {
      return { ok: false, error: 'missing hash' };
    }
    probeFixtures.set(hash, outcome ?? { ok: true });
    return { ok: true };
  });

  replaceHandler('test:get-state', () => ({
    content: [...contentFixtures.keys()],
    ens: [...ensFixtures.keys()],
    probes: [...probeFixtures.keys()],
    agentWalletTransaction,
  }));
}

// Neutralize profile "open"/switch in test mode: opening a profile normally
// spawns a detached second Electron process (profile-launcher.js). In E2E that
// would cold-start a real app against the shared dev-home, racing on locks and
// leaking processes. The launcher checks this global and, when present, records
// the intended launch instead of spawning — so a spec can assert that a switch
// was triggered for the right profile without a second window appearing.
function installProfileLaunchRecorder() {
  globalThis.__FREEDOM_TEST_PROFILE_LAUNCH__ = (entry) => {
    profileLaunches.push(entry);
    log.info(`[test-harness] recorded profile launch: ${entry?.profileId}`);
  };
}

// Counterpart to the launch recorder: when a spec has registered a simulated
// focus result for a profileId, openOrFocusProfile returns it instead of
// resolving a real lock / writing a focus-request file. Returns null for ids
// with no simulation so normal (launch-recording) behaviour applies.
function installProfileFocusSimulator() {
  globalThis.__FREEDOM_TEST_FOCUS_SIM__ = (profileId) =>
    profileFocusSims.has(profileId) ? { ...profileFocusSims.get(profileId) } : null;
}

// Counterpart for deletes: when a spec has registered a simulated outcome for a
// profileId, deleteProfileFromIpc returns it (an ipc-contract failure/success
// object) instead of running the real close-and-remove path. null → real path.
function installProfileDeleteSimulator() {
  globalThis.__FREEDOM_TEST_DELETE_SIM__ = (profileId) =>
    profileDeleteSims.has(profileId) ? { ...profileDeleteSims.get(profileId) } : null;
}

// Expose a synchronous shim on the main-process global so the Playwright
// runner can drive fixtures via `electronApp.evaluate(() => globalThis
// .__FREEDOM_TEST_HARNESS__.setContentFixture(...))` without an IPC
// round-trip.
function exposeGlobalShim(agentRuntime) {
  globalThis.__FREEDOM_TEST_HARNESS__ = {
    setContentFixture: (url, fixture) => {
      contentFixtures.set(url, fixture || {});
    },
    clearContentFixtures: () => contentFixtures.clear(),
    setEnsFixture: (name, result) => {
      ensFixtures.set(String(name).trim().toLowerCase(), result);
    },
    setProbeFixture: (hash, outcome) => {
      probeFixtures.set(hash, outcome ?? { ok: true });
    },
    resetFixtures,
    // Profile-launch recording (see installProfileLaunchRecorder). Specs read
    // these to confirm a profile "open"/switch fired for the expected id.
    profileLaunches: () => profileLaunches.map((entry) => ({ ...entry })),
    clearProfileLaunches: resetProfileLaunches,
    // Focus-fast-path simulation (see installProfileFocusSimulator). A spec
    // marks a profile as already-running so opening it focuses (no launch);
    // pass a result like { focused: true } or { focused: false, error }.
    simulateProfileFocus: (profileId, result) => {
      profileFocusSims.set(profileId, result || { focused: true });
    },
    clearProfileFocusSims: resetProfileFocusSims,
    // Delete-failure simulation (see installProfileDeleteSimulator). A spec
    // registers a failure-shaped result for a profileId so the manager's
    // delete IPC reports failure without a real second process.
    simulateProfileDelete: (profileId, result) => {
      profileDeleteSims.set(
        profileId,
        result || {
          success: false,
          error: {
            code: 'PROFILE_CLOSE_FAILED',
            message:
              'This profile is open and could not be closed automatically. Close its window and try again.',
          },
        }
      );
    },
    clearProfileDeleteSims: resetProfileDeleteSims,
    automationExecute: (operation, input) => automationController.execute(operation, input),
    automationTabForRenderer: (rendererTabId, guestWebContentsId) => {
      const guestWebContents = webContents.fromId(guestWebContentsId);
      const hostWebContents = guestWebContents?.hostWebContents;
      if (!hostWebContents) return null;
      return automationTabIdForRenderer(hostWebContents, rendererTabId);
    },
    createHiddenAutomationPage: async (url) => {
      const window = new BrowserWindow({
        show: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const tabId = registerAutomationWebContents(window.webContents, { kind: 'headless' });
      automationWindows.set(tabId, window);
      window.once('closed', () => automationWindows.delete(tabId));
      await window.loadURL(url);
      return tabId;
    },
    closeHiddenAutomationPage: (tabId) => {
      const window = automationWindows.get(tabId);
      if (!window || window.isDestroyed()) return false;
      window.close();
      return true;
    },
    prepareAgentExitScenario: (request) => prepareAgentExitScenario(agentRuntime, request),
    state: () => ({
      content: [...contentFixtures.keys()],
      contentActivity: Object.fromEntries(contentFixtureActivity),
      ens: [...ensFixtures.keys()],
      probes: [...probeFixtures.keys()],
      profileLaunches: profileLaunches.map((entry) => ({ ...entry })),
      agentWalletTransaction,
    }),
  };
}

function installTestHarness({ defaultSession, agentRuntime }) {
  if (!TEST_MODE_ENABLED) return false;
  log.info('[test-harness] FREEDOM_TEST_MODE=1 — installing harness');
  resetFixtures();
  resetProfileLaunches();
  resetProfileFocusSims();
  resetProfileDeleteSims();
  registerStubProtocols(defaultSession);
  overrideEnsIpc();
  overrideProbeIpc();
  overrideNodeIpc();
  registerTestOps();
  seedRegistry();
  installProfileLaunchRecorder();
  installProfileFocusSimulator();
  installProfileDeleteSimulator();
  exposeGlobalShim(agentRuntime);
  return true;
}

module.exports = {
  createAgentNodeLifecycleTestOptions,
  createAgentNodeRequestTestOptions,
  createAgentWalletTestOptions,
  isTestMode,
  installTestHarness,
  prepareAgentExitScenario,
  // Exposed so private-window sessions (created after startup) get the same
  // fixture-driven protocol stubs as the default session in test mode. The
  // fixture maps are shared module state, so per-session registration is all
  // that's needed. No-op guard lives in the caller (only invoked when
  // isTestMode()).
  registerStubProtocols,
};
