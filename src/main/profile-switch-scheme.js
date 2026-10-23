/**
 * `x-freedom-profile:<id>` — a profile switch handed over through xdg-open
 * (Linux only, issue #142).
 *
 * GNOME on Wayland raises another process's window only with an XDG activation
 * token minted from the user's own input. An in-app profile switch to an
 * already-running profile happens in *this* process, so the running profile's
 * own focus() has no token and mutter answers with "'Freedom' is ready"
 * instead. `shell.openExternal` is the one Electron API that mints a token: it
 * starts xdg-open with XDG_ACTIVATION_TOKEN set, xdg-open launches the
 * installed `freedom.desktop` with `x-freedom-profile:<id>`, and that launch
 * reaches the running profile through Electron's single-instance hand-over
 * (index.js), which passes the token along with its argv.
 *
 * The scheme is registered for the whole desktop (package.json's Linux
 * `mimeTypes`), so anything that can run xdg-open can send one — including a
 * page in another browser, behind that browser's own confirmation. It means
 * exactly "raise the already-open profile <id>" and nothing else: no URL is
 * opened, no profile is created or cold-started, its "last opened" mark is
 * left alone, and anything that is not a canonical id of a registered,
 * currently running profile is refused (profile-resolver.js, index.js). It is
 * ignored on macOS and Windows, which never register it.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeProfileId } = require('./profile-catalog');

const PROFILE_SWITCH_SCHEME = 'x-freedom-profile';
const PROFILE_SWITCH_MIME_TYPE = `x-scheme-handler/${PROFILE_SWITCH_SCHEME}`;
const PREFIX = `${PROFILE_SWITCH_SCHEME}:`;

// The installed desktop entry, which is what xdg-mime must name as the
// scheme's handler for xdg-open to reach this app (also the Wayland app_id;
// see linux-desktop-name.js and scripts/linux-desktop-entry.test.js).
const PACKAGED_DESKTOP_NAME = require('../../package.json').desktopName;

// xdg-mime is a short shell script; a query that takes longer than this is
// stuck, and the switch falls back to the file hand-off.
const XDG_MIME_TIMEOUT_MS = 1000;

// The switch's outcome, written into the target profile's userData dir (one
// file per record, see Confirmation below): by the switch launch itself as
// soon as it starts (`received`), and once it is over by the running profile when the launch raised its window through the
// single-instance hand-over (`done`), or by the launch when it had to use the
// focus-request file instead (`done` or `failed`; profile-instance-handoff.js).
// The in-app switch waits for it: xdg-open itself confirms only that it
// started something.
const PROFILE_SWITCH_ACK_DIR = 'profile-switch-acks';
const PROFILE_SWITCH_STATES = new Set(['received', 'done', 'failed']);
// xdg-open, then a fresh Freedom process up to its first lines of main-process
// code: a few hundred ms normally, more on a cold disk. A launch that has not
// said `received` by then never arrived (the scheme went to something else).
const PROFILE_SWITCH_RECEIVE_TIMEOUT_MS = 3000;
// The whole switch: the launch's instance-lock probe (1 s) and, when that goes
// unanswered, its focus-request file (1.8 s), on top of the start-up above.
const PROFILE_SWITCH_ACK_TIMEOUT_MS = 6000;
const PROFILE_SWITCH_ACK_POLL_MS = 100;
// Records older than this are swept on the next write: well past any wait.
const PROFILE_SWITCH_ACK_MAX_AGE_MS = 60 * 1000;

function isProfileSwitchArg(arg) {
  return typeof arg === 'string' && arg.slice(0, PREFIX.length).toLowerCase() === PREFIX;
}

// The id a canonical `x-freedom-profile:<id>` names, or null. Canonical means
// what sanitizeProfileId would produce for it already: lower-case
// `[a-z0-9_-]`, no leading or trailing dash. No percent-decoding, no
// `//authority`, query, fragment or trailing slash: the app only ever writes
// the bare id, so anything else did not come from it.
function parseProfileSwitchUrl(value) {
  if (!isProfileSwitchArg(value)) return null;
  const id = value.slice(PREFIX.length);
  if (!/^[a-z0-9_-]+$/.test(id)) return null;
  let canonical;
  try {
    canonical = sanitizeProfileId(id);
  } catch {
    return null;
  }
  return canonical === id ? id : null;
}

// A profile switch among a launch's arguments, on Linux only.
//   null              — none (or not Linux): an ordinary launch
//   { id }            — a well-formed switch to `id` (still to be checked
//                       against the catalog by the caller)
//   { id: null }      — a switch was asked for but is malformed, or more than
//                       one was given; the caller refuses the launch
// argv[0] (the executable) is skipped, like extractLaunchUrls.
function parseProfileSwitchArgv(argv, { platform = process.platform } = {}) {
  if (platform !== 'linux' || !Array.isArray(argv)) return null;
  const switches = argv.slice(1).filter(isProfileSwitchArg);
  if (switches.length === 0) return null;
  if (switches.length > 1) return { id: null };
  return { id: parseProfileSwitchUrl(switches[0]) };
}

function buildProfileSwitchUrl(profileId) {
  const url = `${PREFIX}${profileId}`;
  if (parseProfileSwitchUrl(url) !== profileId) {
    throw new Error(`Invalid profile id: ${profileId}`);
  }
  return url;
}

function queryDefaultSchemeHandler(mimeType) {
  return new Promise((resolve, reject) => {
    execFile(
      'xdg-mime',
      ['query', 'default', mimeType],
      { timeout: XDG_MIME_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim()))
    );
  });
}

// --- Is the scheme's handler this very app? ---------------------------------
//
// xdg-mime naming `freedom.desktop` is not enough: with a .deb installed, an
// AppImage (or a second install of another version) would have xdg-open start
// *that* binary against the same userData root, where it runs its own
// migrations and catalog writes before handing over. So the desktop entry's
// Exec program must resolve to the executable this process runs from (the
// AppImage file itself for an AppImage, which runs from a temporary mount).

function desktopEntryDirs({ env = process.env, homedir = os.homedir() } = {}) {
  const dataHome = env?.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
  const dataDirs = String(env?.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter(Boolean);
  return [dataHome, ...dataDirs]
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, 'applications'));
}

// The `Exec` value of a desktop entry's [Desktop Entry] group, or null.
function parseDesktopEntryExec(text) {
  let inMainGroup = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inMainGroup = line === '[Desktop Entry]';
      continue;
    }
    if (!inMainGroup) continue;
    const match = /^Exec\s*=\s*(.*)$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

// The program (first argument) of an Exec value, unquoted per the desktop
// entry spec, or null when it can't be read.
function execProgram(execValue) {
  const value = String(execValue || '').trimStart();
  if (!value) return null;
  if (value[0] !== '"') {
    const program = value.split(/\s+/)[0];
    return program || null;
  }
  let program = '';
  for (let i = 1; i < value.length; i += 1) {
    const char = value[i];
    if (char === '\\' && i + 1 < value.length) {
      program += value[i + 1];
      i += 1;
    } else if (char === '"') {
      return program || null;
    } else {
      program += char;
    }
  }
  return null;
}

function resolveExecProgram(program, { env = process.env, fsImpl = fs } = {}) {
  if (!program) return null;
  if (path.isAbsolute(program)) return program;
  if (program.includes('/')) return null;
  for (const dir of String(env?.PATH || '').split(':')) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, program);
    try {
      fsImpl.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

// Whether the installed `desktopName` entry (looked up in the XDG data dirs,
// first match wins, like xdg-open does) starts this executable.
function desktopEntryRunsThisApp({
  desktopName = PACKAGED_DESKTOP_NAME,
  env = process.env,
  homedir = os.homedir(),
  execPath = process.execPath,
  fsImpl = fs,
} = {}) {
  const self = env?.APPIMAGE || execPath;
  let selfReal;
  try {
    selfReal = fsImpl.realpathSync(self);
  } catch {
    return false;
  }
  for (const dir of desktopEntryDirs({ env, homedir })) {
    let text;
    try {
      text = fsImpl.readFileSync(path.join(dir, desktopName), 'utf-8');
    } catch {
      continue;
    }
    const program = resolveExecProgram(execProgram(parseDesktopEntryExec(text)), {
      env,
      fsImpl,
    });
    if (!program) return false;
    try {
      return fsImpl.realpathSync(program) === selfReal;
    } catch {
      return false;
    }
  }
  return false;
}

// Whether an in-app switch to a running profile should go through xdg-open.
// Only where it is both needed and known to arrive: a Wayland session (X11
// lets the running profile raise itself), a packaged build, and an installed
// desktop entry that xdg-mime names as the scheme's handler and that starts
// this same executable — an AppImage without desktop integration, a tarball
// or `npm start` has none, and a different install's entry would start a
// different binary.
async function shouldSwitchProfileViaXdgOpen({
  platform = process.platform,
  env = process.env,
  isPackaged,
  queryDefaultHandler = queryDefaultSchemeHandler,
  desktopName = PACKAGED_DESKTOP_NAME,
  runsThisApp = desktopEntryRunsThisApp,
} = {}) {
  if (platform !== 'linux') return false;
  if (
    String(env?.XDG_SESSION_TYPE || '')
      .trim()
      .toLowerCase() !== 'wayland'
  )
    return false;
  if (isPackaged !== true) return false;
  let handler;
  try {
    handler = await queryDefaultHandler(PROFILE_SWITCH_MIME_TYPE);
  } catch {
    return false;
  }
  if (typeof handler !== 'string' || handler.trim() !== desktopName) return false;
  try {
    return runsThisApp({ desktopName, env }) === true;
  } catch {
    return false;
  }
}

// --- Confirmation -----------------------------------------------------------
//
// Every record is its own file under PROFILE_SWITCH_ACK_DIR, never one shared
// file: two switches to the same profile can overlap (two menu clicks, a dock
// click during a menu switch), and with a single file the second launch's
// `received` could overwrite the first one's `done` between two polls and
// leave the first waiter running out its budget (R3-M3). Records only ever get
// added, so a waiter sees every state written since it started.

function profileSwitchAckDir(userDataDir) {
  return path.join(userDataDir, PROFILE_SWITCH_ACK_DIR);
}

let ackSequence = 0;

// Drop records too old for any switch still waiting on them. Best effort.
function sweepProfileSwitchAcks(dir, now, fsImpl) {
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^(\d+)-/.exec(name);
    if (!match || now - Number(match[1]) <= PROFILE_SWITCH_ACK_MAX_AGE_MS) continue;
    try {
      fsImpl.unlinkSync(path.join(dir, name));
    } catch {
      // Someone else swept it, or it is in use; next time.
    }
  }
}

// Record the switch's progress (`received`, `done` or `failed`, see above).
function writeProfileSwitchAck(
  userDataDir,
  { state = 'done', now = Date.now(), fsImpl = fs } = {}
) {
  if (!PROFILE_SWITCH_STATES.has(state)) throw new Error(`Invalid switch state: ${state}`);
  const dir = profileSwitchAckDir(userDataDir);
  fsImpl.mkdirSync(dir, { recursive: true });
  sweepProfileSwitchAcks(dir, now, fsImpl);
  ackSequence += 1;
  const name = `${now}-${process.pid}-${ackSequence}-${state}`;
  const target = path.join(dir, `${name}.json`);
  const tmp = path.join(dir, `${name}.tmp`);
  fsImpl.writeFileSync(tmp, JSON.stringify({ handledAtMs: now, state, pid: process.pid }), 'utf-8');
  fsImpl.renameSync(tmp, target);
}

// Every record as { at, state, pid }, oldest first (pid null when absent). A record without a state (none
// is written that way, but keep it readable) counts as `done`; unreadable or
// unknown ones are skipped.
function readProfileSwitchAcks(userDataDir, fsImpl = fs) {
  const dir = profileSwitchAckDir(userDataDir);
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const acks = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const ack = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf-8'));
      const at = Number(ack?.handledAtMs);
      if (!Number.isFinite(at)) continue;
      const state = ack?.state === undefined ? 'done' : ack.state;
      const pid = Number.isInteger(ack?.pid) ? ack.pid : null;
      if (PROFILE_SWITCH_STATES.has(state)) acks.push({ at, state, pid });
    } catch {
      // Skip it.
    }
  }
  return acks.sort((a, b) => a.at - b.at);
}

// The latest record, or null.
function readProfileSwitchAck(userDataDir, fsImpl = fs) {
  const acks = readProfileSwitchAcks(userDataDir, fsImpl);
  return acks.length ? acks[acks.length - 1] : null;
}

function readProfileSwitchAckTime(userDataDir, fsImpl = fs) {
  return readProfileSwitchAck(userDataDir, fsImpl)?.at ?? null;
}

// Where the records written since `sinceMs` leave a switch: `done` if any
// launch raised the window since (an overlapping switch to the same profile
// counts: the window the user asked for is in front); else `failed` once one
// failed since and every switch launch still in flight has finished; else
// `received`, else null.
//
// Each switch launch writes one `received` as it starts and at most one
// `done`/`failed`, so a later, overlapping launch keeps the wait going after an
// earlier one failed (R4-M1). In-flight launches are matched up by pid: a
// launch writes its `received` and, when it falls back to the focus-request
// file, its outcome from the same process. Every record is read for that, not
// only recent ones, so a slow launch whose `received` predates this switch by
// more than a budget cannot have its late `failed` taken for this switch's own
// launch finishing (R5-M1). An outcome from a pid that never said `received`
// is the running profile acknowledging a single-instance hand-over; which
// launch it answers is unknown, so it closes the oldest one in flight: at
// worst this switch then waits out its budget, it never ends early. Launches
// that said `received` more than one whole switch budget before such an
// unattributed outcome (measured from the outcome's own time, R1-M1, but never
// later than this switch's own cutoff, R2-M1) are past any wait (crashed,
// killed) and are dropped before it is matched, so a dead
// launch's leftover `received` cannot absorb the running profile's `failed`
// and turn a fast fail into the full wait (R6-M1), while a historical outcome
// still closes a launch that was live when it landed, not a newer one. A
// pid-attributed late outcome of such a launch still closes only its own
// launch (R5-M1). And a `failed` is only taken as this switch's once some
// launch said `received` since it started: this switch's own launch always
// does first, so a failure landing before that is someone else's.
function profileSwitchStateSince(acks, sinceMs, lookbackMs = PROFILE_SWITCH_ACK_TIMEOUT_MS) {
  const launchPids = new Set();
  for (const ack of acks) {
    if (ack.state === 'received' && ack.pid != null) launchPids.add(ack.pid);
  }
  let inFlight = []; // { at, pid }, oldest first
  let receivedSince = false;
  let failed = false;
  for (const ack of acks) {
    if (ack.state === 'received') {
      inFlight.push({ at: ack.at, pid: ack.pid ?? null });
      if (ack.at >= sinceMs) receivedSince = true;
      continue;
    }
    if (ack.pid != null && launchPids.has(ack.pid)) {
      let index = -1;
      for (let i = inFlight.length - 1; i >= 0; i -= 1) {
        if (inFlight[i].pid === ack.pid) {
          index = i;
          break;
        }
      }
      if (index >= 0) inFlight.splice(index, 1);
    } else {
      // Drop the launches already past any wait when this outcome landed
      // first, so this closes one that was still live then and not a crashed
      // one whose received is still on disk (R6-M1). Measured from the
      // outcome's own time when that predates this switch: an older outcome
      // answered a launch that was live back then, not the one live now
      // (R1-M1). Never later than this switch's own cutoff, though: a launch
      // still live for this switch is not dead, so a late answer to it must
      // close it and not this switch's own launch (R2-M1).
      const deadBefore = Math.min(ack.at, sinceMs) - lookbackMs;
      inFlight = inFlight.filter((launch) => launch.at >= deadBefore);
      inFlight.shift();
    }
    if (ack.at < sinceMs) continue;
    if (ack.state === 'done') return 'done';
    failed = true;
  }
  const staleBefore = sinceMs - lookbackMs;
  const stillGoing = inFlight.filter((launch) => launch.at >= staleBefore).length;
  if (failed && receivedSince && stillGoing === 0) return 'failed';
  return acks.some((ack) => ack.at >= sinceMs) ? 'received' : null;
}

// Resolves true once the profile in `userDataDir` recorded a switch `done` at
// or after `sinceMs`; false as soon as one is recorded `failed`, when none was
// even `received` within `receiveTimeoutMs`, or after `timeoutMs`. Failing
// early keeps the caller's own fallback (and its error, if any) from waiting
// out the whole budget.
async function waitForProfileSwitchAck(userDataDir, sinceMs, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROFILE_SWITCH_ACK_TIMEOUT_MS;
  const receiveTimeoutMs = options.receiveTimeoutMs ?? PROFILE_SWITCH_RECEIVE_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? PROFILE_SWITCH_ACK_POLL_MS;
  const fsImpl = options.fsImpl || fs;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const receiveDeadline = startedAt + Math.min(receiveTimeoutMs, timeoutMs);
  for (;;) {
    const current = profileSwitchStateSince(readProfileSwitchAcks(userDataDir, fsImpl), sinceMs);
    if (current === 'done') return true;
    if (current === 'failed') return false;
    const now = Date.now();
    if (now >= deadline) return false;
    if (current === null && now >= receiveDeadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Hand a switch to the running profile `target` ({ id, userDataDir }) over
// through xdg-open. Resolves true once the running profile confirmed it raised
// its window, false when this path does not apply, failed, or was never
// confirmed (the profile was deleted or quit meanwhile, the launch went
// somewhere else); the caller then uses the profile-focus file hand-off,
// which reports a switch that cannot land.
//
// Switches to the same profile made while one is in flight (two menu clicks;
// switchToProfile has no guard of its own) share that one launch and its
// outcome, rather than racing a second launch whose records the first one's
// would be mixed up with (R4-M1).
const xdgOpenSwitchesInFlight = new Map();

function switchProfileViaXdgOpen(target, deps = {}) {
  const key = typeof target?.userDataDir === 'string' ? target.userDataDir : null;
  if (key && xdgOpenSwitchesInFlight.has(key)) return xdgOpenSwitchesInFlight.get(key);
  const pending = runProfileSwitchViaXdgOpen(target, deps);
  if (!key) return pending;
  const shared = pending.finally(() => {
    if (xdgOpenSwitchesInFlight.get(key) === shared) xdgOpenSwitchesInFlight.delete(key);
  });
  xdgOpenSwitchesInFlight.set(key, shared);
  return shared;
}

async function runProfileSwitchViaXdgOpen(target, deps = {}) {
  let url;
  try {
    url = buildProfileSwitchUrl(target?.id);
  } catch {
    return false;
  }
  if (typeof target?.userDataDir !== 'string' || !target.userDataDir) return false;
  const electron = deps.shell && deps.isPackaged !== undefined ? null : require('electron');
  const shell = deps.shell || electron.shell;
  const isPackaged = deps.isPackaged !== undefined ? deps.isPackaged : electron.app.isPackaged;
  const useXdgOpen = await shouldSwitchProfileViaXdgOpen({ ...deps, isPackaged });
  if (!useXdgOpen) return false;
  const sinceMs = (deps.now || Date.now)();
  try {
    await shell.openExternal(url);
  } catch {
    return false;
  }
  return (deps.waitForAck || waitForProfileSwitchAck)(target.userDataDir, sinceMs, deps.ackOptions);
}

module.exports = {
  PACKAGED_DESKTOP_NAME,
  PROFILE_SWITCH_ACK_DIR,
  PROFILE_SWITCH_ACK_TIMEOUT_MS,
  PROFILE_SWITCH_RECEIVE_TIMEOUT_MS,
  PROFILE_SWITCH_MIME_TYPE,
  PROFILE_SWITCH_SCHEME,
  buildProfileSwitchUrl,
  desktopEntryDirs,
  desktopEntryRunsThisApp,
  execProgram,
  isProfileSwitchArg,
  parseProfileSwitchArgv,
  parseDesktopEntryExec,
  parseProfileSwitchUrl,
  profileSwitchStateSince,
  queryDefaultSchemeHandler,
  readProfileSwitchAck,
  readProfileSwitchAcks,
  readProfileSwitchAckTime,
  shouldSwitchProfileViaXdgOpen,
  switchProfileViaXdgOpen,
  waitForProfileSwitchAck,
  writeProfileSwitchAck,
};
