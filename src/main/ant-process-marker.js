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
// and the data dir. It is removed when the process exits under our watch; one
// that survives names a process that is still alive only if Freedom died
// first. A reused pid would have to also be serving the Ant API on the same
// port for it to match, so a stale marker can at worst make Freedom reuse a
// node on that port, which is the pre-#218 behaviour.

const fs = require('fs');
const path = require('path');

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

function writeAntProcessMarker(userDataDir, { pid, apiPort, dataDir }) {
  if (!userDataDir || !Number.isInteger(pid)) return;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      getMarkerPath(userDataDir),
      JSON.stringify({ pid, apiPort, dataDir }, null, 2),
      'utf-8'
    );
  } catch {
    // Best effort: without the marker an orphan is just offered in the prompt.
  }
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

// The antd this profile spawned on `apiPort` in an earlier run that is still
// alive, or null.
function findOwnLiveAntd(userDataDir, apiPort, options = {}) {
  if (!userDataDir) return null;
  const marker = readMarker(userDataDir);
  if (!marker || marker.apiPort !== apiPort) return null;
  const alive = options.isProcessAlive || isProcessAlive;
  if (marker.pid === process.pid || !alive(marker.pid)) return null;
  return marker;
}

module.exports = {
  ANT_PROCESS_MARKER_FILE,
  clearAntProcessMarker,
  findOwnLiveAntd,
  writeAntProcessMarker,
};
