/**
 * Signer factory.
 *
 * Resolves a wallet index to a signer object so callers never touch raw
 * private keys. The account's `type` (from vault-meta, see
 * identity-manager's WALLET_TYPES) picks the backend: vault-backed
 * mnemonic accounts sign locally with a borrowed key, Ledger accounts
 * sign on the device.
 *
 * Input normalization (0x-hex personal messages → raw bytes, JSON-string
 * typed data → object) happens once in the factory, so backends always
 * receive the same shapes. The EIP-712 payload keeps its full dApp wire
 * shape (EIP712Domain in types) because backends genuinely diverge there:
 * ethers wants the domain stripped, device backends (Ledger, phone) want
 * the canonical wire payload — both conversions live in ./signing-utils.js.
 *
 * Error contract: vault-locked errors keep their identity (check with
 * `isVaultLockedError`); hardware backends must surface user-rejection
 * distinctly so approval UIs can tell "declined on device" from failure.
 */

const { Transaction, getAddress, verifyMessage, verifyTypedData } = require('ethers');

const { withVaultAccount, isValidWalletIndex } = require('./vault-access');
const { getWalletRecord, isHardwareWalletIndex, WALLET_TYPES } = require('../identity-manager');
const { vaultBackend } = require('../core/vault-backend');
const { createLedgerBackend } = require('./ledger/signer');
const { createRemoteBackend } = require('./remote/signer');
const {
  normalizeMessage,
  normalizeTypedData,
  toCoreTypedData,
  toCoreTransaction,
} = require('./signing-utils');

/**
 * @typedef {Object} Signer
 * @property {() => Promise<string>} getAddress
 *   Checksummed address of the account (cached after first resolution).
 * @property {(tx: object) => Promise<string>} signTransaction
 *   Complete unsigned tx (nonce, gas, fees, chainId — no population) →
 *   serialized signed tx.
 * @property {(message: string|Uint8Array) => Promise<string>} signMessage
 *   EIP-191 signature over raw bytes (0x-hex is pre-decoded by the factory).
 * @property {(typedData: object) => Promise<string>} signTypedData
 *   EIP-712 signature; receives the parsed full payload
 *   ({domain, types, message}, EIP712Domain in types allowed).
 * @property {(tx: object) => Promise<string>} [sendTransaction]
 *   Optional capability: sign AND broadcast through the backend's own
 *   channel, returning the tx hash. Present when the backend cannot
 *   produce a raw signed tx (phone wallets expose eth_sendTransaction
 *   only); callers must prefer it over signTransaction+broadcast.
 */

function createVaultBackend(walletIndex) {
  // Public and immutable for the index; resolved through the core.
  let address = null;
  const ownAddress = async () => {
    if (address === null) {
      const derived = await vaultBackend.addresses({ accounts: [walletIndex] });
      address = derived.user_wallets[0].address;
    }
    return address;
  };
  // The core signs (freedom-core design 0002); main checks every result
  // with ethers before it leaves, so a core fault can't produce a signature
  // for something else or from another key.
  const mismatch = () => new Error('The identity core returned a signature that does not match');
  const wrapped = (label, err) =>
    err?.code === 'vault_locked' ? err : new Error(`${label}: ${err.message}`, { cause: err });
  return {
    getAddress: () => withVaultAccount(walletIndex, () => ownAddress()),
    signTransaction: (request) =>
      withVaultAccount(walletIndex, async (key) => {
        const { tx, unsigned, from } = toCoreTransaction(request);
        // Wallet.signTransaction's check.
        if (from != null && getAddress(from) !== (await ownAddress())) {
          throw new Error('transaction from address mismatch');
        }
        const { raw } = await vaultBackend.sign.transaction(key, tx);
        const signed = Transaction.from(raw);
        if (signed.unsignedHash !== unsigned.unsignedHash || signed.from !== (await ownAddress())) {
          throw mismatch();
        }
        return raw;
      }),
    signMessage: (message) =>
      withVaultAccount(walletIndex, async (key) => {
        // Strings sign as UTF-8, as ethers' signMessage does.
        const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
        let signature;
        try {
          signature = await vaultBackend.sign.message(key, bytes);
        } catch (err) {
          throw wrapped('Message signing failed', err);
        }
        if (verifyMessage(bytes, signature) !== (await ownAddress())) throw mismatch();
        return signature;
      }),
    signTypedData: (typedData) =>
      withVaultAccount(walletIndex, async (key) => {
        const data = toCoreTypedData(typedData);
        let signature;
        try {
          signature = await vaultBackend.sign.typedData(key, data);
        } catch (err) {
          throw wrapped('Typed data signing failed', err);
        }
        if (verifyTypedData(data.domain, data.types, data.message, signature) !== (await ownAddress())) {
          throw mismatch();
        }
        return signature;
      }),
  };
}

/**
 * Build a signer for the given wallet index.
 *
 * Construction is cheap and does not touch the vault; each method borrows
 * the key per call, so a locked vault fails at signing time with
 * `VAULT_LOCKED_MESSAGE` (same behaviour callers relied on before). The
 * address is memoized after the first successful resolution — it is public
 * and immutable for a given index, and callers like the send flow need it
 * (for the nonce) right before signing.
 *
 * @param {number} walletIndex
 * @returns {Signer}
 */
function getSigner(walletIndex) {
  if (!isValidWalletIndex(walletIndex)) {
    throw new Error('Invalid wallet index');
  }

  // Unknown mnemonic-range indexes fall through to the vault backend,
  // which fails with its own vault-derivation errors — the
  // pre-hardware-wallet behaviour. An unknown index in the *hardware*
  // range is different: it is a stale reference to a device account that
  // was deleted (dApp permission, publisher identity, an index replayed
  // by a dApp), and the vault backend would happily derive a mnemonic key
  // there. Fail loudly instead.
  const record = getWalletRecord(walletIndex);
  if (!record && isHardwareWalletIndex(walletIndex)) {
    // "Device", not "hardware wallet": remote (phone) accounts share the
    // same index range as Ledger accounts, so a deleted phone account
    // lands here too.
    throw new Error('Device account no longer exists; reconnect the device');
  }
  if (record && record.type === WALLET_TYPES.SAFE) {
    // A Safe is a smart-contract account whose owners are other wallet
    // records — it has no key of its own. Execution goes through the
    // SafeExecutor (./safe/), which signs with the owners' signers.
    throw new Error('Safe accounts cannot sign directly — execute through the Safe flow');
  }
  let backend;
  if (record && record.type === WALLET_TYPES.LEDGER) {
    backend = createLedgerBackend(record);
  } else if (record && record.type === WALLET_TYPES.REMOTE) {
    backend = createRemoteBackend(record);
  } else {
    backend = createVaultBackend(walletIndex);
  }

  let address = null;
  const signer = {
    getAddress: async () => {
      if (address === null) {
        address = await backend.getAddress();
      }
      return address;
    },
    signTransaction: (tx) => backend.signTransaction(tx),
    // async: a malformed input rejects like any other signing failure.
    signMessage: async (message) => backend.signMessage(normalizeMessage(message)),
    signTypedData: async (typedData) => backend.signTypedData(normalizeTypedData(typedData)),
  };
  // Optional capability: backends that sign AND broadcast through their
  // own channel (phone wallets only expose eth_sendTransaction). Callers
  // probe for it — see transaction-service's signAndSendTransaction.
  if (typeof backend.sendTransaction === 'function') {
    signer.sendTransaction = (tx) => backend.sendTransaction(tx);
  }
  return signer;
}

module.exports = { getSigner };
