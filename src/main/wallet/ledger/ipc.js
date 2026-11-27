/**
 * Ledger IPC handlers.
 *
 * Device discovery for the "Connect hardware wallet" flow. Adding the
 * chosen account to the wallet list goes through identity-manager's
 * `wallet:add-ledger-wallet` handler, next to the other wallet-list
 * mutations.
 */

const { ipcMain } = require('electron');
const { listAccounts } = require('./transport');
const { checkLedgerAccounts } = require('./account-checks');

function registerLedgerIpc() {
  // Requires an attached, unlocked device with the Ethereum app open;
  // errors carry a stable LEDGER_* code the renderer turns into
  // instructions ("plug it in", "open the app", …). The connect screen
  // polls this while waiting for the user to get the device ready.
  //
  // With `checkRecords: true`, the connected device also checks the
  // Ledger records no device has matched yet (#1065); the ones it doesn't
  // hold come back as `mismatched`, for the chrome to tell the user, and
  // `updated` says whether any record's state changed (a match included),
  // so the chrome reloads its wallet list and drops a stale "check this
  // owner" warning. A failed check leaves them as they were and doesn't fail discovery.
  // The check costs a second device session, so only Connect Hardware
  // Wallet's first page asks for it: a "Load more" page would re-read the
  // same records and repeat the notice, and the Safe board's warm
  // detection would wait on it before highlighting the row. Signing
  // records the result for a record anyway.
  ipcMain.handle('ledger:get-accounts', async (_event, options = {}) => {
    try {
      const { checkRecords = false, ...listOptions } = options || {};
      const accounts = await listAccounts(listOptions);
      let mismatched = [];
      let updated = false;
      if (checkRecords === true) {
        try {
          ({ mismatched, updated } = await checkLedgerAccounts());
        } catch (err) {
          console.warn('[LedgerIPC] Account check failed:', err.message);
        }
      }
      return { success: true, accounts, mismatched, updated };
    } catch (err) {
      console.error('[LedgerIPC] Account discovery failed:', err.message);
      return { success: false, error: err.message, code: err.code };
    }
  });
}

module.exports = { registerLedgerIpc };
