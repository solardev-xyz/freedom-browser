'use strict';

// Shared production-service composition and reusable runner for the Freedom managed Agent
// workspace qualification scenarios (network permissions, managed processes, automatic terminal
// reconciliation, and managed server previews).
//
// Every scenario runs against the real product objects: the production FreedomAgentService, the
// real SQLite AgentManagedWorkspaceStore and AgentSessionHistoryStore, the production
// ManagedWorkspaceController and its ManagedWorkspaceProcessManager, the real Pi workspace tool
// factory (createWorkspaceTools), the production WorkspacePreviewController and its preview request
// handler, and the real Bubblewrap executor. Only observability wrappers are added around the
// executor and the tool factory, and three deterministic seams remain:
//   * the Pi *session* is a scripted fake (no model provider, no credentials, no harness network),
//   * the browser tab surface is a minimal in-memory stub that records navigations, and
//   * the preview protocol registration is a stub that captures the handler and storage clears.
// These seams are disclosed to each scenario and never substitute for a production authority,
// executor, store, policy, or capability object.
//
// Launch through the checkout's Electron binary in Node mode (ELECTRON_RUN_AS_NODE=1 electron
// <script>): the native SQLite stores are built for Electron's ABI and the production runtime
// detector attests that same binary as the helper runtime. The runner is Linux-only; on other
// platforms it prints an explicit skip and exits 0. Missing Bubblewrap on Linux, or running as
// root, fails the qualification rather than skipping it.

const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(REPO_ROOT, 'package.json'));

const { FreedomAgentService } = require('../../src/main/agent/freedom-agent-service');
const {
  OriginScopedAutomationController,
} = require('../../src/main/automation/origin-scoped-controller');
const { ManagedWorkspaceController } = require('../../src/main/agent/managed-workspace-controller');
const { AgentManagedWorkspaceStore } = require('../../src/main/agent/managed-workspace-store');
const { AgentSessionHistoryStore } = require('../../src/main/agent/session-history-store');
const {
  TERMINAL_PROCESS_RETENTION_MS,
} = require('../../src/main/agent/managed-workspace-process-manager');
const {
  WorkspacePreviewController,
  PREVIEW_CSP,
  SERVER_PREVIEW_CSP,
} = require('../../src/main/agent/workspace-preview-controller');
const { OPERATIONS } = require('../../src/main/automation/contract/operations');
const {
  createWorkspaceExecutor,
} = require('../../src/main/agent/workspace-execution/workspace-executor');
const {
  createWorkspaceExecutionPolicy,
} = require('../../src/main/agent/workspace-execution/execution-policy');
const {
  createFullNetworkCapabilities,
  createWorkspaceCapabilityRequest,
} = require('../../src/main/agent/workspace-execution/workspace-capabilities');
const {
  createWorkspaceTools: realCreateWorkspaceTools,
} = require('../../src/main/agent/pi-workspace-tools');

function emit(type, value = {}) {
  process.stdout.write(`${JSON.stringify({ type, ...value })}\n`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(100);
  }
  return predicate();
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

// A read-only survivor scan for the sandbox primitives. It never kills anything: cleanup happens
// through namespace teardown in controller.dispose(). Scenario-specific process markers can be
// appended; the harness always checks the Bubblewrap and supervisor primitives.
function survivorScan(extraPattern) {
  const pattern = extraPattern
    ? `[b]wrap|freedom-sandbox-supervisor|${extraPattern}`
    : '[b]wrap|freedom-sandbox-supervisor';
  const found = spawnSync('pgrep', ['-af', pattern], { encoding: 'utf8' });
  return (found.stdout || '')
    .split('\n')
    .filter(
      (line) => line && !/shell-snapshots|pgrep|claude|qualify-agent|agent-qualification/.test(line)
    )
    .join('\n');
}

function leakScan(label, value, markers) {
  const text = JSON.stringify(value) || '';
  const found = markers.filter((marker) => marker && text.includes(marker));
  return { label, bytes: text.length, found };
}

async function selectLanAddress(overrideAddress) {
  const candidates = overrideAddress
    ? [overrideAddress]
    : Object.values(os.networkInterfaces())
        .flat()
        .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
        .map((entry) => entry.address);
  for (const address of candidates) {
    const server = net.createServer((socket) => socket.end());
    try {
      await listen(server, { host: address, port: 0 });
      const reachable = await new Promise((resolve) => {
        const socket = net.createConnection({ host: address, port: server.address().port });
        socket.setTimeout(2_000, () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('connect', () => {
          socket.end();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      await closeServer(server);
      if (reachable) return address;
    } catch {
      await closeServer(server).catch(() => {});
    }
  }
  return null;
}

// The kernel listener for a loopback port, as owned by the sandboxed process tree.
function ssListener(port) {
  return spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8' }).stdout.trim();
}

async function pickFreePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 40_000 + Math.floor(Math.random() * 20_000);
    if (ssListener(candidate)) continue;
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port: candidate }, () =>
        server.close(() => resolve(true))
      );
    });
    if (free) return candidate;
  }
  throw new Error('Could not find a free loopback port for the preview server');
}

function createFakeSession() {
  let listener = null;
  let turn = createDeferred();
  const session = {
    subscribe(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    prompt: async () => {
      turn = createDeferred();
      return turn.promise;
    },
    steer: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => turn.resolve(),
    dispose: () => {},
  };
  return {
    session,
    captured: null,
    emit: (event) => listener?.(event),
    endTurn: () => turn.resolve(),
  };
}

function hostBaseline(networkEnabled) {
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const sysctl = (name) => read(`/proc/sys/${name.replace(/\./g, '/')}`);
  const bwrap = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  const apparmor = spawnSync('dpkg-query', ['-W', '-f=${Version}', 'apparmor'], {
    encoding: 'utf8',
  });
  return {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    user: os.userInfo().username,
    kernel: `${os.type()} ${os.release()} ${os.arch()}`,
    distribution: read('/etc/os-release')
      ?.split('\n')
      .find((line) => line.startsWith('PRETTY_NAME='))
      ?.slice('PRETTY_NAME='.length)
      .replace(/"/g, ''),
    bubblewrap: bwrap.status === 0 ? bwrap.stdout.trim() : null,
    apparmor: apparmor.status === 0 ? apparmor.stdout.trim() : null,
    apparmorLabel: read('/proc/self/attr/current'),
    apparmorRestrictUnprivilegedUserns: sysctl('kernel.apparmor_restrict_unprivileged_userns'),
    unprivilegedUsernsClone: sysctl('kernel.unprivileged_userns_clone'),
    maxUserNamespaces: sysctl('user.max_user_namespaces'),
    node: process.version,
    electron: process.versions.electron || null,
    networkPermissionsEnabled: networkEnabled,
  };
}

// Build the full production composition plus the disclosed deterministic seams, and return a
// context object that scenario modules consume. Nothing here decides pass/fail; scenarios do.
function buildComposition({ userDataDir, networkEnabled }) {
  const executions = [];
  const realExecutor = createWorkspaceExecutor();
  // In-flight executor count, so teardown can drain asynchronous termination writes (which the
  // controller records back into the SQLite store after an abort) before closing the stores.
  let inFlightExecutes = 0;
  const executor = {
    detectCapabilities: (...args) => realExecutor.detectCapabilities(...args),
    execute: async (policy, request) => {
      const entry = {
        index: executions.length,
        network: policy.network,
        runtimeRoots: policy.filesystem.runtimeRoots.map((rootEntry) => ({
          id: rootEntry.id,
          access: rootEntry.access,
        })),
        command:
          Array.isArray(request.args) && request.args[2] === 'freedom-workspace-file'
            ? `helper:${request.args[6]}`
            : Array.isArray(request.args) && request.args[2] === 'freedom-workspace'
              ? request.args[4]
              : `other:${request.command}`,
      };
      executions.push(entry);
      inFlightExecutes += 1;
      try {
        const receipt = await realExecutor.execute(policy, request);
        entry.state = receipt.state;
        entry.receipt = {
          state: receipt.state,
          exitCode: receipt.exitCode,
          signal: receipt.signal,
          terminationGuarantee: receipt.terminationGuarantee,
          terminationScope: receipt.terminationScope,
          survivorsPossible: receipt.survivorsPossible,
          completeDescendantTermination: receipt.completeDescendantTermination,
          sideEffects: receipt.sideEffects,
          networkPosture: receipt.capabilities?.networkPosture,
        };
        return receipt;
      } finally {
        inFlightExecutes -= 1;
      }
    },
  };

  let policyCreations = 0;
  // Mirrors createFreedomAgentRuntime(): the production runtime detector, the production executor
  // factory, and the network gate value are used unchanged; only observability wrappers are added.
  const controller = new ManagedWorkspaceController({
    store: new AgentManagedWorkspaceStore({ userDataDir }),
    executor,
    createPolicy: async (options) => {
      policyCreations += 1;
      return createWorkspaceExecutionPolicy(options);
    },
    runtimeOptions: { packaged: false, freedomVersion: pkg.version },
    networkPermissionsEnabled: networkEnabled,
  });
  const workspaceStore = controller.store;
  const historyStore = new AgentSessionHistoryStore({ userDataDir });
  const workspacePreviewController = new WorkspacePreviewController({
    workspaceController: controller,
  });

  // Preview protocol registration stub: captures the production handler and the storage clears the
  // controller requests. The handler itself is the real WorkspacePreviewController logic.
  const protocolRegistrations = [];
  const storageClears = [];
  workspacePreviewController.register({
    protocol: {
      handle: (scheme, handler) => {
        protocolRegistrations.push({ scheme, handler });
      },
      unhandle: async (scheme) => {
        protocolRegistrations.push({ unhandled: scheme });
      },
    },
    clearStorageData: async (options) => {
      storageClears.push(options);
    },
  });
  const previewHandler = (request) => protocolRegistrations[0].handler(request);

  const browserTabs = [];
  const navigations = [];
  const sessions = [];
  const events = [];
  const approvals = [];
  const decisions = [];
  const toolOptions = [];
  const observerCalls = [];
  const observerFailures = { enabled: false, thrown: 0 };
  let runCounter = 0;
  let conversationCounter = 0;

  const service = new FreedomAgentService({
    controller: { execute: async () => ({ ok: false, error: { code: 'UNSUPPORTED' } }) },
    // Keep the tab surface in memory, but exercise the production scope and
    // preview-opening path, including ownership and continued-turn observation.
    createControllerScope: async () => {
      const browser = {
        execute: async (operation, params = {}) => {
          if (operation === OPERATIONS.GET_TAB || operation === OPERATIONS.SNAPSHOT) {
            const tab = browserTabs.find((candidate) => candidate.tabId === params.tabId);
            return tab
              ? { ok: true, result: { tab: { ...tab }, elements: [] } }
              : { ok: false, error: { code: 'TAB_NOT_FOUND' } };
          }
          if (operation === OPERATIONS.LIST_TABS) {
            return {
              ok: true,
              result: {
                tabs: browserTabs.map((tab) => ({ ...tab })),
                activeTabId: browserTabs.at(-1)?.tabId || null,
              },
            };
          }
          if (operation === OPERATIONS.CREATE_TAB) {
            const tab = { tabId: `tab_${browserTabs.length + 1}`, url: params.url };
            browserTabs.push(tab);
            navigations.push({ operation, url: params.url });
            return { ok: true, result: { activeTabId: tab.tabId, tab: { ...tab } } };
          }
          if (operation === OPERATIONS.FOCUS_TAB) {
            return { ok: true, result: { activeTabId: params.tabId } };
          }
          if (operation === OPERATIONS.NAVIGATE) {
            const tab = browserTabs.find((candidate) => candidate.tabId === params.tabId);
            if (tab) tab.url = params.url;
            navigations.push({ operation, url: params.url });
            return { ok: true, result: { activeTabId: params.tabId, tab: tab && { ...tab } } };
          }
          return { ok: false, error: { code: 'UNSUPPORTED' } };
        },
      };
      return new OriginScopedAutomationController({
        controller: browser,
        createWorkspacePage: async (url) => {
          const result = await browser.execute(OPERATIONS.CREATE_TAB, { url });
          return result.result.tab.tabId;
        },
      });
    },
    createTools: async () => [],
    // The real Pi workspace tool factory, wrapped only to observe the trusted per-process terminal
    // observer and, when a scenario asks, to simulate a single observer failure.
    createWorkspaceTools: async (options) => {
      toolOptions.push(options);
      const original = options.onProcessTerminal;
      return realCreateWorkspaceTools({
        ...options,
        onProcessTerminal: (outcome) => {
          observerCalls.push({
            processId: outcome?.workspace?.processId,
            state: outcome?.workspace?.state,
          });
          if (observerFailures.enabled) {
            observerFailures.enabled = false;
            observerFailures.thrown += 1;
            throw new Error('simulated observer failure');
          }
          return original(outcome);
        },
      });
    },
    createSession: async (options) => {
      const fake = sessions.at(-1);
      fake.captured = options;
      return { session: fake.session };
    },
    effectClassifier: { classify: async () => ({ effect: 'read', confidence: 1 }) },
    interactionClassifier: {
      classify: async () => ({ kind: 'ordinary', confidence: 1, summary: '', uncertainties: [] }),
    },
    historyStore,
    workspaceController: controller,
    workspacePreviewController,
    runIdFactory: () => `run_${++runCounter}`,
    conversationIdFactory: () => `conversation_${String.fromCharCode(97 + conversationCounter++)}`,
  });
  service.subscribe((event) => {
    events.push(event);
    if (event.type !== 'approval_requested') return;
    const decision = decisions.length ? decisions.shift() : false;
    approvals.push({ event, decision });
    setImmediate(() => service.decideApproval(event.runId, event.approvalId, decision));
  });

  return {
    executor,
    executions,
    controller,
    workspaceStore,
    historyStore,
    workspacePreviewController,
    previewHandler,
    protocolRegistrations,
    storageClears,
    navigations,
    service,
    sessions,
    events,
    approvals,
    decisions,
    toolOptions,
    observerCalls,
    observerFailures,
    policyCreations: () => policyCreations,
    inFlightExecutions: () => inFlightExecutes,
  };
}

// Assemble the context handed to a scenario's run(ctx). It carries the composition, the run
// helpers (startRun/endRun/callTool), report helpers (check/record/emit), generic utilities, and a
// finally-based cleanup registry.
function buildContext(composition, { root, userDataDir, networkEnabled, includeSlow }) {
  const results = [];
  const cleanups = [];
  let callCounter = 0;

  function record(id, name, status, evidence) {
    results.push({ id, name, status });
    emit('assertion', { id, name, status, ...(evidence !== undefined && { evidence }) });
  }
  function check(id, name, condition, evidence) {
    record(id, name, condition ? 'passed' : 'failed', evidence);
    return Boolean(condition);
  }
  function onCleanup(fn) {
    cleanups.push(fn);
  }

  const { service, sessions, executions } = composition;

  async function startRun(prompt) {
    // A later run of the same conversation reuses the conversation's live Pi session and tools,
    // exactly as the service does; a new conversation gets a fresh fake session.
    const fake = service.conversation && sessions.at(-1) ? sessions.at(-1) : createFakeSession();
    if (!sessions.includes(fake)) sessions.push(fake);
    const started = await service.start({
      prompt,
      tabId: null,
      model: { id: 'qualification-fake-model', provider: 'qualification' },
      modelRuntime: { kind: 'qualification-fake-runtime' },
      createWorkspacePage: async () => 'tab_qualification',
    });
    return {
      ...started,
      fake,
      tools: fake.captured.customTools,
      systemPrompt: fake.captured.systemPrompt,
    };
  }
  async function endRun(run) {
    run.fake.endTurn();
    await service.waitForIdle();
  }
  async function callTool(run, name, params, options = {}) {
    const tool = run.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Tool ${name} is not exposed to Pi`);
    const toolCallId = `call_${++callCounter}`;
    run.fake.emit({ type: 'tool_execution_start', toolCallId, toolName: name, args: params });
    let result;
    let error;
    try {
      result = await tool.execute(toolCallId, params, options.signal, undefined, undefined);
    } catch (caught) {
      error = caught;
    }
    if (!options.deferEnd) {
      run.fake.emit({
        type: 'tool_execution_end',
        toolCallId,
        toolName: name,
        result: error ? { content: [{ type: 'text', text: error.message }] } : result,
        isError: Boolean(error),
      });
    }
    const entry = {
      toolCallId,
      tool: name,
      result,
      ...(error && { error: { code: error.code, message: error.message } }),
    };
    context.piVisible.push(entry);
    return entry;
  }
  const bashText = (entry) =>
    entry.result?.content?.map((item) => item.text).join('\n') ?? entry.error?.message ?? '';
  const lastExecution = () => executions.at(-1);
  const executionsBefore = () => executions.length;

  const context = {
    // node modules and constants, so scenarios do not re-require anything
    fs,
    os,
    path,
    net,
    spawnSync,
    OPERATIONS,
    PREVIEW_CSP,
    SERVER_PREVIEW_CSP,
    TERMINAL_PROCESS_RETENTION_MS,
    createFullNetworkCapabilities,
    createWorkspaceCapabilityRequest,
    // environment
    root,
    userDataDir,
    networkEnabled,
    includeSlow,
    // composition
    ...composition,
    // report + utilities
    record,
    check,
    emit,
    delay,
    waitFor,
    listen,
    closeServer,
    selectLanAddress,
    ssListener,
    pickFreePort,
    survivorScan,
    leakScan,
    onCleanup,
    // run helpers and derived accessors
    startRun,
    endRun,
    callTool,
    bashText,
    createFakeSession,
    lastExecution,
    executionsBefore,
    // collectors
    piVisible: [],
    durableSnapshots: [],
    // internal
    _results: results,
    _cleanups: cleanups,
  };
  return context;
}

async function teardown(context) {
  const { controller, workspacePreviewController, historyStore, service, _cleanups } = context;
  const errors = [];
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      errors.push({ label, message: error.message, code: error.code });
    }
  };
  // Terminate any yielded process still held by the conversation and tear down live namespaces.
  await step('service.dispose', () => service.dispose());
  await step('previewController.dispose', () => workspacePreviewController.dispose());
  await step('controller.dispose', () => controller.dispose());
  // Aborting a running process resolves its executor call and the controller then records the
  // cancelled receipt into SQLite asynchronously. Drain those in-flight writes before closing the
  // stores, otherwise a late write reopens a just-closed database and repopulates the fixture root.
  await step('drain', async () => {
    await waitFor(() => context.inFlightExecutions() === 0, 10_000);
    await delay(600);
  });
  await step('workspaceStore.close', () => controller.store.close());
  await step('historyStore.close', () => historyStore.close());
  for (const fn of [..._cleanups].reverse()) {
    await step('scenario.cleanup', fn);
  }
  return errors;
}

// Run a single scenario module against a fresh composition and guarantee cleanup. Returns the
// summary and never throws: a scenario error is captured, cleanup still runs, and the exit code
// reflects both assertion failures and cleanup failures.
async function runScenario(scenario, { networkEnabled = true, includeSlow = false } = {}) {
  const baseline = hostBaseline(networkEnabled);
  emit('host', baseline);
  emit('scenario', {
    id: scenario.id,
    title: scenario.title,
    networkEnabled,
    includeSlow,
  });

  if (process.platform !== 'linux') {
    emit('skip', {
      reason: 'This qualification requires Linux; the Bubblewrap sandbox is not available here.',
      platform: process.platform,
    });
    emit('summary', { scenario: scenario.id, passed: 0, failed: 0, skipped: true });
    return { skipped: true, failed: 0 };
  }
  if (!process.versions.electron) {
    throw new Error(
      'Launch through Electron in Node mode: ELECTRON_RUN_AS_NODE=1 electron <script>'
    );
  }
  if (baseline.uid === 0) {
    throw new Error('Refusing to qualify the sandbox as root');
  }
  if (!baseline.bubblewrap) {
    throw new Error('Bubblewrap is required on Linux but `bwrap --version` did not succeed');
  }

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-agent-qual-'));
  await fs.promises.chmod(root, 0o700);
  const userDataDir = path.join(root, 'user-data');
  await fs.promises.mkdir(userDataDir, { mode: 0o700 });

  const composition = buildComposition({ userDataDir, networkEnabled });
  const context = buildContext(composition, { root, userDataDir, networkEnabled, includeSlow });

  let scenarioError = null;
  try {
    await scenario.run(context);
  } catch (error) {
    scenarioError = error;
    emit('scenario_error', {
      scenario: scenario.id,
      message: error.message,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 8),
    });
  }

  const cleanupErrors = await teardown(context);
  // Remove the uniquely owned fixture root, retrying briefly in case a late store write recreated a
  // file between the drain and the removal.
  let removalError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      removalError = null;
      break;
    } catch (error) {
      removalError = error;
      await delay(400);
    }
  }
  if (removalError) {
    cleanupErrors.push({
      label: 'rm.root',
      message: removalError.message,
      code: removalError.code,
    });
  }

  const rootRemoved = !fs.existsSync(root);
  const survivors = survivorScan(scenario.survivorPattern);
  emit('cleanup', {
    scenario: scenario.id,
    rootRemoved,
    survivors,
    cleanupErrors,
  });
  // Independent cleanup assertions, always reported, so a controlled failure still proves teardown.
  context.check(
    'cleanup-root',
    'the uniquely owned temporary fixture directory was removed',
    rootRemoved,
    { root: path.basename(root) }
  );
  context.check(
    'cleanup-survivors',
    'no Bubblewrap or sandbox supervisor process survived the qualification',
    survivors === '',
    { survivors }
  );
  context.check(
    'cleanup-errors',
    'teardown completed without cleanup errors',
    cleanupErrors.length === 0,
    { cleanupErrors }
  );

  const results = context._results;
  const summary = {
    scenario: scenario.id,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    findings: results.filter((item) => item.status === 'finding').length,
    scenarioError: scenarioError ? scenarioError.message : null,
    cleanupErrors: cleanupErrors.length,
    networkEnabled,
    includeSlow,
  };
  emit('executions', { records: composition.executions });
  emit('summary', summary);

  const failed = summary.failed > 0 || Boolean(scenarioError) || cleanupErrors.length > 0;
  return { skipped: false, failed, summary };
}

module.exports = {
  runScenario,
  hostBaseline,
  emit,
  TERMINAL_PROCESS_RETENTION_MS,
};
