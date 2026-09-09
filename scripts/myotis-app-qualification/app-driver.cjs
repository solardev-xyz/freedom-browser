// Source-only disposable-Mac driver. Importing this file performs no work.
// The outer DirectOwner/inspector harness owns launch, deadlines and OS exit.
function context({ runId, evidenceDir }) {
  const fs = require('fs');
  const path = require('path');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId || '') || !path.isAbsolute(evidenceDir || '')) {
    throw new Error('Invalid task-owned evidence identity');
  }
  const info = fs.lstatSync(evidenceDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Evidence directory must be a real directory');
  const root = fs.realpathSync(evidenceDir);
  const key = Symbol.for('freedom.myotis.qualification.quit.v1');
  let state = globalThis[key];
  if (!state) state = globalThis[key] = { runId, root, running: false, quitClaimed: false };
  if (state.runId !== runId || state.root !== root) throw new Error('Qualification identity already bound');
  return { fs, path, root, state, runId };
}
function writeNew(ctx, name, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > 16384) throw new Error('Evidence bound exceeded');
  ctx.fs.writeFileSync(ctx.path.join(ctx.root, name), text, { flag: 'wx', mode: 0o600 });
}

// The responsive outer fallback must use this function, never a second direct
// Menu action. Claim and marker precede action; marker failure means no action.
function requestNativeQuit(options) {
  const ctx = context(options);
  if (ctx.state.quitClaimed || ctx.fs.existsSync(ctx.path.join(ctx.root, 'native-quit-request.json'))) {
    return { requested: false, alreadyClaimed: true };
  }
  const { Menu } = require('electron');
  if (process.platform !== 'darwin') throw new Error('Native menu driver requires macOS');
  const reason = options.reason === 'outer-fallback' ? 'outer-fallback' : 'driver-finally';
  ctx.state.quitClaimed = true;
  writeNew(ctx, 'native-quit-request.json', { runId: ctx.runId, requestedAtMs: Date.now(), reason,
    action: 'terminate:', actualOsExitObserved: false });
  Menu.sendActionToFirstResponder('terminate:');
  // This is action-return evidence only. OS exit belongs to the outer observer.
  writeNew(ctx, 'native-quit-returned.json', { runId: ctx.runId, returnedAtMs: Date.now() });
  return { requested: true, actionReturned: true };
}
function safeStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const result = {};
  for (const key of ['running', 'elReaderAvailable', 'elHunting']) {
    if (typeof status[key] === 'boolean') result[key] = status[key];
  }
  for (const key of ['currentPeriod', 'targetPeriod', 'snapPeers', 'peerCount', 'optimisticBlockNumber', 'finalizedBlockNumber']) {
    if (Number.isFinite(status[key])) result[key] = status[key];
  }
  if (/^[A-Z_]{1,32}$/.test(status.beaconState || '')) result.beaconState = status.beaconState;
  if (['disabled', 'unavailable', 'error', 'off', 'ready', 'syncing'].includes(status.state)) result.state = status.state;
  result.hasError = Boolean(status.error);
  return result;
}
function readSummary(value) {
  if (!value || typeof value !== 'object') return { kind: 'unexpected-result' };
  const status = ['ok', 'unavailable', 'revert'].includes(value.status) ? value.status : null;
  const result = { kind: value.error ? 'native-error' : status || 'result-object',
    verifiedFlag: value.verified === true, hasReason: typeof value.reason === 'string' };
  // No raw error/reason, proof, addon log or unbounded account payload.
  for (const key of ['balance', 'nonce', 'codeHash', 'storageRoot']) {
    const field = value[key];
    if (typeof field === 'string' && /^(?:0x[0-9a-fA-F]{0,128}|[0-9]{1,80})$/.test(field)) result[key] = field;
    else if (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) result[key] = field;
  }
  return result;
}
function failureKind(error) {
  if (error?.code === 'DRIVER_DEADLINE') return 'driver-deadline';
  if (error?.code === 'MYOTIS_UNAVAILABLE') return 'myotis-unavailable';
  return 'operation-rejected';
}
function bounded(action, deadlineAtMs) {
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error('Driver deadline'), { code: 'DRIVER_DEADLINE' }));
  let timer;
  return Promise.race([
    Promise.resolve().then(() => {
      if (Date.now() >= deadlineAtMs) throw Object.assign(new Error('Driver deadline'), { code: 'DRIVER_DEADLINE' });
      return action();
    }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Driver deadline'),
      { code: 'DRIVER_DEADLINE' })), remaining); }),
  ]).finally(() => clearTimeout(timer));
}
function captureLifecycle(ctx, app, logger) {
  const fd = ctx.fs.openSync(ctx.path.join(ctx.root, 'lifecycle.jsonl'), 'wx', 0o600);
  const seen = new Set();
  let closed = false;
  const hook = (message) => {
    const line = message?.data?.length === 1 ? message.data[0] : null;
    if (closed || seen.size >= 32 || typeof line !== 'string' || line.length > 2048 ||
      !line.startsWith('[myotis] mainnet lifecycle ')) return message;
    try {
      const raw = JSON.parse(line.slice('[myotis] mainnet lifecycle '.length));
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw.generation || '') ||
        !['start-attempt', 'started', 'startup-failed', 'unavailable', 'stop-requested', 'supervisor-exit'].includes(raw.event)) return message;
      const key = `${raw.generation}:${raw.event}`;
      if (seen.has(key)) return message;
      const event = { runId: ctx.runId, observedAtMs: Date.now(), generation: raw.generation, event: raw.event };
      for (const field of ['code', 'childExitCode', 'childSignal']) {
        if (Number.isInteger(raw[field]) && raw[field] >= -1 && raw[field] <= 0xffffffff) event[field] = raw[field];
      }
      for (const [field, allowed] of Object.entries({
        failure: ['configuration', 'load', 'abi', 'create', 'start', 'unknown'],
        classification: ['verified', 'unconfirmed'], receipt: ['invalid', 'reaped', 'missing'],
      })) {
        if (allowed.includes(raw[field])) event[field] = raw[field];
      }
      if (typeof raw.forced === 'boolean') event.forced = raw.forced;
      if (/^SIG[A-Z0-9]{1,12}$/.test(raw.signal || '')) event.signal = raw.signal;
      ctx.fs.writeSync(fd, JSON.stringify(event) + '\n');
      seen.add(key); // electron-log invokes hooks per transport; capture once.
    } catch { ctx.state.lifecycleCaptureFailed = true; }
    return message; // Never change application logging.
  };
  if (!Array.isArray(logger.hooks)) { ctx.fs.closeSync(fd); throw new Error('Logger hooks unavailable'); }
  logger.hooks.push(hook);
  // Keep observing the product shutdown after run() requests Quit.
  app.once('will-quit', () => {
    closed = true;
    const index = logger.hooks.indexOf(hook);
    if (index >= 0) logger.hooks.splice(index, 1);
    ctx.fs.closeSync(fd);
  });
}

async function run(options) {
  const ctx = context(options);
  if (ctx.state.running || ctx.state.quitClaimed) throw new Error('Driver already invoked or Quit claimed');
  ctx.state.running = true;
  const enteredAtMs = Date.now();
  const supplied = options.deadlineAtMs;
  const deadlineAtMs = Number.isFinite(supplied) ? Math.min(supplied, enteredAtMs + 45000) : enteredAtMs + 45000;
  const result = { runId: ctx.runId, enteredAtMs, deadlineAtMs,
    timingScope: Number.isFinite(supplied) ? 'outer-launch-deadline' : 'driver-entry-only',
    startAttempted: false, readAttempted: false, actualOsExitObserved: false,
    knownColdSyncBlocker: 'Myotis v0.1.7 issue #200; verified reads are not promised',
    addonAbi: 'not-directly-observed-by-driver' };
  let progressFd;
  let manager;
  const progress = (phase) => {
    if (phase !== 'quit-request' && ctx.state.quitClaimed) throw new Error('Quit already claimed');
    result.phase = phase;
    const value = JSON.stringify({ runId: ctx.runId, phase, atMs: Date.now(), elapsedSinceEntryMs: Date.now() - enteredAtMs }) + '\n';
    ctx.fs.ftruncateSync(progressFd, 0);
    ctx.fs.writeSync(progressFd, value, 0, 'utf8');
  };
  try {
    progressFd = ctx.fs.openSync(ctx.path.join(ctx.root, 'driver-progress.json'), 'wx', 0o600);
    progress('setup');
    const { app } = require('electron');
    if (process.platform !== 'darwin') throw new Error('Native menu driver requires macOS');
    const base = ctx.path.join(app.getAppPath(), 'src/main');
    manager = require(ctx.path.join(base, 'myotis/myotis-manager.js'));
    captureLifecycle(ctx, app, require(ctx.path.join(base, 'logger.js')));
    result.beforeStart = safeStatus(manager.publicStatus(1));
    progress('start');
    result.started = await bounded(() => {
      if (ctx.state.quitClaimed) throw new Error('Quit already claimed');
      result.startAttempted = true;
      return manager.startMyotis({ chainId: 1 });
    }, deadlineAtMs);
    progress('cached-status');
    result.statusSamples = [];
    for (let index = 0; index < 4; index++) {
      result.statusSamples.push({ atMs: Date.now(), status: safeStatus(manager.getStatus(1)),
        publicStatus: safeStatus(manager.publicStatus(1)) });
      if (index < 3) await bounded(() => new Promise((resolve) => setTimeout(resolve, 500)), deadlineAtMs);
    }
    progress('read');
    try {
      const value = await bounded(() => {
        if (ctx.state.quitClaimed) throw new Error('Quit already claimed');
        result.readAttempted = true;
        return manager.getAccount('0x0000000000000000000000000000000000000000', 1);
      }, deadlineAtMs);
      result.read = readSummary(value);
    } catch (error) { result.read = { kind: failureKind(error) }; }
    result.phaseCompleted = true;
  } catch (error) {
    result.phaseCompleted = false;
    result.failurePhase = result.phase;
    result.failure = failureKind(error);
  } finally {
    result.finishedAtMs = Date.now();
    result.elapsedSinceEntryMs = result.finishedAtMs - enteredAtMs;
    result.lifecycleCaptureFailed = ctx.state.lifecycleCaptureFailed === true;
    if (manager) {
      try { result.beforeQuit = safeStatus(manager.publicStatus(1)); } catch { result.beforeQuit = null; }
    }
    try {
      if (progressFd !== undefined) { progress('quit-request'); ctx.fs.closeSync(progressFd); }
      writeNew(ctx, 'driver-result.json', result);
    } finally {
      requestNativeQuit({ runId: ctx.runId, evidenceDir: ctx.root, reason: 'driver-finally' });
    }
  }
  return result;
}
module.exports = { run, requestNativeQuit };
