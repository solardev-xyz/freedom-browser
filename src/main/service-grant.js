/**
 * Main's check before it spawns a confined service (freedom-core design
 * 0010, "The recommendation", step 7): a grant, the directory the service
 * may write, may not be, contain, or lie inside a protected root.
 *
 * - **The protected roots:** the lock directory; this profile's identity
 *   directory and every other component's data directory (Bee, Ant, IPFS,
 *   Myotis, Tor, Radicle, and the catalog's short Radicle homes); and every
 *   other profile's userData root. A profile whose root holds this one's,
 *   the default profile kept in the app data root itself, has its
 *   components' directories protected instead, since its whole root would
 *   hold every grant.
 * - **The service's own directory is the grant, never a protected root:**
 *   for freedom-ipfsd, this profile's IPFS data directory.
 * - **Compared as canonical paths:** absolute, symlinks resolved through the
 *   longest prefix that exists, and on macOS and Windows case folded. Their
 *   volumes are case-insensitive by default, and folding a case-sensitive
 *   one only makes the check stricter. So an override (`FREEDOM_IPFS_DATA`),
 *   a symlink alias or a case alias can't widen a grant over a root.
 *
 * A refusal names the root's kind, never a path.
 */

const fs = require('fs');
const path = require('path');
const { getActiveProfile } = require('./profile-resolver');
const { getComponentDataDirs } = require('./profile-paths');
const { listProfileUserDataDirs } = require('./profile-catalog');
const { getLockDir } = require('./service-locks');

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * `target` as the check compares it: absolute, its longest existing prefix
 * resolved through its symlinks (`realpath`), the rest appended, and folded
 * when `foldCase`.
 */
function canonical(target, { foldCase = FOLD_CASE } = {}) {
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
  const joined = path.join(real, ...rest);
  return foldCase ? joined.normalize('NFC').toLowerCase() : joined;
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

// How a refusal names each component's directory (`getComponentDataDirs`).
const COMPONENT_NAMES = Object.freeze({
  identity: 'identity directory',
  bee: 'Bee data directory',
  ant: 'Ant data directory',
  ipfs: 'IPFS data directory',
  myotis: 'Myotis data directory',
  tor: 'Tor data directory',
  radicle: 'Radicle data directory',
  radicleHomes: 'Radicle homes directory',
});

/** A profile's components, by kind: `<label> <component>` roots, without
 * those in `except`. */
function componentRoots(dirs, label, except = []) {
  return Object.entries(dirs)
    .filter(([component]) => !except.includes(component))
    .map(([component, dir]) => ({
      name: `${label} ${COMPONENT_NAMES[component] ?? `${component} directory`}`,
      dir,
    }));
}

/**
 * The roots a service's grant may not touch (see the module's doc), for the
 * service whose own components are `own` (excluded from this profile's).
 */
function protectedRoots({ own = [] } = {}) {
  const roots = [{ name: 'the lock directory', dir: getLockDir() }];
  roots.push(...componentRoots(getComponentDataDirs(), "this profile's", own));
  const active = getActiveProfile();
  if (active?.source !== 'catalog' || !active.appRoot || !active.userDataDir) return roots;
  const mine = canonical(active.userDataDir);
  for (const dir of listProfileUserDataDirs(active.appRoot)) {
    const theirs = canonical(dir);
    if (theirs === mine) continue;
    if (relation(mine, theirs) === 'inside') {
      // The default profile, in the app data root: its components alone.
      roots.push(...componentRoots(getComponentDataDirs(dir), "another profile's"));
    } else {
      roots.push({ name: "another profile's directory", dir });
    }
  }
  return roots;
}

/**
 * Why freedom-ipfsd's persistent process may not be given `dataDir`, its
 * data directory (`<ipfs-data>/freedom-ipfs`), or null. This profile's IPFS
 * data directory is its own, so it isn't protected from it.
 */
function ipfsGrantRefusal(dataDir) {
  return grantRefusal([dataDir], protectedRoots({ own: ['ipfs'] }));
}

module.exports = { canonical, relation, grantRefusal, protectedRoots, ipfsGrantRefusal };
