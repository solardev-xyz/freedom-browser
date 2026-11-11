/**
 * The check of Ledger records no device has matched yet (#1065).
 *
 * Records added before main read the address back from the device took
 * the chrome's word for it. When Connect Hardware Wallet loads its first
 * page of accounts (`ledger:get-accounts` with `checkRecords: true`), main
 * also reads the address at each such record's path from the device. The
 * Safe board's Ledger detection and "Load more" pages don't ask for this
 * check, so they leave records as they are. A match makes the record
 * `matched`. Otherwise it is `mismatched`:
 * kept, shown as such, and unable to own a Safe until a Ledger that holds
 * it is connected. Signing checks the device on every signature anyway.
 */

const { readAddresses } = require('./transport');
const {
  getLedgerRecordsToCheck,
  recordLedgerAddressCheck,
  ADDRESS_CHECK,
} = require('../../identity-manager');

/**
 * Check every Ledger record no device has matched against the attached
 * device, and keep the result on each record.
 *
 * @returns {Promise<{
 *   mismatched: Array<{index: number, name: string, address: string, path: string}>,
 *   updated: boolean,
 * }>} The records the device doesn't match, for the chrome to tell the
 *   user, and whether any record's stored state changed (an `unchecked`
 *   or `mismatched` record that is now `matched` included), so the chrome
 *   knows to reload its wallet list.
 */
async function checkLedgerAccounts() {
  const pending = getLedgerRecordsToCheck().filter(
    (record) => typeof record.path === 'string' && record.path && typeof record.address === 'string'
  );
  if (pending.length === 0) return { mismatched: [], updated: false };

  const addresses = await readAddresses(pending.map((record) => record.path));
  const mismatched = [];
  let updated = false;
  pending.forEach((record, i) => {
    const onDevice = addresses[i];
    const matched = typeof onDevice === 'string' && onDevice.toLowerCase() === record.address.toLowerCase();
    const state = recordLedgerAddressCheck(record.index, matched);
    if (state && state !== record.addressCheck) updated = true;
    if (state === ADDRESS_CHECK.MISMATCHED) {
      mismatched.push({ index: record.index, name: record.name, address: record.address, path: record.path });
    }
  });
  return { mismatched, updated };
}

module.exports = { checkLedgerAccounts };
