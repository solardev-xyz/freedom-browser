/**
 * The per-user lock directory every Freedom build shares (freedom-core
 * designs 0001 and 0007, "Lifetime lock"): freedom-cored's gates and
 * freedom-ipfsd's live in it, each under its own name prefix. It is never
 * deleted.
 */

const path = require('path');
const { app } = require('electron');

function getLockDir() {
  return path.join(app.getPath('appData'), 'Freedom', 'locks');
}

module.exports = { getLockDir };
