/** Main-owned write-ahead relay ledger. A response is not settlement.
 * Resolution retains history and requires explicitly reviewed chain evidence. */
const path = require('path');
const { createHmac } = require('crypto');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { createPrivacyStorage } = require('./privacy-storage');
const { assertPPv2Context } = require('../identity/ppv2-keys');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const HASH = /^0x[0-9a-f]{64}$/;
const KEY = 'relay-attempts-v1';
const invalid = () => privacyError('PRIVATE_PPV2_RELAY_STATE_INVALID', 'Relay state could not be validated');
const blocked = () => privacyError('PRIVATE_PPV2_RELAY_UNRESOLVED', 'A recorded relay attempt requires reconciliation');
const keys = (v, names) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
const fields = ['id', 'intentDigest', 'endpointDigest', 'payloadDigest', 'commitment', 'nullifier'];
function validAttempt(v) {
  return keys(v, fields) && fields.every((k) => typeof v[k] === 'string' && HASH.test(v[k]));
}
function validSettlement(v) {
  return keys(v, ['pool', 'processor', 'outputCommitment', 'amountOut', 'noteDigest', 'fromBlock']) &&
    [v.pool, v.processor].every((x) => typeof x === 'string' && /^0x[0-9a-f]{40}$/.test(x)) &&
    [v.outputCommitment, v.noteDigest].every((x) => typeof x === 'string' && HASH.test(x)) &&
    typeof v.amountOut === 'string' && /^[1-9][0-9]{0,38}$/.test(v.amountOut) &&
    Number.isSafeInteger(v.fromBlock) && v.fromBlock >= 0;
}
function validObservation(v) {
  return keys(v, ['status', 'transactionHash', 'blockHash', 'blockNumber', 'trust']) && v.trust === 'unverified-rpc' &&
    ['included', 'unknown', 'conflict'].includes(v.status) && (v.status === 'included'
      ? HASH.test(v.transactionHash) && HASH.test(v.blockHash) && Number.isSafeInteger(v.blockNumber) && v.blockNumber >= 0
      : v.transactionHash === null && v.blockHash === null && v.blockNumber === null);
}
function createPPv2RelayJournal({ handle, directory, key }) {
  const { subject } = getPrivacyContext(handle);
  if (subject.kind !== 'private-account' || subject.role !== 'storage' || subject.protocol !== 'privacy-pools-v2' ||
      subject.deployment !== 'sepolia' || subject.chainId !== 11155111 || subject.operation !== null ||
      !/^ppv2:(0|[1-9][0-9]{0,4})$/.test(subject.principal) || Number(subject.principal.slice(5)) > 65535) throw invalid();
  const storage = createPrivacyStorage({ handle, directory, key });
  function decode(value) {
    if (value === null) return [];
    try {
      const data = JSON.parse(value);
      if (!keys(data, ['version', 'records']) || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 64) throw invalid();
      for (const record of data.records) {
        const extra = ['settlement', 'observation', 'resolution', 'revision'].filter((k) => Object.hasOwn(record, k));
        if (!keys(record, [...fields, 'attemptedAt', 'acknowledgedHash', ...extra]) ||
            !validAttempt(Object.fromEntries(fields.map((k) => [k, record[k]]))) ||
            !Number.isSafeInteger(record.attemptedAt) || record.attemptedAt < 0 ||
            !(record.acknowledgedHash === null || (typeof record.acknowledgedHash === 'string' && HASH.test(record.acknowledgedHash)))) throw invalid();
        if (record.settlement !== undefined && !validSettlement(record.settlement)) throw invalid();
        if (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 0)) throw invalid();
        if (record.observation !== undefined && (!record.settlement || !Number.isSafeInteger(record.revision) || !validObservation(record.observation))) throw invalid();
        if (record.resolution !== undefined && record.resolution !== null && (!keys(record.resolution, ['blockHash', 'reviewedAt']) ||
            record.observation?.status !== 'included' || record.resolution.blockHash !== record.observation.blockHash ||
            !Number.isSafeInteger(record.resolution.reviewedAt) || record.resolution.reviewedAt < 0)) throw invalid();
      }
      if (new Set(data.records.map((r) => r.id)).size !== data.records.length ||
          new Set(data.records.map((r) => r.nullifier)).size !== data.records.length ||
          new Set(data.records.map((r) => r.commitment)).size !== data.records.length) throw invalid();
      return data.records;
    } catch { throw invalid(); }
  }
  async function list() {
    const value = await storage.get(KEY); getPrivacyContext(handle);
    return Object.freeze(decode(value).map((r) => { for (const k of ['settlement', 'observation', 'resolution']) if (r[k]) Object.freeze(r[k]); return Object.freeze(r); }));
  }
  return Object.freeze({
    assertScope(otherHandle) {
      const current = getPrivacyContext(handle), other = getPrivacyContext(otherHandle);
      const { role: _a, ...a } = current.subject, { role: _b, ...b } = other.subject;
      if (current.profileId !== other.profileId || current.generation !== other.generation || JSON.stringify(a) !== JSON.stringify(b)) throw invalid();
    },
    list,
    async assertCanSubmit() { if ((await list()).some((r) => !r.resolution)) throw blocked(); },
    async begin(attempt, settlement) {
      if (!validAttempt(attempt) || (settlement !== undefined && !validSettlement(settlement))) throw invalid();
      const copy = { ...attempt, ...(settlement ? { settlement: { ...settlement } } : {}) };
      await storage.update(KEY, (value) => {
        const records = decode(value);
        if (records.some((r) => !r.resolution || r.id === copy.id || r.nullifier === copy.nullifier || r.commitment === copy.commitment) || records.length >= 64) throw blocked();
        return JSON.stringify({ version: 1, records: [...records, { ...copy, attemptedAt: Date.now(), acknowledgedHash: null }] });
      });
      getPrivacyContext(handle);
    },
    async observe(id, observation, revision) {
      if (!validObservation(observation) || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw invalid();
      const copy = { ...observation };
      await storage.update(KEY, (value) => {
        const records = decode(value), r = records.find((r) => r.id === id);
        if (!r?.settlement || (r.revision || 0) !== revision) throw invalid();
        if (copy.status !== 'included' || r.observation?.blockHash !== copy.blockHash ||
            r.observation?.transactionHash !== copy.transactionHash) r.resolution = null;
        r.observation = copy; r.revision = revision + 1;
        return JSON.stringify({ version: 1, records });
      });
      return (await list()).find((r) => r.id === id);
    },
    async resolve(id, revision) {
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw invalid();
      await storage.update(KEY, (value) => {
        const records = decode(value), r = records.find((r) => r.id === id);
        if (!r?.settlement || r.revision !== revision || r.observation?.status !== 'included') throw invalid();
        r.resolution = { blockHash: r.observation.blockHash, reviewedAt: Date.now() }; r.revision++;
        return JSON.stringify({ version: 1, records });
      });
      return (await list()).find((r) => r.id === id);
    },
    async acknowledge(id, hash) {
      if (typeof hash !== 'string' || !HASH.test(hash)) throw invalid();
      await storage.update(KEY, (value) => {
        const records = decode(value), record = records.find((r) => r.id === id);
        if (!record || record.id !== id || (record.acknowledgedHash && record.acknowledgedHash !== hash)) throw invalid();
        record.acknowledgedHash = hash;
        return JSON.stringify({ version: 1, records });
      });
      getPrivacyContext(handle);
    },
  });
}

function getPPv2RelayJournal(handle, accountIndex) {
  const { context, profile } = assertPPv2Context(handle, 'storage', accountIndex);
  const vault = require('../identity/vault');
  if (vault.getSessionSignal().aborted || !vault.getMnemonic()) throw privacyError('PRIVACY_VAULT_LOCKED', 'Relay journal is locked');
  const seed = mnemonicToSeedSync(vault.getMnemonic());
  let key;
  try {
    // Stable across endpoint/SDK changes: a new configuration cannot hide an attempt.
    key = createHmac('sha256', seed).update('Freedom PPv2 relay journal v1\0')
      .update(JSON.stringify([context.profileId, context.subject])).digest();
    return createPPv2RelayJournal({ handle, directory: path.join(profile.userDataDir, 'wallet-ppv2-relays'), key });
  } finally { seed.fill(0); key?.fill(0); }
}
module.exports = { createPPv2RelayJournal, getPPv2RelayJournal };
