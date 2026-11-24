'use strict';

const { spawn } = require('child_process');
const { TextDecoder } = require('util');
const { notifyOutput } = require('./process-io');

const SUPERVISOR_PROTOCOL = 1;
const STATUS_RECORD_BYTES = 1024;
const STATUS_TOTAL_BYTES = 2048;
const STATUS_DRAIN_MS = 500;
const OUTPUT_DRAIN_MS = 250;
const OUTPUT_DRAIN_LIMIT_MS = 2000;
const CANCELLATION_RECEIPT_MS = 3000;
const NATIVE_DEADLINE_SLACK_MS = 3000;
const STARTUP_TIMEOUT_MS = 5000;
const FINAL_KEYS = [
  'v', 'type', 'reason', 'spawned', 'releaseIssued', 'rootExitObserved', 'rootReaped',
  'groupVerified', 'cleanupUncertain', 'exitCode', 'signal', 'finalKillAttempted',
  'signalErrors', 'setupError',
];
const FINAL_REASONS = new Set([
  'completed', 'cancelled', 'timed_out', 'setup_failed', 'supervisor_failed',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nullableInteger(value, minimum, maximum) {
  return value === null || (Number.isInteger(value) && value >= minimum && value <= maximum);
}

function validFinal(value, ready) {
  if (!exactKeys(value, FINAL_KEYS) || value.v !== SUPERVISOR_PROTOCOL ||
      value.type !== 'final' || !FINAL_REASONS.has(value.reason)) return false;
  for (const key of ['spawned', 'releaseIssued', 'rootExitObserved', 'rootReaped',
    'groupVerified', 'cleanupUncertain', 'finalKillAttempted']) {
    if (typeof value[key] !== 'boolean') return false;
  }
  if (!nullableInteger(value.exitCode, 0, 255) || !nullableInteger(value.signal, 1, 64) ||
      !nullableInteger(value.setupError, 1, 4096)) return false;
  if (!Array.isArray(value.signalErrors) || value.signalErrors.length > 2 ||
      value.signalErrors.some((error) => !exactKeys(error, ['phase', 'errno']) ||
        !['term', 'kill'].includes(error.phase) ||
        !Number.isInteger(error.errno) || error.errno < 1 || error.errno > 4096)) return false;
  if (new Set(value.signalErrors.map((error) => error.phase)).size !== value.signalErrors.length) return false;
  if (value.releaseIssued && (!ready || !value.spawned || !value.groupVerified)) return false;
  if (value.rootReaped && !value.rootExitObserved) return false;
  if (value.exitCode !== null && value.signal !== null) return false;
  if (value.rootExitObserved !== ((value.exitCode !== null) !== (value.signal !== null))) return false;
  if (!value.spawned && (value.rootExitObserved || value.rootReaped || value.groupVerified ||
      value.finalKillAttempted || value.signalErrors.length > 0)) return false;
  if (value.spawned && (!value.rootReaped || value.signalErrors.length > 0) && !value.cleanupUncertain) return false;
  if (value.reason === 'completed' && (!value.releaseIssued || !value.rootExitObserved)) return false;
  if (value.reason === 'setup_failed' && value.releaseIssued) return false;
  return true;
}

// Dedicated trusted stream only. Command output is never passed to this parser.
class SupervisorStatusParser {
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.pending = Buffer.alloc(0);
    this.bytes = 0;
    this.records = 0;
    this.ready = false;
    this.final = null;
    this.ended = false;
  }

  write(chunk) {
    if (this.ended) throw new Error('Supervisor status arrived after EOF');
    const bytes = Buffer.from(chunk);
    this.bytes += bytes.length;
    if (this.bytes > STATUS_TOTAL_BYTES) throw new Error('Supervisor status exceeded its byte limit');
    this.pending = Buffer.concat([this.pending, bytes]);
    let newline;
    while ((newline = this.pending.indexOf(10)) >= 0) {
      if (newline + 1 > STATUS_RECORD_BYTES || ++this.records > 2) throw new Error('Invalid supervisor status framing');
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (!this.ready && !this.final && exactKeys(record, ['v', 'type']) &&
          record.v === SUPERVISOR_PROTOCOL && record.type === 'ready') {
        this.ready = true;
      } else if (!this.final && validFinal(record, this.ready)) {
        this.final = Object.freeze({ ...record, signalErrors: Object.freeze(
          record.signalErrors.map((error) => Object.freeze({ ...error }))
        ) });
      } else {
        throw new Error('Invalid supervisor lifecycle transition');
      }
      this.onRecord?.(record);
    }
    if (this.pending.length >= STATUS_RECORD_BYTES) throw new Error('Supervisor status record exceeded its byte limit');
  }

  end() {
    this.ended = true;
    if (this.pending.length || !this.final) throw new Error('Incomplete supervisor status');
  }
}

function captureOutput(stream, limit, callback) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  let ended = false;
  let failed = false;
  stream.on('data', (value) => {
    const chunk = Buffer.from(value);
    callback(chunk);
    const available = Math.max(0, limit - bytes);
    if (available) {
      const accepted = chunk.subarray(0, available);
      chunks.push(accepted);
      bytes += accepted.length;
    }
    if (chunk.length > available) truncated = true;
  });
  stream.once('end', () => { ended = true; });
  stream.on('error', () => { failed = true; });
  return {
    get ended() { return ended; },
    result() {
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: truncated || !ended || failed };
    },
    stop() { stream.destroy(); },
  };
}

function runMacosSupervisor(options) {
  const spawnProcess = options.spawnProcess || spawn;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const request = options.request;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(options.executablePath, [
        '--supervise', String(options.timeoutMs), options.profilePath, '--',
        request.command, ...request.args,
      ], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ spawned: false, final: null, releaseIssued: false,
        stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        diagnostics: { supervisorLaunchFailed: true } });
      return;
    }
    const timers = new Map();
    let settled = false;
    let drainingOutput = false;
    let stdinActive = true;
    let releaseIssued = false;
    let cancelled = null;
    let exited = false;
    let statusEnded = false;
    let protocolFailed = false;
    let launched = Boolean(child.pid);
    const diagnostics = {};
    const control = child.stdio[3];
    const status = child.stdio[4];
    const stdout = captureOutput(child.stdout, options.stdoutBytes, (chunk) => {
      outputProgress();
      notifyOutput(request.onOutput, 'stdout', chunk);
    });
    const stderr = captureOutput(child.stderr, options.stderrBytes, (chunk) => {
      outputProgress();
      notifyOutput(request.onOutput, 'stderr', chunk);
    });
    const clear = (name) => {
      if (timers.has(name)) clearTimer(timers.get(name));
      timers.delete(name);
    };
    const arm = (name, milliseconds, callback) => {
      if (settled || timers.has(name)) return;
      timers.set(name, setTimer(() => { timers.delete(name); callback(); }, milliseconds));
    };
    const closeControl = () => {
      try { control.end(); } catch { control.destroy(); }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      stdinActive = false;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      request.signal?.removeEventListener('abort', onAbort);
      const out = stdout.result();
      const err = stderr.result();
      stdout.stop();
      stderr.stop();
      child.stdin.destroy();
      control.destroy();
      status.destroy();
      if (!exited) child.unref?.();
      resolve({
        spawned: launched,
        final: !protocolFailed && statusEnded ? parser.final : null,
        releaseIssued,
        requestedState: cancelled,
        stdout: out.text, stderr: err.text,
        stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
        diagnostics: Object.freeze({ ...diagnostics }),
      });
    };
    const outputExpired = () => {
      diagnostics.supervisorOutputDrainExpired = true;
      finish();
    };
    const outputProgress = () => {
      if (!drainingOutput || settled) return;
      clear('output');
      arm('output', OUTPUT_DRAIN_MS, outputExpired);
    };
    const drainOutput = () => {
      if (settled || drainingOutput) return;
      drainingOutput = true;
      stdinActive = false;
      clear('wall'); clear('startup'); clear('receipt'); clear('evidence');
      closeControl();
      if (stdout.ended && stderr.ended) finish();
      else {
        outputProgress();
        // Progress may extend the idle drain, but an escaped output holder
        // cannot extend it indefinitely.
        arm('outputLimit', OUTPUT_DRAIN_LIMIT_MS, outputExpired);
      }
    };
    const maybeComplete = () => {
      if (drainingOutput) {
        if (stdout.ended && stderr.ended) finish();
      } else if (exited && statusEnded) drainOutput();
    };
    const drainEvidence = () => {
      stdinActive = false;
      closeControl();
      clear('wall'); clear('startup');
      arm('evidence', STATUS_DRAIN_MS, () => {
        if (!exited) diagnostics.supervisorExitUnconfirmed = true;
        if (!statusEnded) diagnostics.supervisorStatusDrainExpired = true;
        drainOutput();
      });
      maybeComplete();
    };
    const cancel = (reason) => {
      if (settled || drainingOutput || parser.final || cancelled) return;
      cancelled = reason;
      stdinActive = false;
      clear('wall'); clear('startup');
      try { control.write('A'); } catch { diagnostics.supervisorControlFailed = true; }
      closeControl();
      arm('receipt', CANCELLATION_RECEIPT_MS, () => {
        diagnostics.supervisorReceiptDeadlineExpired = true;
        if (!exited) diagnostics.supervisorExitUnconfirmed = true;
        drainOutput();
      });
    };
    const failProtocol = () => {
      protocolFailed = true;
      diagnostics.supervisorProtocolFailed = true;
      // A corrupt FINAL must not suppress cancellation of an execution still running.
      parser.final = null;
      cancel('failed');
      if (exited) drainEvidence();
    };
    const parser = new SupervisorStatusParser((record) => {
      if (record.type === 'ready') {
        clear('startup');
        if (!cancelled && !exited && !request.signal?.aborted) {
          releaseIssued = true;
          try { control.write('G'); } catch { failProtocol(); }
        }
      } else {
        if (record.releaseIssued && !releaseIssued) {
          failProtocol();
          return;
        }
        drainEvidence();
      }
    });
    const onAbort = () => cancel('cancelled');
    child.stdin.on('error', () => { stdinActive = false; });
    control.on('error', () => {
      if (settled || parser.final) return;
      diagnostics.supervisorControlFailed = true;
      cancel('failed');
    });
    status.on('data', (chunk) => {
      if (settled || protocolFailed) return;
      try { parser.write(chunk); } catch { failProtocol(); }
    });
    status.once('end', () => {
      statusEnded = true;
      if (!protocolFailed) {
        try { parser.end(); } catch { failProtocol(); }
      }
      drainEvidence();
    });
    status.on('error', () => { if (!settled) failProtocol(); });
    child.once('spawn', () => { launched = true; });
    child.once('error', () => {
      if (settled) return;
      if (!launched) {
        diagnostics.supervisorLaunchFailed = true;
        exited = true;
        statusEnded = true;
        drainOutput();
      } else failProtocol();
    });
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 || signal) diagnostics.supervisorExitedAbnormally = true;
      drainEvidence();
    });
    child.stdout.on('end', maybeComplete);
    child.stderr.on('end', maybeComplete);
    // Native continuous-clock deadlines own termination. These later timers
    // are transport backstops, allowing native failure evidence to arrive.
    arm('wall', options.timeoutMs + NATIVE_DEADLINE_SLACK_MS, () => cancel('timed_out'));
    arm('startup', Math.min(STARTUP_TIMEOUT_MS, options.timeoutMs) + NATIVE_DEADLINE_SLACK_MS, () => {
      diagnostics.supervisorStartupExpired = true;
      cancel('failed');
    });
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    if (typeof request.onStdin === 'function') {
      try {
        request.onStdin(Object.freeze({
          write(value) {
            if (!stdinActive || child.stdin.destroyed) return false;
            try { child.stdin.write(value); return true; } catch { return false; }
          },
        }));
      } catch { /* Observation cannot affect execution ownership. */ }
    }
  });
}

module.exports = {
  SUPERVISOR_PROTOCOL, STATUS_RECORD_BYTES, STATUS_TOTAL_BYTES, STATUS_DRAIN_MS,
  OUTPUT_DRAIN_MS, OUTPUT_DRAIN_LIMIT_MS, CANCELLATION_RECEIPT_MS, STARTUP_TIMEOUT_MS,
  NATIVE_DEADLINE_SLACK_MS,
  SupervisorStatusParser, runMacosSupervisor,
};
