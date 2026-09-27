/** Main-owned write-ahead relay ledger. A response is not settlement. No retry
 * or release API until canonical nullifier/receipt reconciliation is qualified. */
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
      if (!keys(data, ['version', 'records']) || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 1) throw invalid();
      for (const record of data.records) {
        if (!keys(record, [...fields, 'attemptedAt', 'acknowledgedHash']) ||
            !validAttempt(Object.fromEntries(fields.map((k) => [k, record[k]]))) ||
            !Number.isSafeInteger(record.attemptedAt) || record.attemptedAt < 0 ||
            !(record.acknowledgedHash === null || (typeof record.acknowledgedHash === 'string' && HASH.test(record.acknowledgedHash)))) throw invalid();
      }
      return data.records;
    } catch { throw invalid(); }
  }
  async function list() {
    const value = await storage.get(KEY); getPrivacyContext(handle);
    return Object.freeze(decode(value).map(Object.freeze));
  }
  return Object.freeze({
    assertScope(otherHandle) {
      const current = getPrivacyContext(handle), other = getPrivacyContext(otherHandle);
      const { role: _a, ...a } = current.subject, { role: _b, ...b } = other.subject;
      if (current.profileId !== other.profileId || current.generation !== other.generation || JSON.stringify(a) !== JSON.stringify(b)) throw invalid();
    },
    list,
    async assertCanSubmit() { if ((await list()).length) throw blocked(); },
    async begin(attempt) {
      if (!validAttempt(attempt)) throw invalid();
      const copy = { ...attempt };
      await storage.update(KEY, (value) => {
        if (decode(value).length) throw blocked();
        return JSON.stringify({ version: 1, records: [{ ...copy, attemptedAt: Date.now(), acknowledgedHash: null }] });
      });
      getPrivacyContext(handle);
    },
    async acknowledge(id, hash) {
      if (typeof hash !== 'string' || !HASH.test(hash)) throw invalid();
      await storage.update(KEY, (value) => {
        const records = decode(value), record = records[0];
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
