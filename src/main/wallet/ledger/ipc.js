/**
 * Ledger IPC handlers.
 *
 * Device discovery for the "Connect hardware wallet" flow. Adding the
 * chosen account to the wallet list goes through identity-manager's
 * `wallet:add-ledger-wallet` handler, next to the other wallet-list
 * mutations.
 *
 * With FREEDOM_LEDGER_BACKEND=core (ledger-backend-kind.js; freedom-core
 * design 0016, LDG-3), discovery is the core's `ledger.accounts`
 * (core-accounts.js), which also checks the unmatched Ledger records and
 * keeps each result itself, so account-checks.js isn't run. On the JS
 * backend, nothing changes.
 *
 * The chrome's report and Cancel for the hash-only warning over a tab
 * (hash-only-warning.js; freedom-core design 0016, Q23; LDG-3's PR 11) are
 * registered here too, whichever backend runs: on `js` main never shows the
 * notice, and a report names none.
 */

const { ipcMain } = require('electron');
const { listAccounts } = require('./transport');
const { checkLedgerAccounts } = require('./account-checks');
const { ledgerBackendKind } = require('./ledger-backend-kind');
const { registerHashOnlyIpc } = require('./hash-only-warning');

function registerLedgerIpc() {
  registerHashOnlyIpc(ipcMain);

  // Requires an attached, unlocked device with the Ethereum app open;
  // errors carry a stable LEDGER_* code the renderer turns into
  // instructions ("plug it in", "open the app", …). The connect screen
  // polls this while waiting for the user to get the device ready.
  //
  // The connected device also checks the Ledger records no device has
  // matched yet (#1065); the ones it doesn't hold come back as
  // `mismatched`, for the chrome to tell the user. A failed check leaves
  // them as they were and doesn't fail discovery.
  ipcMain.handle('ledger:get-accounts', async (_event, options = {}) => {
    if (ledgerBackendKind() === 'core') return discoverThroughCore(options);
    try {
      const accounts = await listAccounts(options);
      let mismatched = [];
      try {
        mismatched = await checkLedgerAccounts();
      } catch (err) {
        console.warn('[LedgerIPC] Account check failed:', err.message);
      }
      return { success: true, accounts, mismatched };
    } catch (err) {
      console.error('[LedgerIPC] Account discovery failed:', err.message);
      return { success: false, error: err.message, code: err.code };
    }
  });
}

/**
 * Discovery on the core's backend: the same answer, each account with the
 * scheme and index the chrome adds it by (`ledger.add`), the check's
 * `mismatched` the core's.
 */
async function discoverThroughCore(options) {
  try {
    const { discoverAccounts } = require('./core-accounts');
    const { accounts, mismatched } = await discoverAccounts(options);
    return { success: true, accounts, mismatched };
  } catch (err) {
    console.error('[LedgerIPC] Account discovery failed:', err.message);
    return { success: false, error: err.message, code: err.code };
  }
}

module.exports = { registerLedgerIpc };
