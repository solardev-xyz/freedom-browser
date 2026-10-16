'use strict';

const { spawn } = require('node:child_process');
const { notifyOutput } = require('./process-io');

// Only the trusted helper writes these frames; stdout/stderr from the workload
// arrive as base64 data, never as lifecycle/control instructions.
function runWindowsSandbox(runtime, payload, options = {}) {
  return new Promise(resolve => {
    const start = options.spawn || spawn;
    const output = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let pending = '';
    let ready = false;
    let terminal = null;
    let cancellation = null;
    let failure = null;
    let settled = false;
    let killTimer;
    let child;
    const send = frame => {
      if (!child?.stdin?.writable || child.stdin.destroyed) return false;
      try { child.stdin.write(`${JSON.stringify(frame)}\n`); return true; } catch { return false; }
    };
    const stop = reason => {
      if (cancellation || settled) return;
      cancellation = reason;
      send({ type: 'cancel' });
      killTimer = setTimeout(() => child?.kill(), 6000);
      killTimer.unref?.();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed_out'), options.timeoutMs || 15000);
    timer.unref?.();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ ready, terminal, cancellation, failure,
        stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'),
        stdoutTruncated: truncated.stdout, stderrTruncated: truncated.stderr });
    };
    const accept = frame => {
      if (frame.type === 'stdout' || frame.type === 'stderr') {
        if (!ready || terminal || typeof frame.data !== 'string') throw new Error('Unexpected workload output');
        const stream = frame.type;
        const bytes = Buffer.from(frame.data, 'base64');
        const maximum = options[`${stream}Bytes`] ?? 1024 * 1024;
        const kept = bytes.subarray(0, Math.max(0, maximum - lengths[stream]));
        if (kept.length) { output[stream].push(kept); lengths[stream] += kept.length; notifyOutput(options.onOutput, stream, kept); }
        if (kept.length < bytes.length) truncated[stream] = true;
      } else if (frame.type === 'ready' && !ready && !terminal) {
        ready = true;
        try { options.onStdin?.({ write(value) {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
          if (bytes.length > 128 * 1024) return false;
          return send({ type: 'stdin', data: bytes.toString('base64') });
        } }); } catch { /* Observers cannot change execution. */ }
      } else if (['exit', 'error', 'capabilities', 'setup'].includes(frame.type) && !terminal) {
        terminal = frame;
      } else throw new Error('Unexpected sandbox protocol frame');
    };
    try {
      child = start(runtime.executablePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: options.environment || process.env });
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        if (failure) return;
        pending += chunk.toString('utf8');
        try {
          if (pending.length > 2 * 1024 * 1024) throw new Error('Oversized sandbox protocol frame');
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            accept(JSON.parse(line));
          }
        } catch {
          failure = 'The Windows sandbox helper returned an invalid control frame';
          stop('failed');
        }
      });
      // Helper diagnostics can contain local paths; never expose raw stderr as
      // if it came from the workload or as an actionable model instruction.
      child.stderr.resume();
      child.on('error', () => { failure = 'The Windows sandbox helper could not be started'; finish(); });
      child.on('close', () => {
        if (!terminal && !failure) failure = 'The Windows sandbox helper stopped without a result';
        finish();
      });
      send(payload);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    } catch {
      failure = 'The Windows sandbox helper could not be started';
      finish();
    }
  });
}

module.exports = { runWindowsSandbox };
