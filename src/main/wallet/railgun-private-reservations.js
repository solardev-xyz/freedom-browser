/** Account-level, permanent input holds. A durable receipt records a hold; it
 * does not authenticate selection/POI or authorize key release. No release API.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const RECORD = 'railgun-private-reservations-v1',
  MAX_ENTRIES = 512,
  FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const owners = new Set(),
  instances = new WeakSet();
const fail = (code = 'RAILGUN_RESERVATIONS_REFUSED') =>
  Object.assign(new Error('Railgun private input requires recovery'), { code });
const check = (v) => {
  if (!v) throw fail();
};
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const field = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) < FIELD;
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const exact = (v, keys) =>
  v &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const FACTS = [
  'tree',
  'position',
  'nullifier',
  'noteHash',
  'kind',
  'intentDigest',
  'checkpointHash',
  'poiDigest',
];
function facts(v) {
  check(exact(v, FACTS));
  check(integer(v.tree, 65535) && integer(v.position, 65535));
  check(field(v.nullifier) && field(v.noteHash));
  check(['railgun-private-transfer', 'railgun-token-unshield'].includes(v.kind));
  check(typeof v.intentDigest === 'string' && /^0x[0-9a-f]{64}$/.test(v.intentDigest));
  check(digest(v.checkpointHash) && digest(v.poiDigest));
  return Object.freeze(Object.fromEntries(FACTS.map((key) => [key, v[key]])));
}
async function createRailgunPrivateReservations({
  handle,
  directory,
  key,
  binding,
  walletId,
  profileGuard,
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
  check(typeof readFloor === 'function' && typeof advanceFloor === 'function');
  check(path.isAbsolute(directory) && fs.realpathSync(directory) === directory);
  const filename = getPrivacyStoragePath(handle, directory);
  check(!owners.has(filename));
  owners.add(filename);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: context.signal,
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const lease = randomBytes(32).toString('hex'),
    receipts = new WeakMap();
  let storage,
    current,
    closed = false,
    busy = false;
  function active() {
    check(!closed);
    getPrivacyContext(handle);
  }
  function close() {
    if (closed) return;
    closed = true;
    owners.delete(filename);
    scope.close();
  }
  scope.signal.addEventListener('abort', close, { once: true });
  function decode(text) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= 512 * 1024);
    const v = JSON.parse(text);
    check(exact(v, ['version', 'binding', 'walletId', 'lease', 'sequence', 'entries']));
    check(
      v.version === 1 &&
        v.binding === binding &&
        v.walletId === walletId &&
        digest(v.lease) &&
        integer(v.sequence) &&
        Array.isArray(v.entries) &&
        v.entries.length <= MAX_ENTRIES &&
        v.sequence === v.entries.length
    );
    const ids = new Set(),
      inputs = new Set();
    v.entries = v.entries.map((entry) => {
      check(exact(entry, ['id', 'facts']) && digest(entry.id) && !ids.has(entry.id));
      const value = facts(entry.facts),
        input = value.tree + ':' + value.nullifier;
      check(!inputs.has(input));
      ids.add(entry.id);
      inputs.add(input);
      return Object.freeze({ id: entry.id, facts: value });
    });
    return v;
  }
  async function floor() {
    const value = await readFloor();
    active();
    check(value === null || integer(value, MAX_ENTRIES));
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
      const value =
        text === null
          ? { version: 1, binding, walletId, lease, sequence: 0, entries: [] }
          : decode(text);
      check(minimum === null || value.sequence >= minimum);
      current = { ...value, lease };
      return JSON.stringify(current);
    });
    active();
    await advanceFloor(current.sequence);
    active();
    await attest();
  } catch (error) {
    close();
    throw error;
  }
  async function reserve(input) {
    active();
    check(!busy);
    const value = facts(input);
    busy = true;
    try {
      await attest();
      if (
        current.entries.some(
          (e) => e.facts.tree === value.tree && e.facts.nullifier === value.nullifier
        )
      )
        throw fail('RAILGUN_PRIVATE_INPUT_RESERVED');
      if (current.entries.length === MAX_ENTRIES) throw fail('RAILGUN_RESERVATIONS_CAPACITY');
      const entry = Object.freeze({ id: randomBytes(32).toString('hex'), facts: value });
      await storage.update(RECORD, (text) => {
        active();
        const old = decode(text);
        check(JSON.stringify(old) === JSON.stringify(current));
        current = { ...old, sequence: old.sequence + 1, entries: [...old.entries, entry] };
        return JSON.stringify(current);
      });
      active();
      await advanceFloor(current.sequence);
      active();
      await attest();
      const receipt = Object.freeze({});
      receipts.set(receipt, entry);
      return receipt;
    } catch (error) {
      if (!['RAILGUN_PRIVATE_INPUT_RESERVED', 'RAILGUN_RESERVATIONS_CAPACITY'].includes(error.code))
        close();
      throw error;
    } finally {
      busy = false;
    }
  }
  async function assertReceipt(receipt) {
    active();
    check(!busy);
    const entry = receipts.get(receipt);
    check(entry);
    busy = true;
    try {
      const value = await attest();
      check(value.entries.some((e) => JSON.stringify(e) === JSON.stringify(entry)));
      return entry;
    } catch (error) {
      close();
      throw error;
    } finally {
      busy = false;
    }
  }
  async function inspect() {
    active();
    check(!busy);
    busy = true;
    try {
      const value = await attest();
      return Object.freeze({ held: value.entries.length });
    } catch (error) {
      close();
      throw error;
    } finally {
      busy = false;
    }
  }
  const instance = Object.freeze({ reserve, assertReceipt, inspect, close, signal: scope.signal });
  instances.add(instance);
  return instance;
}
module.exports = {
  createRailgunPrivateReservations,
  isRailgunPrivateReservations: (v) => instances.has(v),
};
