/**
 * What the user reads when the core refuses a step because of the key store
 * or the secrets file (freedom-core design 0013; the errors of cored 0.17.0,
 * freedom-core #385): quick unlock's enroll, unlock, exports and disable,
 * Quick Setup's create, a password change and a vault delete.
 *
 * The core answers these with a code, fixed-form `data` and a bare message
 * ("Storage error", "The key store is unavailable", "Cancelled"). Main
 * replaces the message with the cause and a way forward. Each of these
 * refusals comes before anything is written, so the vault, the secrets file
 * and the key store are as they were; the code and `data` stay on the error
 * for callers that branch on them.
 *
 * - `storage` with `data.file: "secrets"`, by `data.kind`: `malformed`,
 *   `not_regular`, `permission`, `no_space`, or `other`.
 * - `key_store_unavailable`, by `data.reason`: the core's own (`timeout`,
 *   `closed`, `no_executor`, `unsupported`, `forget_backlog`,
 *   `entry_refused`), the helper's (`no_keychain`, `read_only`), the
 *   trait's (`not_found`, `invalidated`, `denied`), and `backend` or
 *   `helper` for anything else.
 * - `key_store_cancelled`.
 */

const SECRETS_FILE = "this profile's Touch ID unlock file (secrets.json, in its identity folder)";
const MOVE_ASIDE =
  'You can also move the file out of that folder, which turns Touch ID unlock off for this profile: ' +
  'have your password or recovery phrase ready first.';

const STORAGE = new Map([
  [
    'malformed',
    `Freedom can't read ${SECRETS_FILE}: it is damaged, and Freedom won't write over it. ` +
      `Contact support. ${MOVE_ASIDE}`,
  ],
  [
    'not_regular',
    `Freedom can't read ${SECRETS_FILE}: it isn't a regular file, and Freedom won't replace it. ` +
      `Contact support. ${MOVE_ASIDE}`,
  ],
  [
    'permission',
    `Freedom isn't allowed to read or write ${SECRETS_FILE}. ` +
      'Give your user account read and write access to the file and its folder, then try again.',
  ],
  [
    'no_space',
    `The disk is full, so Freedom couldn't save ${SECRETS_FILE}. Free some space, then try again.`,
  ],
  [
    'other',
    `Freedom couldn't read or write ${SECRETS_FILE}. Try again, and contact support if it keeps failing.`,
  ],
]);

const DEAD_ITEM =
  'Unlock with your password instead. If you set up with Touch ID only, restore from your recovery phrase.';

const UNAVAILABLE = new Map([
  [
    'timeout',
    "The system keychain didn't answer in time. Try again, and answer any keychain prompt macOS shows.",
  ],
  ['closed', 'Freedom was interrupted while it used the system keychain. Try again.'],
  [
    'no_executor',
    "This copy of Freedom can't reach the system keychain. Restart Freedom, then try again.",
  ],
  [
    'unsupported',
    "This computer has no keychain Freedom can use for Touch ID unlock. If this profile's " +
      'Touch ID unlock was set up on a Mac, move secrets.json out of its identity folder to ' +
      'change the password here (Touch ID unlock is then off for this profile), or contact support.',
  ],
  [
    'no_keychain',
    'macOS has no default keychain for Freedom to use. ' +
      'Create or reset your login keychain in Keychain Access, then try again.',
  ],
  [
    'read_only',
    'Your default keychain is read-only. Make it writable in Keychain Access, then try again.',
  ],
  ['not_found', `Touch ID unlock's keychain item is missing. ${DEAD_ITEM}`],
  ['invalidated', `Touch ID unlock's keychain item is no longer valid. ${DEAD_ITEM}`],
  ['entry_refused', `Touch ID unlock's saved password doesn't open. ${DEAD_ITEM}`],
  [
    'denied',
    "The keychain refused Freedom access to Touch ID unlock's item. " +
      'Allow access in Keychain Access, then try again.',
  ],
  [
    'forget_backlog',
    'Freedom still has old keychain items to remove, and no room for a new one. ' +
      'Restart Freedom, then try again.',
  ],
  [
    'backend',
    'The system keychain reported an error. Try again, and contact support if it keeps failing.',
  ],
]);

const CANCELLED =
  'The keychain request was cancelled. Try again, and allow Freedom to use the keychain when macOS asks.';

/**
 * The message for a core error about the key store or the secrets file, or
 * null for any other error (whose message stays the core's).
 * @param {string} code
 * @param {object} [data]
 * @returns {string|null}
 */
function keyStoreMessage(code, data) {
  if (code === 'key_store_cancelled') return CANCELLED;
  if (code === 'key_store_unavailable') {
    return UNAVAILABLE.get(data?.reason) ?? UNAVAILABLE.get('backend');
  }
  if (code === 'storage' && data?.file === 'secrets') {
    return STORAGE.get(data.kind) ?? STORAGE.get('other');
  }
  return null;
}

module.exports = { keyStoreMessage };
