'use strict';

// Automatic terminal-reconciliation qualification. Proves that a yielded managed process whose
// command ends after the Agent turn is over is reconciled without any model polling: a trusted
// per-process terminal observer projects the authoritative sandbox receipt back onto the original
// `bash` tool call, updates the terminal turn's activity in memory and durable SQLite, emits exactly
// one late tool_finished, and updates the ledger — all without disturbing a newer active turn,
// forwarding output or host authority, delaying cleanup, or being downgraded by a late stale
// `running` result. Covers natural completion, ordinary failure, timeout, stale-late-result
// protection, short-command single-finish, at-most-once firing, and observer-failure isolation.
//
// Long processes are launched only after the earlier ones settle so the per-conversation
// four-active-process limit is never reached; commands emit reversed output (`| rev`) so the leak
// scan can prove command stdout never reaches terminal events or durable activity.

module.exports = {
  id: 'reconciliation',
  title: 'Automatic terminal reconciliation without model polling',
  survivorPattern: 'hb-rc-',
  async run(ctx) {
    const {
      fs,
      os,
      path,
      spawnSync,
      check,
      delay,
      waitFor,
      leakScan,
      controller,
      workspaceStore,
      historyStore,
      service,
      executions,
      events,
      decisions,
      piVisible,
      durableSnapshots,
      toolOptions,
      observerCalls,
      observerFailures,
      startRun,
      endRun,
      callTool,
      bashText,
      root,
      userDataDir,
    } = ctx;

    const SESSION_ID = /workspace_process_[a-f0-9]{24}/g;
    const sessionIds = (entry) => [
      ...new Set([...bashText(entry).matchAll(SESSION_ID)].map((m) => m[0])),
    ];
    const finishedEvents = (toolCallId) =>
      events.filter((event) => event.type === 'tool_finished' && event.toolCallId === toolCallId);
    const runFinishedEvent = (runId) =>
      events.find((event) => event.type === 'run_finished' && event.runId === runId);
    const executorFor = (commandText) =>
      executions.find((entry) => entry.command === commandText)?.receipt;
    const survivorProcesses = () =>
      spawnSync('pgrep', ['-af', '[b]wrap|freedom-sandbox-supervisor|hb-rc-'], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((line) => line && !/shell-snapshots|pgrep|claude|qualify-agent/.test(line))
        .join('\n');
    const fullReceipt = (receipt, state) =>
      receipt &&
      receipt.state === state &&
      receipt.backend === 'linux-bubblewrap' &&
      ['none', 'full'].includes(receipt.networkPosture) &&
      receipt.terminationGuarantee === 'namespace_scoped' &&
      receipt.terminationScope === 'pid_namespace' &&
      receipt.survivorsPossible === false &&
      receipt.completeDescendantTermination === true &&
      receipt.sideEffects === 'unknown' &&
      (Number.isInteger(receipt.exitCode) || typeof receipt.signal === 'string');
    process.env.FREEDOM_QUAL_FAKE_SECRET = 'must-not-leak-9f3a7c';

    const run1 = await startRun('Start work that outlives the turn');
    const conversationA = run1.conversationId;
    decisions.push(true);
    const enable = await callTool(run1, 'bash', { command: 'printf enabled' });
    const workspaceA = controller.getWorkspace(conversationA);
    const workspaceRootA = controller.leases.get(workspaceA.workspaceId).workspaceRoot;
    if (!bashText(enable).includes('enabled')) throw new Error('workspace enable failed');

    const ledgerRows = () => workspaceStore.listCommands(conversationA, 100);
    const ledgerFor = (commandText) => ledgerRows().find((row) => row.command === commandText);
    const fileSize = (name) => {
      try {
        return fs.statSync(path.join(workspaceRootA, name)).size;
      } catch {
        return -1;
      }
    };
    const durableTurn = (runId) =>
      historyStore.getSession(conversationA)?.transcript?.find((turn) => turn.runId === runId);
    const durableItem = (runId, toolCallId) =>
      durableTurn(runId)?.activity?.find((item) => item.toolCallId === toolCallId);
    const memoryItem = (runId, toolCallId) =>
      service
        .getState()
        .transcript?.find((turn) => turn.runId === runId)
        ?.activity?.find((item) => item.toolCallId === toolCallId);

    check(
      'R0',
      'the real tool factory received the trusted process-terminal observer',
      toolOptions.length > 0 &&
        toolOptions.every((options) => typeof options.onProcessTerminal === 'function'),
      { factories: toolOptions.length }
    );

    // R5 short command: exactly one tool_finished, no asynchronous terminal event later.
    const shortCommand = 'printf short-ok';
    const short = await callTool(run1, 'bash', { command: shortCommand });

    // R4 stale late Pi result: a process that ends shortly after yielding, tool_execution_end late.
    const staleCommand = 'printf ready; sleep 0.8; printf stale | rev';
    const stale = await callTool(
      run1,
      'bash',
      { command: staleCommand, yield_time_ms: 400 },
      { deferEnd: true }
    );
    const staleId = sessionIds(stale)[0];
    await waitFor(
      () =>
        finishedEvents(stale.toolCallId).some((event) => event.workspace?.state === 'completed'),
      6_000
    );
    const staleTerminalCount = finishedEvents(stale.toolCallId).filter(
      (event) => event.workspace?.state !== 'running'
    ).length;
    run1.fake.emit({
      type: 'tool_execution_end',
      toolCallId: stale.toolCallId,
      toolName: 'bash',
      result: stale.result,
      isError: false,
    });
    await delay(200);
    const staleAfter = memoryItem(run1.runId, stale.toolCallId);
    const staleEventsAfter = finishedEvents(stale.toolCallId);
    check(
      'R4',
      'a late stale Pi result reporting the process as still running does not overwrite the recorded terminal state',
      staleId &&
        staleTerminalCount === 1 &&
        staleAfter?.workspace?.state === 'completed' &&
        staleAfter.status === 'succeeded' &&
        staleEventsAfter.filter((event) => event.workspace?.state !== 'running').length === 1 &&
        staleEventsAfter.at(-1).workspace.state === 'completed',
      {
        memory: staleAfter && {
          status: staleAfter.status,
          state: staleAfter.workspace.state,
          label: staleAfter.label,
        },
        toolFinishedStates: staleEventsAfter.map((event) => event.workspace?.state),
      }
    );

    // R7 observer failure isolation: the next process's terminal observer throws once.
    const isolatedCommand = 'printf ready; sleep 2; printf isolated';
    observerFailures.enabled = true;
    const isolated = await callTool(run1, 'bash', { command: isolatedCommand, yield_time_ms: 500 });
    const isolatedId = sessionIds(isolated)[0];
    await waitFor(() => observerFailures.thrown === 1, 6_000);
    await waitFor(() => ledgerFor(isolatedCommand)?.state === 'completed', 6_000);

    // R1/R2/R3 yielded processes that end after the turn: natural completion, failure, timeout.
    const completeCommand = 'printf ready; sleep 6; printf done | rev; exit 0';
    const failCommand = 'printf ready; sleep 6; printf failing | rev >&2; exit 7';
    const timeoutCommand = 'printf ready; while :; do printf t >> hb-rc-timeout; sleep 0.1; done';
    const complete = await callTool(run1, 'bash', { command: completeCommand, yield_time_ms: 500 });
    const fail = await callTool(run1, 'bash', { command: failCommand, yield_time_ms: 500 });
    const timeout = await callTool(run1, 'bash', {
      command: timeoutCommand,
      yield_time_ms: 500,
      timeout: 6,
    });
    const ids = {
      complete: sessionIds(complete)[0],
      fail: sessionIds(fail)[0],
      timeout: sessionIds(timeout)[0],
    };
    check(
      'R-yield',
      'each long command yielded exactly one opaque workspace_process session while still running',
      Object.values(ids).every((id) => /^workspace_process_[a-f0-9]{24}$/.test(id || '')) &&
        [complete, fail, timeout].every(
          (entry) =>
            sessionIds(entry).length === 1 &&
            finishedEvents(entry.toolCallId).at(-1)?.workspace?.state === 'running'
        ),
      ids
    );

    // The turn finishes while the long processes remain active.
    const ledgerStatesAtTurnEnd = Object.fromEntries(
      [completeCommand, failCommand, timeoutCommand].map((command) => [
        command.slice(0, 32),
        ledgerFor(command)?.state,
      ])
    );
    await endRun(run1);
    const run1Finished = runFinishedEvent(run1.runId);
    check(
      'R-turn',
      'the Agent turn finished while the three long processes were still active',
      run1Finished?.status === 'completed' &&
        Object.values(ledgerStatesAtTurnEnd).every((state) => state === 'running') &&
        durableTurn(run1.runId)?.status === 'completed' &&
        [complete, fail, timeout].every(
          (entry) => durableItem(run1.runId, entry.toolCallId)?.workspace?.state === 'running'
        ),
      { ledgerStatesAtTurnEnd, turnStatus: durableTurn(run1.runId)?.status }
    );

    // R8 a newer active turn must remain unaffected while the older processes complete.
    const run2 = await startRun('Keep working in a new turn');
    const sessionBefore = historyStore.getSession(conversationA);
    const run2TurnBefore = sessionBefore?.transcript?.find((turn) => turn.runId === run2.runId);
    const settled = await waitFor(
      () =>
        ['completed', 'failed', 'timed_out'].every(
          (state, index) =>
            ledgerFor([completeCommand, failCommand, timeoutCommand][index])?.state === state
        ),
      15_000
    );
    await waitFor(
      () =>
        [complete, fail, timeout].every(
          (entry) => memoryItem(run1.runId, entry.toolCallId)?.workspace?.state !== 'running'
        ),
      5_000
    );
    const sessionDuringRun2 = historyStore.getSession(conversationA);
    const run2DurableTurn = sessionDuringRun2?.transcript?.find(
      (turn) => turn.runId === run2.runId
    );
    const stateDuringRun2 = service.getState();
    check(
      'R8',
      'terminal history updates for the older turn did not change the newer active turn or the session status',
      settled &&
        stateDuringRun2.status === 'running' &&
        stateDuringRun2.runId === run2.runId &&
        sessionDuringRun2?.status === sessionBefore?.status &&
        run2DurableTurn?.status === run2TurnBefore?.status &&
        run2DurableTurn.activity.length === 0 &&
        durableTurn(run1.runId)?.status === 'completed' &&
        [complete, fail, timeout].every(
          (entry) => finishedEvents(entry.toolCallId).at(-1)?.runId === run1.runId
        ),
      {
        serviceStatus: stateDuringRun2.status,
        activeRun: stateDuringRun2.runId,
        sessionStatusBefore: sessionBefore?.status,
        sessionStatusAfter: sessionDuringRun2?.status,
        run2TurnStatusBefore: run2TurnBefore?.status,
        run2TurnStatusAfter: run2DurableTurn?.status,
        terminalEventRunIds: [complete, fail, timeout].map(
          (entry) => finishedEvents(entry.toolCallId).at(-1)?.runId
        ),
      }
    );
    const timeoutSize = fileSize('hb-rc-timeout');
    await delay(400);
    const timeoutStable = fileSize('hb-rc-timeout') === timeoutSize;
    await endRun(run2);

    // R1/R2/R3 assertions across transcript, durable SQLite, events, and ledger.
    const cases = [
      {
        id: 'R1',
        name: 'natural completion',
        entry: complete,
        command: completeCommand,
        state: 'completed',
        status: 'succeeded',
        exitCode: 0,
        signal: undefined,
        errorCode: undefined,
      },
      {
        id: 'R2',
        name: 'ordinary failure',
        entry: fail,
        command: failCommand,
        state: 'failed',
        status: 'failed',
        exitCode: 7,
        signal: undefined,
        errorCode: 'WORKSPACE_COMMAND_FAILED',
      },
      {
        id: 'R3',
        name: 'timeout',
        entry: timeout,
        command: timeoutCommand,
        state: 'timed_out',
        status: 'failed',
        exitCode: undefined,
        signal: 'SIGKILL',
        errorCode: 'WORKSPACE_COMMAND_TIMED_OUT',
      },
    ];
    for (const scenario of cases) {
      const memory = memoryItem(run1.runId, scenario.entry.toolCallId);
      const durable = durableItem(run1.runId, scenario.entry.toolCallId);
      const terminalEvents = finishedEvents(scenario.entry.toolCallId).filter(
        (event) => event.workspace?.state !== 'running'
      );
      const terminalEvent = terminalEvents[0];
      const ledger = ledgerFor(scenario.command);
      const executor = executorFor(scenario.command);
      const projection = (controller.getWorkspace(conversationA)?.commands || []).find(
        (entry) => entry.commandId === ledger?.commandId
      );
      const matches = (receipt) =>
        fullReceipt(receipt, scenario.state) &&
        (scenario.exitCode === undefined || receipt.exitCode === scenario.exitCode) &&
        (scenario.signal === undefined || receipt.signal === scenario.signal) &&
        receipt.processId === sessionIds(scenario.entry)[0];
      check(
        scenario.id,
        `${scenario.name}: the original bash activity became terminal automatically in memory, durable SQLite activity, one emitted tool_finished, and the ledger, with the full receipt`,
        memory &&
          memory.status === scenario.status &&
          (scenario.errorCode ? memory.errorCode === scenario.errorCode : !memory.errorCode) &&
          matches(memory.workspace) &&
          durable &&
          durable.status === scenario.status &&
          matches(durable.workspace) &&
          terminalEvents.length === 1 &&
          terminalEvent.runId === run1.runId &&
          terminalEvent.status === scenario.status &&
          matches(terminalEvent.workspace) &&
          terminalEvent.sequence > run1Finished.sequence &&
          ledger?.state === scenario.state &&
          ledger.terminationScope === 'pid_namespace' &&
          (scenario.exitCode === undefined || ledger.exitCode === scenario.exitCode) &&
          (scenario.signal === undefined || ledger.signal === scenario.signal) &&
          projection?.state === scenario.state &&
          projection.terminationScope === 'pid_namespace' &&
          executor?.terminationScope === 'pid_namespace',
        {
          memory: memory && {
            status: memory.status,
            label: memory.label,
            errorCode: memory.errorCode || null,
            workspace: memory.workspace,
          },
          durableMatchesMemory:
            JSON.stringify(durable?.workspace) === JSON.stringify(memory?.workspace),
          terminalEvent: terminalEvent && {
            sequence: terminalEvent.sequence,
            runFinishedSequence: run1Finished.sequence,
            runId: terminalEvent.runId,
            status: terminalEvent.status,
            label: terminalEvent.label,
          },
          terminalEventCount: terminalEvents.length,
          ledger: ledger && {
            state: ledger.state,
            exitCode: ledger.exitCode ?? null,
            signal: ledger.signal ?? null,
            terminationScope: ledger.terminationScope,
            networkPosture: ledger.networkPosture,
          },
          projection: projection && {
            state: projection.state,
            terminationScope: projection.terminationScope,
          },
          executor,
        }
      );
    }
    check(
      'R3-teardown',
      'the timed-out heartbeat writer stopped and no sandbox process survived',
      timeoutStable && survivorProcesses() === '',
      { timeoutStable, survivors: survivorProcesses() }
    );

    // R5 verdict: the short command produced exactly one tool_finished and never a later terminal event.
    const shortEvents = finishedEvents(short.toolCallId);
    check(
      'R5',
      'a short command that finished before yielding produced exactly one tool_finished and no duplicate asynchronous terminal event',
      shortEvents.length === 1 &&
        shortEvents[0].workspace?.state === 'completed' &&
        shortEvents[0].sequence < run1Finished.sequence &&
        durableItem(run1.runId, short.toolCallId)?.workspace?.state === 'completed',
      { count: shortEvents.length, states: shortEvents.map((event) => event.workspace?.state) }
    );

    // R6: the observer fired at most once per yielded session.
    const perSession = Object.fromEntries(
      [complete, fail, timeout, stale].map((entry) => [
        sessionIds(entry)[0],
        finishedEvents(entry.toolCallId).filter((event) => event.workspace?.state !== 'running')
          .length,
      ])
    );
    check(
      'R6',
      'the terminal observer fired at most once per yielded session',
      Object.values(perSession).every((count) => count === 1) &&
        observerCalls.filter((call) => call.processId === isolatedId).length === 1,
      {
        perSession,
        isolatedObserverCalls: observerCalls.filter((call) => call.processId === isolatedId).length,
      }
    );

    // R7: the throwing observer did not affect completion, cleanup, or receipt truthfulness.
    await waitFor(() => ledgerFor(isolatedCommand)?.state === 'completed', 6_000);
    const isolatedLedger = ledgerFor(isolatedCommand);
    const isolatedExecutor = executorFor(isolatedCommand);
    const isolatedMemory = memoryItem(run1.runId, isolated.toolCallId);
    check(
      'R7',
      'a throwing terminal observer did not affect command completion, cleanup, or receipt truthfulness',
      observerFailures.thrown === 1 &&
        isolatedLedger?.state === 'completed' &&
        isolatedLedger.exitCode === 0 &&
        isolatedLedger.terminationScope === 'pid_namespace' &&
        isolatedExecutor?.state === 'completed' &&
        isolatedExecutor.terminationScope === 'pid_namespace' &&
        survivorProcesses() === '',
      {
        thrown: observerFailures.thrown,
        ledger: isolatedLedger && {
          state: isolatedLedger.state,
          exitCode: isolatedLedger.exitCode,
          terminationScope: isolatedLedger.terminationScope,
        },
        executor: isolatedExecutor,
        memoryStateAfterThrow: isolatedMemory?.workspace?.state,
        retainedEntry: controller.processManager.entries.has(`${conversationA}\0${isolatedId}`),
      }
    );

    // R9 leak scan of model-visible terminal events and durable activity (reversed command output).
    const terminalEventText = JSON.stringify(
      events.filter((event) => event.type === 'tool_finished' && event.runId === run1.runId)
    );
    durableSnapshots.push({
      conversationId: conversationA,
      history: historyStore.getSession(conversationA),
      commands: ledgerRows(),
    });
    const durableHistoryText = JSON.stringify(durableSnapshots.map((snapshot) => snapshot.history));
    check(
      'R9',
      'terminal events and durable activity carry no stdout, stderr, host path, authority object, readiness token, or secret',
      [terminalEventText, durableHistoryText].every(
        (text) =>
          !text.includes('enod') &&
          !text.includes('gniliaf') &&
          !text.includes('elats') &&
          !text.includes('must-not-leak-9f3a7c') &&
          !text.includes('freedom-sandbox-ready') &&
          !text.includes(root) &&
          !text.includes(os.homedir()) &&
          !text.includes('runtimeRoots') &&
          !text.includes('sourcePath') &&
          !text.includes('capabilityRequest') &&
          !text.includes('"stdout"') &&
          !text.includes('"stderr"')
      ),
      { eventBytes: terminalEventText.length, historyBytes: durableHistoryText.length }
    );
    const allVisible = JSON.stringify(piVisible);
    check(
      'R11',
      'the readiness marker and the environment secret never reach model-visible output',
      !allVisible.includes('freedom-sandbox-ready') && !allVisible.includes('must-not-leak-9f3a7c'),
      { bytes: allVisible.length }
    );
    const terminalStates = ledgerRows().map((row) => row.state);
    check(
      'R12',
      'the ledger reaches real terminal states for every command',
      terminalStates.length > 0 && !terminalStates.includes('running'),
      {
        states: Object.fromEntries(
          [...new Set(terminalStates)].map((state) => [
            state,
            terminalStates.filter((s) => s === state).length,
          ])
        ),
      }
    );

    // 2d: no host path or internal authority object reaches Pi-visible results or durable activity.
    const markers = [
      root,
      userDataDir,
      os.homedir(),
      'sourcePath',
      'mountPath',
      'runtimeRoots',
      'executablePaths',
      'capabilityRequest',
      'freedom.command-permissions',
      'freedom.workspace-capability-request',
      'must-not-leak-9f3a7c',
      'freedom-sandbox-ready',
    ];
    const durable = [
      ...durableSnapshots.map((snapshot) => snapshot.history),
      ...['conversation_a', 'conversation_b'].map((id) => historyStore.getSession(id)),
    ].filter(Boolean);
    const durableCommands = [
      ...durableSnapshots.flatMap((snapshot) => snapshot.commands),
      ...['conversation_a', 'conversation_b'].flatMap((id) => {
        try {
          return workspaceStore.listCommands(id, 100);
        } catch {
          return [];
        }
      }),
    ];
    const scans = [
      leakScan('pi_visible_tool_results', piVisible, markers),
      leakScan('durable_history_activity', durable, markers),
      leakScan('durable_workspace_commands', durableCommands, markers),
      leakScan(
        'service_events_excluding_approvals',
        events.filter((event) => event.type !== 'approval_requested'),
        markers
      ),
      leakScan(
        'approval_events_authority_objects',
        events.filter((event) => event.type === 'approval_requested'),
        markers.filter((marker) => !marker.startsWith('/'))
      ),
    ];
    check(
      '2d',
      'no host path or internal authority object reaches Pi-visible results or durable activity',
      scans.every((scan) => scan.found.length === 0),
      scans
    );
  },
};
