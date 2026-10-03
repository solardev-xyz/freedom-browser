/** Main-only logical store ownership, including staged initialization and exit. */
const path = require('path');
const owners = new Map();
const fail = () =>
  Object.assign(new Error('Railgun account store is still owned'), {
    code: 'RAILGUN_ACCOUNT_STORE_BUSY',
  });
function claimRailgunAccountStore(filename) {
  if (owners.has(filename)) throw fail();
  const token = {};
  owners.set(filename, token);
  return () => {
    if (owners.get(filename) === token) owners.delete(filename);
  };
}
function assertRailgunAccountStoreDirectoryClosed(directory) {
  for (const filename of owners.keys()) if (path.dirname(filename) === directory) throw fail();
}
module.exports = { claimRailgunAccountStore, assertRailgunAccountStoreDirectoryClosed };
