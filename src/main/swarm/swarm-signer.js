/**
 * Swarm signing through the identity core (freedom-core design 0002,
 * Phase 2 step 2). A signer pairs an origin identity's key *reference* with
 * its public owner address; the core signs single-owner chunks and never
 * returns the key. Every result is checked with bee-js and ethers before
 * it is used, so a core fault can't publish a chunk for something else or
 * under another owner.
 */

const { getAddress, getBytes, hashMessage, keccak256, recoverAddress, concat, isHexString } = require('ethers');

/** A SOC signature as Bee takes it: r ‖ s ‖ v, 65 bytes, v 27 or 28. */
function isWireSignature(signature) {
  if (!isHexString(signature, 65)) return false;
  const v = getBytes(signature)[64];
  return v === 27 || v === 28;
}
const { Identifier } = require('@ethersphere/bee-js');
const { vaultBackend } = require('../core/vault-backend');
const { getPublisherAddress, getBeeWalletAddress } = require('../identity-manager');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');
const { ETHEREUM_WALLET_MODE, ETHEREUM_WALLET_UNAVAILABLE } = require('./removed-identity-mode');
const { getBee } = require('./swarm-service');

function getIdentityMode(identity) {
  return identity?.mode || identity?.identityMode || null;
}

/**
 * @typedef {Object} SwarmSigner
 * @property {string} owner - checksummed owner address
 * @property {(chunk: { identifier: Uint8Array|string, payload: Uint8Array, span?: bigint }) =>
 *   Promise<{ span: bigint, chunkAddress: string, signature: string, owner: string, socAddress: string }>} signSoc
 */

/**
 * @param {object} key - the core's key reference
 * @param {string} owner - the key's address, from keys.addresses
 * @returns {SwarmSigner}
 */
function createSwarmSigner(key, owner) {
  const expectedOwner = getAddress(owner);
  return {
    owner: expectedOwner,
    async signSoc({ identifier, payload, span }) {
      const id = new Identifier(identifier).toUint8Array();
      const result = await vaultBackend.sign.soc(key, { identifier: id, payload, span });
      // bee-js's own construction of the same chunk: span 0 or absent is
      // the payload length there too.
      const cac = getBee().makeContentAddressedChunk(payload, span || undefined);
      const chunkAddress = '0x' + cac.address.toHex();
      const digest = keccak256(concat([id, chunkAddress]));
      const socAddress = keccak256(concat([id, expectedOwner]));
      if (
        result.chunk_address !== chunkAddress ||
        result.span !== cac.span.toBigInt().toString() ||
        getAddress(result.owner) !== expectedOwner ||
        result.soc_address !== socAddress ||
        // recoverAddress also takes forms Bee refuses (64-byte compact, other v).
        !isWireSignature(result.signature) ||
        recoverAddress(hashMessage(getBytes(digest)), result.signature) !== expectedOwner
      ) {
        throw new Error('The identity core returned a chunk signature that does not match');
      }
      return {
        span: BigInt(result.span),
        chunkAddress,
        signature: result.signature,
        owner: expectedOwner,
        socAddress,
      };
    },
  };
}

/**
 * The signer for an origin identity, resolved now: its owner address needs
 * the unlocked vault, so a locked vault is refused here, before any upload
 * work, with the messages each mode used before.
 *
 * @param {object} identity - an origin's active or feed identity
 * @returns {Promise<SwarmSigner>}
 */
async function resolveSwarmSigner(identity) {
  const identityMode = getIdentityMode(identity);
  if (identityMode === 'bee-wallet') {
    const owner = await getBeeWalletAddress();
    if (!owner) throw new Error(VAULT_LOCKED_MESSAGE);
    return createSwarmSigner({ kind: 'bee_wallet' }, owner);
  }

  if (identityMode === 'app-scoped') {
    if (typeof identity.publisherKeyIndex !== 'number') {
      throw new Error('App-scoped identity is missing a publisher key index');
    }
    // Validates the index; "Vault must be unlocked to derive publisher keys"
    // while locked.
    const owner = await getPublisherAddress(identity.publisherKeyIndex);
    return createSwarmSigner({ kind: 'publisher', origin_index: identity.publisherKeyIndex }, owner);
  }

  // Removed (#89): an account's 32-byte personal_sign is a chunk
  // signature, so only keys that sign nothing else own feeds. A stored
  // identity in this mode fails here, before any key is asked for, and
  // nothing falls back to another key (another owner, another feed).
  if (identityMode === ETHEREUM_WALLET_MODE) {
    throw new Error(ETHEREUM_WALLET_UNAVAILABLE);
  }

  throw new Error(`Unknown identity mode: ${identityMode}`);
}

module.exports = { createSwarmSigner, resolveSwarmSigner, getIdentityMode };
