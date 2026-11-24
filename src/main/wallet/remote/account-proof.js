/**
 * Phone account check (#1078).
 *
 * A phone account's address reaches main from the chrome: the connect
 * screen relays what the phone answered to eth_requestAccounts. Main
 * doesn't take its word for it. It has the phone sign a challenge that
 * names the account and carries a fresh nonce, over the same per-request
 * session and QR panel as any phone signature, and recovers the signer
 * with the check every phone signature gets (./signer.js). The challenge
 * is built and checked within one call, so no earlier signature can
 * answer it.
 *
 * Adding an account needs the phone to sign as it; a record added before
 * this check is checked the same way when the user asks (Wallet
 * Settings), and by any signature main verifies for it (../signers.js).
 */

const { randomBytes } = require('crypto');

const { getAddress, verifyMessage } = require('ethers');

const { requestRemoteSignature } = require('./bridge');
const { REMOTE_ERROR_CODES } = require('./errors');
const { verifiedSignature } = require('./signer');
const { messageToBytes } = require('../signing-utils');

/** The job's purpose, for the QR panel's wording. */
const ACCOUNT_CHECK_PURPOSE = 'account-check';

/**
 * The text the phone is asked to sign: what it is for, the account, and
 * a nonce.
 *
 * @param {string} address
 * @param {string} nonce - 64 hex characters
 * @returns {string}
 */
function buildAccountChallenge(address, nonce) {
  return [
    'Freedom: confirm that this phone holds the account',
    getAddress(address),
    '',
    'Signing this only adds or checks the account in your Freedom wallet. It sends nothing and costs nothing.',
    '',
    `Nonce: ${nonce}`,
  ].join('\n');
}

/**
 * Ask the phone to sign a fresh challenge as `address`.
 *
 * @param {string} address - The account the phone must sign as
 * @param {number|null} [walletIndex] - Its record, when it has one
 * @returns {Promise<boolean>} true when the phone signed as the account,
 *   false when it answered from another one (REMOTE_WRONG_ACCOUNT)
 * @throws the bridge's REMOTE_* error, or a bad signature's, when no answer
 *   shows either (timeout, cancel, rejection on the phone, malformed reply)
 */
async function proveRemoteAccount(address, walletIndex = null) {
  const bytes = messageToBytes(buildAccountChallenge(address, randomBytes(32).toString('hex')));
  try {
    const signature = await requestRemoteSignature({
      walletIndex,
      address,
      method: 'personal_sign',
      params: ['0x' + bytes.toString('hex'), address],
      purpose: ACCOUNT_CHECK_PURPOSE,
    });
    verifiedSignature(address, signature, (sig) => verifyMessage(bytes, sig));
    return true;
  } catch (err) {
    if (err?.code === REMOTE_ERROR_CODES.WRONG_ACCOUNT) return false;
    throw err;
  }
}

module.exports = { proveRemoteAccount, buildAccountChallenge, ACCOUNT_CHECK_PURPOSE };
