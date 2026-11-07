/**
 * The check of Ledger records no device has matched yet (#1065).
 *
 * Records added before main read the address back from the device took
 * the chrome's word for it. The first time a Ledger is connected (account
 * discovery: the Connect Hardware Wallet screen, the Safe board's
 * detection), main also reads the address at each such record's path from
 * it. A match makes the record `matched`. Otherwise it is `mismatched`:
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
 * @returns {Promise<Array<{index: number, name: string, address: string, path: string}>>}
 *   The records the device doesn't match, for the chrome to tell the user.
 */
async function checkLedgerAccounts() {
  const pending = getLedgerRecordsToCheck().filter(
    (record) => typeof record.path === 'string' && record.path && typeof record.address === 'string'
  );
  if (pending.length === 0) return [];

  const addresses = await readAddresses(pending.map((record) => record.path));
  const mismatched = [];
  pending.forEach((record, i) => {
    const onDevice = addresses[i];
    const matched = typeof onDevice === 'string' && onDevice.toLowerCase() === record.address.toLowerCase();
    if (recordLedgerAddressCheck(record.index, matched) === ADDRESS_CHECK.MISMATCHED) {
      mismatched.push({ index: record.index, name: record.name, address: record.address, path: record.path });
    }
  });
  return mismatched;
}

module.exports = { checkLedgerAccounts };
