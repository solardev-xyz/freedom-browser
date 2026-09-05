'use strict';

// Trusted-chrome running-process controls qualification. Proves the user-visible managed-process
// controls end to end through the real production path that backs the trusted IPC handlers
// (agent:process:stop and agent:process:preview-open): FreedomAgentService.stopWorkspaceProcess /
// openWorkspaceProcessPreview → ManagedWorkspaceController.terminateProcess / listProcesses →
// ManagedWorkspaceProcessManager.terminate / list → real Bubblewrap execution and the production
// preview controller. It reads the renderer-facing projection from service.getState().workspace
// .processes exactly as the chrome renders it.
//
// The scenario runs in two parts. Part one (PC*) drives the service methods directly against the
// real composition. Part two (PCI*) registers the production Freedom agent IPC (registerFreedomAgentIpc)
// against the same real service and Bubblewrap composition, establishes a chrome-owned run through the
// real agent:start handler, and invokes the registered agent:process:stop / agent:process:preview-open
// handlers with the owning sender, another renderer, a malformed id, and a cross-conversation id —
// proving the full trusted IPC path including the sender-ownership and shape gate, and that a rejected
// request leaves the live process untouched.

const { EventEmitter } = require('events');
const { registerFreedomAgentIpc, AGENT_IPC_ERROR_CODES } = require('../../../src/main/agent/ipc');
const IPC = require('../../../src/shared/ipc-channels');

module.exports = {
  id: 'process-controls',
  title: 'Trusted-chrome running-process controls (list, stop, preview)',
  survivorPattern: 'hb-pc-|node server\\.js',
  async run(ctx) {
    const {
      fs,
      os,
      path,
      emit,
      check,
      delay,
      waitFor,
      pickFreePort,
      ssListener: listener,
      previewHandler,
      navigations,
      controller,
      workspaceStore,
      historyStore,
      workspacePreviewController,
      service,
      executions,
      events,
      decisions,
      piVisible,
      durableSnapshots,
      startRun,
      endRun,
      callTool,
      bashText,
      createFakeSession,
      sessions,
      onCleanup,
      spawnSync,
      root,
    } = ctx;

    const SESSION_ID = /workspace_process_[a-f0-9]{24}/g;
    const sessionIds = (entry) => [
      ...new Set([...bashText(entry).matchAll(SESSION_ID)].map((m) => m[0])),
    ];
    const ledgerRows = (conversationId) => workspaceStore.listCommands(conversationId, 100);
    const executorFor = (commandText) =>
      executions
        .filter((entry) => entry.command === commandText)
        .sort((a, b) => b.index - a.index)[0]?.receipt;
    const survivorProcesses = () =>
      spawnSync('pgrep', ['-af', '[b]wrap|freedom-sandbox-supervisor|hb-pc-|node server\\.js'], {
        encoding: 'utf8',
      })
        .stdout.split('\n')
        .filter(
          (line) =>
            line && !/shell-snapshots|pgrep|claude|qualify-agent|agent-qualification/.test(line)
        )
        .join('\n');
    const ALLOWED_KEYS = [
      'processId',
      'command',
      'workingDirectory',
      'state',
      'backend',
      'networkPosture',
      'previewPort',
    ];
    // The renderer reads exactly service.getState().workspace.processes.
    const projection = () => service.getState()?.workspace?.processes || [];
    const projectionFor = (id) => projection().find((entry) => entry.processId === id);
    const executorTruthful = (receipt, posture) =>
      receipt &&
      receipt.state === 'cancelled' &&
      receipt.signal === 'SIGKILL' &&
      receipt.terminationGuarantee === 'namespace_scoped' &&
      receipt.terminationScope === 'pid_namespace' &&
      receipt.survivorsPossible === false &&
      receipt.completeDescendantTermination === true &&
      receipt.networkPosture === posture;
    const probe = async (url) => {
      const response = await previewHandler(new Request(url));
      const text = await response.text();
      return { status: response.status, text };
    };
    process.env.FREEDOM_QUAL_FAKE_SECRET = 'must-not-leak-9f3a7c';

    const run1 = await startRun('Qualify running-process controls');
    const conversationA = run1.conversationId;
    decisions.push(true);
    const enable = await callTool(run1, 'bash', { command: 'mkdir -p sub && printf enabled' });
    if (!bashText(enable).includes('enabled')) throw new Error('workspace enable failed');
    const workspaceA = controller.getWorkspace(conversationA);
    const workspaceRootA = controller.leases.get(workspaceA.workspaceId).workspaceRoot;
    const fileSize = (name) => {
      try {
        return fs.statSync(path.join(workspaceRootA, name)).size;
      } catch {
        return -1;
      }
    };

    // ---- PC0: short commands never appear in the live projection.
    const short = await callTool(run1, 'bash', { command: 'printf short-only' });
    check(
      'PC0',
      'a short command that never yields does not appear in the live process projection',
      sessionIds(short).length === 0 &&
        projection().length === 0 &&
        controller.listProcesses(conversationA).length === 0,
      { projectionLength: projection().length, text: bashText(short) }
    );

    // ---- PC1: a yielded, still-running command appears once with only bounded public fields.
    const heartbeat =
      'printf ready; i=0; while :; do i=$((i+1)); printf \'pc-out-%s\\n\' "$i"; printf x >> hb-pc-1; sleep 0.2; done';
    const proc = await callTool(run1, 'bash', { command: heartbeat });
    const procId = sessionIds(proc)[0];
    const entry = projectionFor(procId);
    check(
      'PC1',
      'a yielded, still-running command appears once in the projection with only bounded public fields',
      /^workspace_process_[a-f0-9]{24}$/.test(procId || '') &&
        projection().length === 1 &&
        entry &&
        entry.processId === procId &&
        entry.state === 'running' &&
        entry.backend === 'linux-bubblewrap' &&
        entry.networkPosture === 'none' &&
        typeof entry.command === 'string' &&
        entry.command.length > 0 &&
        entry.command.length <= 500 &&
        entry.workingDirectory === '.' &&
        !('previewPort' in entry) &&
        Object.keys(entry).every((key) => ALLOWED_KEYS.includes(key)),
      { entry, keys: entry && Object.keys(entry) }
    );

    // ---- PC2: the projection carries no host path, output, capability, authority, or private data.
    const projText = JSON.stringify(projection());
    check(
      'PC2',
      'the process projection contains no host path, buffered stdout/stderr, capability object, authority, credential, or private sandbox data',
      !projText.includes(root) &&
        !projText.includes(os.homedir()) &&
        !projText.includes(workspaceRootA) &&
        !projText.includes('pc-out-1') &&
        !projText.includes('freedom-sandbox-ready') &&
        !projText.includes('must-not-leak-9f3a7c') &&
        !projText.includes('runtimeRoots') &&
        !projText.includes('sourcePath') &&
        !projText.includes('mountPath') &&
        !projText.includes('capabilityRequest') &&
        !projText.includes('"workspace"') &&
        !projText.includes('"output"') &&
        !projText.includes('"receipt"'),
      { bytes: projText.length, sample: projection() }
    );

    // ---- PC5-iso: another conversation and a malformed id cannot stop or inspect the live process.
    let crossStop;
    try {
      await controller.terminateProcess('conversation_other', procId, { waitMs: 0 });
      crossStop = 'accepted';
    } catch (error) {
      crossStop = error.code;
    }
    const crossList = controller.listProcesses('conversation_other');
    let malformedStop;
    try {
      await service.stopWorkspaceProcess('bad');
      malformedStop = 'accepted';
    } catch (error) {
      malformedStop = error.code;
    }
    let unknownStop;
    try {
      await service.stopWorkspaceProcess('workspace_process_0123456789abcdef01234567');
      unknownStop = 'accepted';
    } catch (error) {
      unknownStop = error.code;
    }
    const survivedIsolation = projectionFor(procId);
    check(
      'PC5-iso',
      'another conversation and malformed or unknown ids cannot stop or inspect the process, and the live process is unaffected',
      crossStop === 'WORKSPACE_PROCESS_NOT_FOUND' &&
        crossList.length === 0 &&
        malformedStop === 'INVALID_ARGUMENT' &&
        unknownStop === 'INVALID_ARGUMENT' &&
        survivedIsolation?.processId === procId &&
        survivedIsolation.state === 'running',
      {
        crossStop,
        crossList: crossList.length,
        malformedStop,
        unknownStop,
        stillRunning: Boolean(survivedIsolation),
      }
    );

    // ---- PC3: chrome Stop reaches real Bubblewrap SIGKILL; the process disappears; ledger terminal.
    const hbBefore = fileSize('hb-pc-1');
    await delay(300);
    const hbGrowing = fileSize('hb-pc-1') > hbBefore;
    const stopResult = await service.stopWorkspaceProcess(procId);
    const stopReceipt = stopResult?.workspace;
    const stopExecutor = executorFor(heartbeat);
    const hbAtStop = fileSize('hb-pc-1');
    await delay(500);
    const hbStable = fileSize('hb-pc-1') === hbAtStop;
    const ledgerA = ledgerRows(conversationA).find((row) => row.command === heartbeat);
    emit('stop_result', { stopResult, projectionAfter: projection() });
    check(
      'PC3',
      'chrome Stop terminates the exact process through real Bubblewrap namespace teardown with a truthful SIGKILL receipt; it disappears from the live projection while its terminal ledger evidence remains',
      hbGrowing &&
        stopResult?.state === 'cancelled' &&
        stopReceipt?.state === 'cancelled' &&
        stopReceipt.signal === 'SIGKILL' &&
        stopReceipt.terminationGuarantee === 'namespace_scoped' &&
        stopReceipt.terminationScope === 'pid_namespace' &&
        stopReceipt.backend === 'linux-bubblewrap' &&
        stopReceipt.survivorsPossible === false &&
        stopReceipt.completeDescendantTermination === true &&
        stopReceipt.networkPosture === 'none' &&
        executorTruthful(stopExecutor, 'none') &&
        projectionFor(procId) === undefined &&
        projection().length === 0 &&
        ledgerA?.state === 'cancelled' &&
        ledgerA.signal === 'SIGKILL' &&
        ledgerA.terminationScope === 'pid_namespace' &&
        hbStable &&
        survivorProcesses() === '',
      {
        hbGrowing,
        topState: stopResult?.state,
        receipt: stopReceipt,
        executor: stopExecutor,
        ledger: ledgerA && {
          state: ledgerA.state,
          signal: ledgerA.signal,
          terminationScope: ledgerA.terminationScope,
        },
        hbStable,
        survivors: survivorProcesses(),
      }
    );

    // ---- PC4: chrome Stop does not consume the process's Pi write_stdin output cursor.
    const heartbeat2 =
      'printf ready; i=0; while :; do i=$((i+1)); printf \'cur-%s\\n\' "$i"; sleep 0.15; done';
    const proc2 = await callTool(run1, 'bash', { command: heartbeat2, yield_time_ms: 600 });
    const proc2Id = sessionIds(proc2)[0];
    const poll1 = await callTool(run1, 'write_stdin', { session_id: proc2Id, yield_time_ms: 500 });
    const ticks1 = [...bashText(poll1).matchAll(/cur-(\d+)/g)].map((m) => Number(m[1]));
    await delay(700); // known output accrues (ticks after Pi's last poll) that Pi has not read
    const stop2 = await service.stopWorkspaceProcess(proc2Id);
    const poll2 = await callTool(run1, 'write_stdin', { session_id: proc2Id, yield_time_ms: 0 });
    const ticks2 = [...bashText(poll2).matchAll(/cur-(\d+)/g)].map((m) => Number(m[1]));
    // The union of what Pi read before Stop and what it reads after must be a single contiguous run
    // of tick numbers with no gap and no duplicate: chrome Stop neither dropped nor re-served output.
    const union = [...ticks1, ...ticks2];
    const sorted = [...union].sort((a, b) => a - b);
    const contiguousNoGap =
      sorted.length > 0 &&
      sorted.every((tick, index) => index === 0 || tick === sorted[index - 1] + 1);
    const noDuplicates = new Set(union).size === union.length;
    const stopPreservedTail = ticks2.length > 0 && Math.min(...ticks2) === Math.max(...ticks1) + 1;
    check(
      'PC4',
      'stopping through chrome preserves the exact unread output the process buffered for the Pi write_stdin cursor, with no gap and no duplication',
      ticks1.length > 0 &&
        ticks2.length > 0 &&
        stopPreservedTail &&
        contiguousNoGap &&
        noDuplicates &&
        stop2?.state === 'cancelled' &&
        poll2.result?.details?.state === 'cancelled',
      {
        poll1Ticks: ticks1.length ? [Math.min(...ticks1), Math.max(...ticks1)] : [],
        poll2Ticks: ticks2.length ? [Math.min(...ticks2), Math.max(...ticks2)] : [],
        firstUnreadAfterStop: ticks2.length ? Math.min(...ticks2) : null,
        lastReadBeforeStop: ticks1.length ? Math.max(...ticks1) : null,
        contiguousNoGap,
        noDuplicates,
        poll2State: poll2.result?.details?.state,
      }
    );

    // ---- PC6: a declared server is reopenable through the chrome preview action; cross-conversation
    //           preview is refused; chrome Stop revokes the route.
    const SERVER_SOURCE = [
      "const http = require('http');",
      'const port = Number(process.argv[2]);',
      "const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>pc-server-ok</h1>'); });",
      "server.listen(port, '127.0.0.1', () => console.log(`listening ${port}`));",
    ].join('\n');
    const serverWrite = await callTool(run1, 'write', {
      path: 'server.js',
      content: SERVER_SOURCE,
    });
    if (serverWrite.error) throw new Error(`write server.js failed: ${serverWrite.error.message}`);
    const port = await pickFreePort();
    const serverCommand = `node server.js ${port}`;
    decisions.push({ approved: true, workspacePermissionScope: 'once' });
    const perm = await callTool(run1, 'request_permissions', {
      executables: ['node'],
      network: 'full',
      reason: 'Serve the project for a chrome preview',
      command: serverCommand,
      workingDirectory: '.',
    });
    const serverLaunch = await callTool(run1, 'bash', {
      command: serverCommand,
      previewPort: port,
      yield_time_ms: 2_500,
    });
    const serverId = sessionIds(serverLaunch)[0];
    const serverEntry = projectionFor(serverId);
    let crossPreview;
    try {
      workspacePreviewController.createProcessPreview('conversation_other', serverId);
      crossPreview = 'accepted';
    } catch (error) {
      crossPreview = error.code;
    }
    const navsBefore = navigations.length;
    const opened = await service.openWorkspaceProcessPreview(serverId);
    const previewUrl = navigations.at(-1)?.url;
    const token = /^freedom-preview:\/\/([a-f0-9]{20,128})\/$/.exec(previewUrl || '')?.[1];
    const live = await probe(previewUrl);
    // Reopen: an existing preview tab is focused and re-navigated, not minted anew.
    const reopened = await service.openWorkspaceProcessPreview(serverId);
    const tokensSeen = [
      ...new Set(
        navigations
          .slice(navsBefore)
          .map((navigation) => /freedom-preview:\/\/([a-f0-9]+)/.exec(navigation.url)?.[1])
          .filter(Boolean)
      ),
    ];
    check(
      'PC6-preview',
      'a declared server is reopened through the chrome preview action via the isolated preview controller; another conversation cannot preview it',
      serverEntry?.previewPort === port &&
        serverEntry.networkPosture === 'full' &&
        crossPreview === 'WORKSPACE_PROCESS_NOT_FOUND' &&
        !perm.error &&
        opened?.processId === serverId &&
        opened.port === port &&
        typeof opened.tabId === 'string' &&
        Boolean(token) &&
        live.status === 200 &&
        live.text.includes('pc-server-ok') &&
        reopened?.processId === serverId &&
        reopened.tabId === opened.tabId &&
        tokensSeen.length === 1,
      {
        serverEntry,
        crossPreview,
        opened,
        reopened,
        previewUrl: previewUrl?.replace(token || '', '<token>'),
        liveStatus: live.status,
        tokensSeen: tokensSeen.length,
      }
    );
    const serverStop = await service.stopWorkspaceProcess(serverId);
    const afterStop = await probe(previewUrl);
    const afterStopAgain = await probe(previewUrl);
    check(
      'PC6-revoke',
      'chrome Stop terminates the server and revokes its preview route',
      serverStop?.state === 'cancelled' &&
        serverStop.workspace?.signal === 'SIGKILL' &&
        serverStop.workspace.previewPort === port &&
        projectionFor(serverId) === undefined &&
        [410, 404].includes(afterStop.status) &&
        afterStopAgain.status === 404 &&
        listener(port) === '' &&
        survivorProcesses() === '',
      {
        receipt: serverStop?.workspace,
        afterStop: [afterStop.status, afterStopAgain.status],
        listener: listener(port),
      }
    );

    // ---- PC7: natural completion during a newer Agent turn triggers the independent
    //           workspace_processes_changed refresh path.
    const completeCommand = 'printf ready; sleep 3; printf pc-done';
    const completing = await callTool(run1, 'bash', {
      command: completeCommand,
      yield_time_ms: 500,
    });
    const completingId = sessionIds(completing)[0];
    const presentDuringTurn = Boolean(projectionFor(completingId));
    await endRun(run1);
    const run2 = await startRun('Keep working while the process finishes');
    const broadcastsBefore = events.filter(
      (event) => event.type === 'workspace_processes_changed'
    ).length;
    await waitFor(
      () =>
        ledgerRows(conversationA).find((row) => row.command === completeCommand)?.state ===
        'completed',
      12_000
    );
    // Allow the reconciliation broadcast to be delivered.
    await waitFor(
      () =>
        events.filter((event) => event.type === 'workspace_processes_changed').length >
        broadcastsBefore,
      5_000
    );
    const changeEvents = events.filter((event) => event.type === 'workspace_processes_changed');
    const lastChange = changeEvents.at(-1);
    check(
      'PC7',
      'natural completion during a newer Agent turn emits the independent workspace_processes_changed refresh and drops the process from the live projection',
      presentDuringTurn &&
        changeEvents.length > broadcastsBefore &&
        lastChange?.conversationId === conversationA &&
        !JSON.stringify(changeEvents).match(/must-not-leak|pc-done|freedom-sandbox-ready/) &&
        projectionFor(completingId) === undefined,
      {
        presentDuringTurn,
        broadcastsBefore,
        broadcastsAfter: changeEvents.length,
        lastChangeConversation: lastChange?.conversationId,
      }
    );
    await endRun(run2);

    // ---- PC8: durable/terminal evidence + no residual leak across the projection and history.
    durableSnapshots.push({
      conversationId: conversationA,
      history: historyStore.getSession(conversationA),
      commands: ledgerRows(conversationA),
    });
    const terminalStates = ledgerRows(conversationA).map((row) => row.state);
    const durableHistoryText = JSON.stringify(durableSnapshots.map((snapshot) => snapshot.history));
    const allVisible = JSON.stringify(piVisible);
    check(
      'PC8',
      'every controlled process reaches a real terminal ledger state and no host path, secret, readiness marker, or authority object leaks into durable activity or model-visible output',
      terminalStates.length > 0 &&
        !terminalStates.includes('running') &&
        !durableHistoryText.includes('must-not-leak-9f3a7c') &&
        !durableHistoryText.includes('freedom-sandbox-ready') &&
        !durableHistoryText.includes(root) &&
        !durableHistoryText.includes(os.homedir()) &&
        !durableHistoryText.includes('runtimeRoots') &&
        !durableHistoryText.includes('sourcePath') &&
        !allVisible.includes('must-not-leak-9f3a7c') &&
        !allVisible.includes('freedom-sandbox-ready'),
      {
        states: Object.fromEntries(
          [...new Set(terminalStates)].map((state) => [
            state,
            terminalStates.filter((s) => s === state).length,
          ])
        ),
        historyBytes: durableHistoryText.length,
      }
    );

    // ===================================================================================
    // Part two: the registered production IPC handlers against the same real composition.
    // ===================================================================================
    await service.clearConversation();

    const ipcMain = {
      handlers: new Map(),
      handle(channel, handler) {
        this.handlers.set(channel, handler);
      },
      removeHandler(channel) {
        this.handlers.delete(channel);
      },
    };
    const makeSender = (id) => {
      const sender = new EventEmitter();
      sender.id = id;
      sender.send = () => {};
      sender.isDestroyed = () => false;
      return sender;
    };
    const ownerSender = makeSender(41);
    const otherSender = makeSender(42);
    const noop = () => {};
    const unregisterIpc = registerFreedomAgentIpc({
      ipcMain,
      service,
      automationTabIdForRenderer: () => null,
      createAutomationPageForHost: async () => 'tab_ipc_workspace',
      desktopBindingForAutomationTab: () => null,
      resolveModel: async () => ({
        model: { id: 'qualification-fake-model', provider: 'qualification' },
        modelRuntime: { kind: 'qualification-fake-runtime' },
        thinkingLevel: 'low',
      }),
      providerResolver: {
        getStatus: () => ({ configured: false }),
        getCatalog: async () => [],
        configureHosted: async () => ({}),
        configureOllama: () => ({}),
        loginSubscription: async () => ({}),
        selectModel: async () => ({}),
        removeProvider: () => ({}),
        clear: () => ({}),
      },
      isTrustedSender: (candidate) => candidate === ownerSender,
      openExternal: async () => {},
      attachmentStore: {
        pickFiles: async () => [],
        pickFolder: async () => [],
        removeStaged: () => true,
        clearStaged: noop,
        renderPreview: async () => ({}),
      },
      getOwnerWindow: () => null,
    });
    onCleanup(async () => {
      try {
        await unregisterIpc();
      } catch {
        // best-effort teardown of the registered handlers
      }
    });
    const handlerFor = (channel) => ipcMain.handlers.get(channel);

    // Establish a chrome-owned run through the real agent:start handler (not a direct service.start).
    const ipcFake = createFakeSession();
    sessions.push(ipcFake);
    const startEnvelope = await handlerFor(IPC.AGENT_START)(
      { sender: ownerSender },
      { rendererTabId: null, prompt: 'Own the run from trusted chrome' }
    );
    const ipcRun = {
      fake: ipcFake,
      tools: ipcFake.captured?.customTools || [],
      conversationId: service.conversation?.conversationId,
      runId: service.getState()?.runId,
    };
    decisions.push(true);
    const ipcEnable = await callTool(ipcRun, 'bash', { command: 'printf enabled-ipc' });
    const ipcHeartbeat =
      'printf ready; i=0; while :; do i=$((i+1)); printf \'ipc-%s\\n\' "$i"; sleep 0.2; done';
    const ipcProc = await callTool(ipcRun, 'bash', { command: ipcHeartbeat });
    const ipcProcId = sessionIds(ipcProc)[0];
    const ipcServerWrite = await callTool(ipcRun, 'write', {
      path: 'server.js',
      content: SERVER_SOURCE,
    });
    if (ipcServerWrite.error) throw new Error(`ipc write server.js failed`);
    const ipcPort = await pickFreePort();
    const ipcServerCommand = `node server.js ${ipcPort}`;
    decisions.push({ approved: true, workspacePermissionScope: 'once' });
    await callTool(ipcRun, 'request_permissions', {
      executables: ['node'],
      network: 'full',
      reason: 'Serve for a chrome preview through IPC',
      command: ipcServerCommand,
      workingDirectory: '.',
    });
    const ipcServerLaunch = await callTool(ipcRun, 'bash', {
      command: ipcServerCommand,
      previewPort: ipcPort,
      yield_time_ms: 2_500,
    });
    const ipcServerId = sessionIds(ipcServerLaunch)[0];
    check(
      'PCI0',
      'the registered IPC handlers exist and a chrome-owned run exposes its live processes to the owning sender',
      startEnvelope?.ok === true &&
        typeof handlerFor(IPC.AGENT_PROCESS_STOP) === 'function' &&
        typeof handlerFor(IPC.AGENT_PROCESS_PREVIEW_OPEN) === 'function' &&
        /^workspace_process_[a-f0-9]{24}$/.test(ipcProcId || '') &&
        /^workspace_process_[a-f0-9]{24}$/.test(ipcServerId || '') &&
        bashText(ipcEnable).includes('enabled-ipc') &&
        (service.getState()?.workspace?.processes || []).some(
          (entry) => entry.processId === ipcProcId
        ),
      {
        startOk: startEnvelope?.ok,
        conversationId: ipcRun.conversationId,
        processCount: (service.getState()?.workspace?.processes || []).length,
      }
    );

    const stopHandler = handlerFor(IPC.AGENT_PROCESS_STOP);
    const previewHandlerIpc = handlerFor(IPC.AGENT_PROCESS_PREVIEW_OPEN);
    const ipcProcLive = () =>
      (service.getState()?.workspace?.processes || []).some(
        (entry) => entry.processId === ipcProcId
      );
    const ipcServerLive = () =>
      (service.getState()?.workspace?.processes || []).some(
        (entry) => entry.processId === ipcServerId
      );

    // ---- PCI-stop: owner success, other-renderer, malformed, and cross-conversation rejection.
    const stopOther = await stopHandler({ sender: otherSender }, { processId: ipcProcId });
    const stopMalformed = await stopHandler(
      { sender: ownerSender },
      { processId: 'not-a-process' }
    );
    // procId is conversation A's (now-cleared) heartbeat id — a genuine cross-conversation identity.
    const stopCross = await stopHandler({ sender: ownerSender }, { processId: procId });
    const liveAfterRejections = ipcProcLive();
    const stopOwner = await stopHandler({ sender: ownerSender }, { processId: ipcProcId });
    const ipcStopReceipt = stopOwner?.result?.workspace;
    check(
      'PCI-stop',
      'the registered agent:process:stop handler rejects another renderer (NOT_OWNER), a malformed id (NOT_OWNER), and a cross-conversation id (INVALID_ARGUMENT) without affecting the live process, then stops the owned process through real Bubblewrap for the owning sender',
      stopOther?.ok === false &&
        stopOther.error?.code === AGENT_IPC_ERROR_CODES.NOT_OWNER &&
        stopMalformed?.ok === false &&
        stopMalformed.error?.code === AGENT_IPC_ERROR_CODES.NOT_OWNER &&
        stopCross?.ok === false &&
        stopCross.error?.code === 'INVALID_ARGUMENT' &&
        liveAfterRejections === true &&
        stopOwner?.ok === true &&
        stopOwner.result?.state === 'cancelled' &&
        ipcStopReceipt?.signal === 'SIGKILL' &&
        ipcStopReceipt.terminationScope === 'pid_namespace' &&
        ipcStopReceipt.terminationGuarantee === 'namespace_scoped' &&
        ipcStopReceipt.backend === 'linux-bubblewrap' &&
        !(stopOwner.state?.workspace?.processes || []).some(
          (entry) => entry.processId === ipcProcId
        ) &&
        ipcProcLive() === false,
      {
        stopOther: stopOther?.error?.code,
        stopMalformed: stopMalformed?.error?.code,
        stopCross: stopCross?.error?.code,
        liveAfterRejections,
        stopOwnerOk: stopOwner?.ok,
        receipt: ipcStopReceipt,
        returnedProcessCount: (stopOwner.state?.workspace?.processes || []).length,
      }
    );

    // ---- PCI-preview: owner success (reopen), other-renderer, malformed, and cross-conversation.
    const previewOther = await previewHandlerIpc(
      { sender: otherSender },
      { processId: ipcServerId }
    );
    const previewMalformed = await previewHandlerIpc({ sender: ownerSender }, { processId: 'bad' });
    const previewCross = await previewHandlerIpc({ sender: ownerSender }, { processId: procId });
    const serverLiveAfterRejections = ipcServerLive();
    const navsBeforeIpc = navigations.length;
    const previewOwner = await previewHandlerIpc(
      { sender: ownerSender },
      { processId: ipcServerId }
    );
    const ipcPreviewUrl = navigations.at(-1)?.url;
    const ipcLive = await probe(ipcPreviewUrl);
    const previewReopen = await previewHandlerIpc(
      { sender: ownerSender },
      { processId: ipcServerId }
    );
    check(
      'PCI-preview',
      'the registered agent:process:preview-open handler rejects another renderer, a malformed id, and a cross-conversation id without affecting the process, then opens and reopens the isolated preview for the owning sender',
      previewOther?.ok === false &&
        previewOther.error?.code === AGENT_IPC_ERROR_CODES.NOT_OWNER &&
        previewMalformed?.ok === false &&
        previewMalformed.error?.code === AGENT_IPC_ERROR_CODES.NOT_OWNER &&
        previewCross?.ok === false &&
        previewCross.error?.code === 'INVALID_ARGUMENT' &&
        serverLiveAfterRejections === true &&
        previewOwner?.ok === true &&
        previewOwner.result?.processId === ipcServerId &&
        previewOwner.result.port === ipcPort &&
        typeof previewOwner.result.tabId === 'string' &&
        navigations.length > navsBeforeIpc &&
        ipcLive.status === 200 &&
        ipcLive.text.includes('pc-server-ok') &&
        previewReopen?.ok === true &&
        previewReopen.result?.tabId === previewOwner.result.tabId,
      {
        previewOther: previewOther?.error?.code,
        previewMalformed: previewMalformed?.error?.code,
        previewCross: previewCross?.error?.code,
        serverLiveAfterRejections,
        previewOwner: previewOwner?.result,
        liveStatus: ipcLive.status,
        reopenTabMatches: previewReopen?.result?.tabId === previewOwner?.result?.tabId,
      }
    );

    // Stop the IPC-owned server through the registered handler and end the owned turn.
    const ipcServerStop = await stopHandler({ sender: ownerSender }, { processId: ipcServerId });
    check(
      'PCI-revoke',
      'stopping the IPC-owned server through the registered handler terminates it and revokes its preview route',
      ipcServerStop?.ok === true &&
        ipcServerStop.result?.state === 'cancelled' &&
        ipcServerStop.result.workspace?.signal === 'SIGKILL' &&
        ipcServerLive() === false &&
        [410, 404].includes((await probe(ipcPreviewUrl)).status) &&
        listener(ipcPort) === '',
      { stopOk: ipcServerStop?.ok, listener: listener(ipcPort) }
    );
    await endRun(ipcRun);

    // ---- PC9: nothing survives (also enforced by the harness cleanup assertions).
    check(
      'PC9',
      'no heartbeat writer, server, Bubblewrap process, or preview listener survives the controlled processes',
      survivorProcesses() === '' && listener(port) === '' && listener(ipcPort) === '',
      { survivors: survivorProcesses(), listener: listener(port), ipcListener: listener(ipcPort) }
    );
  },
};
