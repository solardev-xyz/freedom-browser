/**
 * Main's check before it spawns a confined service (freedom-core design
 * 0010, "The recommendation", step 7): a grant, the directory the service
 * may write, may not be, contain, or lie inside a protected root.
 *
 * - **The protected roots:**
 *   - the lock directory;
 *   - every catalog profile's component directories as main resolves them,
 *     outside its userData directory too: each profile's short Radicle home
 *     (`<appRoot>/R/<slot>`, or `<parent of appRoot>/R/<hash>/<slot>` in a
 *     development build), and this profile's overrides
 *     (`FREEDOM_IDENTITY_DATA`, …);
 *   - every other profile's whole userData directory, this profile's
 *     userData directory, the app data root (which holds the catalog), and
 *     the directory of the short Radicle homes.
 * - **A root that holds this profile is split:** a directory that holds this
 *   profile's userData directory, or the service's own default directory,
 *   is never a root itself. Its entries are, recursively along that path;
 *   at a profile's root, so are the names that may not exist yet, each
 *   component's directory and the browser's storage. So the default
 *   profile, kept in the app data root itself, has its browser storage,
 *   identity and node directories protected, and the `Profiles` directory
 *   that holds the profile in use has every other profile in it protected.
 *   This profile's own userData directory gives up only the service's own
 *   default directory (`ipfs-data` for freedom-ipfsd).
 * - **Compared as canonical paths:** absolute, symlinks resolved through the
 *   longest prefix that exists, and on macOS and Windows case folded. Their
 *   volumes are case-insensitive by default, and folding a case-sensitive
 *   one only makes the check stricter. So an override (`FREEDOM_IPFS_DATA`),
 *   a symlink alias or a case alias can't widen a grant over a root.
 * - **A directory that can't be listed** while it is split throws: the
 *   caller refuses the grant (fails closed).
 *
 * A refusal names the root's kind, never a path.
 */

const fs = require('fs');
const path = require('path');
const { getActiveProfile } = require('./profile-resolver');
const { getComponentDataDirs } = require('./profile-paths');
const { listProfileDataDirs } = require('./profile-catalog');
const { getLockDir } = require('./service-locks');

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** `target` absolute, its longest existing prefix resolved through its
 * symlinks (`realpath`), and the rest appended. */
function realPath(target) {
  let rest = [];
  let prefix = path.resolve(target);
  let real;
  for (;;) {
    try {
      real = fs.realpathSync.native(prefix);
      break;
    } catch {
      const parent = path.dirname(prefix);
      if (parent === prefix) {
        real = prefix;
        break;
      }
      rest = [path.basename(prefix), ...rest];
      prefix = parent;
    }
  }
  return path.join(real, ...rest);
}

function fold(target, foldCase) {
  return foldCase ? target.normalize('NFC').toLowerCase() : target;
}

/** `target` as the check compares it: its real path, folded when
 * `foldCase`. */
function canonical(target, { foldCase = FOLD_CASE } = {}) {
  return fold(realPath(target), foldCase);
}

/** How `grant` relates to `root`, both canonical: `equal`, `inside`,
 * `contains`, or null when neither holds the other. */
function relation(grant, root) {
  if (grant === root) return 'equal';
  const inside = path.relative(root, grant);
  if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) return 'inside';
  const contains = path.relative(grant, root);
  if (contains && !contains.startsWith('..') && !path.isAbsolute(contains)) return 'contains';
  return null;
}

const RELATION_TEXT = { equal: 'is', inside: 'lies inside', contains: 'contains' };

/**
 * Why `grants` may not be given, or null: the first grant that is,
 * contains, or lies inside one of `roots` (`{ name, dir }`), named by the
 * root's `name` and the relation, never by a path.
 */
function grantRefusal(grants, roots, options = {}) {
  const protectedRoots = roots
    .filter((root) => root.dir)
    .map((root) => ({ name: root.name, dir: canonical(root.dir, options) }));
  for (const grant of grants) {
    const dir = canonical(grant, options);
    for (const root of protectedRoots) {
      const how = relation(dir, root.dir);
      if (how) return `the grant ${RELATION_TEXT[how]} ${root.name}`;
    }
  }
  return null;
}

// How a refusal names each component's directory (`getComponentDataDirs`),
// and the entry it has at a profile's root by default.
const COMPONENTS = Object.freeze({
  identity: ['identity', 'identity directory'],
  bee: ['bee-data', 'Bee data directory'],
  ant: ['ant-data', 'Ant data directory'],
  ipfs: ['ipfs-data', 'IPFS data directory'],
  myotis: ['myotis', 'Myotis data directory'],
  tor: ['tor-data', 'Tor data directory'],
  radicle: ['radicle-data', 'Radicle data directory'],
  radicleHome: [null, 'Radicle home'],
});
const ENTRY_NAMES = new Map(
  Object.values(COMPONENTS)
    .filter(([entry]) => entry)
    .map(([entry, name]) => [entry, name])
);

// The browser's own storage at a profile's root (Chromium's, under
// Electron's userData directory), protected before it exists.
const BROWSER_STORAGE = Object.freeze([
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Service Worker',
  'Network',
  'Partitions',
  'blob_storage',
  'databases',
  'File System',
  'WebStorage',
  'Shared Dictionary',
  'SharedStorage',
  'shared_proto_db',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Crashpad',
]);

/** The names that may not exist yet at a profile's root. */
const PROFILE_ENTRIES = Object.freeze([...ENTRY_NAMES.keys(), ...BROWSER_STORAGE]);

/** How a refusal names a profile's entry `entry`. */
function entryName(entry) {
  if (ENTRY_NAMES.has(entry)) return ENTRY_NAMES.get(entry);
  return BROWSER_STORAGE.includes(entry) ? 'browser storage' : 'data';
}

/** The entries of `dir`, a real path; none if it doesn't exist. Any other
 * error throws, so the check fails closed. */
function entries(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

/**
 * `dir` as protected roots: the whole directory, named `whole`; or, when it
 * holds one of `keep` (canonical paths), its entries instead, recursively,
 * each named `nameOf(entry)`, with `known` names added at this level. A
 * directory that is one of `keep` gives none.
 */
function splitRoots(dir, { whole, nameOf, keep, known = [], foldCase = FOLD_CASE }) {
  if (!dir) return [];
  const real = realPath(dir);
  const key = fold(real, foldCase);
  if (keep.includes(key)) return [];
  if (!keep.some((kept) => relation(kept, key) === 'inside')) return [{ name: whole, dir: real }];
  const names = new Set([...known, ...entries(real)]);
  return [...names].flatMap((entry) =>
    splitRoots(path.join(real, entry), { whole: nameOf(entry), nameOf, keep, foldCase })
  );
}

/** Names a split profile's entries as `owner`'s. */
const entriesOf = (owner) => (entry) => `${owner} ${entryName(entry)}`;

/** A profile's component directories as roots `<label> <component>`,
 * without those in `except`. */
function componentRoots(dirs, label, except = []) {
  return Object.entries(dirs)
    .filter(([component]) => {
      const own = component === 'radicleHome' ? 'radicle' : component;
      return !except.includes(own);
    })
    .map(([component, dir]) => ({
      name: `${label} ${COMPONENTS[component]?.[1] ?? `${component} directory`}`,
      dir,
    }));
}

/**
 * The service's own directories where the profile keeps them by default,
 * from `defaults` (`getComponentDataDirs(userDataDir, { slot })`): the
 * containers that are split, never protected whole.
 */
function ownDefaults(defaults, own) {
  const dirs = [];
  for (const component of own) {
    dirs.push(defaults[component]);
    if (component === 'radicle') dirs.push(defaults.radicleHome);
  }
  return dirs.filter(Boolean);
}

/**
 * The roots a service's grant may not touch (see the module's doc), for the
 * service whose own components are `own` (excluded from this profile's).
 */
function protectedRoots({ own = [], foldCase = FOLD_CASE } = {}) {
  const active = getActiveProfile();
  const catalog = active?.source === 'catalog' && active.appRoot && active.userDataDir;
  const mine = catalog ? active.userDataDir : null;
  const defaults = mine
    ? getComponentDataDirs(mine, { slot: active.metadata?.slot ?? null })
    : getComponentDataDirs();
  const ownDirs = ownDefaults(defaults, own).map((dir) => canonical(dir, { foldCase }));
  const mineKey = mine ? canonical(mine, { foldCase }) : null;
  const keep = mineKey ? [mineKey, ...ownDirs] : ownDirs;

  const roots = [{ name: 'the lock directory', dir: getLockDir() }];
  // This profile's components as resolved, overrides and its Radicle home
  // included.
  roots.push(...componentRoots(getComponentDataDirs(), "this profile's", own));
  if (!catalog) return roots;

  const others = listProfileDataDirs(active.appRoot).filter(
    ({ dir }) => canonical(dir, { foldCase }) !== mineKey
  );
  // Each other profile's Radicle home, outside its userData directory.
  for (const { dir, slot } of others) {
    roots.push({
      name: "another profile's Radicle home",
      dir: getComponentDataDirs(dir, { slot }).radicleHome,
    });
  }
  // Each other profile's userData directory: whole where it holds nothing
  // of this profile's, first, then those split around it.
  const split = [];
  for (const { dir } of others) {
    const parts = splitRoots(dir, {
      whole: "another profile's directory",
      nameOf: entriesOf("another profile's"),
      keep,
      known: PROFILE_ENTRIES,
      foldCase,
    });
    if (parts.length === 1 && parts[0].name === "another profile's directory") roots.push(...parts);
    else split.push(...parts);
  }
  roots.push(...split);
  // The short Radicle homes' directory: every profile's home in it.
  const homes = defaults.radicleHome ? path.dirname(defaults.radicleHome) : null;
  roots.push(
    ...splitRoots(homes, {
      whole: 'the Radicle homes directory',
      nameOf: () => "another profile's Radicle home",
      keep,
      foldCase,
    })
  );
  // This profile's own userData directory, all but the service's own
  // default directory.
  roots.push(
    ...splitRoots(mine, {
      whole: "this profile's directory",
      nameOf: entriesOf("this profile's"),
      keep: ownDirs,
      known: PROFILE_ENTRIES,
      foldCase,
    })
  );
  // The app data root: the catalog, and whatever else it holds.
  roots.push(
    ...splitRoots(active.appRoot, {
      whole: 'the app data directory',
      nameOf: entriesOf("the app data directory's"),
      keep,
      foldCase,
    })
  );
  return roots;
}

/**
 * Why freedom-ipfsd's persistent process may not be given `dataDir`, its
 * data directory (`<ipfs-data>/freedom-ipfs`), or null. This profile's IPFS
 * data directory is its own, so it isn't protected from it.
 */
function ipfsGrantRefusal(dataDir, options = {}) {
  return grantRefusal([dataDir], protectedRoots({ ...options, own: ['ipfs'] }), options);
}

module.exports = {
  BROWSER_STORAGE,
  canonical,
  relation,
  grantRefusal,
  protectedRoots,
  ipfsGrantRefusal,
};
