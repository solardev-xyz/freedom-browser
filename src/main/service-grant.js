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
 * - **Whatever the profile's source:** this profile's userData directory and
 *   its browser storage are protected for a catalog profile, a
 *   `--profile-dir` one and a test's (`FREEDOM_TEST_USER_DATA`) alike. Only
 *   the other profiles and the short Radicle homes come from the catalog.
 * - **Ownership is by layout, comparison by canonical path:** which
 *   directory holds this profile, or is the service's own default one, is
 *   decided on the paths main lays out, before any symlink is followed. So
 *   a default directory that is a symlink into another owner's data
 *   exempts nothing there. The service's own default directory must not
 *   resolve into a protected root either: that is refused, as a grant there
 *   would be, even when the grant is elsewhere.
 * - **Compared as canonical paths:** absolute, symlinks resolved through the
 *   longest prefix that exists, and on macOS and Windows case folded. Their
 *   volumes are case-insensitive by default, and folding a case-sensitive
 *   one only makes the check stricter. So an override (`FREEDOM_IPFS_DATA`),
 *   a symlink alias or a case alias can't widen a grant over a root. A
 *   name that begins with two dots, such as `..vault`, is an ordinary name.
 * - **On a case-insensitive volume,** a path whose names that don't exist
 *   yet aren't all ASCII is refused: such a volume folds case by Unicode
 *   rules, which no string comparison here reproduces (these are
 *   developer overrides, `FREEDOM_*_DATA`).
 * - **No hard link in the grant:** a file in it with more than one name is
 *   refused (`hardLinkRefusal`), since a link has the grant's path and
 *   another file's data. The check runs at each spawn; the confined
 *   service can't make a link to a file outside its grant, and a link made
 *   later by another process of the same user is outside the boundary,
 *   since that process could read the data directly. Bind mounts are out
 *   of scope.
 * - **A directory that can't be listed** while it is split throws: the
 *   caller refuses the grant (fails closed).
 *
 * A refusal names the root's kind, never a path.
 */

const fs = require('fs');
const path = require('path');
const { getActiveProfile } = require('./profile-resolver');
const { getComponentDataDirs, getProfileUserDataDir } = require('./profile-paths');
const { listProfileDataDirs } = require('./profile-catalog');
const { getLockDir } = require('./service-locks');

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** `target` absolute, its longest existing prefix resolved through its
 * symlinks (`realpath`), and the rest appended. */
function realPath(target) {
  const { real, rest } = resolveParts(target);
  return path.join(real, ...rest);
}

/** `target`'s longest existing prefix, resolved (`real`), and the names
 * after it that don't exist yet (`rest`). */
function resolveParts(target) {
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
  return { real, rest };
}

/**
 * Whether `target` can't be compared on a case-insensitive volume: a name
 * that doesn't exist yet and isn't ASCII. Such a volume folds case by
 * Unicode rules (Σ and ς name one directory there), which `toLowerCase`
 * doesn't reproduce, and no `realpath` can resolve a name that doesn't
 * exist. Names that exist are resolved, so only the missing ones count.
 */
function uncomparable(target, foldCase) {
  if (!foldCase) return false;
  // eslint-disable-next-line no-control-regex
  return resolveParts(target).rest.some((name) => /[^\x00-\x7f]/.test(name));
}

function fold(target, foldCase) {
  return foldCase ? target.normalize('NFC').toLowerCase() : target;
}

/** `target` as the check compares it: its real path, folded when
 * `foldCase`. */
function canonical(target, { foldCase = FOLD_CASE } = {}) {
  return fold(realPath(target), foldCase);
}

/** Whether `child` lies strictly inside `parent`, both absolute: a
 * relative path from one to the other that climbs out is exactly `..` or
 * begins with `..` and a separator, never a name such as `..vault`. */
function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** How `grant` relates to `root`, both canonical: `equal`, `inside`,
 * `contains`, or null when neither holds the other. */
function relation(grant, root) {
  if (grant === root) return 'equal';
  if (within(grant, root)) return 'inside';
  if (within(root, grant)) return 'contains';
  return null;
}

const RELATION_TEXT = { equal: 'is', inside: 'lies inside', contains: 'contains' };

/**
 * Why `grants` may not be given, or null: the first grant that is,
 * contains, or lies inside one of `roots` (`{ name, dir }`), named by the
 * root's `name` and the relation, never by a path.
 */
function grantRefusal(grants, roots, options = {}) {
  const foldCase = options.foldCase ?? FOLD_CASE;
  const present = roots.filter((root) => root.dir);
  // On a case-insensitive volume, a missing name that isn't ASCII can't be
  // compared: refused, failing closed (these are developer overrides).
  if ([...grants, ...present.map((root) => root.dir)].some((p) => uncomparable(p, foldCase))) {
    return "a path holds a name that doesn't exist yet and isn't ASCII, which this volume's case folding can't be compared by";
  }
  const protectedRoots = present.map((root) => ({
    name: root.name,
    dir: canonical(root.dir, options),
  }));
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

/** `target` as main lays it out: absolute, its symlinks not followed,
 * folded when `foldCase`. Ownership is decided on these. */
function layout(target, foldCase) {
  return fold(path.resolve(target), foldCase);
}

/**
 * `dir` as protected roots: the whole directory, named `whole`; or, when it
 * holds one of `keep` by layout (`layout` paths), its entries instead,
 * recursively, each named `nameOf(entry)`, with `known` names added at
 * this level. A directory that is one of `keep` gives none. Each root is
 * compared later as a canonical path, so an entry that is a symlink
 * protects what it resolves to.
 */
function splitRoots(dir, { whole, nameOf, keep, known = [], foldCase = FOLD_CASE }) {
  if (!dir) return [];
  const resolved = path.resolve(dir);
  const key = fold(resolved, foldCase);
  if (keep.includes(key)) return [];
  if (!keep.some((kept) => within(kept, key))) return [{ name: whole, dir: resolved }];
  const names = new Set([...known, ...entries(resolved)]);
  return [...names].flatMap((entry) =>
    splitRoots(path.join(resolved, entry), { whole: nameOf(entry), nameOf, keep, foldCase })
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

/** This profile, as `protectedRoots` lays it out: its userData directory,
 * whether it is a catalog profile, its components where it keeps them by
 * default, and the service's own default directories among them. */
function thisProfile(own) {
  const active = getActiveProfile();
  const mine = path.resolve(active?.userDataDir || getProfileUserDataDir());
  const catalog = Boolean(active?.source === 'catalog' && active.appRoot);
  const defaults = getComponentDataDirs(mine, {
    slot: catalog ? (active.metadata?.slot ?? null) : null,
  });
  return { active, mine, catalog, defaults, ownDirs: ownDefaults(defaults, own) };
}

/**
 * The roots a service's grant may not touch (see the module's doc), for the
 * service whose own components are `own` (excluded from this profile's).
 */
function protectedRoots({ own = [], foldCase = FOLD_CASE } = {}) {
  const { active, mine, catalog, defaults, ownDirs } = thisProfile(own);
  const ownKeys = ownDirs.map((dir) => layout(dir, foldCase));
  const mineKey = layout(mine, foldCase);
  // What a split leaves out, by layout: this profile, and the service's own
  // default directories.
  const keep = [mineKey, ...ownKeys];

  const roots = [{ name: 'the lock directory', dir: getLockDir() }];
  // This profile's components as resolved, overrides and its Radicle home
  // included.
  roots.push(...componentRoots(getComponentDataDirs(), "this profile's", own));

  const others = catalog
    ? listProfileDataDirs(active.appRoot).filter(({ dir }) => layout(dir, foldCase) !== mineKey)
    : [];
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
  const homes = catalog && defaults.radicleHome ? path.dirname(defaults.radicleHome) : null;
  roots.push(
    ...splitRoots(homes, {
      whole: 'the Radicle homes directory',
      nameOf: () => "another profile's Radicle home",
      keep,
      foldCase,
    })
  );
  // This profile's own userData directory, all but the service's own
  // default directory, whatever the profile's source.
  roots.push(
    ...splitRoots(mine, {
      whole: "this profile's directory",
      nameOf: entriesOf("this profile's"),
      keep: ownKeys,
      known: PROFILE_ENTRIES,
      foldCase,
    })
  );
  // The app data root: the catalog, and whatever else it holds.
  if (catalog) {
    roots.push(
      ...splitRoots(active.appRoot, {
        whole: 'the app data directory',
        nameOf: entriesOf("the app data directory's"),
        keep,
        foldCase,
      })
    );
  }
  return roots;
}

// How far the hard-link walk goes: past either bound, the grant is refused.
const MAX_GRANT_ENTRIES = 100_000;
const MAX_GRANT_DEPTH = 32;

/**
 * Why `grant` may not be given for what it already holds, or null: a file
 * in it with more than one name (`nlink` > 1). A hard link has the grant's
 * path but another file's data, possibly a protected one's, and Landlock
 * and Seatbelt authorize by the path an open uses. The walk uses `lstat`,
 * following no link, and is bounded: more than `maxEntries` entries, or
 * deeper than `maxDepth`, refuses; so does an entry that can't be read.
 * A grant that doesn't exist yet holds nothing.
 */
function hardLinkRefusal(
  grant,
  { maxEntries = MAX_GRANT_ENTRIES, maxDepth = MAX_GRANT_DEPTH } = {}
) {
  let root;
  try {
    root = fs.realpathSync.native(grant);
  } catch (err) {
    return err?.code === 'ENOENT' ? null : "the grant can't be read";
  }
  let seen = 0;
  const pending = [{ dir: root, depth: 0 }];
  while (pending.length > 0) {
    const { dir, depth } = pending.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return "the grant holds a directory that can't be read";
    }
    for (const name of names) {
      seen += 1;
      if (seen > maxEntries) return `the grant holds more than ${maxEntries} entries to check`;
      const entry = path.join(dir, name);
      let stat;
      try {
        stat = fs.lstatSync(entry);
      } catch {
        return "the grant holds an entry that can't be read";
      }
      if (stat.isDirectory()) {
        if (depth + 1 > maxDepth) return `the grant is deeper than ${maxDepth} levels to check`;
        pending.push({ dir: entry, depth: depth + 1 });
      } else if (!stat.isSymbolicLink() && stat.nlink > 1) {
        return 'the grant holds a hard link: a file with another name, possibly outside it';
      }
    }
  }
  return null;
}

/**
 * Why a service whose own components are `own` may not be given `grants`,
 * or null: a grant that is, contains, or lies inside a protected root; or
 * the service's own default directory resolving into one, which would hand
 * it another owner's data through the layout (refused even when the grant
 * is elsewhere).
 */
function serviceGrantRefusal(grants, { own = [], foldCase = FOLD_CASE, hardLinks = {} } = {}) {
  const roots = protectedRoots({ own, foldCase });
  const refused = grantRefusal(grants, roots, { foldCase });
  if (refused) return refused;
  for (const grant of grants) {
    const linked = hardLinkRefusal(grant, hardLinks);
    if (linked) return linked;
  }
  for (const dir of thisProfile(own).ownDirs) {
    const collision = grantRefusal([dir], roots, { foldCase });
    if (collision) {
      return `the service's own default directory resolves into a protected root (${collision.replace(
        /^the grant /,
        ''
      )})`;
    }
  }
  return null;
}

/**
 * Why freedom-ipfsd's persistent process may not be given `dataDir`, its
 * data directory (`<ipfs-data>/freedom-ipfs`), or null. This profile's IPFS
 * data directory is its own, so it isn't protected from it.
 */
function ipfsGrantRefusal(dataDir, options = {}) {
  return serviceGrantRefusal([dataDir], { ...options, own: ['ipfs'] });
}

module.exports = {
  BROWSER_STORAGE,
  canonical,
  relation,
  grantRefusal,
  protectedRoots,
  serviceGrantRefusal,
  hardLinkRefusal,
  ipfsGrantRefusal,
};
