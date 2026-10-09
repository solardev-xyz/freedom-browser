const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FOCUS_REQUEST_FILE = 'profile-focus-request.json';
const FOCUS_ACK_FILE = 'profile-focus-ack.json';
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 1800;
const DEFAULT_MAX_REQUEST_AGE_MS = 10000;

function getProfileFocusPaths(profile) {
  if (!profile?.userDataDir) {
    throw new Error('Profile userDataDir is required for focus handoff');
  }

  return {
    requestPath: path.join(profile.userDataDir, FOCUS_REQUEST_FILE),
    ackPath: path.join(profile.userDataDir, FOCUS_ACK_FILE),
  };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// Read the most recent ack a profile process wrote (for either a focus or a
// quit request). The ack carries the responding process's pid, which lets a
// requester confirm that process has actually exited. Returns null when no ack
// exists or it can't be parsed.
function readProfileFocusAck(profile) {
  return readJsonFile(getProfileFocusPaths(profile).ackPath);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function makeNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function requestProfileFocusSync(profile, options = {}) {
  const paths = getProfileFocusPaths(profile);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const nonce = options.nonce || makeNonce();
  const request = {
    type: 'focus-window',
    nonce,
    profileId: profile.id || null,
    requestedAtMs: Date.now(),
    pid: process.pid,
    // URLs a second launch was given (launch-urls.js), opened by the running
    // process in new tabs. It re-validates them: the file is only a transport.
    ...(Array.isArray(options.urls) && options.urls.length > 0 ? { urls: options.urls } : {}),
  };

  try {
    writeJsonAtomic(paths.requestPath, request);
  } catch (error) {
    return {
      ok: false,
      requestWritten: false,
      error: error.message || 'Focus request could not be written',
      nonce,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const ack = readJsonFile(paths.ackPath);
    if (ack?.nonce === nonce) {
      return {
        ok: ack.ok === true,
        requestWritten: true,
        error: ack.error || null,
        nonce,
      };
    }
    sleepSync(pollIntervalMs);
  }

  return {
    ok: false,
    requestWritten: true,
    error: 'The running profile did not respond',
    nonce,
  };
}

// Async (non-blocking) counterpart of requestProfileFocusSync. Writes the
// focus-request file, then awaits the target's ack by polling on a timer
// (setTimeout) rather than Atomics.wait, so the main process stays responsive
// while a running profile is asked to focus its window. Used by the renderer
// IPC path (which can await) so it can report a *confirmed* focus rather than
// just "the request was written".
//
// Return shape distinguishes the failure modes so callers can react correctly.
// The `requestWritten` flag is the one that matters for the cold-start decision:
// only a profile whose request could not even be written is safe to launch.
//   { ok: true,  requestWritten: true  } — the target acknowledged the focus
//   { ok: false, requestWritten: false } — the request could not be written
//                                          (target dir gone) → caller may cold-start
//   { ok: false, requestWritten: true  } — the request reached the target but it
//                                          did not focus: either it acked a failure
//                                          (e.g. its focus handler is not ready yet)
//                                          or never acked at all (timedOut: true).
//                                          A live process holds the lock — the caller
//                                          must NOT cold-start a duplicate into it.
async function requestProfileFocusAsyncAwait(profile, options = {}) {
  const paths = getProfileFocusPaths(profile);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const nonce = options.nonce || makeNonce();
  const request = {
    type: 'focus-window',
    nonce,
    profileId: profile.id || null,
    requestedAtMs: Date.now(),
    pid: process.pid,
    ...(options.openSettings ? { openSettings: true } : {}),
  };

  try {
    writeJsonAtomic(paths.requestPath, request);
  } catch (error) {
    return {
      ok: false,
      requestWritten: false,
      error: error.message || 'Focus request could not be written',
      nonce,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const ack = readJsonFile(paths.ackPath);
    if (ack?.nonce === nonce) {
      return {
        ok: ack.ok === true,
        requestWritten: true,
        error: ack.error || null,
        nonce,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    ok: false,
    requestWritten: true,
    timedOut: true,
    error: 'The running profile did not respond',
    nonce,
  };
}

const KNOWN_REQUEST_TYPES = new Set(['focus-window', 'quit-app']);

// Fire-and-forget request asking an already-running profile process to quit
// (so its profile lock releases). Used when deleting a profile that is open in
// another window: close it first, then delete. The requester waits for the
// lock to release rather than for an ack.
function requestProfileQuitAsync(profile, options = {}) {
  const paths = getProfileFocusPaths(profile);
  const nonce = options.nonce || makeNonce();
  const request = {
    type: 'quit-app',
    nonce,
    profileId: profile.id || null,
    requestedAtMs: Date.now(),
    pid: process.pid,
  };

  try {
    writeJsonAtomic(paths.requestPath, request);
    return { ok: true, nonce };
  } catch (error) {
    return { ok: false, error: error.message || 'Quit request could not be written', nonce };
  }
}

function isFreshRequest(request, maxAgeMs) {
  if (!request || !KNOWN_REQUEST_TYPES.has(request.type) || typeof request.nonce !== 'string') {
    return false;
  }

  const requestedAtMs = Number(request.requestedAtMs);
  if (!Number.isFinite(requestedAtMs)) {
    return false;
  }

  return Date.now() - requestedAtMs <= maxAgeMs;
}

function startProfileFocusRequestWatcher(profile, onFocusWindow, options = {}) {
  const paths = getProfileFocusPaths(profile);
  const logger = options.logger || console;
  const onQuit = options.onQuit || null;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxRequestAgeMs = options.maxRequestAgeMs ?? DEFAULT_MAX_REQUEST_AGE_MS;

  let stopped = false;
  let handling = false;
  let lastNonce = null;

  const writeAck = (request, result) => {
    try {
      writeJsonAtomic(paths.ackPath, {
        nonce: request.nonce,
        ok: result.ok === true,
        error: result.error || null,
        handledAtMs: Date.now(),
        pid: process.pid,
      });
    } catch (error) {
      logger.warn?.('[profile-focus] Failed to write focus acknowledgement:', error.message);
    }
  };

  const checkRequest = async () => {
    if (stopped || handling) return;

    const request = readJsonFile(paths.requestPath);
    if (!isFreshRequest(request, maxRequestAgeMs) || request.nonce === lastNonce) {
      return;
    }

    handling = true;
    lastNonce = request.nonce;
    try {
      if (request.type === 'quit-app') {
        // Ack before the process winds down so the requester gets a fast
        // confirmation; it still waits on the lock release for the real signal.
        await (onQuit ? onQuit(request) : Promise.resolve());
      } else {
        await onFocusWindow(request);
      }
      writeAck(request, { ok: true });
    } catch (error) {
      logger.warn?.('[profile-focus] Failed to handle profile request:', error);
      writeAck(request, {
        ok: false,
        error: error.message || 'Profile request failed',
      });
    } finally {
      handling = false;
    }
  };

  const timer = setInterval(() => {
    void checkRequest();
  }, pollIntervalMs);
  timer.unref?.();
  void checkRequest();

  return {
    requestPath: paths.requestPath,
    ackPath: paths.ackPath,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = {
  DEFAULT_MAX_REQUEST_AGE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FOCUS_ACK_FILE,
  FOCUS_REQUEST_FILE,
  getProfileFocusPaths,
  readProfileFocusAck,
  requestProfileFocusAsyncAwait,
  requestProfileFocusSync,
  requestProfileQuitAsync,
  startProfileFocusRequestWatcher,
};
