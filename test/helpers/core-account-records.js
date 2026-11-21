/**
 * The real freedom-cored's own account records for a test's world
 * (freedom-core G20, G20b, cored 0.25.0). Once the hello names `vault_meta`
 * in `store_moved` (this build's, from PRF-6(a)), the core reads its own
 * `vault-meta.json` rather than main's word: an account's kind and address
 * for `approval.issue`, `approval.check`, `x402.authorize` and `phone.job`,
 * the accounts `sign.*` signs for, and the `wallets` and `active` of every
 * page request's world, which replace main's.
 *
 * In the app the two always agree: main's wallet list is the core's
 * (identity-manager.js reads and writes every account through `accounts.*`).
 * A suite that gives main a world of its own (`getDerivedWallets`) seeds
 * the same accounts here, as the reference identity-manager.js (an older
 * build, test/helpers/reference-vault-meta.js) stores them, so main's world
 * and the core's records name the same accounts.
 *
 * The records are written straight to the file, as an older build writes
 * it, not through `accounts.add_*`: the worlds hold what those refuse (a
 * Safe below the hardware range, one owner of one, a Ledger and a phone at
 * one address, mnemonic accounts with no vault to derive them).
 */
const fs = require('fs');
const path = require('path');

const FILE = 'vault-meta.json';
const HARDWARE_INDEX_BASE = 1000000;

/**
 * One world entry (`getDerivedWallets`' shape) as vault-meta.json stores
 * it: a Safe's `deployed` chains as the verified mark (`{ verified: true }`,
 * deployed-mark.js), and only the fields the reference keeps.
 */
function storedRecord(wallet) {
  const record = { index: wallet.index, name: wallet.name, address: wallet.address };
  if (wallet.type && wallet.type !== 'mnemonic') record.type = wallet.type;
  for (const field of ['path', 'addressCheck', 'owners', 'threshold', 'saltNonce']) {
    if (wallet[field] !== undefined) record[field] = wallet[field];
  }
  if (wallet.deployed) {
    record.deployed = Object.fromEntries(
      Object.entries(wallet.deployed)
        .filter(([, mark]) => mark === true || mark?.verified === true)
        .map(([chainId]) => [chainId, { verified: true }])
    );
  }
  return record;
}

/**
 * Writes `wallets` (a world's list) into `<identityDir>/vault-meta.json`
 * as its wallet list, with `active` as its active index (0 by default),
 * keeping what the file holds already (the vault's addresses a create or
 * an import wrote). Synchronous: for a test's setup, before the core
 * starts or while it is idle.
 */
function writeAccountRecords(identityDir, wallets, { active = 0 } = {}) {
  const file = path.join(identityDir, FILE);
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const hardware = wallets.map((wallet) => wallet.index).filter((index) => index >= HARDWARE_INDEX_BASE);
  const next = {
    ...meta,
    derivedWallets: wallets.map(storedRecord),
    activeWalletIndex: active,
  };
  if (hardware.length) next.nextHardwareWalletIndex = Math.max(...hardware) + 1;
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * Seeds a started core's records with `wallets` (writeAccountRecords) and
 * has it take its snapshot of them: the core takes one after every
 * `accounts.*` request, so a read (`accounts.list`) does. Resolves to the
 * core's list, which the test may compare with its world.
 * @param {{ request: Function } | Function} client - the core's client, or its `request`
 */
async function seedAccountRecords(client, identityDir, wallets, options) {
  writeAccountRecords(identityDir, wallets, options);
  const request = typeof client === 'function' ? client : client.request.bind(client);
  const { wallets: listed } = await request('accounts.list', {}, { caller: 'shell' });
  return listed;
}

module.exports = { seedAccountRecords, writeAccountRecords, storedRecord };
