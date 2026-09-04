'use strict';

// Managed-process qualification. Proves that Pi's ordinary `bash` surface models long-running
// commands as standard shell sessions: a command that finishes within the yield window returns
// normally, while an active command yields exactly one opaque conversation-owned session ID that is
// continued through the trusted `write_stdin` tool (poll for incremental output, feed bounded
// stdin, or terminate). Covers yielding, incremental output, stdin, output/input bounds, the
// four-active limit, concurrency identity, the retained-terminal poll, allow-once networking that
// stays with its launched process, conversation isolation, explicit termination, Stop, disposal,
// and — only under includeSlow — terminal-handle expiry after the five-minute retention window.

module.exports = {
  id: 'processes',
  title: 'Managed processes: yield, stdin, bounds, termination, Stop, disposal, expiry',
  survivorPattern: 'hb-|netloop|cwd=',
  async run(ctx) {
    const {
      fs,
      path,
      net,
      spawnSync,
      emit,
      check,
      delay,
      listen,
      closeServer,
      onCleanup,
      controller,
      workspaceStore,
      historyStore,
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
      lastExecution,
      root,
      includeSlow,
      TERMINAL_PROCESS_RETENTION_MS,
    } = ctx;

    // A host loopback TCP server so the sandboxed netloop can prove full networking (M16).
    const tcpServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('host-tcp');
    });
    await listen(tcpServer, { host: '0.0.0.0', port: 0 });
    const tcpPort = tcpServer.address().port;
    onCleanup(() => closeServer(tcpServer));

    const SESSION_ID = /workspace_process_[a-f0-9]{24}/g;
    const sessionIds = (entry) => [
      ...new Set([...bashText(entry).matchAll(SESSION_ID)].map((m) => m[0])),
    ];
    const toolFinished = (toolCallId) =>
      events.find((event) => event.type === 'tool_finished' && event.toolCallId === toolCallId);
    const survivors = () => {
      const found = spawnSync(
        'pgrep',
        ['-af', '[b]wrap|freedom-sandbox-supervisor|hb-|netloop|cwd='],
        { encoding: 'utf8' }
      );
      return (found.stdout || '')
        .split('\n')
        .filter((line) => line && !/shell-snapshots|pgrep|claude|qualify-agent/.test(line))
        .join('\n');
    };
    const ticks = (text) => [...text.matchAll(/tick (\d+)/g)].map((m) => Number(m[1]));
    process.env.FREEDOM_QUAL_FAKE_SECRET = 'must-not-leak-9f3a7c';

    const run1 = await startRun('Qualify managed workspace processes');
    const run1Conversation = run1.conversationId;
    decisions.push(true);
    const enable = await callTool(run1, 'bash', { command: 'mkdir -p sub && printf enabled' });
    const workspaceA = controller.getWorkspace(run1Conversation);
    const workspaceRootA = controller.leases.get(workspaceA.workspaceId).workspaceRoot;

    const ledgerRows = () => workspaceStore.listCommands(run1Conversation, 100);
    const ledgerFor = (commandText, workingDirectory = null) =>
      ledgerRows().find(
        (row) =>
          row.command === commandText &&
          (workingDirectory === null || row.workingDirectory === workingDirectory)
      );
    const fileSize = (name) => {
      try {
        return fs.statSync(path.join(workspaceRootA, name)).size;
      } catch {
        return -1;
      }
    };

    check(
      'M0',
      'workspace enabled through the ordinary approval; write_stdin is exposed to Pi',
      bashText(enable).includes('enabled') &&
        run1.tools.some((tool) => tool.name === 'write_stdin'),
      {
        tools: run1.tools.map((tool) => tool.name),
        writeStdinSchema: run1.tools.find((tool) => tool.name === 'write_stdin').parameters,
      }
    );

    // ---- M1: short command completes through ordinary bash without yielding.
    const short = await callTool(run1, 'bash', { command: 'printf short-ok; printf err-line >&2' });
    const shortLedger = ledgerFor('printf short-ok; printf err-line >&2');
    check(
      'M1',
      'a short command completes through ordinary bash without yielding a session',
      !short.error &&
        bashText(short).includes('short-ok') &&
        sessionIds(short).length === 0 &&
        shortLedger?.state === 'completed' &&
        shortLedger.exitCode === 0 &&
        shortLedger.networkPosture === 'none' &&
        lastExecution().state === 'completed',
      {
        text: bashText(short),
        ledger: shortLedger && {
          state: shortLedger.state,
          exitCode: shortLedger.exitCode,
          networkPosture: shortLedger.networkPosture,
        },
      }
    );

    // ---- M2/M3: default ten-second yield returns exactly one opaque session ID; command runs on.
    const heartbeatCommand =
      'printf ready; i=0; while :; do i=$((i+1)); printf \'tick %s\\n\' "$i"; printf x >> hb-default; sleep 0.25; done';
    const startedAt = Date.now();
    const yielded = await callTool(run1, 'bash', { command: heartbeatCommand });
    const yieldElapsed = Date.now() - startedAt;
    const yieldedIds = sessionIds(yielded);
    const sessionA = yieldedIds[0];
    const yieldedFinished = toolFinished(yielded.toolCallId);
    check(
      'M2',
      'a command running beyond the default ten-second yield returns exactly one opaque workspace_process session ID',
      !yielded.error &&
        yieldedIds.length === 1 &&
        /^workspace_process_[a-f0-9]{24}$/.test(sessionA || '') &&
        yieldElapsed >= 9_500 &&
        yieldElapsed < 20_000 &&
        bashText(yielded).includes('Command still running with session ID') &&
        bashText(yielded).includes('ready'),
      {
        elapsedMs: yieldElapsed,
        sessionId: sessionA,
        text: bashText(yielded).slice(0, 300),
        receipt: yieldedFinished?.workspace,
      }
    );
    const sizeBefore = fileSize('hb-default');
    await delay(700);
    const sizeAfter = fileSize('hb-default');
    const runningLedger = ledgerFor(heartbeatCommand);
    check(
      'M3',
      'the original command continues running after the bash tool call returned',
      sizeAfter > sizeBefore &&
        runningLedger?.state === 'running' &&
        yieldedFinished?.workspace?.state === 'running' &&
        yieldedFinished.workspace.processId === sessionA,
      {
        heartbeatBytesBefore: sizeBefore,
        heartbeatBytesAfter: sizeAfter,
        ledgerState: runningLedger?.state,
        activityReceipt: yieldedFinished?.workspace,
      }
    );

    // ---- M4: polling returns only new incremental output.
    const poll1 = await callTool(run1, 'write_stdin', { session_id: sessionA, yield_time_ms: 400 });
    const poll2 = await callTool(run1, 'write_stdin', { session_id: sessionA, yield_time_ms: 400 });
    const ticks1 = ticks(bashText(poll1));
    const ticks2 = ticks(bashText(poll2));
    check(
      'M4',
      'polling through write_stdin returns only new incremental output',
      !poll1.error &&
        !poll2.error &&
        ticks1.length > 0 &&
        ticks2.length > 0 &&
        Math.max(...ticks1) < Math.min(...ticks2) &&
        !bashText(poll1).includes('ready') &&
        !bashText(poll2).includes('ready') &&
        poll1.result.details.state === 'running' &&
        new Set([...ticks1, ...ticks2]).size === ticks1.length + ticks2.length,
      {
        poll1Ticks: [Math.min(...ticks1), Math.max(...ticks1)],
        poll2Ticks: [Math.min(...ticks2), Math.max(...ticks2)],
        poll1Text: bashText(poll1).slice(-120),
        details: poll1.result?.details,
      }
    );

    // ---- M5: bounded stdin reaches the sandboxed command; real exit state comes back.
    const readerCommand =
      'printf ready; while IFS= read -r line; do printf \'got:%s\\n\' "$line"; [ "$line" = quit ] && exit 3; done';
    const reader = await callTool(run1, 'bash', { command: readerCommand, yield_time_ms: 500 });
    const readerId = sessionIds(reader)[0];
    const fed = await callTool(run1, 'write_stdin', {
      session_id: readerId,
      chars: 'hello\n',
      yield_time_ms: 1_000,
    });
    const quitWrite = await callTool(run1, 'write_stdin', {
      session_id: readerId,
      chars: 'quit\n',
      yield_time_ms: 4_000,
    });
    // A write returns at the first change (the echoed line); the exit is observed on the next poll.
    const quit =
      quitWrite.result?.details?.state === 'running'
        ? await callTool(run1, 'write_stdin', { session_id: readerId, yield_time_ms: 4_000 })
        : quitWrite;
    const quitText = `${bashText(quitWrite)}\n${bashText(quit)}`;
    const readerLedger = ledgerFor(readerCommand);
    const quitFinished = toolFinished(quit.toolCallId);
    check(
      'M5',
      'bounded stdin reaches the original sandboxed command, which later exits with its real state',
      readerId &&
        !fed.error &&
        bashText(fed).includes('got:hello') &&
        fed.result.details.state === 'running' &&
        !quitWrite.error &&
        !quit.error &&
        quitText.includes('got:quit') &&
        quit.result.details.state === 'failed' &&
        quit.result.details.exitCode === 3 &&
        readerLedger?.state === 'failed' &&
        readerLedger.exitCode === 3 &&
        quitFinished?.workspace?.state === 'failed' &&
        quitFinished.workspace.exitCode === 3 &&
        quitFinished.workspace.processId === readerId,
      {
        fedText: bashText(fed),
        quitWriteDetails: quitWrite.result?.details,
        quitDetails: quit.result?.details,
        quitText: quitText.slice(0, 200),
        ledger: readerLedger && {
          state: readerLedger.state,
          exitCode: readerLedger.exitCode,
          networkPosture: readerLedger.networkPosture,
        },
      }
    );
    const okCommand = 'printf ready; IFS= read -r line; printf \'done:%s\' "$line"';
    const ok = await callTool(run1, 'bash', { command: okCommand, yield_time_ms: 500 });
    const okId = sessionIds(ok)[0];
    const okWrite = await callTool(run1, 'write_stdin', {
      session_id: okId,
      chars: 'x\n',
      yield_time_ms: 4_000,
    });
    const okDone =
      okWrite.result?.details?.state === 'running'
        ? await callTool(run1, 'write_stdin', { session_id: okId, yield_time_ms: 4_000 })
        : okWrite;
    check(
      'M5-completed',
      'a stdin-driven command can complete normally with exit 0',
      okId &&
        !okWrite.error &&
        !okDone.error &&
        `${bashText(okWrite)}${bashText(okDone)}`.includes('done:x') &&
        okDone.result.details.state === 'completed' &&
        okDone.result.details.exitCode === 0 &&
        ledgerFor(okCommand)?.state === 'completed',
      { writeDetails: okWrite.result?.details, details: okDone.result?.details }
    );
    const consumed = await callTool(run1, 'write_stdin', { session_id: readerId });
    check(
      'M10-consumed',
      'an already-consumed terminal process ID fails safely',
      consumed.error?.code === 'WORKSPACE_PROCESS_NOT_FOUND',
      { error: consumed.error }
    );

    // ---- M11: unobserved completion is retained for one poll, then consumed.
    const briefCommand = 'printf ready; sleep 1';
    const brief = await callTool(run1, 'bash', { command: briefCommand, yield_time_ms: 300 });
    const briefId = sessionIds(brief)[0];
    await delay(2_000);
    const briefPoll = await callTool(run1, 'write_stdin', {
      session_id: briefId,
      yield_time_ms: 0,
    });
    const briefAgain = await callTool(run1, 'write_stdin', {
      session_id: briefId,
      yield_time_ms: 0,
    });
    check(
      'M11-retained',
      'a process that finished unobserved is retained for one terminal poll and then consumed',
      briefId &&
        !briefPoll.error &&
        briefPoll.result.details.state === 'completed' &&
        briefAgain.error?.code === 'WORKSPACE_PROCESS_NOT_FOUND',
      { first: briefPoll.result?.details, second: briefAgain.error }
    );

    // The five-minute expiry regression is slow; only stage it when explicitly requested.
    let expiryId = null;
    let expiryStartedAt = 0;
    if (includeSlow) {
      const expiry = await callTool(run1, 'bash', {
        command: 'printf ready; sleep 1; printf expired-probe',
        yield_time_ms: 300,
      });
      expiryId = sessionIds(expiry)[0];
      expiryStartedAt = Date.now();
    } else {
      emit('skip', {
        id: 'M11-expired',
        reason:
          'terminal-handle expiry waits the five-minute retention window; pass --include-slow',
      });
    }

    // ---- M12: output stays drained and bounded; truncation is reported.
    const floodCommand =
      "printf ready; head -c 400000 /dev/zero | tr '\\0' x; printf '\\nEND\\n'; while :; do sleep 1; done";
    const flood = await callTool(run1, 'bash', { command: floodCommand, yield_time_ms: 1_500 });
    const floodId = sessionIds(flood)[0];
    const floodFinished = toolFinished(flood.toolCallId);
    const floodPoll = await callTool(run1, 'write_stdin', {
      session_id: floodId,
      yield_time_ms: 300,
    });
    check(
      'M12',
      'output remains continuously drained and bounded; truncation is reported to the model and in the receipt',
      floodId &&
        Buffer.byteLength(bashText(flood)) <= 48 * 1024 + 400 &&
        bashText(flood).includes('Freedom omitted earlier command output') &&
        bashText(flood).includes('END') &&
        floodFinished?.workspace?.stdoutTruncated === true &&
        !floodPoll.error &&
        floodPoll.result.details.outputTruncated === false &&
        bashText(floodPoll).trim().startsWith(`Process ${floodId}`),
      {
        modelVisibleBytes: Buffer.byteLength(bashText(flood)),
        receiptStdoutTruncated: floodFinished?.workspace?.stdoutTruncated,
        pollDetails: floodPoll.result?.details,
      }
    );

    // ---- M13: input exceeding 16 KiB is rejected.
    const tooLong = await callTool(run1, 'write_stdin', {
      session_id: sessionA,
      chars: 'y'.repeat(16_385),
      yield_time_ms: 0,
    });
    const exact = await callTool(run1, 'write_stdin', {
      session_id: sessionA,
      chars: 'z'.repeat(16_384),
      yield_time_ms: 0,
    });
    const multibyte = await callTool(run1, 'write_stdin', {
      session_id: sessionA,
      chars: 'é'.repeat(9_000),
      yield_time_ms: 0,
    });
    check(
      'M13',
      'input exceeding 16 KiB is rejected while exactly 16 KiB is accepted; the byte bound also rejects oversized multi-byte text under the character schema',
      tooLong.error?.code === 'INVALID_WORKSPACE_PROCESS_REQUEST' &&
        !exact.error &&
        multibyte.error?.code === 'INVALID_WORKSPACE_PROCESS_REQUEST',
      { tooLong: tooLong.error, exact: exact.result?.details, multibyte: multibyte.error }
    );

    // ---- M14: two identical concurrent command strings stay associated with their own process.
    const cwdCommand = 'printf \'cwd=%s\\n\' "$PWD"; while :; do sleep 0.2; done';
    const twinRoot = await callTool(run1, 'bash', { command: cwdCommand, yield_time_ms: 400 });
    const twinSub = await callTool(run1, 'bash', {
      command: cwdCommand,
      workingDirectory: 'sub',
      yield_time_ms: 400,
    });
    const twinRootId = sessionIds(twinRoot)[0];
    const twinSubId = sessionIds(twinSub)[0];
    const twinRootReceipt = toolFinished(twinRoot.toolCallId)?.workspace;
    const twinSubReceipt = toolFinished(twinSub.toolCallId)?.workspace;
    const twinRows = ledgerRows().filter((row) => row.command === cwdCommand);
    check(
      'M14',
      'two identical concurrent command strings keep distinct process, command, and canonical directory associations with backend and posture',
      twinRootId &&
        twinSubId &&
        twinRootId !== twinSubId &&
        bashText(twinRoot).includes('cwd=/workspace\n') &&
        bashText(twinSub).includes('cwd=/workspace/sub') &&
        twinRootReceipt?.processId === twinRootId &&
        twinSubReceipt?.processId === twinSubId &&
        twinRootReceipt.commandId !== twinSubReceipt.commandId &&
        twinRootReceipt.workingDirectory === '.' &&
        twinSubReceipt.workingDirectory === 'sub' &&
        twinRootReceipt.workspaceId === workspaceA.workspaceId &&
        twinSubReceipt.workspaceId === workspaceA.workspaceId &&
        [twinRootReceipt, twinSubReceipt].every(
          (r) => r.backend === 'linux-bubblewrap' && r.networkPosture === 'none'
        ) &&
        twinRows.length === 2 &&
        twinRows.every((row) => row.state === 'running') &&
        new Set(twinRows.map((row) => row.workingDirectory)).size === 2,
      {
        root: twinRootReceipt,
        sub: twinSubReceipt,
        ledger: twinRows.map((row) => ({
          commandId: row.commandId,
          workingDirectory: row.workingDirectory,
          state: row.state,
        })),
      }
    );

    // ---- M15: the four-active-process limit is enforced (active: sessionA, flood, twinRoot, twinSub).
    const fifth = await callTool(run1, 'bash', {
      command: 'printf fifth; while :; do sleep 1; done',
      yield_time_ms: 300,
    });
    check(
      'M15',
      'the four-active-process limit is enforced for a fifth concurrent command',
      fifth.error?.code === 'WORKSPACE_PROCESS_LIMIT_REACHED' &&
        executions.filter((entry) => entry.command.startsWith('printf fifth')).length === 0,
      { error: fifth.error }
    );
    for (const id of [floodId, twinRootId, twinSubId]) {
      const stopped = await callTool(run1, 'write_stdin', {
        session_id: id,
        terminate: true,
        yield_time_ms: 3_000,
      });
      if (stopped.error || stopped.result.details.state !== 'cancelled') {
        throw new Error(
          `termination of ${id} failed: ${JSON.stringify(stopped.error || stopped.result.details)}`
        );
      }
    }

    // ---- M16: allow-once full networking stays with its launched process only; write_stdin grants nothing.
    const netloop = [
      'import socket, sys, time',
      'port = int(sys.argv[1]); once = len(sys.argv) > 2',
      'print("ready", flush=True)',
      'while True:',
      '    s = socket.socket(); s.settimeout(2)',
      '    try:',
      '        s.connect(("127.0.0.1", port)); r = "connected"',
      '    except Exception as e:',
      '        r = type(e).__name__',
      '    s.close(); print("net:" + r, flush=True)',
      '    if once: break',
      '    time.sleep(1)',
    ].join('\n');
    const written = await callTool(run1, 'write', { path: 'netloop.py', content: netloop });
    if (written.error) throw new Error(`write netloop failed: ${written.error.message}`);
    const netCommand = `python3 -u netloop.py ${tcpPort}`;
    decisions.push({ approved: true, workspacePermissionScope: 'once' });
    const permission = await callTool(run1, 'request_permissions', {
      network: 'full',
      reason: 'Run a long-lived networked loop',
      command: netCommand,
      workingDirectory: '.',
    });
    const grantsBeforeLaunch =
      controller.capabilityGrants.grants.get(run1Conversation)?.once.length ?? 0;
    const netCall = await callTool(run1, 'bash', { command: netCommand, yield_time_ms: 2_500 });
    const netId = sessionIds(netCall)[0];
    const netLaunch = lastExecution();
    const grantsAfterLaunch =
      controller.capabilityGrants.grants.get(run1Conversation)?.once.length ?? 0;
    const other = await callTool(run1, 'bash', { command: `${netCommand} once` });
    const otherLaunch = lastExecution();
    const executionsBeforePolls = executions.length;
    const netPoll = await callTool(run1, 'write_stdin', {
      session_id: netId,
      yield_time_ms: 1_500,
    });
    const netPoll2 = await callTool(run1, 'write_stdin', {
      session_id: netId,
      chars: '',
      yield_time_ms: 1_500,
    });
    const listed = await callTool(run1, 'ls', { path: '.' });
    const readBack = await callTool(run1, 'read', { path: 'netloop.py' });
    const helperLaunches = executions
      .slice(executionsBeforePolls)
      .filter((entry) => entry.command.startsWith('helper:'));
    const grantsAfterPolls =
      controller.capabilityGrants.grants.get(run1Conversation)?.once.length ?? 0;
    check(
      'M16',
      'an allow-once full-network command stays networked for its launched process; a different command inherits nothing; write_stdin grants, widens, replaces, or consumes no authority',
      !permission.error &&
        netId &&
        bashText(netCall).includes('net:connected') &&
        netLaunch.network === 'full' &&
        netLaunch.command === netCommand &&
        grantsBeforeLaunch === 1 &&
        grantsAfterLaunch === 0 &&
        !other.error &&
        bashText(other).includes('net:ConnectionRefusedError') &&
        otherLaunch.network === 'none' &&
        !netPoll.error &&
        bashText(netPoll).includes('net:connected') &&
        !netPoll2.error &&
        bashText(netPoll2).includes('net:connected') &&
        executions
          .slice(executionsBeforePolls)
          .filter((entry) => !entry.command.startsWith('helper:')).length === 0 &&
        grantsAfterPolls === 0,
      {
        netLaunch: { network: netLaunch.network, runtimeRoots: netLaunch.runtimeRoots },
        otherLaunch: { network: otherLaunch.network, text: bashText(other).trim() },
        onceGrants: {
          beforeLaunch: grantsBeforeLaunch,
          afterLaunch: grantsAfterLaunch,
          afterPolls: grantsAfterPolls,
        },
        pollText: bashText(netPoll).trim().slice(-80),
        newLaunchesDuringPolls: executions
          .slice(executionsBeforePolls)
          .map((entry) => entry.command),
      }
    );
    check(
      'M17',
      'helper operations remain offline while a full-network process is active',
      helperLaunches.length >= 2 &&
        helperLaunches.every(
          (entry) => entry.network === 'none' && entry.runtimeRoots.some((r) => r.id === 'electron')
        ) &&
        !listed.error &&
        !readBack.error,
      { helperLaunches }
    );

    // ---- M9: process IDs cannot be used from another conversation; unknown and malformed IDs fail safely.
    let crossConversation;
    try {
      await controller.interactProcess('conversation_other', netId, { waitMs: 0 });
      crossConversation = 'accepted';
    } catch (error) {
      crossConversation = error.code;
    }
    const unknown = await callTool(run1, 'write_stdin', {
      session_id: 'workspace_process_0123456789abcdef01234567',
      yield_time_ms: 0,
    });
    const malformed = await callTool(run1, 'write_stdin', { session_id: 'abc', yield_time_ms: 0 });
    const wrongCase = await callTool(run1, 'write_stdin', {
      session_id: netId.toUpperCase(),
      yield_time_ms: 0,
    });
    check(
      'M9',
      'process IDs cannot be used from another conversation; unknown and malformed IDs fail safely',
      crossConversation === 'WORKSPACE_PROCESS_NOT_FOUND' &&
        unknown.error?.code === 'WORKSPACE_PROCESS_NOT_FOUND' &&
        malformed.error?.code === 'WORKSPACE_PROCESS_NOT_FOUND' &&
        wrongCase.error?.code === 'WORKSPACE_PROCESS_NOT_FOUND',
      {
        crossConversation,
        unknown: unknown.error,
        malformed: malformed.error,
        wrongCase: wrongCase.error,
      }
    );

    // ---- M6: explicit termination produces a truthful cancelled/SIGKILL receipt (net + offline).
    const netStop = await callTool(run1, 'write_stdin', {
      session_id: netId,
      terminate: true,
      yield_time_ms: 3_000,
    });
    const netStopReceipt = toolFinished(netStop.toolCallId)?.workspace;
    const netExecutorReceipt = executions.find((entry) => entry.command === netCommand)?.receipt;
    const hbSizeBeforeStop = fileSize('hb-default');
    const stopA = await callTool(run1, 'write_stdin', {
      session_id: sessionA,
      terminate: true,
      yield_time_ms: 3_000,
    });
    const stopAReceipt = toolFinished(stopA.toolCallId)?.workspace;
    await delay(600);
    const hbSizeAfterStop = fileSize('hb-default');
    const stopAExecutor = executions.find((entry) => entry.command === heartbeatCommand)?.receipt;
    const truthful = (receipt, posture) =>
      receipt &&
      receipt.state === 'cancelled' &&
      receipt.signal === 'SIGKILL' &&
      receipt.backend === 'linux-bubblewrap' &&
      receipt.terminationGuarantee === 'namespace_scoped' &&
      receipt.networkPosture === posture &&
      receipt.survivorsPossible === false &&
      receipt.completeDescendantTermination === true &&
      receipt.sideEffects === 'unknown';
    const executorTruthful = (receipt, posture) =>
      receipt &&
      receipt.state === 'cancelled' &&
      receipt.signal === 'SIGKILL' &&
      receipt.terminationGuarantee === 'namespace_scoped' &&
      receipt.terminationScope === 'pid_namespace' &&
      receipt.survivorsPossible === false &&
      receipt.completeDescendantTermination === true &&
      receipt.networkPosture === posture;
    check(
      'M6',
      'explicit termination yields truthful cancelled/SIGKILL receipts at the tool, ledger, and executor levels; the heartbeat writer stops',
      !netStop.error &&
        netStop.result.details.state === 'cancelled' &&
        truthful(netStopReceipt, 'full') &&
        executorTruthful(netExecutorReceipt, 'full') &&
        ledgerFor(netCommand)?.state === 'cancelled' &&
        ledgerFor(netCommand).signal === 'SIGKILL' &&
        ledgerFor(netCommand).networkPosture === 'full' &&
        !stopA.error &&
        truthful(stopAReceipt, 'none') &&
        executorTruthful(stopAExecutor, 'none') &&
        ledgerFor(heartbeatCommand)?.state === 'cancelled' &&
        hbSizeAfterStop === hbSizeBeforeStop &&
        survivors() === '',
      {
        toolReceiptFull: netStopReceipt,
        executorReceiptFull: netExecutorReceipt,
        toolReceiptNone: stopAReceipt,
        executorReceiptNone: stopAExecutor,
        heartbeat: { before: hbSizeBeforeStop, after: hbSizeAfterStop },
        survivors: survivors(),
      }
    );
    check(
      'M6-scope-field',
      'controller-level receipts carry terminationScope like executor receipts do',
      'terminationScope' in (stopAReceipt || {}),
      { toolReceiptKeys: Object.keys(stopAReceipt || {}) }
    );

    // ---- M18: turn ends. M7: conversation Stop terminates a retained process.
    await endRun(run1);

    const run2 = await startRun('Stop should terminate the process');
    const stopCommand = 'printf ready; while :; do printf y >> hb-stop; sleep 0.2; done';
    const stopped = await callTool(run2, 'bash', { command: stopCommand, yield_time_ms: 400 });
    const stoppedId = sessionIds(stopped)[0];
    const stopLedgerBefore = ledgerFor(stopCommand)?.state;
    await service.stop(run2.runId);
    await service.waitForIdle();
    const stopSizeA = fileSize('hb-stop');
    await delay(600);
    const stopSizeB = fileSize('hb-stop');
    for (
      let waited = 0;
      waited < 3_000 && ledgerFor(stopCommand)?.state === 'running';
      waited += 100
    )
      await delay(100);
    const stopLedger = ledgerFor(stopCommand);
    const stopExecutor = executions.find((entry) => entry.command === stopCommand)?.receipt;
    check(
      'M7-stop',
      'conversation Stop terminates the retained namespace process with a truthful ledger receipt; nothing survives',
      stoppedId &&
        stopLedgerBefore === 'running' &&
        stopLedger?.state === 'cancelled' &&
        stopLedger.signal === 'SIGKILL' &&
        stopLedger.networkPosture === 'none' &&
        executorTruthful(stopExecutor, 'none') &&
        stopSizeA === stopSizeB &&
        survivors() === '',
      {
        ledger: stopLedger && {
          state: stopLedger.state,
          signal: stopLedger.signal,
          networkPosture: stopLedger.networkPosture,
        },
        executor: stopExecutor,
        heartbeat: { a: stopSizeA, b: stopSizeB },
        survivors: survivors(),
      }
    );
    const stopDurable = historyStore
      .getSession(run1Conversation)
      ?.transcript?.at(-1)
      ?.activity?.find(
        (item) => item.operation === 'bash' && item.workspace?.command === stopCommand
      );
    emit('observation', {
      id: 'M7-durable',
      name: 'durable activity item for the yielded bash call after Stop',
      item: stopDurable || null,
    });

    // ---- M8: controller disposal terminates a retained process started in a normal turn that ended.
    const run3 = await startRun('Dispose should terminate the process');
    const disposeCommand = 'printf ready; while :; do printf z >> hb-dispose; sleep 0.2; done';
    const disposed = await callTool(run3, 'bash', { command: disposeCommand, yield_time_ms: 400 });
    const disposedId = sessionIds(disposed)[0];
    await endRun(run3);
    const survivesTurnA = fileSize('hb-dispose');
    await delay(600);
    const survivesTurnB = fileSize('hb-dispose');
    emit('observation', {
      id: 'M8-turn',
      name: 'a yielded process keeps running after its turn ends normally',
      running: survivesTurnB > survivesTurnA,
      ledger: ledgerFor(disposeCommand)?.state,
    });

    // ---- M11-expired: terminal handles expire after the retention window (slow only).
    if (includeSlow) {
      const remaining = TERMINAL_PROCESS_RETENTION_MS + 5_000 - (Date.now() - expiryStartedAt);
      if (remaining > 0) await delay(remaining);
      let expired;
      try {
        const late = await controller.interactProcess(run1Conversation, expiryId, { waitMs: 0 });
        expired = `accepted:${late.state}`;
      } catch (error) {
        expired = error.code;
      }
      check(
        'M11-expired',
        'a terminal handle that was never polled expires after the five-minute retention window',
        expired === 'WORKSPACE_PROCESS_NOT_FOUND',
        { expired, waitedMs: Date.now() - expiryStartedAt }
      );
    }

    // ---- Dispose the controller with the retained process still running.
    const disposeSizeBefore = fileSize('hb-dispose');
    controller.dispose();
    for (
      let waited = 0;
      waited < 5_000 && ledgerFor(disposeCommand)?.state === 'running';
      waited += 100
    )
      await delay(100);
    await delay(600);
    const disposeSizeAfter = fileSize('hb-dispose');
    const disposeLedger = ledgerFor(disposeCommand);
    const disposeExecutor = executions.find((entry) => entry.command === disposeCommand)?.receipt;
    check(
      'M8-dispose',
      'controller disposal terminates the retained namespace process; ledger reaches cancelled; nothing survives',
      disposedId &&
        disposeLedger?.state === 'cancelled' &&
        disposeLedger.signal === 'SIGKILL' &&
        executorTruthful(disposeExecutor, 'none') &&
        disposeSizeAfter === disposeSizeBefore &&
        survivors() === '',
      {
        ledger: disposeLedger && { state: disposeLedger.state, signal: disposeLedger.signal },
        executor: disposeExecutor,
        heartbeat: { before: disposeSizeBefore, after: disposeSizeAfter },
        survivors: survivors(),
      }
    );
    const terminalStates = ledgerRows().map((row) => row.state);
    check(
      'M19',
      'the durable workspace command ledger reaches a real terminal state for every command',
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
    const allVisible = JSON.stringify(piVisible);
    check(
      'M18',
      'the trusted readiness marker and the environment secret never reach model-visible output',
      !allVisible.includes('freedom-sandbox-ready') && !allVisible.includes('must-not-leak-9f3a7c'),
      { bytes: allVisible.length }
    );
    durableSnapshots.push({
      conversationId: run1Conversation,
      history: historyStore.getSession(run1Conversation),
      commands: ledgerRows(),
    });
    emit('durable_bash_process_items', {
      items: (historyStore.getSession(run1Conversation)?.transcript || [])
        .flatMap((turn) => turn.activity || [])
        .filter((item) => ['bash', 'write_stdin'].includes(item.operation))
        .map((item) => ({
          operation: item.operation,
          status: item.status,
          label: item.label?.slice(0, 70),
          workspace: item.workspace && {
            kind: item.workspace.kind,
            state: item.workspace.state,
            processId: item.workspace.processId,
            commandId: item.workspace.commandId,
            workingDirectory: item.workspace.workingDirectory,
            networkPosture: item.workspace.networkPosture,
            signal: item.workspace.signal,
            terminationGuarantee: item.workspace.terminationGuarantee,
            exitCode: item.workspace.exitCode,
          },
        })),
    });
    // Durable Agent *history* activity never carries command stdout/stderr; the bounded workspace
    // command ledger legitimately stores a truncated stdout tail, so it is only checked for host
    // paths, secrets, the readiness marker, and authority objects.
    const durableHistoryText = JSON.stringify(durableSnapshots.map((snapshot) => snapshot.history));
    const durableLedgerText = JSON.stringify(durableSnapshots.map((snapshot) => snapshot.commands));
    check(
      'M18-durable',
      'durable Agent activity carries no stdout/stderr, host paths, secrets, readiness marker, or authority objects; the bounded ledger carries no host paths, secrets, marker, or authority objects',
      !durableHistoryText.includes('tick 1\\n') &&
        !durableHistoryText.includes('tick 2\\n') &&
        !durableHistoryText.includes('got:hello') &&
        !durableHistoryText.includes('got:quit') &&
        !durableHistoryText.includes('done:x') &&
        !durableHistoryText.includes('net:connected') &&
        !durableHistoryText.includes('cwd=/workspace\\n') &&
        [durableHistoryText, durableLedgerText].every(
          (text) =>
            !text.includes('must-not-leak-9f3a7c') &&
            !text.includes('freedom-sandbox-ready') &&
            !text.includes(root) &&
            !text.includes(ctx.os.homedir()) &&
            !text.includes('runtimeRoots') &&
            !text.includes('sourcePath') &&
            !text.includes('capabilityRequest')
        ),
      {
        historyBytes: durableHistoryText.length,
        ledgerBytes: durableLedgerText.length,
        ledgerStoresBoundedStdout: durableLedgerText.includes('tick '),
      }
    );
  },
};
