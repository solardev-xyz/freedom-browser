'use strict';

// Network-permission qualification. Proves that in the product build the sandbox advertises one
// indivisible `full` network permission by default (no environment flag), yet every command and
// helper stays offline until an unforgeable, user-approved, exact-command or conversation grant
// selects the full-network policy. Run with networkEnabled=false for the capability-disabled
// regression, which proves the schema, the Agent instructions, and forged requests all fail closed.
//
// This module owns deterministic local network fixtures (a loopback TCP server, a named
// abstract-Unix-socket server, and a host pathname socket outside every sandbox mount) plus a
// public-internet target. Set FREEDOM_SANDBOX_PUBLIC_HOST / _PORT / _URL / _LAN_HOST to retarget.

const PUBLIC_HOST = process.env.FREEDOM_SANDBOX_PUBLIC_HOST || '1.1.1.1';
const PUBLIC_PORT = process.env.FREEDOM_SANDBOX_PUBLIC_PORT || '443';
const PUBLIC_URL = process.env.FREEDOM_SANDBOX_PUBLIC_URL || 'https://example.com/';
const DNS_NAME = 'example.com';

// The Python probe runs inside the Agent shell policy. The parent re-executes itself as a child so
// that every network observation comes from a descendant of the sandboxed command.
const PROBE_SOURCE = String.raw`
import errno, json, os, socket, subprocess, sys, urllib.request

def code(error):
    if isinstance(error, socket.gaierror):
        return 'EAI_%s' % error.errno if error.errno else 'gaierror'
    if isinstance(error, socket.timeout):
        return 'timeout'
    if isinstance(error, OSError) and error.errno:
        return errno.errorcode.get(error.errno, str(error.errno))
    return type(error).__name__

def connect(family, target):
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(5)
    try:
        sock.connect(target)
        return 'connected'
    except Exception as error:
        return code(error)
    finally:
        sock.close()

def probe(args):
    loop_port, lan_host, lan_port, public_host, public_port, abstract, sock_path, url = args[:8]
    result = {'pid': os.getpid(), 'ppid': os.getppid()}
    result['loopback'] = connect(socket.AF_INET, ('127.0.0.1', int(loop_port)))
    result['lan'] = connect(socket.AF_INET, (lan_host, int(lan_port)))
    result['public'] = connect(socket.AF_INET, (public_host, int(public_port)))
    result['abstract'] = connect(socket.AF_UNIX, '\0' + abstract)
    result['pathname'] = connect(socket.AF_UNIX, sock_path)
    try:
        socket.getaddrinfo('example.com', 443)
        result['dns'] = 'resolved'
    except Exception as error:
        result['dns'] = code(error)
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            result['https'] = 'status:%s' % response.status
    except Exception as error:
        reason = getattr(error, 'reason', None)
        result['https'] = code(reason) if isinstance(reason, Exception) else code(error)
    try:
        with open('/proc/self/attr/current') as handle:
            result['label'] = handle.read().strip()
    except Exception as error:
        result['label'] = code(error)
    return result

if sys.argv[1] == '--child':
    print(json.dumps(probe(sys.argv[2:])))
else:
    child = subprocess.run([sys.executable, __file__, '--child'] + sys.argv[1:], capture_output=True, text=True)
    print(json.dumps({'parent': os.getpid(), 'child': json.loads(child.stdout) if child.stdout else None, 'childError': child.stderr[-400:]}))
`;

module.exports = {
  id: 'network',
  title: 'Network permissions: available by default, offline until an exact approval',
  survivorPattern: null,
  async run(ctx) {
    const {
      fs,
      os,
      net,
      path,
      emit,
      check,
      delay,
      listen,
      closeServer,
      selectLanAddress,
      leakScan,
      onCleanup,
      controller,
      workspaceStore,
      historyStore,
      service,
      executions,
      approvals,
      decisions,
      events,
      piVisible,
      durableSnapshots,
      startRun,
      endRun,
      callTool,
      bashText,
      lastExecution,
      executionsBefore,
      createFullNetworkCapabilities,
      createWorkspaceCapabilityRequest,
      root,
      userDataDir,
      networkEnabled,
      policyCreations,
    } = ctx;
    const NETWORK_PERMISSIONS_ENABLED = networkEnabled;

    // ---- Deterministic local network fixtures.
    const lanAddress = await selectLanAddress(process.env.FREEDOM_SANDBOX_LAN_HOST);
    const tcpServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('host-tcp');
    });
    await listen(tcpServer, { host: '0.0.0.0', port: 0 });
    const tcpPort = tcpServer.address().port;
    const abstractName = `freedom-product-network-${process.pid}-${Date.now()}`;
    const abstractServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('host-abstract');
    });
    await listen(abstractServer, `\0${abstractName}`);
    // A host pathname socket outside every mounted root; the sandbox's /tmp is a private tmpfs.
    const socketPath = path.join(os.tmpdir(), `freedom-product-network-${process.pid}.sock`);
    const unixServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('host-unix');
    });
    await listen(unixServer, socketPath);
    onCleanup(async () => {
      await Promise.all([
        closeServer(tcpServer),
        closeServer(abstractServer),
        closeServer(unixServer),
      ]);
      await fs.promises.rm(socketPath, { force: true });
    });
    emit('fixtures', {
      hostLoopbackPort: tcpPort,
      lanAddress,
      publicTcp: `${PUBLIC_HOST}:${PUBLIC_PORT}`,
      publicUrl: PUBLIC_URL,
      dnsName: DNS_NAME,
      abstractSocket: 'named',
      pathnameSocket: 'host temporary directory, outside every sandbox mount',
    });

    const probeResult = (entry) => {
      try {
        return JSON.parse(bashText(entry).trim().split('\n').at(-1));
      } catch {
        return null;
      }
    };

    const probeArguments = [
      tcpPort,
      lanAddress,
      tcpPort,
      PUBLIC_HOST,
      PUBLIC_PORT,
      abstractName,
      socketPath,
      PUBLIC_URL,
    ].join(' ');
    const probeCommand = `python3 probe.py ${probeArguments}`;
    const offlineExpectation = (child) =>
      child &&
      child.dns !== 'resolved' &&
      child.loopback !== 'connected' &&
      child.lan !== 'connected' &&
      child.public !== 'connected' &&
      child.abstract !== 'connected' &&
      child.pathname !== 'connected' &&
      !String(child.https).startsWith('status:');
    const onlineExpectation = (child) =>
      child &&
      child.dns === 'resolved' &&
      child.loopback === 'connected' &&
      child.lan === 'connected' &&
      child.public === 'connected' &&
      child.abstract === 'connected' &&
      child.pathname !== 'connected' &&
      String(child.https).startsWith('status:');

    // ===================== Run 1: conversation A =====================
    const run1 = await startRun('Qualify the network permission path');
    const permissionTool = run1.tools.find((tool) => tool.name === 'request_permissions');
    const advertisesNetwork = Boolean(permissionTool.parameters.properties.network);
    const promptAdvertisesNetwork = run1.systemPrompt.includes(
      'grant direct networking to an exact workspace command'
    );
    emit('pi_schema', {
      required: permissionTool.parameters.required,
      anyOf: permissionTool.parameters.anyOf || null,
      networkProperty: permissionTool.parameters.properties.network || null,
      additionalProperties: permissionTool.parameters.additionalProperties,
      description: permissionTool.description,
    });
    if (NETWORK_PERMISSIONS_ENABLED) {
      check(
        '2a',
        'request_permissions advertises network: full without requiring an executable',
        advertisesNetwork &&
          JSON.stringify(permissionTool.parameters.properties.network.enum) === '["full"]' &&
          !permissionTool.parameters.required.includes('executables') &&
          JSON.stringify(permissionTool.parameters.anyOf) ===
            '[{"required":["executables"]},{"required":["network"]}]' &&
          promptAdvertisesNetwork,
        { required: permissionTool.parameters.required, promptAdvertisesNetwork }
      );
    } else {
      check(
        '1a',
        'capability-disabled: schema and Agent instructions do not advertise network access',
        !advertisesNetwork &&
          permissionTool.parameters.required.includes('executables') &&
          permissionTool.parameters.additionalProperties === false &&
          !promptAdvertisesNetwork &&
          !run1.systemPrompt.includes('network: full'),
        { required: permissionTool.parameters.required, promptAdvertisesNetwork }
      );
    }

    // Enable the workspace through the ordinary workspace_execution approval.
    decisions.push(true);
    const enable = await callTool(run1, 'bash', {
      command: 'mkdir -p sub && ln -s sub link && printf enabled',
    });
    const enableApproval = approvals.find((item) => item.event.action === 'workspace_execution');
    check(
      '0a',
      'workspace enabled through the ordinary workspace_execution approval',
      bashText(enable).includes('enabled') && Boolean(enableApproval),
      {
        disclosedNetwork: enableApproval?.event.workspace?.network,
        fullNetworkAvailable: (await controller.getCapabilities()).fullNetworkAvailable,
      }
    );
    const conversationA = run1.conversationId;
    const workspaceA = controller.getWorkspace(conversationA);
    const leaseA = controller.leases.get(workspaceA.workspaceId);
    check(
      NETWORK_PERMISSIONS_ENABLED ? '6a' : '1c',
      'lease policies: helper and Agent policies are offline; full-network Agent policy exists only when gated on',
      leaseA.helperPolicy.network === 'none' &&
        leaseA.agentPolicy.network === 'none' &&
        (NETWORK_PERMISSIONS_ENABLED
          ? leaseA.fullNetworkAgentPolicy?.network === 'full'
          : leaseA.fullNetworkAgentPolicy === null),
      {
        helper: leaseA.helperPolicy.network,
        agent: leaseA.agentPolicy.network,
        fullNetworkAgent: leaseA.fullNetworkAgentPolicy?.network ?? null,
      }
    );

    // Stage the probe through the product write tool (helper policy) in both directories.
    for (const target of ['probe.py', 'sub/probe.py']) {
      const written = await callTool(run1, 'write', { path: target, content: PROBE_SOURCE });
      if (written.error) throw new Error(`write ${target} failed: ${written.error.message}`);
    }
    const helperExecutions = executions.filter((entry) => entry.command.startsWith('helper:'));
    check(
      '6b',
      'fixed helper operations run on the offline helper policy with the embedded runtime',
      helperExecutions.length >= 2 &&
        helperExecutions.every(
          (entry) =>
            entry.network === 'none' &&
            entry.runtimeRoots.some((rootEntry) => rootEntry.id === 'electron')
        ),
      { helperExecutions: helperExecutions.length }
    );

    // Offline baseline before any network approval.
    const before = await callTool(run1, 'bash', { command: probeCommand });
    const beforeChild = probeResult(before)?.child;
    check(
      NETWORK_PERMISSIONS_ENABLED ? '6c' : '1d',
      'before approval the exact probe command is offline through the ordinary Agent policy',
      offlineExpectation(beforeChild) && lastExecution().network === 'none',
      { policyNetwork: lastExecution().network, child: beforeChild }
    );

    if (!NETWORK_PERMISSIONS_ENABLED) {
      // Forged model request: Pi would already reject the unknown property, and the product refuses.
      const forged = await callTool(run1, 'request_permissions', {
        executables: ['python3'],
        network: 'full',
        reason: 'Forged network request',
        command: probeCommand,
        workingDirectory: '.',
      });
      check(
        '1b',
        'capability-disabled: a forged network permission request fails closed without any grant',
        forged.error?.code === 'NETWORK_PERMISSION_UNAVAILABLE' &&
          controller.capabilityGrants.grants.size === 0,
        { error: forged.error }
      );
      let forgedGrant = null;
      try {
        controller.grantCommandPermissions(
          conversationA,
          {
            kind: 'freedom.command-permissions',
            executableAccess: { commands: [], runtimeRoots: [] },
            capabilityRequest: { kind: 'freedom.workspace-capability-request', capabilities: [] },
            command: probeCommand,
            workingDirectory: '.',
            network: 'full',
          },
          'conversation'
        );
      } catch (error) {
        forgedGrant = error.code;
      }
      check(
        '1b-2',
        'capability-disabled: a manually supplied grant object is refused',
        forgedGrant === 'INVALID_COMMAND_PERMISSION_GRANT',
        { code: forgedGrant }
      );
      const after = await callTool(run1, 'bash', { command: probeCommand });
      check(
        '1c-2',
        'capability-disabled: ordinary workspace commands remain offline after the forgery attempts',
        offlineExpectation(probeResult(after)?.child) && lastExecution().network === 'none',
        { child: probeResult(after)?.child }
      );
    } else {
      // ---- 2b/2c/3: allow once for the exact command in the canonical directory `sub` via `link`.
      decisions.push({ approved: true, workspacePermissionScope: 'once' });
      const request = await callTool(run1, 'request_permissions', {
        network: 'full',
        reason: 'Probe the network from the exact command',
        command: probeCommand,
        workingDirectory: 'link',
      });
      const approval = approvals.find((item) => item.event.action === 'workspace_permission');
      const projected = approval?.event.workspacePermission;
      emit('approval_projection', {
        workspacePermission: projected,
        piVisibleResult: request.result,
      });
      check(
        '2b',
        'normalized approval is bound to the literal command and canonical working directory with the full bundle',
        projected &&
          projected.command === probeCommand &&
          projected.workingDirectory === 'sub' &&
          Array.isArray(projected.commands) &&
          projected.commands.length === 0 &&
          projected.network?.posture === 'full' &&
          projected.network.publicInternet === true &&
          projected.network.hostLoopback === true &&
          projected.network.privateLan === true &&
          projected.network.hostAbstractUnixSockets === 'reachable' &&
          request.result?.details?.network === 'full' &&
          request.result.details.workingDirectory === 'sub',
        { projected, details: request.result?.details }
      );

      // 3a: different command and different directory remain offline and do not consume.
      const otherCommand = await callTool(run1, 'bash', { command: `${probeCommand} extra` });
      const otherCommandChild = probeResult(otherCommand)?.child;
      const otherDirectory = await callTool(run1, 'bash', { command: probeCommand });
      const otherDirectoryChild = probeResult(otherDirectory)?.child;
      check(
        '3a',
        'allow once: a different command and a different working directory stay offline',
        offlineExpectation(otherCommandChild) &&
          offlineExpectation(otherDirectoryChild) &&
          executions.slice(-2).every((entry) => entry.network === 'none'),
        { otherCommand: otherCommandChild, otherDirectory: otherDirectoryChild }
      );
      const exact = await callTool(run1, 'bash', {
        command: probeCommand,
        workingDirectory: 'link',
      });
      const exactResult = probeResult(exact);
      const exactChild = exactResult?.child;
      check(
        '3b',
        'allow once: a mismatching call did not consume the grant; the exact command gets full networking once',
        onlineExpectation(exactChild) && lastExecution().network === 'full' && !exact.error,
        { policyNetwork: lastExecution().network, child: exactChild, receipt: exact }
      );
      check(
        '5',
        'real Linux behavior from a descendant: DNS, HTTPS, host loopback, non-loopback address, abstract reachable, pathname denied',
        onlineExpectation(exactChild) && exactChild.ppid === exactResult?.parent,
        exactChild
      );
      const again = await callTool(run1, 'bash', {
        command: probeCommand,
        workingDirectory: 'sub',
      });
      const againChild = probeResult(again)?.child;
      check(
        '3c',
        'allow once: a second execution of the exact command is offline again',
        offlineExpectation(againChild) && lastExecution().network === 'none',
        { policyNetwork: lastExecution().network, child: againChild }
      );

      // 3e / 2c: replay, serialization, forgery, incomplete and unknown bundles fail closed.
      const prepared = await controller.prepareCommandPermissions(
        conversationA,
        { network: 'full' },
        { command: 'printf replay', workingDirectory: '.' }
      );
      controller.grantCommandPermissions(conversationA, prepared.prepared, 'once');
      const outcomes = {};
      const attempt = (label, fn) => {
        try {
          fn();
          outcomes[label] = 'accepted';
        } catch (error) {
          outcomes[label] = error.code;
        }
      };
      attempt('replay', () =>
        controller.grantCommandPermissions(conversationA, prepared.prepared, 'once')
      );
      attempt('serialized', () =>
        controller.grantCommandPermissions(
          conversationA,
          JSON.parse(JSON.stringify(prepared.prepared)),
          'once'
        )
      );
      attempt('forged', () =>
        controller.grantCommandPermissions(
          conversationA,
          {
            kind: 'freedom.command-permissions',
            executableAccess: { commands: [], runtimeRoots: [] },
            capabilityRequest: { kind: 'freedom.workspace-capability-request', capabilities: [] },
            command: 'printf forged',
            workingDirectory: '.',
            network: 'full',
          },
          'conversation'
        )
      );
      attempt('other_conversation', () =>
        controller.grantCommandPermissions('conversation_z', prepared.prepared, 'conversation')
      );
      check(
        '3e',
        'reusing, serializing, forging, or re-homing a prepared permission request is rejected',
        ['replay', 'serialized', 'forged', 'other_conversation'].every(
          (label) => outcomes[label] === 'INVALID_COMMAND_PERMISSION_GRANT'
        ),
        outcomes
      );
      controller.clearTurnPermissions(conversationA);

      // Incomplete bundle injected directly into the grant store below the controller.
      const incomplete = createWorkspaceCapabilityRequest({
        conversationId: conversationA,
        command: 'printf incomplete',
        workingDirectory: '.',
        capabilities: createFullNetworkCapabilities().slice(0, 2),
      });
      controller.capabilityGrants.grant(conversationA, incomplete, 'once');
      const beforeIncomplete = executionsBefore();
      const incompleteRun = await callTool(run1, 'bash', { command: 'printf incomplete' });
      check(
        '2c-incomplete',
        'an incomplete network bundle in the grant store fails closed before any launch',
        incompleteRun.error?.code === 'UNSUPPORTED_CAPABILITY_COMBINATION' &&
          executionsBefore() === beforeIncomplete,
        { error: incompleteRun.error }
      );
      const originalResolve = controller.capabilityGrants.resolve.bind(controller.capabilityGrants);
      controller.capabilityGrants.resolve = () => [
        Object.freeze({ kind: 'network_unknown', version: 1 }),
      ];
      const beforeUnknown = executionsBefore();
      const unknownRun = await callTool(run1, 'bash', { command: 'printf unknown' });
      controller.capabilityGrants.resolve = originalResolve;
      check(
        '2c-unknown',
        'an unknown network-prefixed capability resolved from the store fails closed before any launch',
        unknownRun.error?.code === 'UNSUPPORTED_WORKSPACE_CAPABILITY' &&
          executionsBefore() === beforeUnknown,
        { error: unknownRun.error }
      );

      // ---- 7: executable composition in one permission.
      const nodeProbe =
        'node -e \'const fs=require("fs"),net=require("net"),dns=require("dns"),path=require("path");const port=Number(process.argv[1]);const r={execPath:process.execPath};try{fs.writeFileSync(path.join(path.dirname(process.execPath),"freedom-write-probe"),"x");r.rootWrite="unexpected"}catch(e){r.rootWrite=e.code}let done=false;const finish=()=>{if(done)return;done=true;dns.lookup("example.com",(e)=>{r.dns=e?e.code:"resolved";process.stdout.write(JSON.stringify(r))})};const s=net.createConnection({host:"127.0.0.1",port});s.setTimeout(3000,()=>{r.loopback="timeout";s.destroy();finish()});s.once("connect",()=>{r.loopback="connected";s.end();finish()});s.once("error",(e)=>{r.loopback=e.code;finish()})\' ' +
        String(tcpPort);
      decisions.push({ approved: true, workspacePermissionScope: 'once' });
      const composed = await callTool(run1, 'request_permissions', {
        executables: ['node'],
        network: 'full',
        reason: 'Run the Node probe with networking',
        command: nodeProbe,
        workingDirectory: '.',
      });
      const composedApproval = approvals
        .filter((item) => item.event.action === 'workspace_permission')
        .at(-1);
      const composedProjection = composedApproval?.event.workspacePermission;
      emit('approval_projection', {
        workspacePermission: composedProjection,
        piVisibleResult: composed.result,
      });
      const nodeCommand = composedProjection?.commands?.find((entry) => entry.name === 'node');
      const mismatch = await callTool(run1, 'bash', {
        command: `${nodeProbe.slice(0, -String(tcpPort).length)}${tcpPort + 1}`,
      });
      const mismatchExecution = lastExecution();
      const composedRun = await callTool(run1, 'bash', { command: nodeProbe });
      const composedExecution = lastExecution();
      const composedResult = (() => {
        try {
          return JSON.parse(bashText(composedRun).trim().split('\n').at(-1));
        } catch {
          return null;
        }
      })();
      check(
        '7',
        'executable + full network in one permission: exact command gets both; runtime root is read/execute only; mismatch gets neither',
        nodeCommand?.status === 'requires_permission' &&
          composedProjection?.network?.posture === 'full' &&
          composedResult?.execPath?.startsWith('/opt/freedom-toolchain/approved/') &&
          composedResult.rootWrite === 'EROFS' &&
          composedResult.loopback === 'connected' &&
          composedResult.dns === 'resolved' &&
          composedExecution.network === 'full' &&
          composedExecution.runtimeRoots.some(
            (entry) => entry.id.startsWith('approved_') && entry.access === 'read_execute'
          ) &&
          mismatchExecution.network === 'none' &&
          mismatchExecution.runtimeRoots.length === 0 &&
          (mismatch.error?.code === 'WORKSPACE_COMMAND_NOT_FOUND' ||
            mismatch.error?.message?.includes('exited with code 127')),
        {
          nodeCommand,
          composedResult,
          composedPolicy: composedExecution,
          mismatchPolicy: mismatchExecution,
          mismatchError: mismatch.error,
        }
      );

      // ---- 4: allow for the conversation.
      decisions.push({ approved: true, workspacePermissionScope: 'conversation' });
      const conversationGrant = await callTool(run1, 'request_permissions', {
        network: 'full',
        reason: 'Network for the rest of this conversation',
        command: probeCommand,
        workingDirectory: '.',
      });
      const conversationProbe = await callTool(run1, 'bash', {
        command: `${probeCommand} conversation`,
      });
      const conversationChild = probeResult(conversationProbe)?.child;
      const listed = await callTool(run1, 'ls', { path: '.' });
      const read = await callTool(run1, 'read', { path: 'probe.py' });
      const grepped = await callTool(run1, 'grep', { pattern: 'urlopen', path: '.' });
      const found = await callTool(run1, 'find', { pattern: '*.py', path: '.' });
      const edited = await callTool(run1, 'edit', {
        path: 'probe.py',
        edits: [{ oldText: 'def code(error):', newText: 'def code(error):  # edited' }],
      });
      const helperAfterGrant = executions
        .slice(-5)
        .filter((entry) => entry.command.startsWith('helper:'));
      check(
        '4a',
        'allow for conversation: later, different workspace commands use the full-network policy',
        conversationGrant.result?.details?.scope === 'conversation' &&
          onlineExpectation(conversationChild) &&
          executions.find((entry) => entry.command === `${probeCommand} conversation`)?.network ===
            'full',
        { child: conversationChild }
      );
      check(
        '6d',
        'helper read/ls/grep/find/edit stay on the derived offline helper policy while conversation networking exists',
        helperAfterGrant.length >= 4 &&
          helperAfterGrant.every((entry) => entry.network === 'none') &&
          !listed.error &&
          !read.error &&
          !grepped.error &&
          !found.error &&
          !edited.error,
        {
          helperPolicies: helperAfterGrant.map((entry) => entry.network),
          toolErrors: Object.fromEntries(
            Object.entries({ listed, read, grepped, found, edited }).map(([key, entry]) => [
              key,
              entry.error ? `${entry.error.code}: ${entry.error.message?.slice(0, 160)}` : null,
            ])
          ),
        }
      );

      // ---- 8: receipts and lifecycle inside conversation A.
      const failed = await callTool(run1, 'bash', { command: 'printf failing >&2; exit 7' });
      const timedOut = await callTool(run1, 'bash', {
        command: 'while true; do printf x >> heartbeat; sleep 0.03; done',
        timeout: 1,
      });
      const workspaceRoot = leaseA.workspaceRoot;
      const heartbeat = path.join(workspaceRoot, 'heartbeat');
      const heartbeatSize = fs.statSync(heartbeat).size;
      await delay(400);
      const heartbeatStable = fs.statSync(heartbeat).size === heartbeatSize;
      const cancelPromise = callTool(run1, 'bash', {
        command: 'while true; do printf y >> cancelled-heartbeat; sleep 0.03; done',
      });
      for (let waited = 0; waited < 5_000; waited += 50) {
        if (fs.existsSync(path.join(workspaceRoot, 'cancelled-heartbeat'))) break;
        await delay(50);
      }
      await service.stop(run1.runId);
      const cancelled = await cancelPromise;
      await service.waitForIdle();
      const cancelledSize = fs.statSync(path.join(workspaceRoot, 'cancelled-heartbeat')).size;
      await delay(400);
      const cancelledStable =
        fs.statSync(path.join(workspaceRoot, 'cancelled-heartbeat')).size === cancelledSize;
      const commands = workspaceStore.listCommands(conversationA, 100);
      const byCommand = (text) => commands.find((entry) => entry.command === text);
      const receipts = {
        completed: byCommand(`${probeCommand} conversation`),
        failed: byCommand('printf failing >&2; exit 7'),
        timedOut: byCommand('while true; do printf x >> heartbeat; sleep 0.03; done'),
        cancelled: byCommand('while true; do printf y >> cancelled-heartbeat; sleep 0.03; done'),
      };
      const receiptNetwork = Object.fromEntries(
        Object.entries(receipts).map(([key, receipt]) => [
          key,
          executions.find((entry) => entry.command === receipt?.command)?.network ?? null,
        ])
      );
      emit('receipts', {
        receipts,
        policyNetworkPerReceipt: receiptNetwork,
        toolErrors: {
          failed: failed.error?.message?.slice(0, 120),
          timedOut: timedOut.error?.message?.slice(0, 120),
          cancelled: cancelled.error?.message?.slice(0, 120),
        },
      });
      const honest = (receipt, state) =>
        receipt &&
        receipt.state === state &&
        receipt.backend === 'linux-bubblewrap' &&
        receipt.terminationGuarantee === 'namespace_scoped' &&
        receipt.sideEffects === 'unknown';
      check(
        '8',
        'successful, failed, timed-out, and cancelled receipts stay honest and no descendant survives',
        honest(receipts.completed, 'completed') &&
          receipts.completed.exitCode === 0 &&
          honest(receipts.failed, 'failed') &&
          receipts.failed.exitCode === 7 &&
          honest(receipts.timedOut, 'timed_out') &&
          receipts.timedOut.signal === 'SIGKILL' &&
          honest(receipts.cancelled, 'cancelled') &&
          receipts.cancelled.signal === 'SIGKILL' &&
          heartbeatStable &&
          cancelledStable,
        { heartbeatStable, cancelledStable, receiptNetwork }
      );
      check(
        '8-network-field',
        'command receipts carry an explicit effective network posture field',
        Object.entries(receipts).every(
          ([key, receipt]) =>
            receipt &&
            ['none', 'full'].includes(receipt.networkPosture) &&
            receipt.networkPosture === receiptNetwork[key]
        ),
        {
          receiptPostures: Object.fromEntries(
            Object.entries(receipts).map(([key, receipt]) => [key, receipt?.networkPosture ?? null])
          ),
          policyNetworkPerReceipt: receiptNetwork,
        }
      );

      // ---- 4b/4c: a second conversation cannot inherit or replay; deletion removes the grant.
      const run2 = await startRun('Continue conversation A');
      const stillGranted = await callTool(run2, 'bash', { command: `${probeCommand} second-run` });
      check(
        '4a-2',
        'a conversation-scoped grant survives into the next run of the same conversation',
        onlineExpectation(probeResult(stillGranted)?.child) && lastExecution().network === 'full',
        { child: probeResult(stillGranted)?.child }
      );
      await endRun(run2);
      await service.clearConversation();
      const run3 = await startRun('Start conversation B');
      decisions.push(true);
      const conversationB = run3.conversationId;
      const bProbeWrite = await callTool(run3, 'write', {
        path: 'probe.py',
        content: PROBE_SOURCE,
      });
      void bProbeWrite;
      const bProbe = await callTool(run3, 'bash', { command: probeCommand });
      let replayOutcome = null;
      try {
        controller.grantCommandPermissions(conversationB, prepared.prepared, 'conversation');
      } catch (error) {
        replayOutcome = error.code;
      }
      check(
        '4b',
        'a second conversation neither inherits nor can replay the first conversation grant',
        conversationB !== conversationA &&
          offlineExpectation(probeResult(bProbe)?.child) &&
          lastExecution().network === 'none' &&
          controller.capabilityGrants.resolve(conversationB, {
            command: probeCommand,
            workingDirectory: '.',
          }).length === 0 &&
          replayOutcome === 'INVALID_COMMAND_PERMISSION_GRANT',
        { conversationB, replayOutcome, child: probeResult(bProbe)?.child }
      );
      await endRun(run3);
      const hadGrant = controller.capabilityGrants.grants.has(conversationA);
      durableSnapshots.push({
        conversationId: conversationA,
        history: historyStore.getSession(conversationA),
        commands: workspaceStore.listCommands(conversationA, 100),
      });
      const deleted = await service.deleteConversation(conversationA);
      check(
        '4c',
        'deleting the conversation removes its grant',
        hadGrant &&
          deleted === true &&
          !controller.capabilityGrants.grants.has(conversationA) &&
          controller.capabilityGrants.resolve(conversationA, {
            command: probeCommand,
            workingDirectory: '.',
          }).length === 0,
        { hadGrant, deleted }
      );
      check(
        '6e',
        'no second workspace hardlink scan per command or permission request',
        policyCreations() === 2 && executions.length > 10,
        { policyCreations: policyCreations(), leases: 2, executions: executions.length }
      );
    }

    if (!NETWORK_PERMISSIONS_ENABLED) {
      await endRun(run1);
      check(
        '6e',
        'no second workspace hardlink scan per command or permission request',
        policyCreations() === 1 && executions.length > 3,
        { policyCreations: policyCreations(), executions: executions.length }
      );
    }

    // ---- Leak scan over Pi-visible results and durable activity.
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
    const serializedDurable = JSON.stringify(durable);
    const durableActivity = durable.flatMap((session) =>
      Array.isArray(session.transcript)
        ? session.transcript.flatMap((turn) => (Array.isArray(turn.activity) ? turn.activity : []))
        : []
    );
    check(
      '8-network-durable',
      NETWORK_PERMISSIONS_ENABLED
        ? 'durable Agent activity preserves effective full and offline network postures'
        : 'durable Agent activity remains offline while full networking is disabled',
      serializedDurable.includes('"networkPosture":"none"') &&
        NETWORK_PERMISSIONS_ENABLED === serializedDurable.includes('"networkPosture":"full"'),
      {
        hasFull: serializedDurable.includes('"networkPosture":"full"'),
        hasNone: serializedDurable.includes('"networkPosture":"none"'),
      }
    );
    if (NETWORK_PERMISSIONS_ENABLED) {
      const cancelledActivity = durableActivity.find(
        (item) =>
          item.operation === 'bash' &&
          item.status !== 'running' &&
          item.workspace?.state === 'cancelled' &&
          item.workspace?.networkPosture === 'full' &&
          item.workspace?.signal === 'SIGKILL'
      );
      check(
        '8-network-cancelled-durable',
        'a stopped full-network command is durably terminal with its authoritative receipt',
        Boolean(cancelledActivity),
        cancelledActivity || null
      );
    }
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
    emit('durable_activity_sample', {
      turns: durable.map((session) => ({
        conversationId: session.conversationId || session.id,
        activity: session.transcript?.map((turn) => turn.activity) ?? [],
      })),
    });
  },
};
