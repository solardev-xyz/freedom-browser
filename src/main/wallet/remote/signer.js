/**
 * Remote (phone) signing backend for the wallet signer factory.
 *
 * getAddress serves the address stored on the account record (learned via
 * eth_requestAccounts when the account was added) — no vault involved.
 *
 * Every signature and payment is an identity core job (freedom-core design
 * 0012, PHN-2; ./bridge.js `requestPhoneJob`): the core checks the
 * request's authorization (`job`: what `sign.*` would present, and the
 * page's PageContext; none for main's own), opens the job, and gives the
 * JSON-RPC request main relays to the chrome's session, which shows a QR
 * code and tunnels it to the phone. The core checks the phone's answer: a
 * signature must recover to the account (typed data over the hash the user
 * confirmed), and main checks it again (`verifiedSignature`), as it checks
 * the core's own signatures. What an answer showed about the record
 * (signed as the account, or answered from another one) is reported
 * through `onAddressCheck`, so the signer factory can keep it on the
 * record (#1078).
 *
 * Phone wallets expose `eth_sendTransaction`, not raw transaction
 * signing, so this backend implements the optional `sendTransaction`
 * capability instead of `signTransaction`: the phone picks the nonce,
 * estimates gas, and broadcasts through its own RPC. The core compares the
 * reported transaction with every field the job binds (`from`, `to`,
 * `value`, `data`, the chain) once it is visible: at the answer
 * (`verified`), or later (`unverified` until its `phone.checked`).
 */

const { verifyMessage, recoverAddress, toQuantity } = require('ethers');

const { requestPhoneJob } = require('./bridge');
const { REMOTE_ERROR_CODES, UNREADABLE_ANSWER, createRemoteError } = require('./errors');
const { messageToBytes } = require('../signing-utils');

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * EIP-3085 chain descriptor for the tx's target chain. The phone's
 * wallet session defaults to Ethereum mainnet regardless of what the
 * user selected in the wallet, so the broker must actively switch it
 * (wallet_switchEthereumChain) — and, when the wallet doesn't know the
 * chain (4902), offer to add it, which needs this metadata. Only public
 * https RPC endpoints go over: the user's own node config is unreachable
 * from a phone and nobody else's business, and a keyed provider's URL
 * carries the user's API key (#1040). The descriptor passes through the
 * chrome renderer on its way to the phone.
 */
function buildChainDescriptor(chainId) {
  const { getChain } = require('../chains');
  const { getKeylessRpcUrls } = require('../rpc-manager');

  const descriptor = { chainId: toQuantity(chainId) };
  const chain = getChain(chainId);
  if (!chain) return descriptor;

  descriptor.chainName = chain.name;
  descriptor.nativeCurrency = chain.nativeCurrency;
  if (chain.blockExplorer) descriptor.blockExplorerUrls = [chain.blockExplorer];
  const rpcUrls = (getKeylessRpcUrls(chainId) || []).filter((url) => url.startsWith('https://'));
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
  /**
   * One core job (`requestPhoneJob`): `job` is what the signer factory
   * gives, the authorization and PageContext the core checks it under, and
   * `beforeSign`, the caller's last check, awaited once the core opened the
   * job, right before its request goes to the chrome.
   */
  const request = (method, payload, job = {}, extra = {}) =>
    requestPhoneJob({
      walletIndex: record.index,
      address: record.address,
      method,
      payload,
      ...(job.authorization ? { authorization: job.authorization } : {}),
      page: job.page || null,
      ...(job.beforeSign ? { beforeRelay: job.beforeSign } : {}),
      ...extra,
    });

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
   * The phone's signature, which the core required to be the account's,
   * checked again here. A phone that answers from another account (a
   * signature that recovers elsewhere, or the wallet's own EIP-1193 4100)
   * shows the record doesn't match it.
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

    /**
     * `job.payload`: the message as a token bound it (`{ message }`), or
     * none, and it is made from the bytes.
     */
    signMessage: async (message, job = {}) => {
      const bytes = messageToBytes(message);
      return accountSignature(
        request('message', job.payload || { message: '0x' + bytes.toString('hex') }, job),
        (sig) => verifyMessage(bytes, sig)
      );
    },

    /**
     * `digest`: the hash the user confirmed, or the core's own for main's
     * typed data (#1063); the core relays its view, which hashes to it, and
     * the signature must recover over it. `job.payload`: `sign.typed_data`'s
     * params without the key and the hash (the core's form of the data, and
     * the `primary_type` and `chain_id` a token was minted with).
     */
    signTypedData: async (_typedData, { digest, job = {} } = {}) => {
      if (typeof digest !== 'string') throw createRemoteError(REMOTE_ERROR_CODES.UNSUPPORTED);
      return accountSignature(
        request('typed_data', { ...job.payload, expected_hash: digest }, job),
        (sig) => recoverAddress(digest, sig)
      );
    },

    /**
     * Ask the phone to sign AND broadcast. The core relays only the intent
     * fields: the phone re-estimates gas, picks the nonce, and shows its
     * own fee UI, exactly as it would for one of its own dApps. The chain
     * descriptor rides along so the broker can switch the phone's wallet
     * to the tx's chain first.
     *
     * An answer that isn't a transaction hash is the phone's answer all the
     * same: the payment may have been sent, so its outcome is unknown
     * (REMOTE_OUTCOME_UNKNOWN), not a failure to try again.
     *
     * @param {{chainId: number}} tx - the send; its chain names the descriptor
     * @param {{payload: {tx: object}}} job - `sign.transaction`'s params
     *   without the key: the transaction a token bound, or main's
     * @returns {Promise<{hash: string, outcome: 'verified'|'unverified'|'unknown', job: string,
     *   rule?: object, durable?: false}>} the core's judgement of the reported hash
     */
    sendTransaction: async (tx, job = {}) => {
      const sent = await request('transaction', job.payload, job, { chain: buildChainDescriptor(tx.chainId) });
      if (typeof sent?.hash !== 'string' || !TX_HASH_RE.test(sent.hash)) {
        throw createRemoteError(REMOTE_ERROR_CODES.OUTCOME_UNKNOWN, UNREADABLE_ANSWER);
      }
      return sent;
    },
  };
}

module.exports = { createRemoteBackend, verifiedSignature };
