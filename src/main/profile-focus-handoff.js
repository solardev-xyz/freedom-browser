const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Every request goes into its own file in FOCUS_REQUEST_DIR (named by its
// nonce) and is answered in its own file in FOCUS_ACK_DIR, so two launches
// racing each other (a mail client's "open all links", `xdg-open a; xdg-open b`)
// can't overwrite one another's request or ack. The single FOCUS_REQUEST_FILE /
// FOCUS_ACK_FILE pair is still written too, for a running process or requester
// from an older build that only knows those; the watcher dedupes by nonce.
const FOCUS_REQUEST_FILE = 'profile-focus-request.json';
const FOCUS_ACK_FILE = 'profile-focus-ack.json';
const FOCUS_REQUEST_DIR = 'profile-focus-requests';
const FOCUS_ACK_DIR = 'profile-focus-acks';
// Nonces name files, so only accept a shape that can't escape the directory.
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Per-request acks a requester never collected (it timed out or died) are
// swept once they are this old.
const ACK_RETENTION_MS = 60000;
const HANDLED_NONCE_MEMORY = 256;
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
    requestDir: path.join(profile.userDataDir, FOCUS_REQUEST_DIR),
    ackDir: path.join(profile.userDataDir, FOCUS_ACK_DIR),
  };
}

function isValidNonce(nonce) {
  return typeof nonce === 'string' && NONCE_PATTERN.test(nonce);
}

function requestFileFor(paths, nonce) {
  return path.join(paths.requestDir, `${nonce}.json`);
}

function ackFileFor(paths, nonce) {
  return path.join(paths.ackDir, `${nonce}.json`);
}

function removeFileQuietly(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort; the watcher's sweep removes leftovers.
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// Read the ack a profile process wrote (for either a focus or a quit request).
// The ack carries the responding process's pid, which lets a requester confirm
// that process has actually exited. With a nonce, the ack for that request:
// its own per-request file, else the shared file if it still holds that nonce
// (an older running build). Without one, the most recent shared ack. Returns
// null when no such ack exists or it can't be parsed.
function readProfileFocusAck(profile, nonce = null) {
  const paths = getProfileFocusPaths(profile);
  if (nonce == null) return readJsonFile(paths.ackPath);
  if (!isValidNonce(nonce)) return null;
  const own = readJsonFile(ackFileFor(paths, nonce));
  if (own?.nonce === nonce) return own;
  const shared = readJsonFile(paths.ackPath);
  return shared?.nonce === nonce ? shared : null;
}

let tmpCounter = 0;
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  tmpCounter += 1;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`;
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

// Writes the request's own file (what this build's watcher reads), then the
// shared legacy file (what an older running build reads). Only the first has
// to succeed for the request to count as written.
function writeRequest(paths, request) {
  if (!isValidNonce(request.nonce)) {
    throw new Error('Invalid focus request nonce');
  }
  writeJsonAtomic(requestFileFor(paths, request.nonce), request);
  try {
    writeJsonAtomic(paths.requestPath, request);
  } catch {
    // An older build won't see it; this build's watcher already can.
  }
}

// The ack for `nonce`, if the target wrote one yet; collects (deletes) its
// per-request file and the request file once found.
function takeAck(paths, nonce) {
  const own = readJsonFile(ackFileFor(paths, nonce));
  if (own?.nonce === nonce) {
    removeFileQuietly(ackFileFor(paths, nonce));
    removeFileQuietly(requestFileFor(paths, nonce));
    return own;
  }
  const shared = readJsonFile(paths.ackPath);
  if (shared?.nonce === nonce) {
    removeFileQuietly(requestFileFor(paths, nonce));
    return shared;
  }
  return null;
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
    writeRequest(paths, request);
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
    const ack = takeAck(paths, nonce);
    if (ack) {
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
    writeRequest(paths, request);
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
    const ack = takeAck(paths, nonce);
    if (ack) {
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
    writeRequest(paths, request);
    return { ok: true, nonce };
  } catch (error) {
    return { ok: false, error: error.message || 'Quit request could not be written', nonce };
  }
}

function isFreshRequest(request, maxAgeMs) {
  if (!request || !KNOWN_REQUEST_TYPES.has(request.type) || !isValidNonce(request.nonce)) {
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
  // Nonces already handled, oldest first. A request can be seen twice: in its
  // own file and in the shared legacy file, which also outlives the request.
  const handledNonces = new Set();
  const rememberNonce = (nonce) => {
    handledNonces.add(nonce);
    if (handledNonces.size > HANDLED_NONCE_MEMORY) {
      handledNonces.delete(handledNonces.values().next().value);
    }
  };

  const writeAck = (request, result) => {
    const ack = {
      nonce: request.nonce,
      ok: result.ok === true,
      error: result.error || null,
      handledAtMs: Date.now(),
      pid: process.pid,
    };
    try {
      writeJsonAtomic(ackFileFor(paths, request.nonce), ack);
    } catch (error) {
      logger.warn?.('[profile-focus] Failed to write focus acknowledgement:', error.message);
    }
    // Shared copy for requesters from an older build, and for a reader that
    // only wants "the latest ack".
    try {
      writeJsonAtomic(paths.ackPath, ack);
    } catch (error) {
      logger.warn?.('[profile-focus] Failed to write shared focus acknowledgement:', error.message);
    }
  };

  // Pending requests, oldest first: every per-request file plus the shared
  // legacy file. Stale or malformed request files and uncollected old acks are
  // removed on the way.
  const collectRequests = () => {
    const requests = [];
    let names;
    try {
      names = fs.readdirSync(paths.requestDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const filePath = path.join(paths.requestDir, name);
      const request = name.endsWith('.json') ? readJsonFile(filePath) : null;
      if (isFreshRequest(request, maxRequestAgeMs) && `${request.nonce}.json` === name) {
        requests.push({ request, filePath });
        continue;
      }
      // Stale, malformed, misnamed, or a temp file a crashed writer left
      // behind: remove it once it is older than any request we would accept.
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
      } catch {
        // Already gone.
      }
      if (ageMs > maxRequestAgeMs) removeFileQuietly(filePath);
    }
    const legacy = readJsonFile(paths.requestPath);
    if (isFreshRequest(legacy, maxRequestAgeMs)) {
      requests.push({ request: legacy, filePath: null });
    }
    requests.sort(
      (left, right) => Number(left.request.requestedAtMs) - Number(right.request.requestedAtMs)
    );

    try {
      for (const name of fs.readdirSync(paths.ackDir)) {
        const filePath = path.join(paths.ackDir, name);
        try {
          if (Date.now() - fs.statSync(filePath).mtimeMs > ACK_RETENTION_MS) {
            removeFileQuietly(filePath);
          }
        } catch {
          // Collected by its requester meanwhile.
        }
      }
    } catch {
      // No ack directory yet.
    }
    return requests;
  };

  const handleRequest = async (request) => {
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
    }
  };

  const checkRequest = async () => {
    if (stopped || handling) return;
    handling = true;
    try {
      // Every pending request, one after another: concurrent launches each get
      // their own ack.
      for (const { request, filePath } of collectRequests()) {
        if (stopped) break;
        if (handledNonces.has(request.nonce)) {
          if (filePath) removeFileQuietly(filePath);
          continue;
        }
        rememberNonce(request.nonce);
        await handleRequest(request);
        if (filePath) removeFileQuietly(filePath);
      }
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
  FOCUS_ACK_DIR,
  FOCUS_REQUEST_DIR,
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
