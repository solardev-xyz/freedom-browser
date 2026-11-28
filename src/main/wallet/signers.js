/**
 * Signer factory.
 *
 * Resolves a wallet index to a signer object so callers never touch raw
 * private keys. The account's `type` (from vault-meta, see
 * identity-manager's WALLET_TYPES) picks the backend: vault-backed
 * mnemonic accounts sign locally with a borrowed key, Ledger accounts
 * sign on the device. Which drives a Ledger is FREEDOM_LEDGER_BACKEND's
 * (freedom-core design 0016, LDG-3; ledger/ledger-backend-kind.js): `js`,
 * main's own hw-app-eth path (ledger/signer.js), or `core`, the identity
 * core's device lane, whose APDUs main's relay carries to the device
 * (`createCoreLedgerBackend`). Packaged builds always run `js`.
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

const { Transaction, getAddress, verifyMessage, recoverAddress } = require('ethers');

const { withVaultAccount, isValidWalletIndex } = require('./vault-access');
const {
  getWalletRecord,
  isHardwareWalletIndex,
  recordLedgerAddressCheck,
  recordRemoteAddressCheck,
  WALLET_TYPES,
} = require('../identity-manager');
const { vaultBackend } = require('../core/vault-backend');
const { createLedgerBackend } = require('./ledger/signer');
const { ledgerBackendKind } = require('./ledger/ledger-backend-kind');
const { LEDGER_ERROR_CODES, createLedgerError, fromCoreError } = require('./ledger/errors');
const { currentHashOnlySurface } = require('./ledger/hash-only-warning');
const { createRemoteBackend } = require('./remote/signer');
const {
  normalizeMessage,
  normalizeTypedData,
  toCoreTypedData,
  toCoreTransaction,
  typedDataViewOptions,
  assertBoundedTypeGraph,
  buildTransaction,
} = require('./signing-utils');
const {
  signingAuthorization,
  safeAuthorization,
  spendConfirmation,
  finalizeReceiptOf,
  confirmationError,
} = require('./signing-confirmation');

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

/**
 * What a vault signature sends beside its request (freedom-core design
 * 0012, API): the confirmation's `authorization`, which the core checks and
 * spends before any key is derived; for a page's request a standing rule
 * answers, `{ standing: { paused? } }`, which the core judges against the
 * site's rule; for a Safe's vault owner or its executor, the Safe approval
 * (`{ safe }`) under the caller it was recorded for; and a page's
 * PageContext, under which a page's request is sent. None from main itself.
 */
function signOptions({ confirmation = null, page = null, standing = null, safe = null } = {}) {
  if (confirmation) return signingAuthorization(confirmation);
  // A Safe's owner or executor: the Safe approval, under its own caller.
  if (safe) return safeAuthorization(safe);
  if (page && standing) return { authorization: { standing: { ...standing } }, page };
  return { page };
}

/**
 * For a standing rule's typed data: what the core is told beside it, the
 * page's `primaryType` and chain (`typedDataViewOptions`), in the form a
 * minted token's payload carries them.
 */
function standingView(typedData, { standing = null, chainId } = {}) {
  if (!standing) return {};
  const options = typedDataViewOptions(typedData, chainId);
  return {
    ...(options.primaryType !== undefined ? { primary_type: options.primaryType } : {}),
    ...(options.chainId !== undefined ? { chain_id: String(options.chainId) } : {}),
  };
}

/** The core's refusal of a confirmation, in today's words, or null. */
function refusal(err) {
  const mapped = confirmationError(err);
  return mapped === err ? null : mapped;
}

function createVaultBackend(walletIndex, authorized = {}) {
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
    err?.code === 'vault_locked'
      ? err
      : refusal(err) || new Error(`${label}: ${err.message}`, { cause: err });
  const options = signOptions(authorized);
  // The caller's last check, whenever the caller gives one: for a signature
  // no token answers, main's own (a Safe owner's) or a standing rule's; and
  // for a token the Agent's decision minted (design 0012), which the core
  // spends under the PageContext main read as this signer was built. Either
  // way main read custody before this signer's own waits, so it is read
  // again here, last.
  const lastCheck = authorized.beforeSign || null;
  return {
    getAddress: () => withVaultAccount(walletIndex, () => ownAddress()),
    // The expected address is resolved before signing: a lock right after
    // the core signs must not turn a good signature into a failure.
    signTransaction: (request) =>
      withVaultAccount(walletIndex, async (key) => {
        const { tx, unsigned, from } = toCoreTransaction(request);
        const expected = await ownAddress();
        // Wallet.signTransaction's check.
        if (from != null && getAddress(from) !== expected) {
          throw new Error('transaction from address mismatch');
        }
        if (lastCheck) await lastCheck();
        let reply;
        try {
          reply = await vaultBackend.sign.transaction(key, tx, options);
        } catch (err) {
          throw refusal(err) || err;
        }
        const { raw } = reply;
        const signed = Transaction.from(raw);
        if (signed.unsignedHash !== unsigned.unsignedHash || signed.from !== expected) {
          throw mismatch();
        }
        // What became of a flagged dApp send's "Always allow" (design 0012):
        // its reply's `rule`, the rule the core wrote as it signed (APB-2), or
        // why it wrote none, for the dispatcher to report.
        if (typeof authorized.onRule === 'function') authorized.onRule(reply.rule ?? null);
        return raw;
      }),
    signMessage: (message) =>
      withVaultAccount(walletIndex, async (key) => {
        // Strings sign as UTF-8, as ethers' signMessage does.
        const bytes =
          typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
        const expected = await ownAddress();
        if (lastCheck) await lastCheck();
        let signature;
        try {
          signature = await vaultBackend.sign.message(key, bytes, options);
        } catch (err) {
          throw wrapped('Message signing failed', err);
        }
        if (verifyMessage(bytes, signature) !== expected) throw mismatch();
        return signature;
      }),
    signTypedData: (typedData, { expectedHash } = {}) =>
      withVaultAccount(walletIndex, async (key) => {
        const data = toCoreTypedData(typedData);
        const expected = await ownAddress();
        let digest;
        try {
          // The digest the core signs only if the data hashes to it
          // (freedom-core #88): the hash the user confirmed, or, for
          // main's own typed data (SafeTx, SafeMessage, x402), the core's
          // own hash of it, taken now. The core's bounded encoder, not
          // ethers' (whose type walk is exponential on some graphs).
          digest = expectedHash ?? (await vaultBackend.typedDataHash(data));
        } catch (err) {
          throw wrapped('Typed data signing failed', err);
        }
        // After the core's hash, right before the signature.
        if (lastCheck) await lastCheck();
        let signature;
        try {
          // The view a typed-data token binds is made again from what the
          // core was told beside the data when it was minted; a standing
          // rule's is the page's view, on the page's chain, which the core
          // judges for warnings as it did for `approval.check`.
          const bound = authorized.confirmation?.payload ?? standingView(typedData, authorized);
          signature = await vaultBackend.sign.typedData(key, data, digest, {
            ...options,
            ...(bound.primary_type !== undefined ? { primaryType: bound.primary_type } : {}),
            ...(bound.chain_id !== undefined ? { chainId: bound.chain_id } : {}),
          });
        } catch (err) {
          throw wrapped('Typed data signing failed', err);
        }
        if (recoverAddress(digest, signature) !== expected) throw mismatch();
        return signature;
      }),
  };
}

/**
 * A Ledger account on the core's backend (freedom-core design 0016,
 * "Accounts", "Approvals: enforced"; LDG-3's PR 7; FREEDOM_LEDGER_BACKEND
 * is `core`): the identity core signs with the Ledger key `{ kind:
 * 'ledger', index, path, address }`, the path and address main's record's
 * (the core refuses a key that isn't its record's), on its device lane,
 * through main's relay (vault-backend.js `deviceCall`). It is treated as a
 * vault account is:
 * - **The authorization** goes to `sign.*` itself (`signOptions`): a
 *   confirmation's token, which the core spends as it is presented, before
 *   the first APDU (a page's `{ device }` token under `page` with its
 *   PageContext, page-devices.js; the plan's point 10); a standing rule's
 *   `{ standing }` under `page`, which skips the browser's prompt, never
 *   the device's; a Safe owner's Safe approval under the caller it was
 *   recorded for (point 11, the JS Safe backend's alone: a Ledger owner's
 *   SafeTx or SafeMessage goes as `sign.typed_data`; on the core's Safe
 *   backend it goes through `safe.sign_owner` or `safe.message_sign`,
 *   SAFE-3's PR 8, and this path is refused); main's own, none.
 *   Nothing is spent through `approval.spend` first.
 * - **`beforeSign`**, the caller's last check, is held by the relay before
 *   the first APDU after `B0 01` (point 7): after the lane's queue, the
 *   device's open and the address check. Its refusal reaches the caller
 *   as it is, and nothing is signed.
 * - **The device's failures** are the core's `device_failed` with its
 *   `LEDGER_*` code, shown with ledger/errors.js's text.
 * - **The address check** (point 8): the core's `sign.*` checks the record's
 *   address on the device first but doesn't keep the result, so main keeps
 *   it (`keepAddressCheck`), as the JS backend does: `matched` after a good
 *   signature, `mismatched` on LEDGER_WRONG_DEVICE.
 * - **Every result is checked again** here before it leaves, as a vault
 *   signature is (the core already recovered the device's): a transaction's
 *   unsigned hash and sender, a message's EIP-191 signer, typed data's
 *   signer over the confirmed digest. Anything else is LEDGER_BAD_SIGNATURE.
 * - **The hash-only warning** (Q23; LDG-3's PR 11): the relay holds the
 *   device's `6D00` until it is on screen. The caller's `hashOnlySurface`
 *   when it gives one; otherwise the one its request's target names
 *   (ledger/hash-only-warning.js `currentHashOnlySurface`: the approvals
 *   document's waiting state for the approval it waits on, or the chrome's
 *   notice over its tab), captured as the signer is asked, inside the
 *   caller's entry point.
 * - `signal` (main's own cancel, PR 10) goes to the relay when the caller
 *   gives it.
 * - **The user's Cancel** (`signal`, LDG-3's PR 10 and its point 5): once it
 *   aborts, the core is told and the relay lets go of the device at once
 *   (vault-backend.js `deviceCall`), and the call fails LEDGER_CANCELLED,
 *   whatever the core then answers: a signature whose reply came in after
 *   the Cancel is dropped too, so nothing signed leaves after it (a send
 *   releases its nonce, nonce-reservations.js).
 */
function createCoreLedgerBackend(walletIndex, record, authorized = {}) {
  const key = { kind: 'ledger', index: walletIndex, path: record.path, address: record.address };
  const options = signOptions(authorized);
  const badSignature = () => createLedgerError(LEDGER_ERROR_CODES.BAD_SIGNATURE);
  const ownAddress = () => getAddress(record.address);
  const keep = (matched) => keepAddressCheck(recordLedgerAddressCheck, walletIndex, matched);
  /**
   * One signature through the core: `sign(device)` gets the device's
   * options (the caller's last check wrapped, so its refusal is told apart
   * from the core's errors, the hash-only surface and the signal) and
   * returns the core's reply; `check(reply)` returns the result, or null
   * (or throws) for one that isn't the request's; `after(reply)` runs once
   * it passed.
   */
  const viaCore = async (sign, check, after = null) => {
    let refused = null;
    const device = {
      ...(typeof authorized.beforeSign === 'function'
        ? {
            beforeSign: async () => {
              try {
                await authorized.beforeSign();
              } catch (err) {
                refused = { err };
                throw err;
              }
            },
          }
        : {}),
      hashOnlySurface:
        typeof authorized.hashOnlySurface === 'function' ? authorized.hashOnlySurface : currentHashOnlySurface(),
      ...(authorized.signal ? { signal: authorized.signal } : {}),
    };
    // The user's Cancel: its own error, whatever came of the request after.
    const cancelled = () => authorized.signal?.aborted === true;
    let reply;
    try {
      reply = await sign({ ...options, ...device });
    } catch (err) {
      if (refused) throw refused.err;
      if (cancelled()) throw createLedgerError(LEDGER_ERROR_CODES.CANCELLED);
      const failure = fromCoreError(err);
      if (failure) {
        if (failure.code === LEDGER_ERROR_CODES.WRONG_DEVICE) keep(false);
        throw failure;
      }
      throw refusal(err) || err;
    }
    if (cancelled()) throw createLedgerError(LEDGER_ERROR_CODES.CANCELLED);
    let result;
    try {
      result = check(reply);
    } catch (err) {
      throw badSignature(err);
    }
    if (result === null) throw badSignature();
    keep(true);
    after?.(reply);
    return result;
  };
  return {
    getAddress: async () => record.address,
    signTransaction: async (request) => {
      const { tx, unsigned, from } = toCoreTransaction(request);
      const expected = ownAddress();
      // Wallet.signTransaction's check, as a vault account's.
      if (from != null && getAddress(from) !== expected) {
        throw new Error('transaction from address mismatch');
      }
      return viaCore(
        (device) => vaultBackend.sign.transaction(key, tx, device),
        (reply) => {
          const signed = Transaction.from(reply.raw);
          if (signed.unsignedHash !== unsigned.unsignedHash || signed.from !== expected) return null;
          return reply.raw;
        },
        // What became of a flagged dApp send's "Always allow" (design
        // 0012): the core writes it once the device's signature passed its
        // checks, as it does a vault send's.
        (reply) => {
          if (typeof authorized.onRule === 'function') authorized.onRule(reply.rule ?? null);
        }
      );
    },
    signMessage: async (message) => {
      // Strings sign as UTF-8, as ethers' signMessage does.
      const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
      const expected = ownAddress();
      return viaCore(
        (device) => vaultBackend.sign.message(key, bytes, device),
        (signature) => (verifyMessage(bytes, signature) === expected ? signature : null)
      );
    },
    signTypedData: async (typedData, { expectedHash } = {}) => {
      const data = toCoreTypedData(typedData);
      const expected = ownAddress();
      // The digest the core signs only if the data hashes to it (#88): the
      // hash the user confirmed, or, for main's own typed data (SafeTx,
      // SafeMessage, x402), the core's own hash of it, taken now.
      const digest = expectedHash ?? (await vaultBackend.typedDataHash(data));
      // The view a typed-data token binds, made again from what the core
      // was told beside the data when it was minted; a standing rule's is
      // the page's.
      const bound = authorized.confirmation?.payload ?? standingView(typedData, authorized);
      return viaCore(
        (device) =>
          vaultBackend.sign.typedData(key, data, digest, {
            ...device,
            ...(bound.primary_type !== undefined ? { primaryType: bound.primary_type } : {}),
            ...(bound.chain_id !== undefined ? { chainId: bound.chain_id } : {}),
          }),
        (signature) => (recoverAddress(digest, signature) === expected ? signature : null)
      );
    },
  };
}

/**
 * A phone send no token binds (a standing rule's, main's own), as the core
 * reads `sign.transaction`'s `tx` with no nonce (design 0012, PHN-1): the
 * phone picks its own gas, fees and nonce, so a fee or gas limit main
 * quoted none for is named as zero. The core relays only `to`, `value`,
 * `data` and the chain.
 */
function phoneJobTx({
  to,
  value,
  data,
  chainId,
  gasLimit,
  maxFeePerGas,
  maxPriorityFeePerGas,
  gasPrice,
}) {
  const { tx } = toCoreTransaction(
    buildTransaction({
      to,
      value: value ?? 0,
      data,
      chainId,
      nonce: 0,
      gasLimit: gasLimit ?? 0,
      ...(gasPrice != null && maxFeePerGas == null
        ? { gasPrice }
        : { maxFeePerGas: maxFeePerGas ?? 0, maxPriorityFeePerGas: maxPriorityFeePerGas ?? 0 }),
    })
  );
  delete tx.nonce;
  return tx;
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
 * A signer for a confirmed request carries its confirmation (freedom-core
 * design 0012, APB-1): a vault account's signature presents it to the core,
 * which spends it there; a Ledger's, on the JS backend, spends it through
 * the core first (`approval.spend`), and the device signs only after, and
 * on the core's backend presents it to `sign.*` with the Ledger key, as a
 * vault account's does (design 0016, `createCoreLedgerBackend`); a phone's
 * opens a core job (`phone.job`, PHN-1/PHN-2) with it, and the core checks
 * the phone's answer against what the job bound. A page's request a site's
 * standing rule answers carries the page's PageContext and `{ standing }`,
 * so it is sent under `page`, never as main's own: a vault signature, a
 * Ledger's on the core's backend and a phone job are judged by the core
 * against the site's rule; a Ledger on the JS backend signs it as before
 * (the core's `approval.check` advised the choice).
 *
 * `beforeSign`, the caller's last check, is awaited whenever the caller
 * gives one: a page's standing rule read again, with custody, for a
 * signature no token answers (a device's, which the core never judges, and
 * a vault's under `{ standing }`, whose PageContext main read before the
 * signer's own waits) or main's own (a Safe owner's); and the Agent's
 * decision read again (design 0012: its tab, its document, its name) for
 * the token it minted, on any account, whose PageContext main read as the
 * signer was built. It is awaited after every other wait of the signer's
 * (the address, the core's hash, a token's spend), right before the device
 * is asked or the core signs, and throws to refuse: nothing is signed, and
 * the caller hears its own error. A Ledger's JS backend awaits it inside
 * its device session, after the device queue, the transport's open and the
 * address check, right before each signing APDU (`ledger/signer.js`); on
 * the core's backend the relay holds the first APDU after `B0 01` for it,
 * after the lane's queue, the device's open and the address check
 * (core/ledger-relay.js).
 *
 * @param {number} walletIndex
 * A Safe's owner or executor carries the Safe approval (`safe`: `{ id,
 * page }`, `safe/safe-approvals.js`): a vault signature presents it to the
 * core (design 0012, APB-1c), and so does a Ledger owner's on the core's
 * backend, its SafeTx or SafeMessage as `sign.typed_data` with the Ledger
 * key (design 0016, "Approvals: enforced"), but only on the JS Safe
 * backend: on the core's (FREEDOM_SAFE_BACKEND=core, SAFE-3's PR 8) a
 * Safe's Ledger owner signs through `safe.sign_owner` or
 * `safe.message_sign` (safe/ledger-owners.js), and a Safe approval here is
 * refused. On the JS Ledger backend a device owner signs as before: the
 * core doesn't make its signature, and has no check of a Safe approval
 * for it.
 *
 * @param {{confirmation?: object, page?: object, standing?: {paused?: boolean},
 *   chainId?: number, onRule?: (rule: object|null) => void,
 *   onReceipt?: (held: {receipt: string, page: object}|null) => void,
 *   beforeSign?: () => Promise<void>, safe?: object,
 *   hashOnlySurface?: Function, signal?: AbortSignal}} [authorized]
 *   the confirmation (`signing-confirmation.js`), or a page's PageContext
 *   with, for a rule's answer, `standing` and the page's chain (typed
 *   data's view); `onRule` hears a vault send's `rule` reply (and a
 *   Ledger's on the core's backend), and `onReceipt` a device's spend's
 *   finalize receipt, with the PageContext it was spent under (null when
 *   it gave none); or a Safe approval. `hashOnlySurface` and `signal` are
 *   a Ledger's on the core's backend: the hash-only warning's surface
 *   (core/ledger-relay.js) and main's own cancel
 * @returns {Signer}
 */
/**
 * What a device's answer showed about its record, kept by the identity core
 * (`accounts.record_address_check`) without holding up the signature: a
 * failure is logged, and the next answer is kept again.
 */
function keepAddressCheck(record, walletIndex, matched) {
  const warn = (err) => {
    console.warn(`[Signers] Account ${walletIndex}'s address check was not kept:`, err?.message);
  };
  try {
    Promise.resolve(record(walletIndex, matched)).catch(warn);
  } catch (err) {
    warn(err);
  }
}

function getSigner(walletIndex, authorized = {}) {
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
  // The core signs, and checks and spends the authorization as it does: a
  // vault account's signature, and on the core's Ledger backend a Ledger's
  // (design 0016), whose last check the relay holds before the device is
  // asked (`createCoreLedgerBackend`).
  let coreSigned = false;
  // A phone's signature is an identity core job (design 0012, PHN-2): the
  // core checks and spends its authorization as it opens the job, as
  // `sign.*` would, and runs nothing here first.
  let phoneJob = false;
  // A Ledger's backend runs the caller's last check itself, in its device
  // session (after the queue, the transport and the address check), right
  // before each signing APDU (`ledger/signer.js`).
  let backendChecks = false;
  if (record && record.type === WALLET_TYPES.LEDGER && ledgerBackendKind() === 'core') {
    if (authorized?.safe && require('./safe/safe-backend-kind').safeBackendKind() === 'core') {
      // LDG-3's point-11 path is the JS Safe backend's: on the core's, a
      // Safe's Ledger owner signs through the core's Safe methods.
      throw new Error("A Safe's Ledger owner signs through the Safe's own steps here");
    }
    backend = createCoreLedgerBackend(walletIndex, record, authorized || {});
    coreSigned = true;
  } else if (record && record.type === WALLET_TYPES.LEDGER) {
    backend = createLedgerBackend(record, {
      // What the device said about a record no device has matched yet
      // (#1065): kept on the record by the identity core, without holding
      // up the signature; a failure is logged.
      onAddressCheck: (matched) => keepAddressCheck(recordLedgerAddressCheck, walletIndex, matched),
      ...(authorized?.beforeSign ? { beforeSign: authorized.beforeSign } : {}),
    });
    backendChecks = true;
  } else if (record && record.type === WALLET_TYPES.REMOTE) {
    backend = createRemoteBackend(record, {
      // What the phone's answer showed about the record (#1078): kept on
      // it, so a record added before the phone check gets checked.
      onAddressCheck: (matched) => keepAddressCheck(recordRemoteAddressCheck, walletIndex, matched),
    });
    phoneJob = true;
  } else {
    backend = createVaultBackend(walletIndex, authorized);
    coreSigned = true;
  }
  // On the JS backend a Ledger signs what it shows, so the core can only
  // advise: its confirmation is spent first, and the device asked only
  // after. A phone's confirmation goes with its core job instead
  // (`phone.job`), and one the core signs with goes to `sign.*`.
  const confirmation = coreSigned || phoneJob ? null : authorized?.confirmation || null;
  // The caller's last check (`beforeSign`), after the token's spend: a
  // device's signature is never judged by the core, so it is awaited right
  // before the device is asked, after every other wait of the signer's,
  // whether a token answers it or not. A phone's backend asks the phone in
  // the same run as it is called; a Ledger's waits on its device session
  // first, so its backend runs the check there, right before the APDU.
  const beforeSign =
    coreSigned || backendChecks || phoneJob ? null : authorized?.beforeSign || null;
  // A phone job's authorization and PageContext (`signOptions`, as a vault
  // signature presents them), `payload` the `sign.*` params without the
  // key, and the caller's last check, which the bridge awaits once the core
  // opened the job, right before the request goes to the chrome.
  const jobOf = (payload) =>
    phoneJob
      ? {
          ...signOptions(authorized),
          payload,
          ...(authorized?.beforeSign ? { beforeSign: authorized.beforeSign } : {}),
        }
      : undefined;
  // A flagged dApp send's spend for a device gives a finalize receipt
  // instead of a rule (design 0012, "A device send's rule"): handed to the
  // caller with the PageContext it was spent under, for it to present once
  // the device signed and the send is recorded.
  const spendAndCheck = async () => {
    if (confirmation) {
      const spent = await spendConfirmation(confirmation);
      if (typeof authorized?.onReceipt === 'function')
        authorized.onReceipt(finalizeReceiptOf(spent, confirmation.page));
    }
    if (beforeSign) await beforeSign();
  };

  let address = null;
  const signer = {
    getAddress: async () => {
      if (address === null) {
        address = await backend.getAddress();
      }
      return address;
    },
    signTransaction: async (tx) => {
      await spendAndCheck();
      return backend.signTransaction(tx);
    },
    // async: a malformed input rejects like any other signing failure.
    signMessage: async (message) => {
      const normalized = normalizeMessage(message);
      await spendAndCheck();
      return backend.signMessage(normalized, jobOf(authorized?.confirmation?.payload));
    },
    /**
     * `expectedHash`: the hash the user confirmed (#88). The core refuses a
     * vault signature over anything else. A device signs what it shows, so
     * for one the core hashes and checks every request first, main's own
     * typed data (SafeTx, SafeMessage, x402) included: data the core
     * refuses, or a request that changed after its confirmation, fails
     * before the device is asked, and nothing is signed.
     */
    signTypedData: async (typedData, { expectedHash } = {}) => {
      const normalized = normalizeTypedData(typedData);
      // Every backend: the Ledger and phone ones walk the types with ethers.
      assertBoundedTypeGraph(normalized?.types);
      if (coreSigned) {
        return backend.signTypedData(normalized, { expectedHash });
      }
      const hash = await vaultBackend.typedDataHash(toCoreTypedData(normalized));
      if (expectedHash !== undefined && hash !== expectedHash) {
        throw new Error('The typed data changed after it was confirmed');
      }
      await spendAndCheck();
      // `digest`: the hash a device's signature must recover over (#1063):
      // the one the user confirmed, or the core's own for main's typed
      // data, never one rebuilt from what the device was sent. A phone's
      // job carries the data as the core takes it, with the view a token
      // was minted with (or a standing rule's, the page's).
      const bound = authorized?.confirmation?.payload ?? {
        typed_data: toCoreTypedData(normalized),
        ...standingView(normalized, authorized),
      };
      return backend.signTypedData(normalized, {
        expectedHash,
        digest: hash,
        job: jobOf({
          typed_data: bound.typed_data,
          ...(bound.primary_type !== undefined ? { primary_type: bound.primary_type } : {}),
          ...(bound.chain_id !== undefined ? { chain_id: bound.chain_id } : {}),
        }),
      });
    },
  };
  // Optional capability: backends that sign AND broadcast through their
  // own channel (phone wallets only expose eth_sendTransaction). Callers
  // probe for it — see transaction-service's signAndSendTransaction.
  if (typeof backend.sendTransaction === 'function') {
    signer.sendTransaction = async (tx) => {
      await spendAndCheck();
      // The transaction a token bound, exactly; or the send as main has it,
      // in the core's form (`phoneJobTx`). The core's reply says what became
      // of a flagged dApp send's "Always allow" (`rule`), only once its
      // transaction showed and matched.
      const bound = authorized?.confirmation?.payload?.tx;
      const sent = await backend.sendTransaction(tx, jobOf({ tx: bound ?? phoneJobTx(tx) }));
      if (phoneJob && typeof authorized?.onRule === 'function')
        authorized.onRule(sent?.rule ?? null);
      return sent;
    };
  }
  return signer;
}

module.exports = { getSigner };
