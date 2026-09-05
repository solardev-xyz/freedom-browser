'use strict';

// Trusted-chrome running-process controls qualification. Proves the user-visible managed-process
// controls end to end through the real production path that backs the trusted IPC handlers
// (agent:process:stop and agent:process:preview-open): FreedomAgentService.stopWorkspaceProcess /
// openWorkspaceProcessPreview → ManagedWorkspaceController.terminateProcess / listProcesses →
// ManagedWorkspaceProcessManager.terminate / list → real Bubblewrap execution and the production
// preview controller. It reads the renderer-facing projection from service.getState().workspace
// .processes exactly as the chrome renders it.
//
// The pure IPC gate (sender ownership — "another renderer" — and the processId shape check) is a
// deterministic wrapper covered by src/main/agent/ipc.test.js and src/main/preload.test.js; this
// scenario exercises everything those unit tests cannot: the real service → controller → process
// manager → Bubblewrap chain, the bounded projection, SIGKILL/namespace teardown, output-cursor
// preservation, cross-conversation isolation against live processes, preview reopening through the
// isolated preview controller, and the independent process-change broadcast.

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
    await delay(700); // more output accrues that Pi has not polled
    const stop2 = await service.stopWorkspaceProcess(proc2Id);
    const poll2 = await callTool(run1, 'write_stdin', { session_id: proc2Id, yield_time_ms: 0 });
    const ticks2 = [...bashText(poll2).matchAll(/cur-(\d+)/g)].map((m) => Number(m[1]));
    check(
      'PC4',
      'stopping through chrome does not consume the output the process buffered for the Pi write_stdin cursor',
      ticks1.length > 0 &&
        ticks2.length > 0 &&
        Math.max(...ticks1) < Math.min(...ticks2) &&
        new Set([...ticks1, ...ticks2]).size === ticks1.length + ticks2.length &&
        stop2?.state === 'cancelled' &&
        poll2.result?.details?.state === 'cancelled',
      {
        poll1Ticks: ticks1.length ? [Math.min(...ticks1), Math.max(...ticks1)] : [],
        poll2Ticks: ticks2.length ? [Math.min(...ticks2), Math.max(...ticks2)] : [],
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

    // ---- PC9: nothing survives (also enforced by the harness cleanup assertions).
    check(
      'PC9',
      'no heartbeat writer, server, Bubblewrap process, or preview listener survives the controlled processes',
      survivorProcesses() === '' && listener(port) === '',
      { survivors: survivorProcesses(), listener: listener(port) }
    );
  },
};
