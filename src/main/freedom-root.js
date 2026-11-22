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
 * The move itself is PRF-9's: main runs `profile migrate` at a start of an
 * idle profile in the root layout (profile-resolver.js's
 * `startProfileMove`, from index.js), before anything reads the profile.
 * Until then index.js holds this module (`holdFreedomRoot`): a read of the
 * Freedom root before the move has settled throws rather than pinning the
 * root layout, and `resetFreedomRoot` lets reads resolve again once it has.
 */

const fs = require('fs');
const path = require('path');

const FREEDOM_DIR = 'freedom';
/** The move's marker: present once every entry is in `freedom/`. */
const LAYOUT_MARKER = 'layout.json';
/** The move's journal: present while a move is unsettled. */
const MOVE_JOURNAL = '.move.json';
/** The regular file a move leaves at the root's `identity`, saying where the
 * data went; the one moved name found at the root once a move is done. */
const PLACEHOLDER = 'identity';

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

/** `target` with every link on its way resolved, as far as it exists: the
 * realpath of its deepest existing ancestor, and the rest as written. */
function resolveExisting(target) {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Every form of `target` with links followed up to one of its components
 * and none past it: the lexical path (path.resolve only), each partial
 * resolution, and the full one (resolveExisting). */
function partlyResolved(target) {
  const lexical = path.resolve(target);
  const { root } = path.parse(lexical);
  const parts = lexical.slice(root.length).split(path.sep).filter(Boolean);
  const forms = new Set([lexical]);
  for (let index = 1; index <= parts.length; index += 1) {
    const prefix = path.join(root, ...parts.slice(0, index));
    forms.add(path.join(resolveExisting(prefix), ...parts.slice(index)));
  }
  return [...forms];
}

/**
 * The entry of MOVED_ENTRIES at the root of the profile at `userDataDir`
 * that `target` is, or is inside, or null: a component's data-directory
 * override there would be left behind by the move, its node's state split
 * between the old path and `freedom/`. It fails closed: `target` counts as
 * inside when any of its forms is (partlyResolved: lexical, resolved, and
 * resolved only up to each of its components), against the profile's
 * directory as written or resolved. The lexical form catches an entry that
 * is itself a link to outside storage (the move takes the link, and the
 * override would name the root path it left); the resolved one a link from
 * outside into an entry; the partial ones the two together, an alias of the
 * profile leading to a linked entry.
 * Names compare as the core compares them: exactly on Linux, folded on
 * macOS and Windows (folding where unsure only finds more). Anything under
 * `<userDataDir>/freedom/`, or outside the profile, is null.
 */
function movedEntryContaining(userDataDir, target, { platform = process.platform } = {}) {
  const folds = platform === 'darwin' || platform === 'win32';
  const fold = (text) => (folds ? text.normalize('NFC').toLowerCase() : text);
  const entryAt = (root, place) => {
    const relative = path.relative(fold(root), fold(place));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const first = relative.split(path.sep)[0];
    return MOVED_ENTRIES.find((name) => fold(name) === first) || null;
  };
  const roots = [path.resolve(userDataDir), resolveExisting(userDataDir)];
  for (const place of partlyResolved(target)) {
    for (const root of roots) {
      const entry = entryAt(root, place);
      if (entry) return entry;
    }
  }
  return null;
}

// The Freedom root of the profile this process runs, resolved once.
let active = null;
// Set from main's start until its profile's layout has settled (index.js).
let held = false;

/**
 * Until resetFreedomRoot, a read of this process's Freedom root throws: main
 * holds it from its start until the move (or its recovery) has settled, so
 * nothing reads the profile in a layout about to change (0013, MG5: the
 * packaged default profile's userData is set before any app.setPath).
 */
function holdFreedomRoot() {
  held = true;
  active = null;
}

/** Forgets the resolved Freedom root and ends the hold: the next read
 * resolves the layout the move left. */
function resetFreedomRoot() {
  held = false;
  active = null;
}

/**
 * Where this process's profile keeps its Freedom-owned entries:
 * `<userData>/freedom/` once a move has finished, `<userData>` before.
 * Resolved once for the profile (a later `app.setPath('userData')`, which
 * only tests make, resolves again): main settles the move before anything
 * reads the profile (index.js), and the layout can't change while main
 * holds the profile. Throws while held (holdFreedomRoot).
 */
function getFreedomDataDir() {
  if (held) {
    const error = new Error("The profile's Freedom root was read before its move settled");
    error.code = 'FREEDOM_ROOT_UNSETTLED';
    throw error;
  }
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
  PLACEHOLDER,
  getFreedomDataDir,
  getFreedomDataPath,
  holdFreedomRoot,
  movedEntryContaining,
  profileLayout,
  resetFreedomRoot,
  resolveFreedomRoot,
};
