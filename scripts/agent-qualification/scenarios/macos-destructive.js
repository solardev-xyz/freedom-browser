'use strict';

function processCommand(spawnSync, pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

module.exports = {
  id: 'macos-destructive',
  title: 'Doubly gated detached-descendant product-path qualification',
  platforms: ['darwin'],
  survivorPattern: 'freedom-product-detached',
  async run(ctx) {
    if (
      process.env.FREEDOM_SANDBOX_DESTRUCTIVE !== '1' ||
      process.env.FREEDOM_SANDBOX_VM_ONLY !== '1'
    ) {
      throw new Error('The macOS destructive product scenario requires both disposable-host gates');
    }
    const {
      fs,
      path,
      net,
      check,
      delay,
      listen,
      closeServer,
      decisions,
      startRun,
      endRun,
      callTool,
      bashText,
      controller,
      workspaceStore,
      spawnSync,
      root,
      onCleanup,
      platform,
    } = ctx;

    const server = net.createServer((socket) => socket.end('owned-host-listener'));
    await listen(server, { host: '127.0.0.1', port: 0 });
    onCleanup(() => closeServer(server));

    const run = await startRun('Qualify a detached descendant through the product process path');
    decisions.push(true);
    await callTool(run, 'bash', { command: 'printf enabled' });
    const workspace = controller.getWorkspace(run.conversationId);
    const workspaceRoot = controller.leases.get(workspace.workspaceId).workspaceRoot;
    const outsideCanary = path.join(root, 'detached-outside-canary');
    await fs.promises.writeFile(outsideCanary, 'outside-canary');
    const token = `freedom-product-detached-${process.pid}-${Date.now()}`;
    const script = [
      'import json, os, pathlib, socket, sys, time',
      `outside = ${JSON.stringify(outsideCanary)}`,
      `port = ${server.address().port}`,
      "pid_file = pathlib.Path('detached.pid')",
      "result_file = pathlib.Path('detached-result.json')",
      "heartbeat = pathlib.Path('detached-heartbeat')",
      'token = sys.argv[1]',
      'if os.fork() == 0:',
      '    os.setsid()',
      "    devnull = os.open('/dev/null', os.O_RDWR)",
      '    for descriptor in (0, 1, 2): os.dup2(devnull, descriptor)',
      '    pid_file.write_text(str(os.getpid()))',
      '    result = {}',
      '    try:',
      '        pathlib.Path(outside).read_text()',
      "        result['outsideRead'] = 'unexpected'",
      "    except OSError as error: result['outsideRead'] = error.errno",
      "    for name, address in [('localhost', ('127.0.0.1', port)), ('external', ('1.1.1.1', 53))]:",
      '        sock = socket.socket()',
      '        try: result[name] = sock.connect_ex(address)',
      '        finally: sock.close()',
      '    try:',
      "        socket.getaddrinfo('example.com', 443)",
      "        result['dns'] = 'unexpected'",
      "    except OSError as error: result['dns'] = getattr(error, 'errno', None) or type(error).__name__",
      '    result_file.write_text(json.dumps(result))',
      '    while True:',
      "        with heartbeat.open('a') as stream: stream.write('x')",
      '        time.sleep(0.03)',
      'while True: time.sleep(1)',
    ].join('\n');
    await fs.promises.writeFile(path.join(workspaceRoot, 'detached.py'), script);

    let detachedPid = null;
    const cleanupDetached = async () => {
      if (!detachedPid) return;
      const owned = () => processCommand(spawnSync, detachedPid);
      if (!owned()) return;
      if (!owned().includes(token)) {
        throw new Error('Refusing to signal a detached PID without its synthetic ownership token');
      }
      process.kill(detachedPid, 'SIGTERM');
      for (let index = 0; index < 40 && owned(); index += 1) await delay(25);
      if (owned()) {
        if (!owned().includes(token)) throw new Error('Detached PID ownership changed before kill');
        process.kill(detachedPid, 'SIGKILL');
        for (let index = 0; index < 40 && owned(); index += 1) await delay(25);
      }
      if (owned()) throw new Error('Detached synthetic process survived bounded cleanup');
    };
    onCleanup(cleanupDetached);

    const command = `python3 detached.py ${token}`;
    const launched = await callTool(run, 'bash', { command, yield_time_ms: 500 });
    const sessionId = bashText(launched).match(/workspace_process_[a-f0-9]{24}/)?.[0];
    for (let index = 0; index < 200 && !fs.existsSync(path.join(workspaceRoot, 'detached-result.json')); index += 1) {
      await delay(25);
    }
    detachedPid = Number.parseInt(
      await fs.promises.readFile(path.join(workspaceRoot, 'detached.pid'), 'utf8'),
      10
    );
    const containment = JSON.parse(
      await fs.promises.readFile(path.join(workspaceRoot, 'detached-result.json'), 'utf8')
    );
    const stopped = await callTool(run, 'write_stdin', {
      session_id: sessionId,
      terminate: true,
      yield_time_ms: 3_000,
    });
    const receipt = workspaceStore
      .listCommands(run.conversationId, 100)
      .find((entry) => entry.command === command);
    const commandAfterStop = processCommand(spawnSync, detachedPid);
    const heartbeat = path.join(workspaceRoot, 'detached-heartbeat');
    const heartbeatBefore = fs.statSync(heartbeat).size;
    await delay(150);
    const heartbeatAfter = fs.statSync(heartbeat).size;
    check(
      'MD1',
      'a setsid descendant may survive original-group cancellation and the receipt says so honestly',
      sessionId &&
        stopped.result?.details?.state === 'cancelled' &&
        platform.receiptMatches(receipt, 'cancelled') &&
        commandAfterStop.includes(token) &&
        heartbeatAfter > heartbeatBefore,
      {
        sessionId,
        receipt,
        survivorObservedBeforeCleanup: commandAfterStop.includes(token),
        heartbeatAdvanced: heartbeatAfter > heartbeatBefore,
      }
    );
    check(
      'MD2',
      'the detached survivor remains Seatbelt-confined from outside files, loopback, internet, and DNS',
      containment.outsideRead !== 'unexpected' &&
        containment.localhost !== 0 &&
        containment.external !== 0 &&
        containment.dns !== 'unexpected' &&
        fs.readFileSync(outsideCanary, 'utf8') === 'outside-canary',
      containment
    );
    await cleanupDetached();
    const cleanedHeartbeat = fs.statSync(heartbeat).size;
    await delay(150);
    check(
      'MD3',
      'the token-validated detached PID is explicitly cleaned within bounds and its heartbeat stops',
      processCommand(spawnSync, detachedPid) === '' &&
        fs.statSync(heartbeat).size === cleanedHeartbeat,
      { pidRecorded: true, survivorAfterCleanup: false, heartbeatStable: true }
    );
    await endRun(run);
  },
};
