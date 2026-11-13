/**
 * A profile's Freedom root (freedom-core design 0013, 5.4b, "Readers, and the
 * downgrade"; the reader release, step PRF-4): `<profile>/freedom/` once
 * `freedom/layout.json`, the move's marker, is there, and the profile's
 * directory itself otherwise. Every path getter of a Freedom-owned entry
 * (`MOVED_ENTRIES`, the list `fc-profile` pins with vectors) resolves it,
 * once per profile: main settles a move's journal (`profile migrate
 * --finish-only`) before anything reads the profile, and the layout can't
 * change while main holds the profile. The shell's entries (Electron's and
 * Chromium's files, `profile.json`, the profile lock, the focus hand-off
 * files, `crash-reports/`, a non-catalog `radicle-data/`, …) stay at the
 * profile's root in both layouts.
 *
 * The move itself is PRF-9's: no build writes `freedom/` yet. This release
 * reads both layouts, so a build from it on opens a moved profile, and
 * finishes or rolls back a move a crash left half done.
 */

const fs = require('fs');
const path = require('path');

const FREEDOM_DIR = 'freedom';
/** The move's marker: present once every entry is in `freedom/`. */
const LAYOUT_MARKER = 'layout.json';
/** The move's journal: present while a move is unsettled. */
const MOVE_JOURNAL = '.move.json';

/**
 * What moves into `freedom/` (0013, "What moves"), as `fc-profile`'s
 * `MOVED_ENTRIES` lists it: a name this list doesn't know stays at the root.
 */
const MOVED_ENTRIES = Object.freeze([
  'identity',
  // Set A.
  'wallet-intents.jsonl',
  'safe-pending.json',
  'dapp-permissions.json',
  'swarm-permissions.json',
  'radicle-permissions.json',
  'x402-permissions.json',
  'phone-payments.json',
  'swarm-feeds.json',
  'swarm-manifest-grants.json',
  'rpc-api-keys.json',
  'payment-history.sqlite',
  'payment-history.sqlite-wal',
  'payment-history.sqlite-shm',
  'publish-history.sqlite',
  'publish-history.sqlite-wal',
  'publish-history.sqlite-shm',
  // Set B.
  'settings.json',
  'network-config.json',
  'custom-chains.json',
  'custom-tokens.json',
  'permissions.json',
  'adblock-allowlist.json',
  'external-node-decisions.json',
  'balance-cache.json',
  'chain-catalog.json',
  'swarm-browsing-credit.json',
  // The nodes' data, and antd's hand-off.
  'ant-data',
  'ipfs-data',
  'tor-data',
  'myotis',
  'bee-data',
  'run',
]);

/** Whether `target` is there, as a link or anything else (the core's
 * `symlink_metadata` test). */
function present(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** The Freedom root of the profile at `userDataDir`. */
function resolveFreedomRoot(userDataDir) {
  const freedom = path.join(userDataDir, FREEDOM_DIR);
  return present(path.join(freedom, LAYOUT_MARKER)) ? freedom : userDataDir;
}

/**
 * The profile's layout, as `profile open` reports it: `pending` while a
 * move's journal is there, `freedom` once its marker is, `root` otherwise.
 */
function profileLayout(userDataDir) {
  const freedom = path.join(userDataDir, FREEDOM_DIR);
  if (present(path.join(freedom, MOVE_JOURNAL))) return 'pending';
  if (present(path.join(freedom, LAYOUT_MARKER))) return 'freedom';
  return 'root';
}

// The Freedom root of the profile this process runs, resolved once.
let active = null;

/**
 * Where this process's profile keeps its Freedom-owned entries:
 * `<userData>/freedom/` once a move has finished, `<userData>` before.
 * Resolved once for the profile (a later `app.setPath('userData')`, which
 * only tests make, resolves again): main settles a move's journal before
 * anything reads the profile (index.js), and the layout can't change while
 * main holds the profile.
 */
function getFreedomDataDir() {
  const userDataDir = require('electron').app.getPath('userData');
  if (active?.userDataDir !== userDataDir) {
    active = { userDataDir, root: resolveFreedomRoot(userDataDir) };
  }
  return active.root;
}

/** A Freedom-owned entry of this process's profile, `name` under its Freedom
 * root. */
function getFreedomDataPath(name) {
  return path.join(getFreedomDataDir(), name);
}

module.exports = {
  FREEDOM_DIR,
  LAYOUT_MARKER,
  MOVED_ENTRIES,
  MOVE_JOURNAL,
  getFreedomDataDir,
  getFreedomDataPath,
  profileLayout,
  resolveFreedomRoot,
};
