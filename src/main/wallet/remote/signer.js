/**
 * Remote (phone) signing backend for the wallet signer factory.
 *
 * getAddress serves the address stored on the account record (learned via
 * eth_requestAccounts when the account was added) — no vault involved.
 *
 * Signing methods publish a JSON-RPC job to the renderer session broker
 * (see ./bridge.js), which shows a QR code, tunnels the request to the
 * phone over openlv, and returns the phone's answer. The answer is never
 * trusted: signatures must recover to the account's address (a phone
 * answering from a different account fails with REMOTE_WRONG_ACCOUNT).
 * What an answer showed about the record (signed as the account, or
 * answered from another one) is reported through `onAddressCheck`, so
 * the signer factory can keep it on the record (#1078).
 *
 * Phone wallets expose `eth_sendTransaction`, not raw transaction
 * signing, so this backend implements the optional `sendTransaction`
 * capability instead of `signTransaction`: the phone picks the nonce,
 * estimates gas, and broadcasts through its own RPC. The reported hash's
 * `from` is verified on-chain by transaction-service (the provider layer
 * — this module never touches RPC).
 */

const { verifyMessage, verifyTypedData, toQuantity } = require('ethers');

const { requestRemoteSignature } = require('./bridge');
const { REMOTE_ERROR_CODES, createRemoteError } = require('./errors');
const { getEip712WirePayload, messageToBytes } = require('../signing-utils');

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * EIP-3085 chain descriptor for the tx's target chain. The phone's
 * wallet session defaults to Ethereum mainnet regardless of what the
 * user selected in the wallet, so the broker must actively switch it
 * (wallet_switchEthereumChain) — and, when the wallet doesn't know the
 * chain (4902), offer to add it, which needs this metadata. Only public
 * https RPC endpoints go over: the user's own node config is unreachable
 * from a phone and nobody else's business.
 */
function buildChainDescriptor(chainId) {
  const { getChain } = require('../chains');
  const { getEffectiveRpcUrls } = require('../rpc-manager');

  const descriptor = { chainId: toQuantity(chainId) };
  const chain = getChain(chainId);
  if (!chain) return descriptor;

  descriptor.chainName = chain.name;
  descriptor.nativeCurrency = chain.nativeCurrency;
  if (chain.blockExplorer) descriptor.blockExplorerUrls = [chain.blockExplorer];
  const rpcUrls = (getEffectiveRpcUrls(chainId) || []).filter((url) => url.startsWith('https://'));
  if (rpcUrls.length) descriptor.rpcUrls = rpcUrls;
  return descriptor;
}

/**
 * Shape-check a phone's signature and require it to recover to `address`.
 * Every phone signature goes through it, and so does the check that a
 * phone holds an account (./account-proof.js).
 *
 * @param {string} address - The account the signature must come from
 * @param {unknown} signature - The phone's answer
 * @param {(signature: string) => string} recover - Recovers the signer over what was asked
 * @returns {string} The signature
 */
function verifiedSignature(address, signature, recover) {
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
    throw createRemoteError(REMOTE_ERROR_CODES.BAD_RESPONSE);
  }
  if (recover(signature).toLowerCase() !== address.toLowerCase()) {
    throw createRemoteError(REMOTE_ERROR_CODES.WRONG_ACCOUNT);
  }
  return signature;
}

/**
 * @param {{index: number, address: string}} record - Remote wallet record from vault-meta
 * @param {Object} [options]
 * @param {(matched: boolean) => void} [options.onAddressCheck] - Told, after a
 *   phone's answer, whether it signed as the account (true) or answered from
 *   another account (false). Not called when no answer came.
 * @returns {import('../signers').Signer & {sendTransaction: (tx: object) => Promise<string>}}
 */
function createRemoteBackend(record, { onAddressCheck } = {}) {
  const request = (method, params, chain) =>
    requestRemoteSignature({ walletIndex: record.index, address: record.address, method, params, chain });

  /** Report what the phone's answer showed about the record (#1078). */
  function report(matched) {
    if (!onAddressCheck) return;
    try {
      onAddressCheck(matched);
    } catch (err) {
      // The signature stands or falls on its own check; keeping the
      // result is a courtesy for the next Safe the account may own.
      console.warn('[RemoteSigner] Could not keep the address check:', err.message);
    }
  }

  /**
   * The phone's signature, required to be the account's. A phone that
   * answers from another account (a signature that recovers elsewhere, or
   * the wallet's own EIP-1193 4100) shows the record doesn't match it.
   */
  async function accountSignature(answer, recover) {
    let signature;
    try {
      signature = verifiedSignature(record.address, await answer, recover);
    } catch (err) {
      if (err?.code === REMOTE_ERROR_CODES.WRONG_ACCOUNT) report(false);
      throw err;
    }
    report(true);
    return signature;
  }

  return {
    getAddress: async () => record.address,

    // Phone wallets have no raw-signing RPC; transactions go through
    // sendTransaction below (the signer factory advertises it, and
    // transaction-service prefers it when present).
    signTransaction: async () => {
      throw createRemoteError(REMOTE_ERROR_CODES.UNSUPPORTED);
    },

    signMessage: async (message) => {
      const bytes = messageToBytes(message);
      return accountSignature(
        request('personal_sign', ['0x' + bytes.toString('hex'), record.address]),
        (sig) => verifyMessage(bytes, sig),
      );
    },

    signTypedData: async (typedData) => {
      // eth_signTypedData_v4 takes the full EIP-712 wire payload.
      const { domain, strippedTypes, payload } = getEip712WirePayload(typedData);
      return accountSignature(
        request('eth_signTypedData_v4', [record.address, JSON.stringify(payload)]),
        (sig) => verifyTypedData(domain, strippedTypes, typedData.message, sig),
      );
    },

    /**
     * Ask the phone to sign AND broadcast. Only intent fields go over —
     * the phone re-estimates gas, picks the nonce, and shows its own fee
     * UI, exactly as it would for one of its own dApps. The chain
     * descriptor rides along so the broker can switch the phone's wallet
     * to the tx's chain first.
     *
     * @param {{to: string, value?: string|bigint, data?: string, chainId: number}} tx
     * @returns {Promise<string>} Transaction hash reported by the phone.
     */
    sendTransaction: async (tx) => {
      const txParam = {
        from: record.address,
        to: tx.to,
        value: toQuantity(tx.value ?? 0),
        chainId: toQuantity(tx.chainId),
      };
      if (tx.data) txParam.data = tx.data;

      const hash = await request('eth_sendTransaction', [txParam], buildChainDescriptor(tx.chainId));
      if (typeof hash !== 'string' || !TX_HASH_RE.test(hash)) {
        throw createRemoteError(REMOTE_ERROR_CODES.BAD_RESPONSE);
      }
      return hash;
    },
  };
}

module.exports = { createRemoteBackend, verifiedSignature };
