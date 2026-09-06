'use strict';

const { spawn } = require('child_process');

function processCommand(spawnSync, pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

module.exports = {
  id: 'macos-boundary',
  title: 'macOS product-path filesystem and host-process containment',
  platforms: ['darwin'],
  survivorPattern: 'freedom-product-host-sentinel',
  async run(ctx) {
    const {
      fs,
      path,
      check,
      delay,
      decisions,
      startRun,
      endRun,
      callTool,
      bashText,
      controller,
      lastExecution,
      leakScan,
      piVisible,
      durableSnapshots,
      historyStore,
      workspaceStore,
      root,
      userDataDir,
      spawnSync,
      onCleanup,
      platform,
    } = ctx;

    const run = await startRun('Qualify the macOS filesystem and process boundary');
    decisions.push(true);
    await callTool(run, 'bash', { command: 'printf enabled' });
    const workspace = controller.getWorkspace(run.conversationId);
    const workspaceRoot = controller.leases.get(workspace.workspaceId).workspaceRoot;
    const outsideRoot = path.join(root, 'outside');
    const outsideCanary = path.join(outsideRoot, 'canary.txt');
    const outsideDirectory = path.join(outsideRoot, 'recursive-canary');
    const outsideNested = path.join(outsideDirectory, 'nested.txt');
    await fs.promises.mkdir(outsideDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(outsideCanary, 'outside-canary');
    await fs.promises.writeFile(outsideNested, 'recursive-canary');
    await fs.promises.writeFile(path.join(workspaceRoot, 'ordinary-source'), 'ordinary');
    await Promise.all([
      fs.promises.symlink(outsideCanary, path.join(workspaceRoot, 'outside-link')),
      fs.promises.symlink(outsideDirectory, path.join(workspaceRoot, 'outside-parent')),
      fs.promises.symlink(path.join(workspaceRoot, '.git'), path.join(workspaceRoot, 'git-parent')),
    ]);

    const script = [
      'import json, os, pathlib, shutil',
      `outside = ${JSON.stringify(outsideCanary)}`,
      `outside_dir = ${JSON.stringify(outsideDirectory)}`,
      'result = {}',
      "for name, target, mode in [('directRead', outside, 'r'), ('directWrite', outside, 'w'), ('symlinkRead', 'outside-link', 'r'), ('parentRead', 'outside-parent/nested.txt', 'r')]:",
      '    try:',
      "        with open(target, mode) as stream: stream.read() if mode == 'r' else stream.write('escaped')",
      "        result[name] = 'unexpected'",
      '    except OSError as error: result[name] = error.errno',
      'try:',
      "    os.link(outside, 'outside-hardlink')",
      "    result['outsideHardlink'] = 'unexpected'",
      "except OSError as error: result['outsideHardlink'] = error.errno",
      'try:',
      '    shutil.rmtree(outside_dir)',
      "    result['recursiveDelete'] = 'unexpected'",
      "except OSError as error: result['recursiveDelete'] = error.errno",
      "result['secretAbsent'] = os.environ.get('FREEDOM_PRODUCT_PRIVATE_SENTINEL') is None",
      "result['privateStorage'] = all(os.path.realpath(os.environ[name]).startswith(os.path.realpath(os.environ['HOME']).rsplit('/', 1)[0]) for name in ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'])",
      "pathlib.Path(os.environ['HOME']).joinpath('probe').write_text('private')",
      "pathlib.Path(os.environ['TMPDIR']).joinpath('probe').write_text('private')",
      'print(json.dumps(result), end="")',
    ].join('\n');
    await fs.promises.writeFile(path.join(workspaceRoot, 'boundary.py'), script);
    process.env.FREEDOM_PRODUCT_PRIVATE_SENTINEL = 'must-not-leak';
    const boundary = await callTool(run, 'bash', { command: 'python3 boundary.py' });
    const boundaryResult = JSON.parse(bashText(boundary).trim());
    check(
      'MB1',
      'direct, interpreter-mediated, symlink, hard-link, and recursive-deletion escapes are denied with EPERM',
      !boundary.error &&
        ['directRead', 'directWrite', 'symlinkRead', 'parentRead', 'outsideHardlink', 'recursiveDelete']
          .every((name) => boundaryResult[name] === 1),
      boundaryResult
    );
    check(
      'MB2',
      'outside direct and recursive canaries remain intact',
      fs.readFileSync(outsideCanary, 'utf8') === 'outside-canary' &&
        fs.readFileSync(outsideNested, 'utf8') === 'recursive-canary' &&
        !fs.existsSync(path.join(workspaceRoot, 'outside-hardlink')),
      { direct: true, recursive: true, hardlinkCreated: false }
    );
    check(
      'MB3',
      'the host environment is scrubbed and command-private HOME/TMP/XDG storage is usable',
      boundaryResult.secretAbsent === true && boundaryResult.privateStorage === true,
      { secretAbsent: boundaryResult.secretAbsent, privateStorage: boundaryResult.privateStorage }
    );

    const protectedLink = await callTool(run, 'bash', {
      command: 'ln .git/HEAD protected-head-alias',
    });
    const protectedReceipt = lastExecution().receipt;
    const ordinaryLink = await callTool(run, 'bash', {
      command: 'ln ordinary-source ordinary-alias',
    });
    const sourceStats = fs.statSync(path.join(workspaceRoot, 'ordinary-source'));
    const aliasStats = fs.statSync(path.join(workspaceRoot, 'ordinary-alias'));
    check(
      'MB4',
      'protected Git hard-link creation is denied with EPERM while an ordinary workspace hard link works',
      protectedLink.error?.code === 'WORKSPACE_COMMAND_FAILED' &&
        protectedReceipt?.state === 'failed' &&
        protectedReceipt.exitCode === 1 &&
        !fs.existsSync(path.join(workspaceRoot, 'protected-head-alias')) &&
        !ordinaryLink.error &&
        sourceStats.dev === aliasStats.dev &&
        sourceStats.ino === aliasStats.ino,
      {
        protected: {
          state: protectedReceipt?.state,
          exitCode: protectedReceipt?.exitCode,
          aliasCreated: fs.existsSync(path.join(workspaceRoot, 'protected-head-alias')),
        },
        ordinarySameInode: sourceStats.dev === aliasStats.dev && sourceStats.ino === aliasStats.ino,
      }
    );

    const caseFolded = await callTool(run, 'bash', {
      command: "for p in .GIT/config .GiT/config git-parent/config; do if printf mutation >> \"$p\" 2>/dev/null; then printf unexpected; else printf denied; fi; done",
    });
    check(
      'MB5',
      'case-folded Git paths and protected paths reached through a symlinked parent stay read-only',
      !caseFolded.error &&
        !bashText(caseFolded).includes('unexpected') &&
        (bashText(caseFolded).match(/denied/g) || []).length === 3,
      {
        deniedMarkers: (bashText(caseFolded).match(/denied/g) || []).length,
        unexpected: bashText(caseFolded).includes('unexpected'),
      }
    );

    const token = `freedom-product-host-sentinel-${process.pid}-${Date.now()}`;
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token], {
      stdio: 'ignore',
    });
    const cleanupSentinel = async () => {
      const command = processCommand(spawnSync, sentinel.pid);
      if (!command) return;
      if (!command.includes(token)) throw new Error('Refusing to signal an unowned sentinel PID');
      sentinel.kill('SIGTERM');
      for (let index = 0; index < 40 && processCommand(spawnSync, sentinel.pid); index += 1) {
        await delay(25);
      }
      if (processCommand(spawnSync, sentinel.pid)) throw new Error('Host sentinel did not stop');
    };
    onCleanup(cleanupSentinel);
    await delay(100);
    const processProbe = await callTool(run, 'bash', {
      command: `/bin/ps -p ${sentinel.pid} -o pid=,command=`,
    });
    const processReceipt = lastExecution().receipt;
    check(
      'MB6',
      'the sandbox cannot enumerate a uniquely identified host-side sentinel process',
      processCommand(spawnSync, sentinel.pid).includes(token) &&
        processProbe.error?.code === 'WORKSPACE_COMMAND_FAILED' &&
        processReceipt?.state === 'failed' &&
        processReceipt.exitCode === 126 &&
        !bashText(processProbe).includes(token),
      {
        hostSawOwnedSentinel: processCommand(spawnSync, sentinel.pid).includes(token),
        sandboxState: processReceipt?.state,
        sandboxExitCode: processReceipt?.exitCode,
        tokenLeaked: bashText(processProbe).includes(token),
      }
    );
    await cleanupSentinel();

    await endRun(run);
    durableSnapshots.push(historyStore.getSession(run.conversationId));
    const markers = [root, userDataDir, workspaceRoot, outsideRoot, token, 'must-not-leak'];
    const publicLeak = leakScan('pi-visible', piVisible, markers);
    const durableLeak = leakScan(
      'durable',
      [historyStore.getSession(run.conversationId), workspaceStore.listCommands(run.conversationId, 100)],
      markers
    );
    check(
      'MB7',
      'public Pi results and renderer/durable projections contain no host fixture paths or private sentinel',
      publicLeak.found.length === 0 && durableLeak.found.length === 0,
      { publicLeak, durableLeak }
    );
    check(
      'MB8',
      'product-path receipts retain macOS best-effort survivor semantics',
      ctx.executions.every((entry) => platform.receiptMatches(entry.receipt, entry.state)),
      { receipts: ctx.executions.map((entry) => entry.receipt) }
    );
  },
};
