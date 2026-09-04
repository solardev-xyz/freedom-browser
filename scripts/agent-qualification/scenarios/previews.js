'use strict';

// Managed server-preview qualification. Proves that a full-network-approved ordinary `bash` launch
// that declares one bounded port can, after it yields, mint an isolated `freedom-preview://` origin
// for only that immutable process/port association, and that the production preview request handler
// enforces the boundary on every request. Covers the tool schema, offline and invalid-port
// rejection before launch or grant consumption, a valid positive control, kernel listener ownership,
// preview identity and negative identities, credential stripping, header replacement, redirect
// handling, request/response bounds, safe error responses, pollable output, and route revocation on
// explicit termination, conversation Stop, deletion (with storage clearing), and controller
// disposal. Run with networkEnabled=false for the gate-absent regression (D1–D4): the preview
// parameters are not advertised, forged parameters fail closed, and only the offline static preview
// remains.

module.exports = {
  id: 'previews',
  title: 'Managed server previews through the isolated preview origin',
  survivorPattern: 'node server\\.js',
  async run(ctx) {
    const {
      fs,
      os,
      emit,
      check,
      waitFor,
      pickFreePort,
      ssListener: listener,
      previewHandler,
      navigations,
      storageClears,
      workspacePreviewController,
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
      spawnSync,
      root,
      networkEnabled,
      PREVIEW_CSP,
      SERVER_PREVIEW_CSP,
    } = ctx;
    const NETWORK_PERMISSIONS_ENABLED = networkEnabled;

    const SESSION_ID = /workspace_process_[a-f0-9]{24}/g;
    const sessionIds = (entry) => [
      ...new Set([...bashText(entry).matchAll(SESSION_ID)].map((m) => m[0])),
    ];
    const toolFinished = (toolCallId) =>
      events.find((event) => event.type === 'tool_finished' && event.toolCallId === toolCallId);
    const runFinishedEvent = (runId) =>
      events.find((event) => event.type === 'run_finished' && event.runId === runId);
    const survivorProcesses = () =>
      spawnSync('pgrep', ['-af', '[b]wrap|freedom-sandbox-supervisor|node server\\.js'], {
        encoding: 'utf8',
      })
        .stdout.split('\n')
        .filter(
          (line) =>
            line && !/shell-snapshots|pgrep|claude|qualify-agent|agent-qualification/.test(line)
        )
        .join('\n');
    const safeJson = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    };
    const probe = async (url, init = {}) => {
      const request = init.raw
        ? {
            method: init.method || 'GET',
            url,
            headers: new Headers(init.headers || {}),
            body: init.body,
            signal: init.signal,
          }
        : new Request(url, init);
      const started = Date.now();
      const response = await previewHandler(request);
      const text = init.skipBody ? '' : await response.text();
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: response.status, headers, text, ms: Date.now() - started };
    };
    process.env.FREEDOM_QUAL_FAKE_SECRET = 'must-not-leak-9f3a7c';

    const SERVER_SOURCE = [
      "const http = require('http');",
      'const port = Number(process.argv[2]);',
      'let targetHits = 0;',
      'const common = { "Set-Cookie": "session=upstream-secret; Path=/", "X-Frame-Options": "ALLOWALL", "Strict-Transport-Security": "max-age=1", "X-Upstream-Custom": "leak", "Content-Security-Policy": "default-src *" };',
      'const server = http.createServer((req, res) => {',
      "  const url = new URL(req.url, 'http://127.0.0.1');",
      '  console.log(`request ${req.method} ${url.pathname}`);',
      '  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };',
      "  if (url.pathname === '/') return send(200, { ...common, 'Content-Type': 'text/html; charset=utf-8' }, '<!doctype html><html><body><h1>server-preview-ok</h1><script src=\"/assets/app.js\"></script></body></html>');",
      "  if (url.pathname === '/assets/app.js') return send(200, { ...common, 'Content-Type': 'application/javascript' }, 'window.__asset = \"asset-ok\";');",
      "  if (url.pathname === '/echo') return send(200, { 'Content-Type': 'application/json' }, JSON.stringify({ search: url.search, query: Object.fromEntries(url.searchParams) }));",
      "  if (url.pathname === '/headers') return send(200, { 'Content-Type': 'application/json' }, JSON.stringify({ headers: req.headers, remote: req.socket.remoteAddress, localPort: req.socket.localPort }));",
      "  if (url.pathname === '/api/json' || url.pathname === '/api/form' || url.pathname === '/echo-body') { let length = 0; let body = ''; req.on('data', (chunk) => { length += chunk.length; if (body.length < 200) body += chunk.toString('utf8'); }); req.on('end', () => send(200, { 'Content-Type': 'application/json' }, JSON.stringify({ method: req.method, contentType: req.headers['content-type'] || null, body: body.slice(0, 200), length }))); return; }",
      "  if (url.pathname === '/redirect-external') return send(302, { Location: 'https://example.com/private' }, '');",
      "  if (url.pathname === '/redirect-local') return send(302, { Location: `http://127.0.0.1:${port}/target?x=1` }, '');",
      "  if (url.pathname === '/redirect-relative') return send(302, { Location: '/target?x=2' }, '');",
      "  if (url.pathname === '/target') { targetHits += 1; return send(200, { 'Content-Type': 'text/plain' }, 'target'); }",
      "  if (url.pathname === '/target-hits') return send(200, { 'Content-Type': 'text/plain' }, String(targetHits));",
      "  if (url.pathname === '/big') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); const chunk = Buffer.alloc(1024 * 1024, 120); let sent = 0; const write = () => { while (sent < 17 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', write); return; } } res.end(); }; write(); return; }",
      "  if (url.pathname === '/big-declared') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(17 * 1024 * 1024) }); res.write('x'); setTimeout(() => res.destroy(), 3000); return; }",
      "  if (url.pathname === '/slow') { const ms = Number(url.searchParams.get('ms') || 12000); setTimeout(() => send(200, { 'Content-Type': 'text/plain' }, 'slow-done'), ms); return; }",
      "  if (url.pathname === '/crash') { req.socket.destroy(); return; }",
      "  send(404, { 'Content-Type': 'text/plain' }, 'not-found');",
      '});',
      "server.listen(port, '127.0.0.1', () => console.log(`listening ${port}`));",
    ].join('\n');
    const STATIC_HTML = '<!doctype html><html><body><h1>static-preview-ok</h1></body></html>';

    const run1 = await startRun('Serve the project');
    const conversationA = run1.conversationId;
    decisions.push(true);
    const enable = await callTool(run1, 'bash', { command: 'printf enabled' });
    if (!bashText(enable).includes('enabled')) throw new Error('workspace enable failed');
    const bashTool = run1.tools.find((tool) => tool.name === 'bash');
    const previewTool = run1.tools.find((tool) => tool.name === 'workspace_preview');
    const previewPortSchema = bashTool.parameters.properties.previewPort || null;
    const processIdSchema = previewTool.parameters.properties.processId || null;
    emit('schemas', {
      previewPort: previewPortSchema,
      processId: processIdSchema,
      bashRequired: bashTool.parameters.required,
      previewAdditional: previewTool.parameters.additionalProperties,
    });
    for (const [file, content] of [
      ['server.js', SERVER_SOURCE],
      ['index.html', STATIC_HTML],
    ]) {
      const written = await callTool(run1, 'write', { path: file, content });
      if (written.error) throw new Error(`write ${file} failed: ${written.error.message}`);
    }
    const ledgerRows = () => workspaceStore.listCommands(conversationA, 100);
    const ledgerFor = (commandText) =>
      ledgerRows()
        .filter((row) => row.command === commandText)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
    const executorFor = (commandText) =>
      executions
        .filter((entry) => entry.command === commandText)
        .sort((a, b) => b.index - a.index)[0];
    const grantsFor = (commandText) =>
      controller.capabilityGrants.inspect(conversationA, {
        command: commandText,
        workingDirectory: '.',
      }).length;

    if (!NETWORK_PERMISSIONS_ENABLED) {
      check(
        'D1',
        'gate absent: bash exposes no previewPort and workspace_preview exposes no processId',
        previewPortSchema === null &&
          processIdSchema === null &&
          previewTool.parameters.additionalProperties === false &&
          bashTool.parameters.additionalProperties === false,
        {
          bashProperties: Object.keys(bashTool.parameters.properties),
          previewProperties: Object.keys(previewTool.parameters.properties),
        }
      );
      const launchesBefore = executions.length;
      const forgedBash = await callTool(run1, 'bash', {
        command: 'printf forged',
        previewPort: 45_000,
        yield_time_ms: 300,
      });
      const forgedPreview = await callTool(run1, 'workspace_preview', {
        processId: 'workspace_process_0123456789abcdef01234567',
      });
      const plain = await callTool(run1, 'bash', {
        command: 'printf plain; sleep 20',
        yield_time_ms: 300,
      });
      const plainId = sessionIds(plain)[0];
      let direct;
      try {
        workspacePreviewController.createProcessPreview(conversationA, plainId);
        direct = 'accepted';
      } catch (error) {
        direct = error.code;
      }
      check(
        'D2',
        'gate absent: forged server-preview parameters fail closed before any launch, and a running process without full networking cannot mint a server preview',
        forgedBash.error?.code === 'WORKSPACE_PREVIEW_NETWORK_REQUIRED' &&
          executions.length === launchesBefore + 1 &&
          !ledgerFor('printf forged') &&
          forgedPreview.error?.code === 'WORKSPACE_PREVIEW_UNAVAILABLE' &&
          direct === 'WORKSPACE_PREVIEW_UNAVAILABLE',
        { forgedBash: forgedBash.error, forgedPreview: forgedPreview.error, direct, plainId }
      );
      await callTool(run1, 'write_stdin', {
        session_id: plainId,
        terminate: true,
        yield_time_ms: 3_000,
      });
      const staticPreview = await callTool(run1, 'workspace_preview', { path: 'index.html' });
      const staticUrl = navigations.at(-1)?.url;
      const staticGet = await probe(staticUrl);
      const staticPost = await probe(staticUrl, { method: 'POST', body: 'x' });
      const staticReceipt = toolFinished(staticPreview.toolCallId)?.workspace;
      await endRun(run1);
      check(
        'D3',
        'gate absent: static preview still works unchanged and remains offline',
        !staticPreview.error &&
          /^freedom-preview:\/\/[a-f0-9]{20,128}\/index\.html$/.test(staticUrl || '') &&
          staticGet.status === 200 &&
          staticGet.text.includes('static-preview-ok') &&
          staticGet.headers['content-security-policy'] === PREVIEW_CSP &&
          staticPost.status === 405 &&
          staticReceipt?.kind === 'static_preview' &&
          staticReceipt.networkPosture === 'none' &&
          runFinishedEvent(run1.runId)?.outcome?.headline === 'Static preview opened',
        {
          staticUrlShape: staticUrl?.replace(/[a-f0-9]{20,128}/, '<token>'),
          status: staticGet.status,
          csp: staticGet.headers['content-security-policy'],
          post: staticPost.status,
          receipt: staticReceipt,
          headline: runFinishedEvent(run1.runId)?.outcome?.headline,
        }
      );
      check(
        'D4',
        'gate absent: helpers stay offline and the fake session keeps the preview opaque',
        executions
          .filter((entry) => entry.command.startsWith('helper:'))
          .every((entry) => entry.network === 'none') &&
          !JSON.stringify(piVisible).includes('freedom-preview://'),
        {
          helperPostures: [
            ...new Set(
              executions
                .filter((entry) => entry.command.startsWith('helper:'))
                .map((entry) => entry.network)
            ),
          ],
        }
      );
      return;
    }

    // ---- S1 schema
    check(
      'S1',
      'gate enabled: previewPort is an integer bounded to 1024–65535 and workspace_preview accepts only a valid opaque process ID',
      previewPortSchema?.type === 'integer' &&
        previewPortSchema.minimum === 1_024 &&
        previewPortSchema.maximum === 65_535 &&
        processIdSchema?.pattern === '^workspace_process_[a-f0-9]{24}$' &&
        previewTool.parameters.additionalProperties === false,
      { previewPort: previewPortSchema, processId: processIdSchema }
    );

    // ---- S2 offline launch with previewPort fails before execution
    const port1 = await pickFreePort();
    const serverCommand = `node server.js ${port1}`;
    const launchesBefore = executions.length;
    const offline = await callTool(run1, 'bash', {
      command: serverCommand,
      previewPort: port1,
      yield_time_ms: 500,
    });
    check(
      'S2',
      'an offline launch with previewPort fails before command execution',
      offline.error?.code === 'WORKSPACE_PREVIEW_NETWORK_REQUIRED' &&
        executions.length === launchesBefore &&
        !ledgerFor(serverCommand),
      { error: offline.error, port: port1 }
    );

    // ---- S3a non-integer previewPort values are rejected before launch by the tool and controller.
    const launchesBeforeDrop = executions.length;
    const fractional = await callTool(run1, 'bash', {
      command: serverCommand,
      previewPort: 4_173.5,
      yield_time_ms: 300,
    });
    const stringPort = await callTool(run1, 'bash', {
      command: serverCommand,
      previewPort: '4567',
      yield_time_ms: 300,
    });
    const droppedLaunches = executions.length - launchesBeforeDrop;
    const managerRejections = {};
    for (const value of [4_173.5, '4567']) {
      try {
        await controller.startProcess(conversationA, {
          command: serverCommand,
          previewPort: value,
          yieldMs: 300,
        });
        managerRejections[String(value)] = 'accepted';
      } catch (error) {
        managerRejections[String(value)] = error.code;
      }
    }
    check(
      'S3a',
      'fractional and string previewPort values are rejected with INVALID_WORKSPACE_PROCESS_REQUEST before execution by the tool layer and the controller, launching nothing',
      fractional.error?.code === 'INVALID_WORKSPACE_PROCESS_REQUEST' &&
        stringPort.error?.code === 'INVALID_WORKSPACE_PROCESS_REQUEST' &&
        droppedLaunches === 0 &&
        Object.values(managerRejections).every(
          (code) => code === 'INVALID_WORKSPACE_PROCESS_REQUEST'
        ),
      {
        toolResults: {
          4173.5: fractional.error?.code || `launched:${fractional.result?.details?.state || 'ok'}`,
          4567: stringPort.error?.code || `launched:${stringPort.result?.details?.state || 'ok'}`,
        },
        launchesTriggeredByTool: droppedLaunches,
        controllerRejections: managerRejections,
      }
    );

    // ---- S3 one exact approval; invalid integer ports and mismatches must not consume it
    decisions.push({ approved: true, workspacePermissionScope: 'once' });
    const permission = await callTool(run1, 'request_permissions', {
      executables: ['node'],
      network: 'full',
      reason: 'Serve the project locally',
      command: serverCommand,
      workingDirectory: '.',
    });
    const grantedBefore = grantsFor(serverCommand);
    const launchesBeforeBad = executions.length;
    const badPorts = [80, 1_023, 65_536, -1, 0];
    const badPortResults = {};
    for (const value of badPorts) {
      const attempt = await callTool(run1, 'bash', {
        command: serverCommand,
        previewPort: value,
        yield_time_ms: 300,
      });
      badPortResults[String(value)] =
        attempt.error?.code || `accepted:${attempt.result?.details?.state || 'ok'}`;
    }
    const mismatch = await callTool(run1, 'bash', {
      command: `${serverCommand} --extra`,
      previewPort: port1,
      yield_time_ms: 300,
    });
    check(
      'S3',
      'privileged, zero, negative and out-of-range integer ports and a mismatching command are rejected without consuming the one-shot grant or launching anything',
      !permission.error &&
        grantedBefore === 4 &&
        Object.values(badPortResults).every(
          (code) => code === 'INVALID_WORKSPACE_PROCESS_REQUEST'
        ) &&
        mismatch.error?.code === 'WORKSPACE_PREVIEW_NETWORK_REQUIRED' &&
        grantsFor(serverCommand) === 4 &&
        executions.length === launchesBeforeBad,
      {
        badPortResults,
        mismatch: mismatch.error,
        grantsBefore: grantedBefore,
        grantsAfter: grantsFor(serverCommand),
      }
    );

    // ---- S4 exact launch (valid positive control)
    const launch = await callTool(run1, 'bash', {
      command: serverCommand,
      previewPort: port1,
      yield_time_ms: 2_500,
    });
    const serverId = sessionIds(launch)[0];
    const launchReceipt = toolFinished(launch.toolCallId)?.workspace;
    const launchExecution = executorFor(serverCommand);
    check(
      'S4',
      'the exact approved command runs with networkPosture full, an approved Node root, and its declared previewPort, consuming the one-shot grant',
      serverId &&
        bashText(launch).includes(`listening ${port1}`) &&
        launchReceipt?.state === 'running' &&
        launchReceipt.networkPosture === 'full' &&
        launchReceipt.previewPort === port1 &&
        launchReceipt.terminationScope === 'pending' &&
        launchExecution?.network === 'full' &&
        launchExecution.runtimeRoots.some(
          (r) => r.id.startsWith('approved_') && r.access === 'read_execute'
        ) &&
        grantsFor(serverCommand) === 0 &&
        ledgerFor(serverCommand)?.state === 'running',
      {
        serverId,
        receipt: launchReceipt,
        execution: {
          network: launchExecution?.network,
          runtimeRoots: launchExecution?.runtimeRoots,
        },
        grantsAfterLaunch: grantsFor(serverCommand),
      }
    );

    // ---- S5 kernel listener ownership versus declared association
    await waitFor(() => Boolean(listener(port1)), 5_000);
    const listenerLine = listener(port1);
    const listenerPid = Number(/pid=(\d+)/.exec(listenerLine)?.[1] || 0);
    const ancestry = [];
    let cursor = listenerPid;
    while (cursor > 1 && ancestry.length < 12) {
      let status;
      try {
        status = fs.readFileSync(`/proc/${cursor}/status`, 'utf8');
      } catch {
        break;
      }
      const name = /^Name:\s+(.+)$/m.exec(status)?.[1];
      const ppid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] || 0);
      ancestry.push({ pid: cursor, name });
      cursor = ppid;
    }
    const readNs = (pid, kind) => {
      try {
        return fs.readlinkSync(`/proc/${pid}/ns/${kind}`);
      } catch {
        return null;
      }
    };
    check(
      'S5',
      'the listener on 127.0.0.1:<port> is kernel-owned by the sandboxed process tree (bwrap ancestor, foreign pid namespace, shared network namespace); the product itself only records the declared process/port association',
      listenerLine.includes(`127.0.0.1:${port1}`) &&
        listenerPid > 0 &&
        ancestry.some((entry) => entry.name === 'bwrap') &&
        readNs(listenerPid, 'pid') !== readNs(process.pid, 'pid') &&
        readNs(listenerPid, 'net') === readNs(process.pid, 'net'),
      {
        listener: listenerLine.replace(/fd=\d+/g, 'fd=…'),
        ancestry,
        pidNamespaceDiffers: readNs(listenerPid, 'pid') !== readNs(process.pid, 'pid'),
        netNamespaceShared: readNs(listenerPid, 'net') === readNs(process.pid, 'net'),
      }
    );

    // ---- S6 preview creation and negative identities
    const opened = await callTool(run1, 'workspace_preview', { processId: serverId });
    const previewUrl = navigations.at(-1)?.url;
    const token1 = /^freedom-preview:\/\/([a-f0-9]{20,128})\/$/.exec(previewUrl || '')?.[1];
    const openedAgain = await callTool(run1, 'workspace_preview', { processId: serverId });
    const openedReceipt = toolFinished(opened.toolCallId)?.workspace;
    const plainLaunch = await callTool(run1, 'bash', {
      command: 'printf plain; sleep 60',
      yield_time_ms: 300,
    });
    const plainId = sessionIds(plainLaunch)[0];
    const wrongId = await callTool(run1, 'workspace_preview', { processId: 'abc' });
    const unrelated = await callTool(run1, 'workspace_preview', { processId: plainId });
    const both = await callTool(run1, 'workspace_preview', {
      processId: serverId,
      path: 'index.html',
    });
    let otherConversation;
    try {
      workspacePreviewController.createProcessPreview('conversation_other', serverId);
      otherConversation = 'accepted';
    } catch (error) {
      otherConversation = error.code;
    }
    check(
      'S6-mint',
      'workspace_preview mints one opaque freedom-preview origin for the exact running server and opens it in an isolated tab',
      !opened.error &&
        Boolean(token1) &&
        opened.result.details.kind === 'server' &&
        opened.result.details.processId === serverId &&
        opened.result.details.port === port1 &&
        bashText(opened).includes(`managed server preview on port ${port1}`) &&
        navigations.at(-1)?.url === previewUrl &&
        !JSON.stringify(opened.result).includes(token1),
      {
        details: opened.result?.details,
        previewUrl: previewUrl?.replace(token1, '<token>'),
        navLast: navigations.at(-1)?.url?.replace(token1, '<token>'),
      }
    );
    check(
      'S6-idempotent',
      'a second workspace_preview for the same process refreshes the same opaque origin without minting a new one',
      !openedAgain.error &&
        openedReceipt?.kind === 'server_preview' &&
        openedReceipt.networkPosture === 'full' &&
        openedReceipt.backend === 'freedom-workspace-server-preview' &&
        navigations.every(
          (entry) => !token1 || entry.url === previewUrl || !entry.url.includes('freedom-preview')
        ) &&
        workspacePreviewController.previews.size >= 1,
      {
        receipt: openedReceipt,
        tokens: [
          ...new Set(
            navigations
              .map((entry) => /freedom-preview:\/\/([a-f0-9]+)/.exec(entry.url)?.[1])
              .filter(Boolean)
          ),
        ].length,
      }
    );
    check(
      'S6-identity',
      'malformed, unrelated, dual-target and other-conversation identities are refused',
      wrongId.error?.code === 'WORKSPACE_PROCESS_NOT_FOUND' &&
        unrelated.error?.code === 'WORKSPACE_PREVIEW_UNAVAILABLE' &&
        both.error?.code === 'INVALID_WORKSPACE_REQUEST' &&
        otherConversation === 'WORKSPACE_PROCESS_NOT_FOUND',
      {
        wrongId: wrongId.error?.code,
        unrelated: unrelated.error?.code,
        both: both.error?.code,
        otherConversation,
      }
    );
    await callTool(run1, 'write_stdin', {
      session_id: plainId,
      terminate: true,
      yield_time_ms: 3_000,
    });

    // ---- S7 proxy boundary
    const base = `freedom-preview://${token1}/`;
    const html = await probe(base);
    const asset = await probe(`${base}assets/app.js`);
    const query = await probe(`${base}echo?q=one&x=2`);
    const headersProbe = await probe(`${base}headers`, {
      headers: {
        cookie: 'private=value',
        authorization: 'Bearer secret',
        'x-custom': 'nope',
        accept: 'application/json',
      },
    });
    const upstreamHeaders = safeJson(headersProbe.text);
    const form = await probe(`${base}api/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=freedom&kind=form',
    });
    const json = await probe(`${base}api/json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const external = await probe(`${base}redirect-external`);
    const local = await probe(`${base}redirect-local`);
    const relative = await probe(`${base}redirect-relative`);
    const hits = await probe(`${base}target-hits`);
    const head = await probe(base, { method: 'HEAD' });
    check(
      'S7-content',
      'the proxy serves HTML, nested assets, query strings, same-origin JSON fetches and form POSTs from the opaque origin',
      html.status === 200 &&
        html.text.includes('server-preview-ok') &&
        html.headers['content-type']?.startsWith('text/html') &&
        asset.status === 200 &&
        asset.text.includes('asset-ok') &&
        asset.headers['content-type']?.startsWith('application/javascript') &&
        query.status === 200 &&
        safeJson(query.text).search === '?q=one&x=2' &&
        form.status === 200 &&
        safeJson(form.text).method === 'POST' &&
        safeJson(form.text).body === 'name=freedom&kind=form' &&
        json.status === 200 &&
        safeJson(json.text).contentType === 'application/json' &&
        head.status === 200 &&
        head.text === '',
      {
        html: { status: html.status, ms: html.ms },
        asset: asset.status,
        query: safeJson(query.text),
        form: safeJson(form.text),
        json: safeJson(json.text),
        head: head.status,
      }
    );
    const requestChecks = {
      cookieStripped: !('cookie' in (upstreamHeaders.headers || {})),
      authorizationStripped: !('authorization' in (upstreamHeaders.headers || {})),
      customStripped: !('x-custom' in (upstreamHeaders.headers || {})),
      acceptForwarded: upstreamHeaders.headers?.accept === 'application/json',
      userAgent: upstreamHeaders.headers?.['user-agent'] === 'Freedom workspace preview',
      host: upstreamHeaders.headers?.host === `127.0.0.1:${port1}`,
      remote: upstreamHeaders.remote === '127.0.0.1',
      localPort: upstreamHeaders.localPort === port1,
    };
    const allowedResponseHeaders = new Set([
      'cache-control',
      'content-length',
      'content-security-policy',
      'content-type',
      'cross-origin-resource-policy',
      'permissions-policy',
      'referrer-policy',
      'x-content-type-options',
      'x-frame-options',
    ]);
    const responseChecks = {
      noSetCookie: !('set-cookie' in html.headers),
      xFrameReplacedToDeny: html.headers['x-frame-options'] === 'DENY',
      noHsts: !('strict-transport-security' in html.headers),
      noUpstreamCustom: !('x-upstream-custom' in html.headers),
      serverCsp: html.headers['content-security-policy'] === SERVER_PREVIEW_CSP,
      upstreamCspReplaced: !html.headers['content-security-policy'].includes('default-src *'),
      noStore: html.headers['cache-control'] === 'no-store',
      corp: html.headers['cross-origin-resource-policy'] === 'same-origin',
      onlyFixedAllowlist: Object.keys(html.headers).every((name) =>
        allowedResponseHeaders.has(name)
      ),
    };
    check(
      'S7-req-headers',
      'Cookie and Authorization are not forwarded and the upstream target is exactly 127.0.0.1 at the declared port',
      Object.values(requestChecks).every(Boolean),
      { requestChecks, upstreamSaw: upstreamHeaders }
    );
    check(
      'S7-resp-headers',
      'Set-Cookie and arbitrary upstream security headers are replaced by the fixed server-preview policy',
      Object.values(responseChecks).every(Boolean),
      { responseChecks, responseHeaders: html.headers }
    );
    check(
      'S7-redirects',
      'external redirects are blocked, same-loopback redirects are rewritten to the opaque origin, and the proxy follows no redirect',
      external.status === 403 &&
        external.text === 'Preview blocked' &&
        local.status === 302 &&
        local.headers.location === '/target?x=1' &&
        relative.status === 302 &&
        relative.headers.location === '/target?x=2' &&
        hits.text === '0',
      {
        external: external.status,
        local: { status: local.status, location: local.headers.location },
        relative: { status: relative.status, location: relative.headers.location },
        targetHits: hits.text,
      }
    );
    const oneMiB = 1024 * 1024;
    const tooBigBody = await probe(`${base}echo-body`, {
      method: 'POST',
      body: Buffer.alloc(oneMiB + 1, 121),
    });
    const declaredBig = await probe(`${base}echo-body`, {
      method: 'POST',
      raw: true,
      headers: { 'content-length': String(oneMiB + 1) },
      body: new Blob(['x']).stream(),
    });
    const exactBody = await probe(`${base}echo-body`, {
      method: 'POST',
      body: Buffer.alloc(oneMiB, 121),
    });
    const big = await probe(`${base}big`);
    const bigDeclared = await probe(`${base}big-declared`);
    check(
      'S7-bounds',
      'request bodies above 1 MiB and responses above 16 MiB fail closed while exactly 1 MiB is accepted',
      tooBigBody.status === 413 &&
        declaredBig.status === 413 &&
        exactBody.status === 200 &&
        safeJson(exactBody.text).length === oneMiB &&
        big.status === 413 &&
        bigDeclared.status === 413,
      {
        tooBigBody: tooBigBody.status,
        declaredBig: declaredBig.status,
        exactBody: safeJson(exactBody.text).length,
        big: big.status,
        bigDeclared: bigDeclared.status,
      }
    );
    const trace = await probe(base, { method: 'TRACE', raw: true });
    const crash = await probe(`${base}crash`);
    const slowStarted = Date.now();
    const slow = await probe(`${base}slow`);
    const slowMs = Date.now() - slowStarted;
    const burst = await Promise.all(Array.from({ length: 12 }, () => probe(`${base}slow?ms=1500`)));
    const burstStatuses = burst.map((entry) => entry.status);
    const unknownToken = await probe(`freedom-preview://${'f'.repeat(40)}/`);
    const wrongScheme = await probe(`http://${token1}/`);
    check(
      'S7-safety',
      'unsupported methods, upstream failure, timeout, excessive concurrency, unknown tokens and wrong schemes return bounded safe responses',
      trace.status === 405 &&
        crash.status === 502 &&
        crash.text === 'Preview server unavailable' &&
        slow.status === 504 &&
        slow.text === 'Preview server timed out' &&
        slowMs >= 9_500 &&
        slowMs < 12_000 &&
        burstStatuses.filter((status) => status === 429).length === 4 &&
        burstStatuses.filter((status) => status === 200).length === 8 &&
        unknownToken.status === 404 &&
        wrongScheme.status === 404,
      {
        trace: trace.status,
        crash: crash.status,
        slow: { status: slow.status, ms: slowMs },
        burst: burstStatuses,
        unknownToken: unknownToken.status,
        wrongScheme: wrongScheme.status,
      }
    );

    // ---- S8 pollable output
    const polled = await callTool(run1, 'write_stdin', {
      session_id: serverId,
      yield_time_ms: 300,
    });
    check(
      'S8',
      'normal server output remains incrementally pollable through write_stdin',
      !polled.error &&
        /request GET \/headers/.test(bashText(polled)) &&
        polled.result.details.state === 'running',
      { sample: bashText(polled).split('\n').slice(0, 4) }
    );

    // ---- S9 explicit termination revokes the route
    const stopped = await callTool(run1, 'write_stdin', {
      session_id: serverId,
      terminate: true,
      yield_time_ms: 3_000,
    });
    const stoppedReceipt = toolFinished(stopped.toolCallId)?.workspace;
    const afterStopFirst = await probe(base);
    const afterStopSecond = await probe(base);
    const stoppedLedger = ledgerFor(serverCommand);
    const stoppedExecutor = executorFor(serverCommand)?.receipt;
    check(
      'S9',
      'explicit termination stops the server through namespace teardown, keeps a truthful receipt with the declared port, and the first preview request returns terminal behavior before the route disappears',
      stopped.result?.details?.state === 'cancelled' &&
        stoppedReceipt?.state === 'cancelled' &&
        stoppedReceipt.signal === 'SIGKILL' &&
        stoppedReceipt.networkPosture === 'full' &&
        stoppedReceipt.previewPort === port1 &&
        stoppedReceipt.terminationGuarantee === 'namespace_scoped' &&
        stoppedReceipt.terminationScope === 'pid_namespace' &&
        stoppedReceipt.survivorsPossible === false &&
        stoppedReceipt.completeDescendantTermination === true &&
        stoppedLedger?.state === 'cancelled' &&
        stoppedLedger.terminationScope === 'pid_namespace' &&
        stoppedLedger.networkPosture === 'full' &&
        stoppedExecutor?.state === 'cancelled' &&
        stoppedExecutor.terminationScope === 'pid_namespace' &&
        afterStopFirst.status === 410 &&
        afterStopFirst.text === 'Preview server stopped' &&
        afterStopSecond.status === 404 &&
        listener(port1) === '' &&
        survivorProcesses() === '',
      {
        receipt: stoppedReceipt,
        ledger: stoppedLedger && {
          state: stoppedLedger.state,
          signal: stoppedLedger.signal,
          terminationScope: stoppedLedger.terminationScope,
          networkPosture: stoppedLedger.networkPosture,
        },
        executor: stoppedExecutor,
        afterStop: [afterStopFirst.status, afterStopSecond.status],
        listener: listener(port1),
        survivors: survivorProcesses(),
      }
    );

    // ---- S10 conversation Stop
    const port2 = await pickFreePort();
    const serverCommand2 = `node server.js ${port2}`;
    decisions.push({ approved: true, workspacePermissionScope: 'once' });
    await callTool(run1, 'request_permissions', {
      executables: ['node'],
      network: 'full',
      reason: 'Serve again',
      command: serverCommand2,
      workingDirectory: '.',
    });
    const launch2 = await callTool(run1, 'bash', {
      command: serverCommand2,
      previewPort: port2,
      yield_time_ms: 2_500,
    });
    const serverId2 = sessionIds(launch2)[0];
    const opened2 = await callTool(run1, 'workspace_preview', { processId: serverId2 });
    const base2 = navigations.at(-1)?.url;
    const live2 = await probe(base2);
    await service.stop(run1.runId);
    await service.waitForIdle();
    await waitFor(() => ledgerFor(serverCommand2)?.state !== 'running', 5_000);
    const afterStop2 = await probe(base2);
    const afterStop2Again = await probe(base2);
    check(
      'S10',
      'conversation Stop terminates the server process and revokes its preview route',
      !opened2.error &&
        live2.status === 200 &&
        ledgerFor(serverCommand2)?.state === 'cancelled' &&
        ledgerFor(serverCommand2).signal === 'SIGKILL' &&
        executorFor(serverCommand2)?.receipt?.terminationScope === 'pid_namespace' &&
        afterStop2.status === 410 &&
        afterStop2Again.status === 404 &&
        listener(port2) === '' &&
        survivorProcesses() === '',
      {
        ledger: ledgerFor(serverCommand2) && {
          state: ledgerFor(serverCommand2).state,
          signal: ledgerFor(serverCommand2).signal,
          terminationScope: ledgerFor(serverCommand2).terminationScope,
        },
        afterStop: [afterStop2.status, afterStop2Again.status],
        listener: listener(port2),
      }
    );

    // ---- S11 deletion clears the route and storage; headline evidence from the ending turn
    const run2 = await startRun('Serve once more');
    const port3 = await pickFreePort();
    const serverCommand3 = `node server.js ${port3}`;
    decisions.push({ approved: true, workspacePermissionScope: 'once' });
    await callTool(run2, 'request_permissions', {
      executables: ['node'],
      network: 'full',
      reason: 'Serve for deletion test',
      command: serverCommand3,
      workingDirectory: '.',
    });
    const launch3 = await callTool(run2, 'bash', {
      command: serverCommand3,
      previewPort: port3,
      yield_time_ms: 2_500,
    });
    const serverId3 = sessionIds(launch3)[0];
    const opened3 = await callTool(run2, 'workspace_preview', { processId: serverId3 });
    const base3 = navigations.at(-1)?.url;
    const token3 = /^freedom-preview:\/\/([a-f0-9]{20,128})\/$/.exec(base3 || '')?.[1];
    const live3 = await probe(base3);
    await endRun(run2);
    const run2Outcome = runFinishedEvent(run2.runId)?.outcome;
    const executor3Before = executorFor(serverCommand3);
    durableSnapshots.push({
      conversationId: conversationA,
      history: historyStore.getSession(conversationA),
      commands: ledgerRows(),
    });
    const deleted = await service.deleteConversation(conversationA);
    await waitFor(() => executor3Before?.receipt, 5_000);
    const afterDelete = await probe(base3);
    check(
      'S11',
      'conversation deletion stops the server, revokes the route, clears the preview origin storage, and the turn that ended with the server preview reports Server preview opened',
      !opened3.error &&
        live3.status === 200 &&
        run2Outcome?.headline === 'Server preview opened' &&
        run2Outcome.verification === 'workspace_preview_opened' &&
        deleted === true &&
        executor3Before?.receipt?.state === 'cancelled' &&
        executor3Before.receipt.terminationScope === 'pid_namespace' &&
        afterDelete.status === 404 &&
        storageClears.some(
          (entry) =>
            entry.origin === `freedom-preview://${token3}` && entry.storages.includes('cookies')
        ) &&
        listener(port3) === '' &&
        survivorProcesses() === '',
      {
        headline: run2Outcome?.headline,
        detail: run2Outcome?.detail,
        deleted,
        executor: executor3Before?.receipt,
        afterDelete: afterDelete.status,
        storageClears: storageClears.map((entry) => ({
          origin: entry.origin.replace(/[a-f0-9]{20,128}/, '<token>'),
          storages: entry.storages,
        })),
        listener: listener(port3),
      }
    );

    // ---- S12 static preview in the gated build plus controller disposal (new conversation)
    await service.clearConversation();
    const run3 = await startRun('Static and disposal');
    decisions.push(true);
    const enableB = await callTool(run3, 'bash', { command: 'printf enabled-b' });
    if (!bashText(enableB).includes('enabled-b')) throw new Error('workspace B enable failed');
    for (const [file, content] of [
      ['server.js', SERVER_SOURCE],
      ['index.html', STATIC_HTML],
    ]) {
      const written = await callTool(run3, 'write', { path: file, content });
      if (written.error) throw new Error(`write ${file} failed`);
    }
    const port4 = await pickFreePort();
    const serverCommand4 = `node server.js ${port4}`;
    decisions.push({ approved: true, workspacePermissionScope: 'once' });
    await callTool(run3, 'request_permissions', {
      executables: ['node'],
      network: 'full',
      reason: 'Serve for disposal test',
      command: serverCommand4,
      workingDirectory: '.',
    });
    const launch4 = await callTool(run3, 'bash', {
      command: serverCommand4,
      previewPort: port4,
      yield_time_ms: 2_500,
    });
    const serverId4 = sessionIds(launch4)[0];
    const opened4 = await callTool(run3, 'workspace_preview', { processId: serverId4 });
    const base4 = navigations.at(-1)?.url;
    const staticPreview = await callTool(run3, 'workspace_preview', { path: 'index.html' });
    const staticUrl = navigations.at(-1)?.url;
    const staticGet = await probe(staticUrl);
    const staticPost = await probe(staticUrl, { method: 'POST', body: 'x' });
    const staticReceipt = toolFinished(staticPreview.toolCallId)?.workspace;
    await endRun(run3);
    const run3Outcome = runFinishedEvent(run3.runId)?.outcome;
    check(
      'S12-static',
      'static preview evidence is unchanged in the gated build: offline CSP, GET only, static_preview receipt on networkPosture none, and the Static preview opened card',
      !staticPreview.error &&
        staticGet.status === 200 &&
        staticGet.text.includes('static-preview-ok') &&
        staticGet.headers['content-security-policy'] === PREVIEW_CSP &&
        staticPost.status === 405 &&
        staticReceipt?.kind === 'static_preview' &&
        staticReceipt.networkPosture === 'none' &&
        run3Outcome?.headline === 'Static preview opened',
      {
        csp: staticGet.headers['content-security-policy'],
        post: staticPost.status,
        receipt: staticReceipt,
        headline: run3Outcome?.headline,
      }
    );
    const executor4 = executorFor(serverCommand4);
    const live4 = await probe(base4);
    controller.dispose();
    await waitFor(() => executor4?.receipt, 5_000);
    const afterDispose = await probe(base4);
    check(
      'S12-dispose',
      'controller disposal stops the retained server through namespace teardown and the preview route reports terminal then unavailable',
      !opened4.error &&
        live4.status === 200 &&
        executor4?.receipt?.state === 'cancelled' &&
        executor4.receipt.terminationScope === 'pid_namespace' &&
        executor4.receipt.signal === 'SIGKILL' &&
        [410, 404].includes(afterDispose.status) &&
        listener(port4) === '' &&
        survivorProcesses() === '',
      {
        executor: executor4?.receipt,
        afterDispose: afterDispose.status,
        listener: listener(port4),
        survivors: survivorProcesses(),
      }
    );

    // ---- S13 helpers offline; receipts truthful at every level for the terminated server (port1)
    const helperLaunches = executions.filter((entry) => entry.command.startsWith('helper:'));
    const durableA = durableSnapshots.at(-1)?.history;
    const durableStopItem = (durableA?.transcript || [])
      .flatMap((turn) => turn.activity || [])
      .find(
        (item) =>
          item.operation === 'write_stdin' &&
          item.workspace?.command === serverCommand &&
          item.workspace.state === 'cancelled'
      );
    const durableServerPreview = (durableA?.transcript || [])
      .flatMap((turn) => turn.activity || [])
      .find(
        (item) =>
          item.operation === 'workspace_preview' && item.workspace?.kind === 'server_preview'
      );
    const ledgerA = durableSnapshots
      .at(-1)
      ?.commands.filter((row) => row.command === serverCommand)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    check(
      'S13',
      'helpers stay offline; server-preview activity is durably recorded as server_preview with networkPosture full; the terminated server keeps truthful guarantees across executor, tool, durable activity and ledger',
      helperLaunches.length >= 4 &&
        helperLaunches.every((entry) => entry.network === 'none') &&
        durableServerPreview?.workspace?.networkPosture === 'full' &&
        durableServerPreview.workspace.backend === 'freedom-workspace-server-preview' &&
        durableStopItem?.workspace?.terminationGuarantee === 'namespace_scoped' &&
        durableStopItem.workspace.terminationScope === 'pid_namespace' &&
        durableStopItem.workspace.signal === 'SIGKILL' &&
        ledgerA?.terminationScope === 'pid_namespace' &&
        ledgerA.terminationGuarantee === 'namespace_scoped',
      {
        helperPostures: [...new Set(helperLaunches.map((entry) => entry.network))],
        durableServerPreview: durableServerPreview?.workspace,
        durableStop: durableStopItem?.workspace,
        ledger: ledgerA && {
          state: ledgerA.state,
          terminationGuarantee: ledgerA.terminationGuarantee,
          terminationScope: ledgerA.terminationScope,
          networkPosture: ledgerA.networkPosture,
        },
      }
    );

    // ---- S14 leak scan: tokens, localhost URLs, host paths, authority objects, secrets
    const tokens = navigations
      .map((entry) => /^freedom-preview:\/\/([a-f0-9]{20,128})\//.exec(entry.url)?.[1])
      .filter(Boolean);
    const leakMarkers = [
      ...tokens,
      'http://127.0.0.1',
      'freedom-preview://',
      root,
      os.homedir(),
      'runtimeRoots',
      'sourcePath',
      'capabilityRequest',
      'must-not-leak-9f3a7c',
      'freedom-sandbox-ready',
    ];
    const scan = (label, value) => {
      const text = JSON.stringify(value) || '';
      return {
        label,
        bytes: text.length,
        found: leakMarkers.filter((marker) => text.includes(marker)),
      };
    };
    const leakScans = [
      scan('pi_visible_tool_results', piVisible),
      scan(
        'durable_history_activity',
        durableSnapshots.map((snapshot) => snapshot.history)
      ),
      scan(
        'durable_workspace_commands',
        durableSnapshots.map((snapshot) => snapshot.commands)
      ),
      scan(
        'service_events_excluding_approvals',
        events.filter((event) => event.type !== 'approval_requested')
      ),
    ];
    check(
      'S14',
      'the opaque preview tokens, the localhost URL, host paths, capability objects, the readiness marker and the secret never reach Pi-visible results, durable activity, the ledger, or ordinary events',
      leakScans.every((entry) => entry.found.length === 0) && tokens.length >= 4,
      leakScans
    );
  },
};
