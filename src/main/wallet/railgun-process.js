/** Main-owned persistent Electron utility session. No renderer channel. The
 * caller supplies a reviewed runtime entry and minimum viewing-only JSON input.
 * A supplied host broker is borrowed for this job; its owner retains storage
 * lifetime and must drain its own dispatches. It is mutually exclusive with
 * process-owned storage/provider sessions.
 * Ready means initialization completed, never a balance/proof result. RSS limits
 * are sampled soft limits; these JavaScript processes are not an OS sandbox.
 */
const path = require('path');
const { getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunSession } = require('./railgun-session');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const owners = new Set();
const fail = (code) => Object.assign(new Error('Railgun process unavailable'), { code });
function startRailgunProcess({
  handle,
  filename,
  input,
  storage,
  createProvider,
  broker,
  storageWorker = false,
  startupMs = 30000,
  lifetimeMs = 600000,
  heapMb = 256,
  rssMb = 768,
}) {
  const context = getPrivacyContext(handle);
  const { app, utilityProcess, MessageChannelMain } = require('electron');
  if (
    !app.isReady() ||
    typeof filename !== 'string' ||
    !path.isAbsolute(filename) ||
    typeof input !== 'string' ||
    Buffer.byteLength(input) > 65536 ||
    typeof storageWorker !== 'boolean' ||
    (broker !== undefined &&
      (!broker ||
        typeof broker.dispatch !== 'function' ||
        !(broker.signal instanceof AbortSignal) ||
        storage !== undefined ||
        createProvider !== undefined ||
        storageWorker)) ||
    !Number.isInteger(startupMs) ||
    startupMs < 1 ||
    startupMs > 120000 ||
    !Number.isInteger(lifetimeMs) ||
    lifetimeMs < startupMs ||
    lifetimeMs > 1800000 ||
    !Number.isInteger(heapMb) ||
    heapMb < 16 ||
    heapMb > 1024 ||
    !Number.isInteger(rssMb) ||
    rssMb < 64 ||
    rssMb > 2048
  )
    throw fail('RAILGUN_PROCESS_INVALID');
  const owner = JSON.stringify([context.profileId, context.generation, context.subject]);
  if (owners.size >= 2 || owners.has(owner)) throw fail('RAILGUN_PROCESS_BUSY');
  owners.add(owner);
  const controller = new AbortController();
  let child,
    channel,
    session,
    exited = false,
    stopping = false,
    spawned = false,
    cause,
    escalation,
    startup,
    deadline,
    memoryPoll,
    peakRssBytes = 0,
    missingMetrics = 0,
    readySeen = false,
    brokerReady = !storageWorker,
    readyDelivered = false,
    escalated = false,
    peerDisconnected = false,
    resolveReady,
    rejectReady,
    resolveClosed;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller may immediately close and await closed only. Keep readiness failure
  // observed internally without changing what awaiting ready reports.
  ready.catch(() => {});
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  function terminate() {
    if (exited || !child?.pid) return;
    const pid = child.pid;
    try {
      // Electron kill() also schedules Chromium termination/reaping. On POSIX
      // send TERM ourselves so our bounded grace interval owns escalation.
      if (process.platform === 'win32') child.kill();
      else process.kill(pid, 'SIGTERM');
    } catch {
      /* Escalation and observed exit remain authoritative. */
    }
    if (exited) return;
    escalation ||= setTimeout(() => {
      if (!exited && child.pid === pid) {
        escalated = true;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Never release a living process slot. */
        }
      }
    }, 250);
  }
  function stop(code = 'RAILGUN_PROCESS_CLOSED') {
    if (exited || stopping) return;
    cause ||= code;
    stopping = true;
    controller.abort();
    if (!readyDelivered) rejectReady(fail(cause));
    if (!broker) session?.close();
    closePorts();
    terminate();
  }
  function closePorts() {
    for (const port of [channel?.port1, channel?.port2]) {
      try {
        port?.close();
      } catch {
        /* A transferred endpoint may already be detached. */
      }
    }
  }
  const aborted = () => stop('PRIVACY_CONTEXT_REVOKED');
  const quit = () => stop('RAILGUN_PROCESS_CLOSED');
  const brokerAborted = () => stop('RAILGUN_SESSION_REVOKED');
  function finish(exitCode = null) {
    if (exited) return;
    exited = true;
    controller.abort();
    cause ||= 'RAILGUN_PROCESS_EXITED';
    if (!broker) session?.close();
    closePorts();
    clearTimeout(escalation);
    clearTimeout(startup);
    clearTimeout(deadline);
    clearInterval(memoryPoll);
    context.signal.removeEventListener('abort', aborted);
    broker?.signal.removeEventListener('abort', brokerAborted);
    app.removeListener('before-quit', quit);
    if (!readyDelivered) rejectReady(fail(cause));
    const release = () => {
      owners.delete(owner);
      resolveClosed(
        Object.freeze({ code: cause, peakRssBytes, exitCode, escalated, peerDisconnected })
      );
    };
    // A stopped engine cannot release a database still owned by its host worker.
    if (!broker && session?.closed) session.closed.then(release);
    else release();
  }
  function sampleMemory() {
    if (!spawned || exited || stopping) return;
    try {
      getPrivacyContext(handle);
      const value = app.getAppMetrics().find((entry) => entry.pid === child.pid)
        ?.memory?.workingSetSize;
      if (!Number.isFinite(value) || value <= 0) {
        if (++missingMetrics >= 20) stop('RAILGUN_PROCESS_MEMORY_UNAVAILABLE');
        return;
      }
      missingMetrics = 0;
      peakRssBytes = Math.max(peakRssBytes, value * 1024);
      if (peakRssBytes > rssMb * 1024 * 1024) {
        stop('RAILGUN_PROCESS_MEMORY_LIMIT');
        return;
      }
      if (readySeen && brokerReady && !readyDelivered) {
        readyDelivered = true;
        clearTimeout(startup);
        resolveReady();
      }
    } catch {
      stop('RAILGUN_PROCESS_MEMORY_UNAVAILABLE');
    }
  }
  try {
    const createSession = storageWorker ? startRailgunSessionWorker : createRailgunSession;
    session = broker
      ? Object.freeze({ dispatch: broker.dispatch.bind(broker), signal: broker.signal })
      : createSession({
          handle,
          storage,
          createProvider,
          onClose: () =>
            stop(context.signal.aborted ? 'PRIVACY_CONTEXT_REVOKED' : 'RAILGUN_SESSION_REVOKED'),
        });
    if (storageWorker)
      session.ready.then(
        () => {
          if (stopping || exited) return;
          brokerReady = true;
          sampleMemory();
        },
        () => stop('RAILGUN_SESSION_REVOKED')
      );
    context.signal.addEventListener('abort', aborted, { once: true });
    broker?.signal.addEventListener('abort', brokerAborted, { once: true });
    app.once('before-quit', quit);
    if (context.signal.aborted || session.signal.aborted || stopping) {
      stop(context.signal.aborted ? 'PRIVACY_CONTEXT_REVOKED' : 'RAILGUN_SESSION_REVOKED');
      finish();
    } else {
      channel = new MessageChannelMain();
      child = utilityProcess.fork(path.join(__dirname, 'railgun-process-entry.js'), [], {
        env: Object.fromEntries(Object.keys(process.env).map((key) => [key, ''])),
        cwd: app.getPath('temp'),
        stdio: 'ignore',
        execArgv: [`--max-old-space-size=${heapMb}`],
        serviceName: 'Freedom Railgun engine',
      });
      child.once('exit', finish);
      child.once('error', () => stop('RAILGUN_PROCESS_FAILED'));
      child.once('spawn', () => {
        spawned = true;
        if (stopping || session.signal.aborted) {
          terminate();
          return;
        }
        try {
          getPrivacyContext(handle);
          child.postMessage(JSON.stringify({ type: 'init', filename, input }), [channel.port2]);
          sampleMemory();
        } catch {
          stop('RAILGUN_PROCESS_FAILED');
        }
      });
      // All commands belong to this single transferred channel. ParentPort is
      // initialization-only and never provides a second authority path.
      child.on('message', () => stop('RAILGUN_PROCESS_FAILED'));
      channel.port1.on('close', () => {
        if (!stopping && !exited) peerDisconnected = true;
        stop('RAILGUN_PROCESS_CHANNEL_CLOSED');
      });
      channel.port1.on('message', ({ data: wire, ports = [] }) => {
        if (stopping || exited) return;
        try {
          getPrivacyContext(handle);
          if (
            !spawned ||
            ports.length ||
            typeof wire !== 'string' ||
            wire.length > 4 * 1024 * 1024 + 128 ||
            Buffer.byteLength(wire) > 4 * 1024 * 1024 + 128
          )
            throw new Error();
          const message = JSON.parse(wire);
          if (
            message?.type === 'failure' &&
            Object.keys(message).length === 2 &&
            ['egress', 'job', 'protocol'].includes(message.reason)
          ) {
            stop(
              message.reason === 'egress'
                ? 'RAILGUN_PROCESS_EGRESS_REFUSED'
                : 'RAILGUN_PROCESS_FAILED'
            );
            return;
          }
          if (message?.type === 'ready' && Object.keys(message).length === 1 && !readySeen) {
            readySeen = true;
            sampleMemory();
            return;
          }
          if (
            message?.type !== 'command' ||
            Object.keys(message).length !== 2 ||
            typeof message.wire !== 'string'
          )
            throw new Error();
          // Do not await, enqueue, or schedule before dispatch. Its arrival order
          // establishes storage ordering and reserves the host request slot.
          session.dispatch(message.wire).then(
            (reply) => {
              if (stopping || exited || session.signal.aborted) return;
              try {
                getPrivacyContext(handle);
                channel.port1.postMessage(JSON.stringify({ type: 'reply', wire: reply }));
              } catch {
                stop('RAILGUN_PROCESS_FAILED');
              }
            },
            () => stop('RAILGUN_SESSION_REVOKED')
          );
        } catch {
          stop('RAILGUN_PROCESS_FAILED');
        }
      });
      channel.port1.start();
      startup = setTimeout(
        () => stop(spawned ? 'RAILGUN_PROCESS_STARTUP_TIMEOUT' : 'RAILGUN_PROCESS_SPAWN_TIMEOUT'),
        startupMs
      );
      deadline = setTimeout(() => stop('RAILGUN_PROCESS_LIFETIME'), lifetimeMs);
      memoryPoll = setInterval(sampleMemory, 250);
    }
  } catch {
    stop('RAILGUN_PROCESS_FAILED');
    if (!child) finish();
  }
  return Object.freeze({
    ready,
    closed,
    close: () => stop(),
    signal: controller.signal,
    getStatus: () =>
      Object.freeze({
        phase: exited ? 'exited' : stopping ? 'stopping' : spawned ? 'running' : 'starting',
        code: cause ?? null,
        peakRssBytes,
      }),
  });
}
module.exports = { startRailgunProcess };
