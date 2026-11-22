// Remembers which antd this profile spawned, so the next launch can recognise
// it if it outlived Freedom (#218 review R1-M1).
//
// antd is spawned without `detached` and with no parent-death signal, so a
// Freedom that is SIGKILLed or crashes leaves it running. A legacy profile
// (FREEDOM_TEST_USER_DATA / --profile-dir) runs its own antd on the ecosystem
// default 1633, so after such a crash the launch prompt would otherwise offer
// that orphan as "an existing node", and "Keep managed" would spawn a second
// antd on the same data dir, which cannot take the statestore LevelDB lock the
// orphan still holds. Reusing the orphan is what Freedom did before the prompt
// existed, and it is the only thing that works until the orphan exits.
//
// The marker lives in the profile directory and records the pid, the API port
// and the data dir, plus the node's overlay address once it answers on its API
// port. It is removed when the process exits under our watch; one that
// survives names a process that is still alive only if Freedom died first.
//
// A live pid alone proves nothing (pids are recycled), and neither does an Ant
// API on the recorded port (a foreign Bee can serve 1633). So a marker only
// matches when its pid is alive *and* the node answering on its recorded API
// port reports the overlay this profile's antd reported: another node has
// another identity. The port is the marker's own, not 1633, because a legacy
// profile that keeps its own node next to a foreign one runs antd on the next
// free port (#218 review R2-M1/M2). A marker written before the node first
// answered has no overlay and never matches; ant-manager keeps retrying the
// overlay fetch (with backoff) while its antd runs, so that only affects a
// Freedom that died before any fetch succeeded, which then falls back to the
// prompt and saved choice (#218 review R3-M1).
//
// It is also the second layer of the profile move's orphan check
// (freedom-core design 0013, MD7; profile-resolver.js's startProfileMove):
// the move waits while the marker names a live process, or is there but
// can't be read. So the marker is replaced whole and durably
// (lib/atomic-file.js), never written in place: a crash mid-write leaves the
// old marker or the new one, never a torn one. The first layer is the
// core's: from freedom-cored 0.26.0 its move tries antd's own
// `ant-data/antd.lock`, which antd locks (flock, LockFileEx) before it opens
// its data and holds for its life. That covers what no marker can: the
// moment between the spawn and the marker's write, and a marker lost or
// damaged otherwise.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { writeFileAtomicSync } = require('./lib/atomic-file');

const ANT_PROCESS_MARKER_FILE = 'ant-process.json';

function getMarkerPath(userDataDir) {
  return path.join(userDataDir, ANT_PROCESS_MARKER_FILE);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, we just may not signal it.
    return err.code === 'EPERM';
  }
}

function normalizeOverlay(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

// The overlay address the node on 127.0.0.1:`port` reports, or null.
function fetchNodeOverlay(port, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) {
      resolve(null);
      return;
    }
    const req = http.get(`http://127.0.0.1:${port}/addresses`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('error', () => resolve(null));
      res.on('end', () => {
        try {
          resolve(normalizeOverlay(JSON.parse(body)?.overlay));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Replaces the marker whole and durably (temp file, fsync, rename, directory
// flush). Returns whether it was written; a failure leaves the old marker.
function writeMarkerFile(userDataDir, marker) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    writeFileAtomicSync(getMarkerPath(userDataDir), JSON.stringify(marker, null, 2));
    return true;
  } catch {
    // Best effort for the launch prompt: without the marker an orphan is just
    // offered there. The move doesn't rely on it alone (see the top).
    return false;
  }
}

function writeAntProcessMarker(userDataDir, { pid, apiPort, dataDir }) {
  if (!userDataDir || !Number.isInteger(pid)) return false;
  return writeMarkerFile(userDataDir, { pid, apiPort, dataDir });
}

// Adds the overlay the spawned antd reported to its marker, once it answers.
// Only touches a marker that still names `pid`.
function recordAntProcessOverlay(userDataDir, pid, overlay) {
  if (!userDataDir) return;
  const normalized = normalizeOverlay(overlay);
  const marker = readMarker(userDataDir);
  if (!normalized || !marker || marker.pid !== pid) return;
  writeMarkerFile(userDataDir, { ...marker, overlay: normalized });
}

function readMarker(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getMarkerPath(userDataDir), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Only removes a marker that still names `pid`, so the close of an old child
// cannot delete the marker of the one that replaced it.
function clearAntProcessMarker(userDataDir, pid) {
  if (!userDataDir) return;
  const marker = readMarker(userDataDir);
  if (!marker || (pid !== undefined && marker.pid !== pid)) return;
  try {
    fs.rmSync(getMarkerPath(userDataDir), { force: true });
  } catch {
    // Best effort.
  }
}

// The antd this profile spawned in an earlier run that is still alive and
// still serving its API on the port it recorded, or null. `options.apiPort`
// narrows it to a node on that port.
async function findOwnLiveAntd(userDataDir, options = {}) {
  if (!userDataDir) return null;
  const marker = readMarker(userDataDir);
  if (!marker || !Number.isInteger(marker.apiPort)) return null;
  if (options.apiPort !== undefined && marker.apiPort !== options.apiPort) return null;
  const expected = normalizeOverlay(marker.overlay);
  if (!expected) return null;
  const alive = options.isProcessAlive || isProcessAlive;
  if (marker.pid === process.pid || !alive(marker.pid)) return null;
  const fetchOverlay = options.fetchOverlay || fetchNodeOverlay;
  const actual = normalizeOverlay(await fetchOverlay(marker.apiPort));
  return actual === expected ? marker : null;
}

// What the marker says for the profile move's orphan check (freedom-core
// design 0013, MD7), failing closed and asking the node nothing:
// - `{ state: 'none' }`: no marker;
// - `{ state: 'live', pid }`: it names a live process other than this one;
// - `{ state: 'gone', pid }`: the process it names is gone (or is this one);
// - `{ state: 'unreadable', reason }`: a marker is there but can't be read,
//   doesn't parse (a torn write by an older build, say), or names no pid.
// The move waits on `live` and `unreadable`. A recycled pid only defers it:
// the next antd Freedom starts replaces the marker, and its exit removes it.
function readAntProcessMarkerState(userDataDir, options = {}) {
  let text;
  try {
    text = fs.readFileSync(getMarkerPath(userDataDir), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'none' };
    return { state: 'unreadable', reason: err.code || 'read_failed' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'unreadable', reason: 'malformed' };
  }
  const pid = parsed && typeof parsed === 'object' ? parsed.pid : undefined;
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'unreadable', reason: 'no_pid' };
  if (pid === process.pid) return { state: 'gone', pid };
  const alive = options.isProcessAlive || isProcessAlive;
  return alive(pid) ? { state: 'live', pid } : { state: 'gone', pid };
}

module.exports = {
  ANT_PROCESS_MARKER_FILE,
  clearAntProcessMarker,
  fetchNodeOverlay,
  findOwnLiveAntd,
  readAntProcessMarkerState,
  recordAntProcessOverlay,
  writeAntProcessMarker,
};
