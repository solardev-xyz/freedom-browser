/**
 * Vaughan IPC handlers.
 *
 * Account discovery for the "Connect Vaughan wallet" flow. Adding the chosen
 * account to the wallet list goes through identity-manager's
 * `wallet:add-vaughan-wallet` handler, next to the other wallet-list mutations.
 */

const { ipcMain } = require('electron');
const { rpcRequest } = require('./transport');
const { mapVaughanError } = require('./errors');

function registerVaughanIpc() {
  // Requires a running Vaughan provider on loopback with the wallet unlocked;
  // errors carry a stable VAUGHAN_* code the renderer turns into instructions
  // ("start Vaughan", "unlock the wallet", …).
  ipcMain.handle('vaughan:get-accounts', async () => {
    try {
      // Prefer the connect gesture so Vaughan may surface an unlock/connect UX.
      let accounts;
      try {
        accounts = await rpcRequest('eth_requestAccounts', []);
      } catch (err) {
        // Fall back to a read-only probe when the connect method is unavailable.
        if (err && err.eip1193Code === 4200) {
          accounts = await rpcRequest('eth_accounts', []);
        } else {
          throw err;
        }
      }
      const normalized = Array.isArray(accounts)
        ? accounts.filter((a) => typeof a === 'string' && a.length > 0)
        : [];
      return { success: true, accounts: normalized };
    } catch (err) {
      const mapped = mapVaughanError(err);
      console.error('[VaughanIPC] Account discovery failed:', mapped.message);
      return { success: false, error: mapped.message, code: mapped.code };
    }
  });
}

module.exports = { registerVaughanIpc };
