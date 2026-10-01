/** Account-scoped coordination for the development Sepolia privacy experiment.
 * Ordinary sends never enroll an account. Existing encrypted journals remain
 * authoritative across routes and restart; opaque permits authorize one handoff.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Transaction } = require('ethers');
const {
  createPrivacyScope,
  getPrivacyContext,
  privacyError,
} = require('../networks/privacy-context');
const { getPrivacyStoragePath } = require('./privacy-storage');
const active = new Set();
const permits = new WeakMap();
const profile = () => require('../profile-resolver').getActiveProfile();
const profileKey = (value) =>
  value?.id && value.userDataDir
    ? createHash('sha256')
        .update(JSON.stringify([value.id, value.userDataDir]))
        .digest('hex')
    : null;
const subject = (from) => ({
  kind: 'public-address',
  principal: from,
  chainId: 11155111,
  role: 'transaction-rpc',
});

function enrollment(chainId, from) {
  if (Number(chainId) !== 11155111) return null;
  const current = profile(),
    id = profileKey(current);
  if (!id) return null;
  const marker = path.join(current.userDataDir, 'wallet-privacy-inventory.json');
  const stores = ['wallet-private-submissions', 'wallet-ppv2-experiment', 'wallet-ppv2-relays'];
  const hasStores = stores.some((name) => {
    const directory = path.join(current.userDataDir, name);
    return fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
  });
  if (!fs.existsSync(marker)) {
    if (hasStores)
      throw privacyError(
        'PRIVATE_PROFILE_INVENTORY_MISSING',
        'Privacy inventory requires recovery'
      );
    return null;
  }
  // A negative enrollment decision must authenticate the inventory too. A
  // locked experimental profile therefore needs unlocking for Sepolia sends,
  // even when another account is the one with private history.
  const vault = require('../identity/vault');
  if (vault.getSessionSignal().aborted || !vault.getMnemonic())
    throw privacyError(
      'PRIVATE_JOURNAL_UNAVAILABLE',
      'Unlock the profile to check its private submission history'
    );
  const scope = createPrivacyScope({
    profileId: id,
    signal: vault.getSessionSignal(),
    isCurrent: () => profileKey(profile()) === id,
  });
  const seed = require('@scure/bip39').mnemonicToSeedSync(vault.getMnemonic());
  try {
    const handle = scope.getContext(subject(from));
    const file = getPrivacyStoragePath(
      handle,
      path.join(current.userDataDir, 'wallet-private-submissions')
    );
    require('./privacy-profile-guard')
      .createPrivacyProfileGuard({ handle, profile: current, seed })
      .assert(file);
    return fs.existsSync(file) ? { id, current } : null;
  } finally {
    seed.fill(0);
    scope.close();
  }
}

function acquireSubmissionLease({ chainId, from, privacyContext, remote = false }) {
  const coordinated = Number(chainId) === 11155111;
  const id = privacyContext ? getPrivacyContext(privacyContext).profileId : profileKey(profile());
  const key = JSON.stringify([id, Number(chainId), from.toLowerCase()]);
  if (coordinated && active.has(key))
    throw privacyError(
      'PRIVATE_SEND_IN_PROGRESS',
      'Another transaction is being prepared for this account'
    );
  if (coordinated) active.add(key);
  let journal = null,
    handle = null,
    released = false;
  function assertActive() {
    if (!coordinated) return;
    if (released) throw privacyError('PRIVATE_SEND_ENDED', 'Transaction preparation ended');
    if (privacyContext) getPrivacyContext(privacyContext, chainId);
    else if (profileKey(profile()) !== id)
      throw privacyError('PRIVATE_PROFILE_MOVED', 'Active profile changed');
    if (handle) getPrivacyContext(handle, chainId);
  }
  return {
    assertActive,
    assertProfileCurrent() {
      if (coordinated && profileKey(profile()) !== id)
        throw privacyError('PRIVATE_PROFILE_MOVED', 'Active profile changed');
    },
    get signal() {
      return handle ? getPrivacyContext(handle).signal : undefined;
    },
    get journaled() {
      return !!journal;
    },
    async prepare() {
      assertActive();
      if (privacyContext) return;
      const enrolled = enrollment(chainId, from);
      if (!enrolled) return;
      if (remote)
        throw privacyError(
          'PRIVATE_REMOTE_BROADCAST_UNSUPPORTED',
          'This enrolled account requires a wallet-owned broadcast'
        );
      handle = require('./privacy-session').openPrivacySession().getContext(subject(from));
      journal = require('./private-submission-journal').getPrivateSubmissionJournal(handle);
      await journal.assertCanSubmit();
      assertActive();
    },
    async selectNonce(pending) {
      assertActive();
      const selected = journal ? await journal.selectNonce(pending) : pending;
      assertActive();
      return selected;
    },
    async begin(raw) {
      assertActive();
      if (!journal) return undefined;
      const tx = Transaction.from(raw);
      if (
        !tx.isSigned() ||
        tx.from.toLowerCase() !== from.toLowerCase() ||
        tx.chainId !== BigInt(chainId)
      )
        throw privacyError(
          'PRIVATE_SIGNED_TX_INVALID',
          'Signed transaction differs from its account'
        );
      await journal.begin(tx.hash.toLowerCase(), tx.nonce);
      // Once durable, return the permit even if the lifetime ended in this await.
      // Consumption still checks the lifetime; the caller reports uncertainty.
      const permit = Object.freeze({});
      permits.set(permit, { chainId: Number(chainId), hash: tx.hash, assertActive });
      return permit;
    },
    async submitted(hash) {
      assertActive();
      await journal?.markSubmitted(hash.toLowerCase());
      assertActive();
    },
    release() {
      if (released) return;
      released = true;
      if (coordinated) active.delete(key);
    },
  };
}

function consumeSubmissionPermit(chainId, raw, permit) {
  if (Number(chainId) !== 11155111 && !permit) return false;
  const current = profile();
  // No experiment state means existing non-enrolled broadcasts retain their
  // behavior, including raw network adapters used independently of a wallet.
  const stateExists =
    current &&
    [
      'wallet-privacy-inventory.json',
      'wallet-private-submissions',
      'wallet-ppv2-experiment',
      'wallet-ppv2-relays',
    ].some((name) => fs.existsSync(path.join(current.userDataDir, name)));
  if (!permit && !stateExists) return false;
  const tx = Transaction.from(raw);
  const entry = permit && permits.get(permit);
  if (!entry && !enrollment(chainId, tx.from)) return false;
  if (!entry || entry.chainId !== Number(chainId) || entry.hash !== tx.hash)
    throw privacyError(
      'PRIVATE_BROADCAST_PERMIT_REQUIRED',
      'An enrolled account requires a fresh journaled broadcast'
    );
  permits.delete(permit);
  entry.assertActive();
  return true;
}
module.exports = { enrollment, acquireSubmissionLease, consumeSubmissionPermit };
