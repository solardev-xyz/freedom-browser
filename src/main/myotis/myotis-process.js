// Main requires a native terminal receipt and supervisor OS exit for data reuse.
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const MAX_ACTIVE = 2;
const MAX_QUEUED = 16;
const REQUEST_MS = 10000;
const START_MS = 15000;
const STOP_GRACE_MS = 1500;
const EXIT_WAIT_MS = 5000;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function childEnvironment() {
  // Do not inherit NODE_OPTIONS, wallet/provider credentials, model tokens, or
  // shell configuration. The executable and profile data path are absolute.
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function supervisorPath() {
  const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const binary = `myotis-supervisor${process.platform === 'win32' ? '.exe' : ''}`;
  return (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'myotis-node', binary)))
    ? path.join(process.resourcesPath, 'myotis-node', binary)
    : path.join(__dirname, '../../..', 'myotis-bin', `${os}-${process.arch}`, binary);
}

function statusSnapshot(status) {
  const snapshot = {};
  for (const key of ['beaconState', 'currentPeriod', 'targetPeriod', 'peerCount', 'snapPeers',
    'finalizedBlockNumber', 'elReaderAvailable', 'elHunting']) {
    const value = status?.[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 64)) snapshot[key] = value;
  }
  if (typeof status?.optimisticBlockNumber === 'number' && Number.isFinite(status.optimisticBlockNumber)) {
    snapshot.optimisticBlockNumber = status.optimisticBlockNumber;
  }
  return snapshot;
}

function unavailable(message, uncertain = false) {
  const error = new Error(uncertain
    ? 'Myotis broadcast outcome uncertain; check the signed transaction hash before retrying'
    : message);
  error.code = uncertain ? 'MYOTIS_BROADCAST_UNCERTAIN' : 'MYOTIS_UNAVAILABLE';
  return error;
}

class MyotisProcess {
  constructor({ addonPath, network, dataDir, onStatus, onUnavailable, onExit, onLifecycle = () => {} }) {
    this.generation = randomUUID();
    this.onLifecycle = onLifecycle;
    this.lifecycleEvents = new Set();
    this.report('start-attempt');
    this.nextId = 0;
    this.active = new Map();
    this.queue = [];
    this.accepting = false;
    this.exited = false;
    this.stopping = false;
    this.onStatus = onStatus;
    this.onUnavailable = onUnavailable;
    this.onExit = onExit;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.startPromise = new Promise((resolve) => { this.resolveStart = resolve; });
    const helper = supervisorPath();
    fs.accessSync(helper, fs.constants.X_OK);
    fs.mkdirSync(dataDir, { recursive: true });
    this.receiptBuffer = '';
    this.child = fork(path.join(__dirname, 'myotis-child.js'), [this.generation, dataDir], {
      execPath: helper,
      env: childEnvironment(),
      execArgv: [process.execPath],
      stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
      serialization: 'json',
    });
    this.child.on('message', (message) => this.receive(message));
    this.child.once('exit', (code, signal) => {
      this.supervisorExit = { code, signal };
      this.finishExit();
    });
    this.child.stdout.on('data', (chunk) => {
      if (this.receiptInvalid) return;
      this.receiptBuffer += chunk.toString('utf8');
      if (this.receiptBuffer.length > 1024) { this.invalidReceipt(); return; }
      let end;
      while ((end = this.receiptBuffer.indexOf('\n')) >= 0) {
        const line = this.receiptBuffer.slice(0, end);
        this.receiptBuffer = this.receiptBuffer.slice(end + 1);
        let receipt;
        try { receipt = JSON.parse(line); } catch { this.invalidReceipt(); return; }
        if (receipt.generation !== this.generation) { this.invalidReceipt(); return; }
        if (receipt.type === 'owned' && !this.owned) {
          this.owned = true;
          if (!this.stopping) this.send({ type: 'start', addonPath, network, dataDir });
        } else if (receipt.type === 'reaped' && this.owned && !this.terminalReceipt &&
          typeof receipt.forced === 'boolean' &&
          Number.isInteger(receipt.exitCode) && receipt.exitCode >= -1 && receipt.exitCode <= 0xffffffff &&
          Number.isInteger(receipt.signal) && receipt.signal >= 0 && receipt.signal <= 128) {
          this.terminalReceipt = receipt;
        } else { this.invalidReceipt(); return; }
      }
      this.finishExit();
    });
    this.child.stdout.on('error', () => this.invalidReceipt());
    this.child.stdout.once('end', () => { this.receiptsEnded = true; this.finishExit(); });
    this.child.stdin.on('error', () => this.fail('Myotis supervisor control failed'));
    this.child.on('error', () => this.fail('Myotis supervisor failed'));
    this.child.on('disconnect', () => {
      if (!this.exited && !this.stopping) this.fail('Myotis child disconnected');
    });
    this.startTimer = setTimeout(() => this.fail('Myotis startup timed out'), START_MS);

  }

  // At most one of each fixed lifecycle event per generation. Never pass raw
  // addon exceptions, paths, request arguments or engine diagnostics here.
  report(event, fields = {}) {
    if (this.lifecycleEvents.has(event)) return;
    this.lifecycleEvents.add(event);
    this.onLifecycle({ generation: this.generation, event, ...fields });
  }

  invalidReceipt() {
    this.receiptInvalid = true;
    this.receiptBuffer = '';
    this.fail('Invalid Myotis supervisor receipt');
  }

  send(message) {
    if (this.exited) return;
    try {
      this.child.send({ ...message, generation: this.generation }, (error) => {
        if (error && !this.exited && !this.stopping) this.fail('Myotis child transport failed');
      });
    } catch {
      if (!this.stopping) this.fail('Myotis child transport failed');
    }
  }

  receive(message) {
    if (this.exited || !message || message.generation !== this.generation) return;
    if (message.type === 'started' && !this.stopping) {
      clearTimeout(this.startTimer);
      if (!message.ok) {
        const failure = ['configuration', 'load', 'abi', 'create', 'start'].includes(message.failure)
          ? message.failure : 'unknown';
        this.report('startup-failed', { failure });
        this.fail('Myotis native startup failed (check addon ABI and installation)');
        return;
      }
      this.report('started');
      this.accepting = true;
      this.resolveStart(true);
      return;
    }
    if (message.type !== 'reply') return;
    const request = this.active.get(message.id);
    if (!request || request.op !== message.op) return;
    // A native completion (including a late one) can release its own slot.
    this.active.delete(request.id);
    clearTimeout(request.timer);
    if (!this.stopping) {
      if (message.ok && JSON.stringify(message.result ?? null).length <= MAX_MESSAGE_BYTES) {
        if (request.op === 'status') this.onStatus(statusSnapshot(message.result));
        request.resolve(message.result);
      } else {
        request.reject(unavailable('Myotis native operation failed', request.op === 'broadcast'));
      }
      this.pump();
    }
  }

  request(op, args = [], timeoutMs = REQUEST_MS) {
    if (!this.accepting || this.stopping) return Promise.reject(unavailable('Myotis is unavailable'));
    if (JSON.stringify(args).length > MAX_MESSAGE_BYTES) {
      return Promise.reject(unavailable('Myotis request exceeds size limit'));
    }
    // Status is one bounded control request, independent of the read queue.
    const control = op === 'status';
    if (control && [...this.active.values()].some((entry) => entry.op === 'status')) {
      return Promise.reject(unavailable('Myotis status already pending'));
    }
    if (!control && this.queue.length >= MAX_QUEUED) {
      return Promise.reject(unavailable('Myotis request queue is full'));
    }
    return new Promise((resolve, reject) => {
      const request = { op, args, resolve, reject };
      request.timer = setTimeout(() => {
        const index = this.queue.indexOf(request);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(unavailable('Myotis queue deadline exceeded'));
          return;
        }
        // Timeout is NOT completion. Retain active permits and stop the child;
        // no more native work is admitted until a new generation after exit.
        this.fail('Myotis request timed out');
      }, timeoutMs);
      if (control) this.dispatch(request);
      else {
        this.queue.push(request);
        this.pump();
      }
    });
  }

  pump() {
    while (this.accepting && !this.stopping && this.queue.length &&
      [...this.active.values()].filter((entry) => entry.op !== 'status').length < MAX_ACTIVE) {
      this.dispatch(this.queue.shift());
    }
  }

  dispatch(request) {
    request.id = ++this.nextId;
    this.active.set(request.id, request);
    this.send({ type: 'request', id: request.id, op: request.op, args: request.args });
  }

  fail(message) {
    if (this.exited || this.stopping) return;
    this.report('unavailable', { reason: message });
    this.onUnavailable(message);
    this.stop();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.exited) return Promise.resolve(true);
    this.report('stop-requested');
    this.stopping = true;
    this.accepting = false;
    clearTimeout(this.startTimer);
    this.resolveStart(false);
    for (const request of [...this.queue, ...this.active.values()]) {
      clearTimeout(request.timer);
      request.reject(unavailable('Myotis stopped',
        request.op === 'broadcast' && this.active.has(request.id)));
    }
    this.queue.length = 0;
    this.send({ type: 'stop' });
    this.killTimer = setTimeout(() => {
      // EOF revokes the native supervisor's control lease. Only native code
      // owns the unreaped child and may signal it; JS never signals a PID.
      if (!this.exited) this.child.stdin.end();
    }, STOP_GRACE_MS);
    this.stopPromise = new Promise((resolve) => {
      this.exitWaitTimer = setTimeout(() => resolve(false), EXIT_WAIT_MS);
      this.exitPromise.then(() => {
        clearTimeout(this.exitWaitTimer);
        resolve(true);
      });
    });
    return this.stopPromise;
  }

  finishExit() {
    if (!this.supervisorExit || !this.receiptsEnded) return;
    const verified = !this.receiptInvalid && this.terminalReceipt &&
      this.supervisorExit.code === 0 && !this.supervisorExit.signal;
    this.report('supervisor-exit', {
      classification: verified ? 'verified' : 'unconfirmed',
      code: Number.isInteger(this.supervisorExit.code) ? this.supervisorExit.code : null,
      signal: /^SIG[A-Z0-9]{1,12}$/.test(this.supervisorExit.signal) ? this.supervisorExit.signal : null,
      receipt: this.receiptInvalid ? 'invalid' : this.terminalReceipt ? 'reaped' : 'missing',
      childExitCode: this.terminalReceipt?.exitCode ?? null,
      childSignal: this.terminalReceipt?.signal ?? null,
      forced: this.terminalReceipt?.forced ?? null,
    });
    if (verified) {
      this.didExit();
    } else {
      this.fail('Myotis supervisor exit unconfirmed; data directory quarantined');
    }
  }

  didExit() {
    if (this.exited) return;
    if (!this.stopping) this.onUnavailable('Myotis child exited unexpectedly');
    this.exited = true;
    this.accepting = false;
    clearTimeout(this.startTimer);
    clearTimeout(this.killTimer);
    this.resolveStart(false);
    for (const request of [...this.queue, ...this.active.values()]) {
      clearTimeout(request.timer);
      request.reject(unavailable('Myotis child exited',
        request.op === 'broadcast' && this.active.has(request.id)));
    }
    this.queue.length = 0;
    this.active.clear();
    this.resolveExit(true);
    this.onExit();
  }
}

module.exports = { MyotisProcess, childEnvironment, supervisorPath };
