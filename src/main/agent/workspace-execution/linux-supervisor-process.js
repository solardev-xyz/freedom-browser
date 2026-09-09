'use strict';

const { spawn } = require('child_process');
const { resolveLinuxSupervisor } = require('./linux-supervisor-runtime');
const { notifyStdin, notifyOutput } = require('./process-io');
const MAX_STATUS = 4096;
const TRANSPORT_MS = 500;
const REASONS = new Set(['completed', 'cancelled', 'control_eof', 'timed_out', 'setup_failed',
  'unavailable', 'protocol_error', 'exec_failed', 'supervisor_failed']);
const FLAGS = ['created', 'armed', 'released', 'execAttempted', 'observed', 'retired', 'reaped',
  'uncertain', 'monitorObserved'];
const STAGES = new Set(['channels', 'executable', 'internal_channels', 'parent_pidfd',
  'unprivileged_identity', 'user_namespace', 'uid_map', 'setgroups', 'gid_map', 'browser_parent', 'lifetime_clone', 'lifetime']);
function validateFinal(record, buildId, ready) {
  const keys = ['type', 'protocol', 'buildId', 'reason', 'stage', ...FLAGS, 'initCode', 'initSignal',
    'monitorCode', 'monitorSignal', 'error'].sort();
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys) ||
      record.type !== 'FINAL' || record.protocol !== 1 || record.buildId !== buildId ||
      !REASONS.has(record.reason) || !STAGES.has(record.stage) || FLAGS.some((key) => typeof record[key] !== 'boolean') ||
      ['initCode', 'monitorCode'].some((key) => !Number.isInteger(record[key]) || record[key] < -1 || record[key] > 255) ||
      ['initSignal', 'monitorSignal'].some((key) => !Number.isInteger(record[key]) || record[key] < 0 || record[key] > 64) ||
      !Number.isInteger(record.error) || record.error < 0 || record.error > 4095 ||
      (record.released && (!ready || !record.armed)) || (record.reaped && (!record.observed || !record.retired)) ||
      (record.armed && !record.created) || (record.observed && !record.created) ||
      (record.execAttempted && !record.released) ||
      (record.monitorObserved && !record.armed) ||
      (!record.created && (record.retired || record.monitorObserved)) ||
      (record.observed ? (record.initCode >= 0) === (record.initSignal > 0)
        : record.initCode !== -1 || record.initSignal !== 0) ||
      (record.monitorObserved ? (record.monitorCode >= 0) === (record.monitorSignal > 0)
        : record.monitorCode !== -1 || record.monitorSignal !== 0) ||
      (record.reason === 'completed' && (!record.released || !record.monitorObserved ||
        !record.reaped || record.uncertain || record.initCode !== 0 || record.error !== 0)))
    throw new Error('LINUX_OWNER_PROTOCOL');
  return Object.freeze(record);
}
function parser(buildId, onReady) {
  let pending = '', bytes = 0, ready = false, final = null;
  return {
    feed(chunk) {
      bytes += chunk.length;
      if (bytes > MAX_STATUS || final) throw new Error('LINUX_OWNER_PROTOCOL');
      pending += chunk.toString('utf8');
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n');
        if (index > 2048 || final) throw new Error('LINUX_OWNER_PROTOCOL');
        const record = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
        if (record.type === 'READY') {
          if (ready || JSON.stringify(Object.keys(record).sort()) !== '["protocol","type"]' || record.protocol !== 1)
            throw new Error('LINUX_OWNER_PROTOCOL');
          ready = true; onReady();
        } else final = validateFinal(record, buildId, ready);
      }
    },
    end() { if (pending || !final) throw new Error('LINUX_OWNER_PROTOCOL'); return final; },
  };
}
function cleanupProven(final) {
  return !!final && final.created && final.observed && final.retired && final.reaped && !final.uncertain;
}
async function runLinuxOwner(binary, args, options = {}) {
  if (binary !== '/usr/bin/bwrap') throw new Error('LINUX_OWNER_REQUIRES_SYSTEM_BWRAP');
  const runtime = options.runtime || await (options.resolveRuntime || resolveLinuxSupervisor)();
  const timeoutMs = options.timeoutMs || 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) {
    await runtime.close(); throw new Error('LINUX_OWNER_INVALID_TIMEOUT');
  }
  return new Promise((resolve) => {
    let child, done = false, transport = null, timer = null, cancellationTimer = null, final = null;
    let error = null, requested = false, notSpawned = false, ownerExit = null, outEnd = false, errEnd = false, statusEnd = false;
    const outputs = { stdout: { chunks: [], bytes: 0, truncated: false }, stderr: { chunks: [], bytes: 0, truncated: false } };
    function abort() {
      if (done) return;
      requested = true;
      if (child?.stdio?.[3] && !child.stdio[3].destroyed && !child.stdio[3].writableEnded) {
        try { child.stdio[3].end('A'); } catch { error ||= 'LINUX_OWNER_CONTROL_FAILED'; }
      }
      if (child && !cancellationTimer) cancellationTimer = setTimeout(() => {
        error ||= 'LINUX_OWNER_CANCELLATION_UNCONFIRMED'; finish();
      }, 2000 + TRANSPORT_MS);
    }
    function finish() {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(transport); clearTimeout(cancellationTimer);
      options.signal?.removeEventListener('abort', abort);
      // Closing control requests native-owned cleanup. Never kill a ChildProcess.
      child?.stdio?.[3]?.destroy();
      for (const stream of [child?.stdout, child?.stderr, child?.stdio?.[4], child?.stdin]) stream?.destroy();
      const text = (key) => Buffer.concat(outputs[key].chunks).toString('utf8');
      resolve({ code: final?.monitorObserved ? final.monitorCode : null,
        signal: final?.monitorSignal || null, stdout: text('stdout'), stderr: text('stderr'),
        stdoutTruncated: outputs.stdout.truncated, stderrTruncated: outputs.stderr.truncated,
        final, ownerExit, requested, notSpawned, error,
        transportComplete: outEnd && errEnd && statusEnd && !!ownerExit });
    }
    function terminalDrain() {
      if (outEnd && errEnd && statusEnd && ownerExit) finish();
      else if (!transport) transport = setTimeout(finish, TRANSPORT_MS);
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      requested = true; notSpawned = true;
      runtime.close().catch(() => { error = 'LINUX_OWNER_FD_CLOSE_FAILED'; }).then(finish); return;
    }
    try {
      child = (options.spawnProcess || spawn)('/proc/self/fd/5',
        [options.probe ? '--probe' : '--run', String(timeoutMs), String(process.pid), '--', binary, ...args],
        { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', runtime.fd] });
    } catch {
      error = 'LINUX_OWNER_SPAWN_FAILED'; runtime.close().then(finish); return;
    }
    runtime.close().catch(() => { error = 'LINUX_OWNER_FD_CLOSE_FAILED'; abort(); });
    const wire = parser(runtime.sourceSha256, () => {
      if (requested || options.signal?.aborted) return;
      const control = child.stdio[3];
      if (!control || control.destroyed || control.writableEnded) {
        error ||= 'LINUX_OWNER_CONTROL_FAILED'; abort(); return;
      }
      try { control.write('G'); } catch {
        // A transport/release race is not malformed native status.
        if (!requested && !options.signal?.aborted) error ||= 'LINUX_OWNER_CONTROL_FAILED';
        abort();
      }
    });
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        const buffer = Buffer.from(chunk); const output = outputs[name];
        const max = options[`${name}Bytes`] ?? 65536;
        const length = Math.min(Math.max(0, max - output.bytes), buffer.length);
        if (length) { output.chunks.push(buffer.subarray(0, length)); output.bytes += length; }
        if (length < buffer.length) output.truncated = true;
        notifyOutput(options.onOutput, name, buffer);
      });
      child[name].on('end', () => { if (name === 'stdout') outEnd = true; else errEnd = true;
        if (final || ownerExit) terminalDrain(); });
      child[name].on('error', () => { error = 'LINUX_OWNER_OUTPUT_FAILED'; abort(); });
    }
    child.stdio[3].on('error', () => { error = 'LINUX_OWNER_CONTROL_FAILED'; });
    child.stdio[4].on('data', (chunk) => {
      try { wire.feed(chunk); } catch { error = 'LINUX_OWNER_PROTOCOL'; abort(); }
    });
    child.stdio[4].on('end', () => {
      statusEnd = true;
      try { final = wire.end(); } catch { error = 'LINUX_OWNER_PROTOCOL'; abort(); }
      terminalDrain();
    });
    child.stdio[4].on('error', () => { error = 'LINUX_OWNER_STATUS_FAILED'; abort(); terminalDrain(); });
    child.once('error', () => { error = 'LINUX_OWNER_SPAWN_FAILED'; terminalDrain(); });
    child.once('exit', (code, signal) => { ownerExit = { code, signal }; terminalDrain(); });
    // Native wall+cleanup is independent of JS. This timer only bounds transports.
    timer = setTimeout(() => { error = 'LINUX_OWNER_TRANSPORT_DEADLINE'; abort(); finish(); }, timeoutMs + 2000 + TRANSPORT_MS);
    notifyStdin(options.onStdin, child);
    if (options.signal?.aborted || requested) abort();
  });
}
module.exports = { MAX_STATUS, TRANSPORT_MS, validateFinal, parser, cleanupProven, runLinuxOwner };
