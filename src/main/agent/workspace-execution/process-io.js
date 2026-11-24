'use strict';

function notifyOutput(callback, stream, value) {
  if (typeof callback !== 'function') return;
  try {
    callback(stream, Buffer.isBuffer(value) ? value : Buffer.from(value || ''));
  } catch {
    // Observability must never influence sandbox execution.
  }
}

function createReadinessOutputForwarder(markerPrefix, callback) {
  const marker = Buffer.from(markerPrefix);
  let prefix = Buffer.alloc(0);
  let decided = false;
  let accepted = false;
  return (value) => {
    if (typeof callback !== 'function') return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
    if (decided) {
      if (accepted) notifyOutput(callback, 'stdout', chunk);
      return;
    }
    prefix = Buffer.concat([prefix, chunk]);
    if (prefix.length < marker.length) return;
    decided = true;
    accepted = prefix.subarray(0, marker.length).equals(marker);
    if (accepted && prefix.length > marker.length) {
      notifyOutput(callback, 'stdout', prefix.subarray(marker.length));
    }
    prefix = Buffer.alloc(0);
  };
}

function createStdinControl(child) {
  child?.stdin?.on?.('error', () => {});
  return Object.freeze({
    write(value) {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
      if (!child?.stdin || child.stdin.destroyed || child.exitCode !== null) return false;
      try {
        child.stdin.write(buffer);
        return true;
      } catch {
        return false;
      }
    },
  });
}

function notifyStdin(callback, child) {
  if (typeof callback !== 'function') return;
  try {
    callback(createStdinControl(child));
  } catch {
    // Process-control observation must never influence sandbox execution.
  }
}

module.exports = {
  createReadinessOutputForwarder,
  createStdinControl,
  notifyOutput,
  notifyStdin,
};
