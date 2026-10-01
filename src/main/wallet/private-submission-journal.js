/** Main-owned write-ahead journal. No signed bytes or keys are persisted.
 * Every durable attempt is possibly submitted, including after a crash before
 * transport handoff. Observations never authorize retries or erase attempts.
 */
const { createHash, createHmac } = require('crypto');
const path = require('path');
const { createPrivacyProfileGuard } = require('./privacy-profile-guard');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { createPrivacyStorage } = require('./privacy-storage');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { validIntent, isExitIntent } = require('./private-transaction-intent');
const journals = new WeakMap();
const HASH = /^0x[0-9a-f]{64}$/;
const KEY = 'submissions-v1';
const retention = require('./privacy-journal-retention');
const unresolved = (records) => records.some((record) => !record.resolution);
function snapshot(record) {
  if (record.intent) Object.freeze(record.intent);
  if (record.observation) Object.freeze(record.observation);
  if (record.resolution) Object.freeze(record.resolution);
  return Object.freeze(record);
}
function validObservation(value) {
  return (
    value &&
    ['unknown', 'pending', 'included', 'reverted', 'reorged', 'nonce-consumed'].includes(
      value.status
    ) &&
    value.trust === 'unverified' &&
    Number.isSafeInteger(value.observedAt) &&
    value.observedAt >= 0 &&
    Number.isSafeInteger(value.confirmations) &&
    value.confirmations >= 0 &&
    (value.status !== 'nonce-consumed' ||
      (Number.isSafeInteger(value.finalizedNonce) && value.finalizedNonce > 0)) &&
    (['included', 'reverted', 'nonce-consumed'].includes(value.status)
      ? typeof value.blockHash === 'string' &&
        HASH.test(value.blockHash) &&
        Number.isSafeInteger(value.blockNumber) &&
        value.blockNumber >= 0 &&
        value.confirmations > 0
      : value.blockHash === null && value.blockNumber === null && value.confirmations === 0)
  );
}

function createSubmissionJournal({ handle, directory, key, profileGuard }) {
  const context = getPrivacyContext(handle);
  const { subject } = context;
  if (
    subject.kind !== 'public-address' ||
    subject.role !== 'transaction-rpc' ||
    subject.chainId !== 11155111 ||
    subject.operation !== null ||
    subject.protocol !== null ||
    subject.deployment !== null
  ) {
    throw privacyError('PRIVATE_JOURNAL_SCOPE', 'Unsupported submission journal scope');
  }
  const storage = createPrivacyStorage({ handle, directory, key, profileGuard });
  const invalid = () =>
    privacyError('PRIVATE_JOURNAL_INVALID', 'Submission state could not be validated');
  function decode(value) {
    if (value === null) return { records: [], archive: [] };
    try {
      const data = JSON.parse(value);
      if (
        ![1, 2, 3].includes(data.version) ||
        !Array.isArray(data.records) ||
        data.records.length > 64
      )
        throw invalid();
      const hashes = new Set();
      for (const record of data.records) {
        if (
          !HASH.test(record.hash) ||
          hashes.has(record.hash) ||
          !Number.isSafeInteger(record.nonce) ||
          record.nonce < 0 ||
          !['attempted', 'submitted'].includes(record.state) ||
          !Number.isSafeInteger(record.attemptedAt) ||
          record.attemptedAt < 0
        )
          throw invalid();
        if (
          record.revision !== undefined &&
          (!Number.isSafeInteger(record.revision) || record.revision < 0)
        )
          throw invalid();
        if (record.intent !== undefined && !validIntent(record.intent)) throw invalid();
        if (record.observation !== undefined && !validObservation(record.observation))
          throw invalid();
        if (
          record.observation?.status === 'nonce-consumed' &&
          record.observation.finalizedNonce <= record.nonce
        )
          throw invalid();
        if (
          record.resolution &&
          (!record.observation ||
            record.resolution.blockHash !== record.observation.blockHash ||
            !Number.isSafeInteger(record.resolution.minimumConfirmations) ||
            record.resolution.minimumConfirmations < 1 ||
            record.observation.confirmations < record.resolution.minimumConfirmations ||
            !Number.isSafeInteger(record.resolution.reviewedAt) ||
            record.resolution.reviewedAt < 0)
        )
          throw invalid();
        hashes.add(record.hash);
      }
      const archive = data.version === 1 ? [] : data.archive;
      if (
        !retention.validArchive(archive, 'public') ||
        new Set([...data.records, ...archive].map((r) => r.hash)).size !==
          data.records.length + archive.length ||
        archive.some((r, i) => i > 0 && r.nonce <= archive[i - 1].nonce) ||
        data.records.some((r) => archive.length && r.nonce <= archive.at(-1).nonce)
      )
        throw invalid();
      return { records: data.records, archive };
    } catch {
      throw invalid();
    }
  }
  async function list() {
    getPrivacyContext(handle);
    const value = await storage.get(KEY);
    getPrivacyContext(handle);
    return decode(value).records.map(snapshot);
  }
  function modify(change) {
    return storage.update(KEY, (value) => {
      const state = decode(value);
      return JSON.stringify({
        version: 3,
        records: change(state.records, state.archive),
        archive: state.archive,
      });
    });
  }
  async function assertCanSubmit() {
    if (unresolved(await list()))
      throw privacyError(
        'PRIVATE_SUBMISSION_UNRESOLVED',
        'Reconcile the recorded submission before creating another transaction'
      );
  }
  return Object.freeze({
    list,
    assertCanSubmit,
    // Explicit private initialization enrolls the account before its first
    // submission. Ordinary sends must never create a new enrollment.
    async initialize() {
      const current = await storage.get(KEY);
      decode(current);
      if (current === null) {
        const lease = require('./transaction-submission-coordinator').acquireSubmissionLease({
          chainId: subject.chainId,
          from: subject.principal,
          privacyContext: handle,
        });
        try {
          await storage.update(KEY, (value) => {
            decode(value);
            return value === null
              ? JSON.stringify({ version: 3, records: [], archive: [] })
              : value;
          });
        } finally {
          lease.release();
        }
      }
      getPrivacyContext(handle);
    },
    async selectNonce(pending) {
      if (!Number.isSafeInteger(pending) || pending < 0) throw invalid();
      const state = decode(await storage.get(KEY));
      getPrivacyContext(handle);
      if (unresolved(state.records))
        throw privacyError(
          'PRIVATE_SUBMISSION_UNRESOLVED',
          'Reconcile the recorded submission before creating another transaction'
        );
      const highest = Math.max(
        -1,
        ...state.records.map((r) => r.nonce),
        ...state.archive.map((r) => r.nonce)
      );
      if (!Number.isSafeInteger(highest + 1)) throw invalid();
      return Math.max(pending, highest + 1);
    },
    async listArchive() {
      const state = decode(await storage.get(KEY));
      getPrivacyContext(handle);
      return structuredClone(state.archive);
    },
    async archiveResolved(expected, anchors) {
      await storage.update(KEY, (value) => {
        const state = decode(value);
        return JSON.stringify({
          version: 3,
          ...retention.archivePrefix(state.records, state.archive, expected, anchors, 'public'),
        });
      });
      getPrivacyContext(handle);
    },
    async has(hash) {
      const state = decode(await storage.get(KEY));
      getPrivacyContext(handle);
      return [...state.records, ...state.archive].some((r) => r.hash === hash?.toLowerCase());
    },
    async begin(hash, nonce, intent) {
      if (
        !HASH.test(hash) ||
        !Number.isSafeInteger(nonce) ||
        nonce < 0 ||
        (intent !== undefined &&
          (!validIntent(intent) || (isExitIntent(intent) && !intent.commitment)))
      )
        throw invalid();
      const metadata = intent === undefined ? {} : { intent: { ...intent } };
      try {
        await modify((records, archive) => {
          if ([...records, ...archive].some((record) => record.hash === hash)) {
            throw Object.assign(
              privacyError(
                'PRIVATE_BROADCAST_ALREADY_ATTEMPTED',
                'Query the existing submission before any further action'
              ),
              { transactionHash: hash }
            );
          }
          if (
            isExitIntent(intent) &&
            [...records, ...archive].some(
              (record) =>
                isExitIntent(record.intent) &&
                record.intent.pool === intent.pool &&
                record.intent.commitment === intent.commitment
            )
          ) {
            throw privacyError(
              'PRIVATE_PPV2_EXIT_RESERVED',
              'Selected note has a recorded exit attempt'
            );
          }
          // Conservatively serialize all sends for this account. Unverified RPC
          // receipts alone cannot clear the gate; an explicit review must.
          if (unresolved(records))
            throw privacyError(
              'PRIVATE_SUBMISSION_UNRESOLVED',
              'Reconcile the recorded submission before creating another transaction'
            );
          if (records.length >= 64)
            throw privacyError('PRIVATE_TRANSACTION_LIMIT', 'Submission history capacity reached');
          if ([...records, ...archive].some((record) => record.nonce >= nonce))
            throw privacyError(
              'PRIVATE_NONCE_REUSE_REFUSED',
              'Nonce must advance beyond recorded submissions'
            );
          return [
            ...records,
            { hash, nonce, state: 'attempted', attemptedAt: Date.now(), ...metadata },
          ];
        });
      } catch (error) {
        if (error.storageCommitted)
          throw Object.assign(
            privacyError(
              'PRIVATE_BROADCAST_UNCERTAIN',
              'Submission record may have been saved; reconcile the recorded attempt'
            ),
            { transactionHash: hash, submissionStatus: 'unknown' }
          );
        throw error;
      }
    },
    async observe(hash, observation, revision) {
      if (!validObservation(observation)) throw invalid();
      let updated;
      await modify((records) => {
        const record = records.find((entry) => entry.hash === hash);
        if (!record || (record.revision || 0) !== revision)
          throw privacyError(
            'PRIVATE_RECONCILIATION_STALE',
            'Submission observation was superseded'
          );
        if (observation.status === 'nonce-consumed' && observation.finalizedNonce <= record.nonce)
          throw invalid();
        if (!Number.isSafeInteger(revision + 1)) throw invalid();
        const previous = record.observation;
        record.observation = { ...observation };
        record.revision = revision + 1;
        if (
          record.resolution &&
          (record.resolution.blockHash !== observation.blockHash ||
            previous?.status !== observation.status ||
            previous?.blockNumber !== observation.blockNumber ||
            previous?.finalizedNonce !== observation.finalizedNonce ||
            observation.confirmations < record.resolution.minimumConfirmations)
        )
          record.resolution = null;
        updated = record;
        return records;
      });
      getPrivacyContext(handle);
      return snapshot(updated);
    },
    async resolve(hash, revision, minimumConfirmations) {
      let updated;
      await modify((records) => {
        const record = records.find((entry) => entry.hash === hash);
        if (!record || record.revision !== revision)
          throw privacyError(
            'PRIVATE_RECONCILIATION_STALE',
            'Submission observation was superseded'
          );
        if (
          !Number.isSafeInteger(minimumConfirmations) ||
          minimumConfirmations < 1 ||
          !Number.isSafeInteger(revision + 1) ||
          !['included', 'reverted', 'nonce-consumed'].includes(record.observation?.status) ||
          record.observation.confirmations < minimumConfirmations
        )
          throw invalid();
        record.resolution = {
          blockHash: record.observation.blockHash,
          minimumConfirmations,
          reviewedAt: Date.now(),
        };
        record.revision += 1;
        updated = record;
        return records;
      });
      getPrivacyContext(handle);
      return snapshot(updated);
    },
    async bindExitIntent(hash, revision, intent, assertCurrent) {
      if (
        !HASH.test(hash) ||
        !validIntent(intent) ||
        !isExitIntent(intent) ||
        !intent.commitment ||
        typeof assertCurrent !== 'function'
      )
        throw invalid();
      const binding = { ...intent };
      await modify((records) => {
        assertCurrent();
        const record = records.find((r) => r.hash === hash);
        if (
          !record ||
          (record.revision || 0) !== revision ||
          !Number.isSafeInteger(revision + 1) ||
          !record.intent ||
          record.intent.commitment ||
          record.intent.kind !== binding.kind ||
          record.intent.digest !== binding.digest
        ) {
          throw privacyError('PRIVATE_RECONCILIATION_STALE', 'Legacy exit recovery was superseded');
        }
        record.intent = binding;
        record.revision = revision + 1;
        return records;
      });
      getPrivacyContext(handle);
    },
    async markSubmitted(hash) {
      await modify((records) => {
        const record = records.find((entry) => entry.hash === hash);
        if (!record) throw invalid();
        record.state = 'submitted';
        return records;
      });
    },
  });
}

// Derive only a domain-separated local encryption key from the active vault.
// Reopening the same profile/account after restart reconstructs the same key;
// other profiles/accounts/chains cannot authenticate this journal's contents.
function getPrivateSubmissionJournal(handle) {
  const context = getPrivacyContext(handle);
  if (journals.has(handle)) return journals.get(handle);
  const profile = require('../profile-resolver').getActiveProfile();
  const vault = require('../identity/vault');
  const signal = vault.getSessionSignal();
  if (!profile?.id || !profile.userDataDir || signal.aborted || !vault.getMnemonic()) {
    throw privacyError('PRIVATE_JOURNAL_UNAVAILABLE', 'An unlocked active profile is required');
  }
  const profileId = createHash('sha256')
    .update(JSON.stringify([profile.id, profile.userDataDir]))
    .digest('hex');
  if (profileId !== context.profileId)
    throw privacyError('PRIVATE_JOURNAL_SCOPE', 'Submission context belongs to another profile');
  const seed = mnemonicToSeedSync(vault.getMnemonic());
  let key;
  try {
    key = createHmac('sha256', seed)
      .update('Freedom wallet submission journal v1\0')
      .update(JSON.stringify([profileId, context.subject]))
      .digest();
    const journal = createSubmissionJournal({
      handle,
      directory: path.join(profile.userDataDir, 'wallet-private-submissions'),
      key,
      profileGuard: createPrivacyProfileGuard({ handle, profile, seed }),
    });
    journals.set(handle, journal);
    return journal;
  } finally {
    seed.fill(0);
    key?.fill(0);
  }
}

module.exports = { createSubmissionJournal, getPrivateSubmissionJournal };
