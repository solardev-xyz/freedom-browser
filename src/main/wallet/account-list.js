/**
 * The account list file (#1037): every wallet account's name and address,
 * plus the public details it takes to bring the account back on another
 * computer or after a reinstall. Never a key, the recovery phrase or its
 * passphrase, so the file can't restore funds on its own.
 *
 *   {
 *     "format": "freedom-account-list",
 *     "version": 1,
 *     "accounts": [
 *       { "type": "mnemonic", "name": "Main Wallet", "address": "0x…", "path": "m/44'/60'/0'/0/0" },
 *       { "type": "ledger", "name": "Ledger 1", "address": "0x…", "path": "44'/60'/0'/0/0" },
 *       { "type": "remote", "name": "Phone 1", "address": "0x…" },
 *       { "type": "safe", "name": "Joint", "address": "0x…",
 *         "owners": ["0x…", "0x…"], "threshold": 1, "saltNonce": "…" }
 *     ]
 *   }
 *
 * Safe owners are addresses, because wallet indexes only mean something on
 * the computer that made them. A Ledger's path is there for the user; import
 * never adds a device account.
 *
 * Importing goes through a session: main reads the file the user picked, and
 * the renderer only ever holds a token for it, so what gets imported is the
 * file that was previewed, read by main.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const { getAddress, isAddress } = require('ethers');

const { normalizeWalletPath } = require('../identity/derivation');
const {
  WALLET_TYPES,
  getDerivedWallets,
  previewAccountListImport,
  applyAccountListImport,
} = require('../identity-manager');

const ACCOUNT_LIST_FORMAT = 'freedom-account-list';
const ACCOUNT_LIST_VERSION = 1;
const INVALID_ACCOUNT_LIST = 'INVALID_ACCOUNT_LIST';

// A list this size is far beyond any real wallet; the limits only keep a
// stray large file from being read into memory and planned.
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ACCOUNTS = 1000;
// The longest name the wallet's name fields accept.
const MAX_NAME_LENGTH = 32;
// The largest uint256 has 78 digits.
const SALT_NONCE = /^\d{1,78}$/;
// Predicting a Safe's address asks the chain for the factory's code.
const SAFE_CHECK_TIMEOUT_MS = 20_000;
const MAX_SESSIONS = 4;

const FILE_FILTERS = [{ name: 'Account list', extensions: ['json'] }];

function invalidAccountList() {
  const err = new Error("This file isn't an account list from Freedom");
  err.code = INVALID_ACCOUNT_LIST;
  return err;
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// ============================================
// Export
// ============================================

/**
 * The account list for these wallets.
 *
 * @param {Array<Object>} wallets - From getDerivedWallets
 * @returns {{format: string, version: number, accounts: Array<Object>}}
 */
function buildAccountList(wallets) {
  const addressOf = new Map(wallets.map((wallet) => [wallet.index, wallet.address]));
  const accounts = [];
  for (const wallet of wallets) {
    // Only a pre-multi-wallet record, read while locked, has no address yet.
    if (!wallet.address) continue;
    const account = {
      type: wallet.type,
      name: wallet.name?.trim() || 'Unnamed account',
      address: getAddress(wallet.address),
    };
    if (wallet.type === WALLET_TYPES.MNEMONIC) {
      account.path = wallet.path || `m/44'/60'/${wallet.index}'/0/0`;
    } else if (wallet.type === WALLET_TYPES.LEDGER && wallet.path) {
      account.path = wallet.path;
    } else if (wallet.type === WALLET_TYPES.SAFE) {
      const owners = (wallet.owners || []).map((index) => addressOf.get(index));
      // An owner can't be deleted while its Safe exists; a Safe whose owners
      // are gone anyway couldn't be imported, so it isn't exported either.
      if (owners.length === 0 || owners.some((owner) => !owner)) continue;
      account.owners = owners.map((owner) => getAddress(owner));
      account.threshold = wallet.threshold;
      account.saltNonce = wallet.saltNonce;
    }
    accounts.push(account);
  }
  return { format: ACCOUNT_LIST_FORMAT, version: ACCOUNT_LIST_VERSION, accounts };
}

/** `freedom-accounts-2026-11-08.json`, by the local date. */
function defaultFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `freedom-accounts-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/**
 * Ask where to save the account list, and save it.
 *
 * @param {Electron.BrowserWindow|null} win - Window the save dialog belongs to
 * @returns {Promise<{canceled: true}|{fileName: string, count: number}>}
 */
async function exportAccountList(win) {
  const list = buildAccountList(await getDerivedWallets());
  if (list.accounts.length === 0) {
    throw new Error('There are no accounts to export');
  }
  const options = {
    title: 'Export Account List',
    defaultPath: path.join(app.getPath('downloads'), defaultFileName()),
    filters: FILE_FILTERS,
  };
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  await fs.promises.writeFile(result.filePath, `${JSON.stringify(list, null, 2)}\n`, 'utf-8');
  return { fileName: path.basename(result.filePath), count: list.accounts.length };
}

// ============================================
// Import
// ============================================

function parseName(value) {
  if (typeof value !== 'string') return null;
  const name = Array.from(value.trim()).slice(0, MAX_NAME_LENGTH).join('').trim();
  return name || null;
}

function parseAddress(value) {
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
}

function parseSafe(entry, base) {
  const { owners, threshold, saltNonce } = entry;
  if (!Array.isArray(owners)) return null;
  const ownerAddresses = owners.map(parseAddress);
  if (ownerAddresses.includes(null)) return null;
  if (new Set(ownerAddresses.map((owner) => owner.toLowerCase())).size !== owners.length) {
    return null;
  }
  // The two presets Freedom creates (see addSafeWallet).
  const preset =
    (owners.length === 2 && threshold === 1) || (owners.length === 3 && threshold === 2);
  if (!preset || typeof saltNonce !== 'string' || !SALT_NONCE.test(saltNonce)) {
    return null;
  }
  return { ...base, owners: ownerAddresses, threshold, saltNonce };
}

function parseAccount(entry) {
  if (!isPlainObject(entry) || !Object.values(WALLET_TYPES).includes(entry.type)) return null;
  const name = parseName(entry.name);
  const address = parseAddress(entry.address);
  if (!name || !address) return null;
  const base = { type: entry.type, name, address };
  switch (entry.type) {
    case WALLET_TYPES.MNEMONIC:
      try {
        return { ...base, path: normalizeWalletPath(entry.path) };
      } catch {
        return null;
      }
    case WALLET_TYPES.SAFE:
      return parseSafe(entry, base);
    default:
      return base;
  }
}

/**
 * Read an account list. Anything that isn't a whole, valid list made by
 * Freedom is refused as a whole, so a damaged file never half-imports.
 *
 * @param {string} text - File contents
 * @returns {Array<Object>} Accounts: type, name (trimmed), checksummed address,
 *   and the canonical path or the Safe's owners, threshold and saltNonce
 * @throws {Error} code INVALID_ACCOUNT_LIST
 */
function parseAccountList(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalidAccountList();
  }
  if (
    !isPlainObject(data) ||
    data.format !== ACCOUNT_LIST_FORMAT ||
    data.version !== ACCOUNT_LIST_VERSION ||
    !Array.isArray(data.accounts) ||
    data.accounts.length === 0 ||
    data.accounts.length > MAX_ACCOUNTS
  ) {
    throw invalidAccountList();
  }

  const accounts = data.accounts.map(parseAccount);
  if (accounts.includes(null)) {
    throw invalidAccountList();
  }
  const types = new Map();
  for (const account of accounts) {
    const key = account.address.toLowerCase();
    if (types.has(key)) throw invalidAccountList();
    types.set(key, account.type);
  }
  // Freedom never lets a Safe own another Safe.
  const safeOwnsSafe = accounts.some(
    (account) =>
      account.type === WALLET_TYPES.SAFE &&
      account.owners.some((owner) => types.get(owner.toLowerCase()) === WALLET_TYPES.SAFE)
  );
  if (safeOwnsSafe) {
    throw invalidAccountList();
  }
  return accounts;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Work out whether each Safe's address follows from its owners, threshold
 * and salt, the way Freedom made it. The prediction asks the user's own
 * Gnosis RPC for the factory's code, as creating a Safe does. A Safe that
 * can't be checked (no connection, a timeout) is left out of `checks`.
 *
 * @param {Array<Object>} safes - Safe accounts from parseAccountList
 * @param {Map<string, boolean>} checks - Filled in, by lowercased address
 */
async function checkSafeAddresses(safes, checks, { timeoutMs = SAFE_CHECK_TIMEOUT_MS } = {}) {
  if (safes.length === 0) return;
  // Lazy: the Safe stack loads protocol-kit.
  const { predictSafeAddress } = require('./safe/safe-executor');
  const { DEPLOY_CHAIN_ID } = require('./safe/safe-service');
  await Promise.all(
    safes.map(async (safe) => {
      try {
        const predicted = await withTimeout(
          predictSafeAddress({
            owners: safe.owners,
            threshold: safe.threshold,
            saltNonce: safe.saltNonce,
            chainId: DEPLOY_CHAIN_ID,
          }),
          timeoutMs
        );
        checks.set(
          safe.address.toLowerCase(),
          predicted.toLowerCase() === safe.address.toLowerCase()
        );
      } catch (err) {
        console.warn(`[AccountList] Couldn't check Safe ${safe.address}: ${err.message}`);
      }
    })
  );
}

// token -> { accounts, fileName, safeChecks }
const sessions = new Map();

function openSession(accounts, fileName) {
  const token = crypto.randomUUID();
  sessions.set(token, { accounts, fileName, safeChecks: new Map() });
  while (sessions.size > MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value);
  }
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) {
    throw new Error('This import has ended. Choose the file again.');
  }
  return session;
}

/**
 * Ask for an account list file and read it.
 *
 * @param {Electron.BrowserWindow|null} win - Window the open dialog belongs to
 * @returns {Promise<{canceled: true}|{token: string, fileName: string, count: number}>}
 * @throws {Error} code INVALID_ACCOUNT_LIST
 */
async function openAccountList(win) {
  const options = {
    title: 'Import Account List',
    properties: ['openFile'],
    filters: FILE_FILTERS,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const filePath = result.filePaths?.[0];
  if (result.canceled || !filePath) {
    return { canceled: true };
  }
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw invalidAccountList();
  }
  const accounts = parseAccountList(await fs.promises.readFile(filePath, 'utf-8'));
  const fileName = path.basename(filePath);
  return { token: openSession(accounts, fileName), fileName, count: accounts.length };
}

/**
 * What importing the opened file would do now. Safes that could be added
 * are checked against the chain first; a check that worked is kept for the
 * rest of the session, one that couldn't run is tried again next time.
 *
 * @param {string} token - From openAccountList
 * @returns {Promise<{fileName: string, count: number, rows: Array<Object>}>}
 */
async function previewImport(token) {
  const session = getSession(token);
  const preview = () =>
    previewAccountListImport(session.accounts, { safeChecks: session.safeChecks });
  let rows = await preview();
  const unchecked = new Set(
    rows.filter((row) => row.reason === 'safe-unchecked').map((row) => row.address.toLowerCase())
  );
  if (unchecked.size > 0) {
    const safes = session.accounts.filter((account) =>
      unchecked.has(account.address.toLowerCase())
    );
    await checkSafeAddresses(safes, session.safeChecks);
    rows = await preview();
  }
  return { fileName: session.fileName, count: session.accounts.length, rows };
}

/**
 * Import the opened file. Safes count as checked only if the preview
 * checked them, so the import never adds a Safe the preview didn't show.
 *
 * @param {string} token - From openAccountList
 * @returns {Promise<{rows: Array<Object>}>}
 */
async function importAccountList(token) {
  const session = getSession(token);
  const rows = await applyAccountListImport(session.accounts, { safeChecks: session.safeChecks });
  sessions.delete(token);
  return { rows };
}

module.exports = {
  ACCOUNT_LIST_FORMAT,
  ACCOUNT_LIST_VERSION,
  INVALID_ACCOUNT_LIST,
  buildAccountList,
  defaultFileName,
  parseAccountList,
  checkSafeAddresses,
  exportAccountList,
  openAccountList,
  previewImport,
  importAccountList,
};
