/** Account-owned recovery data, not signing/proof authority. One bounded atomic
 * document retains every intent, including unused holds. The controller persists
 * a capsule before markSigning, a signature before A, and a C-verified transaction
 * before the EOA journal. Storage validation alone does not establish those gates.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes, createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { assertRailgunPrivateReservationsOwner } = require('./railgun-private-reservations');
const {
  normalizeRailgunPrivateCapsule,
  digestRailgunPrivateCapsule,
} = require('./railgun-private-capsule');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('./railgun-private-intent');
const RECORD = 'railgun-private-capsules-v1',
  MAX_RECORDS = 32,
  MAX_SEQUENCE = 96;
const owners = new Set(),
  instances = new WeakSet(),
  permits = new WeakMap();
const fail = (code = 'RAILGUN_CAPSULE_STORE_REFUSED') =>
  Object.assign(new Error('Railgun recovery data requires recovery'), { code });
const check = (v) => {
  if (!v) throw fail();
};
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_SEQUENCE;
const exact = (v, keys) =>
  v &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const hash = (v) =>
  createHash('sha256')
    .update('freedom:railgun:recovery-binding-v1\0')
    .update(JSON.stringify(v))
    .digest('hex');
async function createRailgunPrivateCapsuleStore({
  handle,
  directory,
  key,
  binding,
  walletId,
  profileGuard,
  reservations,
  create = false,
  readFloor,
  advanceFloor,
}) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(digest(binding) && digest(walletId) && typeof create === 'boolean');
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.deployment === 'sepolia' &&
      subject.role === 'storage' &&
      subject.operation === RECORD + ':' + walletId
  );
  assertRailgunPrivateReservationsOwner(reservations, { handle, binding, walletId, directory });
  check(typeof readFloor === 'function' && typeof advanceFloor === 'function');
  check(path.isAbsolute(directory) && fs.realpathSync(directory) === directory);
  const filename = getPrivacyStoragePath(handle, directory);
  check(!owners.has(filename));
  owners.add(filename);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, reservations.signal]),
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const lease = randomBytes(32).toString('hex');
  let storage,
    current,
    closed = false,
    busy = false;
  const active = () => {
    check(!closed);
    getPrivacyContext(handle);
    check(!reservations.signal.aborted);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    owners.delete(filename);
    scope.close();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  function record(v) {
    check(
      exact(v, [
        'holdId',
        'factsDigest',
        'authorizationDigest',
        'capsuleDigest',
        'capsule',
        'signingDigest',
        'signature',
        'provedTransaction',
      ])
    );
    check(
      digest(v.holdId) &&
        digest(v.factsDigest) &&
        digest(v.capsuleDigest) &&
        digest(v.authorizationDigest)
    );
    const capsule = normalizeRailgunPrivateCapsule(v.capsule);
    check(
      capsule.walletId === walletId && digestRailgunPrivateCapsule(capsule) === v.capsuleDigest
    );
    const signature = v.signature === null ? null : normalizeRailgunSignature(v.signature);
    check(signature === null ? v.signingDigest === null : digest(v.signingDigest));
    let provedTransaction = null;
    if (v.provedTransaction !== null) {
      check(signature !== null);
      matchRailgunPrivateProvedTransaction(
        capsule.preparation.transaction,
        v.provedTransaction,
        capsule.preparation.expected
      );
      provedTransaction = Object.freeze({ ...v.provedTransaction });
    }
    const result = Object.freeze({
      holdId: v.holdId,
      factsDigest: v.factsDigest,
      authorizationDigest: v.authorizationDigest,
      capsuleDigest: v.capsuleDigest,
      capsule,
      signingDigest: v.signingDigest,
      signature,
      provedTransaction,
    });
    check(Buffer.byteLength(JSON.stringify(result)) <= 24 * 1024);
    return result;
  }
  function decode(text) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= 800 * 1024);
    const v = JSON.parse(text);
    check(exact(v, ['version', 'binding', 'walletId', 'lease', 'sequence', 'entries']));
    check(
      v.version === 1 &&
        v.binding === binding &&
        v.walletId === walletId &&
        digest(v.lease) &&
        integer(v.sequence) &&
        Array.isArray(v.entries) &&
        v.entries.length <= MAX_RECORDS
    );
    const entries = v.entries.map(record),
      ids = new Set(entries.map((e) => e.holdId));
    check(ids.size === entries.length);
    check(
      v.sequence ===
        entries.reduce(
          (n, e) => n + 1 + Number(e.signature !== null) + Number(e.provedTransaction !== null),
          0
        )
    );
    return { version: 1, binding, walletId, lease: v.lease, sequence: v.sequence, entries };
  }
  const encode = (v) => {
    const text = JSON.stringify(v);
    decode(text);
    return text;
  };
  async function floor() {
    const value = await readFloor();
    active();
    check(value === null || integer(value));
    return value;
  }
  async function attest() {
    active();
    const value = decode(await storage.get(RECORD));
    active();
    check(value.lease === lease && JSON.stringify(value) === JSON.stringify(current));
    const minimum = await floor();
    check(minimum !== null && value.sequence >= minimum);
    return value;
  }
  try {
    storage = createPrivacyStorage({
      handle: scope.getContext(subject),
      directory,
      key,
      profileGuard,
    });
    const minimum = await floor();
    await storage.update(RECORD, (text) => {
      active();
      check(create ? text === null && minimum === null : text !== null);
      const v =
        text === null
          ? { version: 1, binding, walletId, lease, sequence: 0, entries: [] }
          : decode(text);
      check(minimum === null || v.sequence >= minimum);
      current = { ...v, lease };
      return encode(current);
    });
    active();
    await advanceFloor(current.sequence);
    active();
    await attest();
  } catch (error) {
    close();
    throw error;
  }
  async function exclusive(use) {
    active();
    check(!busy);
    busy = true;
    try {
      await attest();
      return await use();
    } catch (error) {
      if (
        ![
          'RAILGUN_CAPSULE_STORE_CAPACITY',
          'RAILGUN_CAPSULE_NOT_FOUND',
          'RAILGUN_CAPSULE_NOT_READY',
          'RAILGUN_CAPSULE_CONFLICT',
        ].includes(error.code)
      )
        close();
      throw error;
    } finally {
      busy = false;
    }
  }
  async function persist(next) {
    // All callers build append-only values. Assert each other record and each
    // immutable target field before a whole-document rewrite.
    check(
      next.entries.length === current.entries.length ||
        next.entries.length === current.entries.length + 1
    );
    let fills = next.entries.length - current.entries.length;
    current.entries.forEach((old, i) => {
      const value = next.entries[i];
      for (const name of [
        'holdId',
        'factsDigest',
        'authorizationDigest',
        'capsuleDigest',
        'capsule',
      ])
        check(JSON.stringify(value[name]) === JSON.stringify(old[name]));
      for (const name of ['signature', 'provedTransaction']) {
        if (old[name] !== null) check(JSON.stringify(value[name]) === JSON.stringify(old[name]));
        else if (value[name] !== null) fills++;
      }
      if (old.signingDigest !== null) check(value.signingDigest === old.signingDigest);
    });
    check(fills === 1 && next.sequence === current.sequence + 1);
    const text = encode(next);
    await storage.update(RECORD, (previous) => {
      active();
      check(JSON.stringify(decode(previous)) === JSON.stringify(current));
      return text;
    });
    current = next;
    active();
    await advanceFloor(current.sequence);
    active();
    await attest();
  }
  function assertBinding(entry, held) {
    check(entry.holdId === held.id && entry.factsDigest === hash(held.facts));
    const { capsule } = entry,
      f = held.facts,
      s = capsule.selection,
      e = capsule.preparation.expected;
    check(
      s.tree === f.tree &&
        s.position === f.position &&
        s.kind === f.kind &&
        e.nullifier === f.nullifier &&
        capsule.noteHash === f.noteHash
    );
    check(
      validateRailgunPrivateSigningIntent(capsule.preparation.transaction, e).digest ===
        f.intentDigest
    );
    if (held.state === 'signing')
      check(
        held.signing.gatesDigest ===
          hash({
            capsuleDigest: entry.capsuleDigest,
            authorizationDigest: entry.authorizationDigest,
          })
      );
  }
  async function put(receipt, input, authorizationDigest) {
    const capsule = normalizeRailgunPrivateCapsule(input);
    check(digest(authorizationDigest));
    return exclusive(async () => {
      const held = await reservations.assertReceipt(receipt);
      active();
      check(held.state === 'held');
      const next = record({
        holdId: held.id,
        factsDigest: hash(held.facts),
        authorizationDigest,
        capsuleDigest: digestRailgunPrivateCapsule(capsule),
        capsule,
        signingDigest: null,
        signature: null,
        provedTransaction: null,
      });
      assertBinding(next, held);
      const existing = current.entries.find((e) => e.holdId === held.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(next))
          throw fail('RAILGUN_CAPSULE_CONFLICT');
        return existing;
      }
      if (current.entries.length === MAX_RECORDS) throw fail('RAILGUN_CAPSULE_STORE_CAPACITY');
      await persist({
        ...current,
        sequence: current.sequence + 1,
        entries: [...current.entries, next],
      });
      await reservations.assertReceipt(receipt);
      active();
      return next;
    });
  }
  async function fill(receipt, name, value) {
    return exclusive(async () => {
      const held = await reservations.assertReceipt(receipt);
      active();
      check(held.state === 'signing');
      const old = current.entries.find((e) => e.holdId === held.id);
      check(old);
      assertBinding(old, held);
      const signingDigest = hash(held.signing);
      check(old.signingDigest === null || old.signingDigest === signingDigest);
      const next = record({ ...old, signingDigest, [name]: value });
      if (old[name] !== null) {
        if (JSON.stringify(old) !== JSON.stringify(next)) throw fail('RAILGUN_CAPSULE_CONFLICT');
        return old;
      }
      await persist({
        ...current,
        sequence: current.sequence + 1,
        entries: current.entries.map((e) => (e === old ? next : e)),
      });
      return next;
    });
  }
  async function markSigning(receipt, evidence) {
    return exclusive(async () => {
      const held = await reservations.assertReceipt(receipt);
      active();
      check(held.state === 'held');
      const entry = current.entries.find((e) => e.holdId === held.id);
      check(entry);
      assertBinding(entry, held);
      check(
        exact(evidence, ['submitter', 'operationId', 'gatesDigest']) && digest(evidence.gatesDigest)
      );
      check(evidence.gatesDigest === entry.authorizationDigest);
      const bound = Object.freeze({
        ...evidence,
        gatesDigest: hash({
          capsuleDigest: entry.capsuleDigest,
          authorizationDigest: evidence.gatesDigest,
        }),
      });
      const permit = Object.freeze({});
      permits.set(permit, {
        store: instance,
        reservations,
        receipt,
        evidence: bound,
        assertCurrent: () => {
          active();
          check(current.entries.includes(entry));
        },
      });
      try {
        const signed = await reservations.markSigning(receipt, bound, permit);
        await attest();
        return signed;
      } finally {
        permits.delete(permit);
      }
    });
  }
  // Recovery-only local data. A persisted signature/proof is not fresh signing,
  // chain, POI or disclosure authority. Keep the binding inside its owning store.
  async function readSigned(receipt) {
    reservations.assertReceiptContext(receipt, 'recovery');
    return exclusive(async () => {
      const held = await reservations.assertReceipt(receipt);
      active();
      reservations.assertReceiptContext(receipt, 'recovery');
      check(held.state === 'signing');
      const entry = current.entries.find((value) => value.holdId === held.id);
      if (!entry) throw fail('RAILGUN_CAPSULE_NOT_FOUND');
      assertBinding(entry, held);
      if (entry.signature === null || entry.provedTransaction === null)
        throw fail('RAILGUN_CAPSULE_NOT_READY');
      check(entry.signingDigest === hash(held.signing));
      await attest();
      active();
      reservations.assertReceiptContext(receipt, 'recovery');
      return entry;
    });
  }
  async function readSignedUnfinished(receipt) {
    reservations.assertReceiptContext(receipt, 'recovery');
    return exclusive(async () => {
      const held = await reservations.assertReceipt(receipt);
      active();
      reservations.assertReceiptContext(receipt, 'recovery');
      check(held.state === 'signing');
      const entry = current.entries.find((value) => value.holdId === held.id);
      if (!entry) throw fail('RAILGUN_CAPSULE_NOT_FOUND');
      assertBinding(entry, held);
      if (entry.signature === null || entry.provedTransaction !== null)
        throw fail('RAILGUN_CAPSULE_NOT_READY');
      check(entry.signingDigest === hash(held.signing));
      await attest();
      active();
      reservations.assertReceiptContext(receipt, 'recovery');
      return entry;
    });
  }
  const instance = Object.freeze({
    put,
    markSigning,
    readSigned,
    readSignedUnfinished,
    saveSignature: (receipt, value) => fill(receipt, 'signature', normalizeRailgunSignature(value)),
    saveProvedTransaction: (receipt, value) =>
      fill(receipt, 'provedTransaction', Object.freeze({ ...value })),
    get: (id) => {
      check(digest(id));
      return exclusive(async () => {
        const entry = current.entries.find((e) => e.holdId === id);
        if (!entry) throw fail('RAILGUN_CAPSULE_NOT_FOUND');
        return entry;
      });
    },
    inspect: () =>
      exclusive(async () =>
        Object.freeze({
          records: current.entries.length,
          signatures: current.entries.filter((e) => e.signature !== null).length,
          proofs: current.entries.filter((e) => e.provedTransaction !== null).length,
          capacity: MAX_RECORDS,
        })
      ),
    close,
    signal: scope.signal,
  });
  instances.add(instance);
  return instance;
}
module.exports = {
  createRailgunPrivateCapsuleStore,
  consumeRailgunCapsuleSigningPermit: (permit, store, reservations, receipt, evidence) => {
    const value = permits.get(permit);
    check(
      value &&
        value.store === store &&
        value.reservations === reservations &&
        value.receipt === receipt &&
        JSON.stringify(value.evidence) === JSON.stringify(evidence)
    );
    permits.delete(permit);
    value.assertCurrent();
    return value.assertCurrent;
  },
  isRailgunPrivateCapsuleStore: (value) => instances.has(value),
};
