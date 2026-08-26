/**
 * Ledger signing backend for the wallet signer factory.
 *
 * getAddress serves the address stored on the account record (read from
 * the device when the account was added) — no device round-trip, no vault.
 *
 * Every signing method opens the device (serialized via withEthApp),
 * verifies the attached device still derives the account's address at
 * the stored path (a different Ledger with a different seed would
 * otherwise silently sign from an address the user never approved),
 * then asks for an on-device confirmation. Errors surface with stable
 * LEDGER_* codes (see ./errors.js) — user rejection included.
 *
 * Transactions and typed data are signed WITHOUT @ledgerhq's hosted
 * clear-signing resolution: resolving token/plugin/EIP-712 metadata posts
 * the transaction contents (or the typed-data schema hash, chain id and
 * verifying contract) to Ledger's registry before signing, which violates
 * this project's rule against routing user data through hosted services.
 * `signTransaction` passes a null resolution; the typed-data path is
 * covered by the offline load config the transport builds Eth with.
 * Consequence: plain ETH transfers display normally on the device, but
 * contract calls (e.g. ERC-20 transfers) show as raw data and may
 * require "blind signing" to be enabled in the device's Ethereum app.
 * An opt-in setting (or a bundled offline token registry) can lift this
 * later — that decision belongs to the user, not this module.
 */

const { Transaction, Signature, TypedDataEncoder } = require('ethers');

const { withEthApp } = require('./transport');
const { LEDGER_ERROR_CODES, createLedgerError } = require('./errors');
const { getEip712WirePayload, messageToBytes } = require('../signing-utils');

/** hw-app-eth returns r/s as bare hex and v as hex string or number. */
function toEthersSignature(sig) {
  return Signature.from({
    r: '0x' + sig.r,
    s: '0x' + sig.s,
    v: typeof sig.v === 'string' ? BigInt('0x' + sig.v) : BigInt(sig.v),
  });
}

/**
 * @param {{address: string, path: string}} record - Ledger wallet record from vault-meta
 * @returns {import('../signers').Signer}
 */
function createLedgerBackend(record) {
  /**
   * Run a device task after verifying the attached Ledger derives this
   * account's address at the stored path — signing with a different
   * device/seed must fail, not silently produce a foreign signature.
   */
  const withVerifiedDevice = (task) =>
    withEthApp(async (eth) => {
      const { address } = await eth.getAddress(record.path, false);
      if (address.toLowerCase() !== record.address.toLowerCase()) {
        throw createLedgerError(LEDGER_ERROR_CODES.WRONG_DEVICE);
      }
      return task(eth);
    });

  return {
    getAddress: async () => record.address,

    signTransaction: async (tx) => {
      // Serialize outside the device session — nothing here needs the
      // transport, and withEthApp holds the exclusive device queue.
      const unsigned = Transaction.from(tx);
      const rawHex = unsigned.unsignedSerialized.slice(2);

      return withVerifiedDevice(async (eth) => {
        const sig = await eth.signTransaction(record.path, rawHex, null);
        unsigned.signature = toEthersSignature(sig);
        return unsigned.serialized;
      });
    },

    signMessage: async (message) => {
      const messageHex = messageToBytes(message).toString('hex');

      return withVerifiedDevice(async (eth) => {
        const sig = await eth.signPersonalMessage(record.path, messageHex);
        return toEthersSignature(sig).serialized;
      });
    },

    signTypedData: async (typedData) => {
      // The device wants the full EIP-712 wire payload.
      const { strippedTypes, payload } = getEip712WirePayload(typedData);

      return withVerifiedDevice(async (eth) => {
        let sig;
        try {
          sig = await eth.signEIP712Message(record.path, payload);
        } catch (err) {
          // Older Ethereum apps only support signing the pre-hashed
          // struct (no field-by-field review). 0x6d00 = INS not supported.
          if (err?.statusCode !== 0x6d00) throw err;
          const domainSeparator = TypedDataEncoder.hashDomain(payload.domain);
          const structHash = TypedDataEncoder.from(strippedTypes).hash(typedData.message);
          sig = await eth.signEIP712HashedMessage(record.path, domainSeparator.slice(2), structHash.slice(2));
        }
        return toEthersSignature(sig).serialized;
      });
    },
  };
}

module.exports = { createLedgerBackend };
