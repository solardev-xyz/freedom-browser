/**
 * The removed `ethereum-wallet` publisher identity mode (freedom-core
 * design 0002, "Accounts as feed owners", #89). A feed update's signature
 * is exactly an account's `personal_sign` of 32 bytes, so a key that
 * answers dApps' signing requests can't safely own a feed: only the Bee
 * wallet and per-origin publisher keys, which sign nothing else, do.
 *
 * The mode is never offered, created or signed with. An identity stored in
 * it still loads, and every use of it fails with this error. Nothing falls
 * back to another key: another key is another owner, and so another feed.
 */

const ETHEREUM_WALLET_MODE = 'ethereum-wallet';

const ETHEREUM_WALLET_UNAVAILABLE =
  "Ethereum wallet publisher identities aren't available. Choose another publisher identity.";

module.exports = { ETHEREUM_WALLET_MODE, ETHEREUM_WALLET_UNAVAILABLE };
