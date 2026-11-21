/**
 * Where a test finds a profile's Freedom-owned entry (freedom-core design
 * 0013; PRF-9 moves them into `<profile>/freedom/`): `name`, one of
 * freedom-root.js's `MOVED_ENTRIES`, under the Freedom root of the profile
 * at `userDataDir`, which `resolveFreedomRoot` finds by the move's marker as
 * main's getters do. Before a profile's first start there is no marker, so
 * a test seeds at the root and the move takes the entry along; after a
 * start, it reads or seeds where the app keeps the entry, in either layout.
 * Jest tests and Playwright specs both require it.
 */

const path = require('path');
const { MOVED_ENTRIES, resolveFreedomRoot } = require('../../src/main/freedom-root');

function freedomPath(userDataDir, name) {
  if (!MOVED_ENTRIES.includes(name)) {
    throw new Error(`freedomPath: ${name} isn't a moved entry; it stays at the profile's root`);
  }
  return path.join(resolveFreedomRoot(userDataDir), name);
}

module.exports = { freedomPath };
