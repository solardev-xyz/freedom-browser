/** Internal local-custody data writer opened by fixed fenced enrollment.
 * The connected controller must still join review, original-work and
 * proof gates. These methods issue no signing/discard/export permits and do not
 * establish cryptographic validity. Scope revocation never closes enrollment's
 * borrowed process-lifetime fence. No storage/floor pair is claimed atomic.
 */
const fs = require('fs');
const path = require('path');
const { isProxy } = require('util').types;
const { randomBytes } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const {
  decodeRailgunRelayLocalRecord,
  decodeRailgunRelayLocalDocument,
  digestRailgunRelayLocalIntent,
  RAILGUN_RELAY_LOCAL_LIMITS: limits,
} = require('./railgun-relay-recovery-data');
const RECORD = 'railgun-relay-local-recovery-v4';
const owners = new Set();
const instances = new WeakMap();
const unavailable = new WeakMap();
const refused = (code = 'RAILGUN_RELAY_RECOVERY_STORE_REFUSED') =>
  Object.assign(new Error('Railgun local relay recovery store refused'), {
    code,
  });
const check = (value) => {
  if (!value) throw refused();
};
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
// Copy bounded plain data without invoking getters, proxy traps or toJSON.
function capture(input, maximum) {
  try {
    function walk(value, depth) {
      check(depth <= 16);
      if (typeof value === 'string') {
        check(Buffer.byteLength(value) <= maximum);
        return value;
      }
      if (typeof value === 'number') {
        check(Number.isSafeInteger(value));
        return value;
      }
      if (value === null || typeof value === 'boolean') return value;
      check(value && typeof value === 'object' && !isProxy(value));
      if (Array.isArray(value)) {
        check(Object.getPrototypeOf(value) === Array.prototype && value.length <= 64);
        const keys = Array.from({ length: value.length }, (_, i) => String(i));
        check(Reflect.ownKeys(value).length === keys.length + 1);
        return keys.map((name) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          check(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
          return walk(descriptor.value, depth + 1);
        });
      }
      const keys = Reflect.ownKeys(value);
      check(keys.length <= 64 && keys.every((key) => typeof key === 'string'));
      shape(value, keys);
      return Object.fromEntries(keys.map((key) => [key, walk(value[key], depth + 1)]));
    }
    const result = walk(input, 0);
    check(Buffer.byteLength(JSON.stringify(result)) <= maximum);
    return freeze(result);
  } catch {
    throw refused();
  }
}
async function createRailgunRelayRecoveryStore(options) {
  let scope, filename;
  let claimed = false,
    opening = true,
    closed = false,
    busy = false;
  const release = () => {
    if (closed && !opening && !busy && claimed) {
      owners.delete(filename);
      claimed = false;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    scope?.close();
    release();
  };
  try {
    check(options && !isProxy(options));
    shape(options, [
      'enrollment',
      'handle',
      'directory',
      'key',
      'binding',
      'walletId',
      'readFloor',
      'advanceFloor',
      ...(Object.hasOwn(options, 'profileGuard') ? ['profileGuard'] : []),
      ...(Object.hasOwn(options, 'create') ? ['create'] : []),
    ]);
    const {
      enrollment,
      handle,
      directory,
      key,
      binding,
      walletId,
      readFloor,
      advanceFloor,
      profileGuard,
      create = false,
    } = options;
    // Deferred to avoid an enrollment -> store -> enrollment CommonJS cycle.
    const { assertRailgunFencedAccountEnrollment } = require('./railgun-account-enrollment');
    assertRailgunFencedAccountEnrollment(enrollment);
    check(digest(binding) && digest(walletId) && typeof create === 'boolean');
    check(enrollment.binding === binding && enrollment.descriptor.walletId === walletId);
    check(directory === enrollment.directory && path.isAbsolute(directory));
    check(fs.realpathSync(directory) === directory);
    check(profileGuard === enrollment.profileGuard);
    check(typeof readFloor === 'function' && typeof advanceFloor === 'function');
    const operation = RECORD + ':' + walletId;
    check(handle === enrollment.getContext('storage', operation));
    const context = getPrivacyContext(handle),
      subject = context.subject;
    check(
      subject.kind === 'private-account' &&
        subject.protocol === 'railgun' &&
        subject.chainId === 11155111 &&
        subject.deployment === 'sepolia' &&
        subject.role === 'storage' &&
        subject.operation === operation
    );
    const active = () => {
      try {
        check(!closed);
        assertRailgunFencedAccountEnrollment(enrollment);
        check(getPrivacyContext(handle) === context);
        check(!closed);
      } catch {
        close();
        throw refused();
      }
    };
    active();
    filename = getPrivacyStoragePath(handle, directory);
    check(!owners.has(filename));
    owners.add(filename);
    claimed = true;
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([context.signal, enrollment.signal]),
      isCurrent: () => {
        active();
        return true;
      },
    });
    scope.signal.addEventListener('abort', close, { once: true });
    const storage = createPrivacyStorage({
      handle: scope.getContext(subject),
      directory,
      key,
      profileGuard,
    });
    const lease = randomBytes(32).toString('hex');
    const decode = (text) => decodeRailgunRelayLocalDocument(text, { binding, walletId });
    const encode = (value) => {
      const text = JSON.stringify(value);
      decode(text);
      return text;
    };
    let current;
    const floorValue = (sequence) => Object.freeze({ version: 4, binding, walletId, sequence });
    async function floor() {
      active();
      const value = await readFloor();
      active();
      if (value === null) return null;
      shape(value, ['version', 'binding', 'walletId', 'sequence']);
      check(value.version === 4 && value.binding === binding && value.walletId === walletId);
      check(
        Number.isSafeInteger(value.sequence) &&
          value.sequence >= 0 &&
          value.sequence <= limits.sequence
      );
      return floorValue(value.sequence);
    }
    async function advance(sequence) {
      active();
      await advanceFloor(floorValue(sequence));
      active();
    }
    async function attest() {
      active();
      const text = await storage.get(RECORD);
      active();
      const value = decode(text);
      check(value.lease === lease && text === current);
      const minimum = await floor();
      active();
      check(minimum !== null && minimum.sequence === value.sequence);
      return value;
    }
    const minimum = await floor();
    active();
    await storage.update(RECORD, (text) => {
      active();
      check(create ? text === null && minimum === null : text !== null && minimum !== null);
      const old =
        text === null
          ? { version: 4, binding, walletId, lease, sequence: 0, entries: [] }
          : decode(text);
      check(minimum === null || minimum.sequence <= old.sequence);
      current = encode({ ...old, lease });
      return current;
    });
    active();
    // A cold opener may repair a lower authenticated floor, but never a missing
    // floor, missing document or newer floor. Failed writers do not repair.
    await advance(decode(current).sequence);
    active();
    await attest();
    active();
    opening = false;
    const prewriteRefusal = (code) => {
      const error = Object.freeze(refused(code));
      unavailable.set(error, instance);
      return error;
    };
    async function exclusive(use) {
      active();
      if (busy) throw prewriteRefusal('RAILGUN_RELAY_RECOVERY_STORE_BUSY');
      busy = true;
      try {
        const value = await attest();
        active();
        const result = await use(value);
        active();
        return result;
      } catch (error) {
        if (unavailable.get(error) === instance) throw error;
        close();
        throw refused();
      } finally {
        busy = false;
        release();
      }
    }
    async function persist(value, entries, assertMutation = active) {
      const next = { ...value, sequence: value.sequence + 1, entries };
      const text = encode(next),
        previous = current;
      active();
      assertMutation();
      await storage.update(RECORD, (stored) => {
        active();
        assertMutation();
        check(stored === previous && decode(stored).lease === lease);
        return text;
      });
      active();
      assertMutation();
      current = text;
      await advance(next.sequence);
      active();
      assertMutation();
      await attest();
      active();
      assertMutation();
    }
    const select = (value, id) => {
      check(digest(id));
      const row = value.entries.find((entry) => entry.id === id);
      check(row);
      return row;
    };
    async function change(id, transform, assertMutation = active) {
      return exclusive(async (value) => {
        const old = select(value, id),
          next = decodeRailgunRelayLocalRecord(JSON.stringify(transform(old)));
        check(
          digestRailgunRelayLocalIntent(JSON.stringify(old)) ===
            digestRailgunRelayLocalIntent(JSON.stringify(next))
        );
        if (old.signature !== null)
          check(JSON.stringify(old.signature) === JSON.stringify(next.signature));
        if (old.proved !== null) check(JSON.stringify(old.proved) === JSON.stringify(next.proved));
        await persist(
          value,
          value.entries.map((entry) => (entry === old ? next : entry)),
          assertMutation
        );
        active();
        return next;
      });
    }
    const availableHeld = (value, text) => {
      const row = decodeRailgunRelayLocalRecord(text);
      check(row.state === 'held' && row.binding === binding && row.walletId === walletId);
      if (value.entries.length >= limits.records)
        throw prewriteRefusal('RAILGUN_RELAY_RECOVERY_CAPACITY');
      check(!value.entries.some((entry) => entry.id === row.id));
      // Decode the complete proposed document, including every retained row's
      // maximum future transitions and encoded completion capacity, before write.
      encode({ ...value, sequence: value.sequence + 1, entries: [...value.entries, row] });
      return row;
    };
    const instance = Object.freeze({
      signal: scope.signal,
      close,
      read: (id) => exclusive(async (value) => select(value, id)),
      lookup: (id) =>
        exclusive(async (value) => {
          check(digest(id));
          return value.entries.find((entry) => entry.id === id) ?? null;
        }),
      assertHeldAvailable: (text) =>
        exclusive(async (value) => {
          availableHeld(value, text);
        }),
      inspect: () =>
        exclusive(async (value) =>
          freeze({
            records: value.entries.length,
            sequence: value.sequence,
            capacity: limits.records,
            states: value.entries.map(({ id, state }) => ({ id, state })),
          })
        ),
      async appendHeld(token, text) {
        const assertMutation =
          require('./railgun-private-reservations').consumeRailgunRelayReservationMutation(
            token,
            instance,
            'appendHeld',
            text
          );
        assertMutation();
        active();
        const row = decodeRailgunRelayLocalRecord(text);
        check(row.state === 'held' && row.binding === binding && row.walletId === walletId);
        return exclusive(async (value) => {
          availableHeld(value, text);
          await persist(value, [...value.entries, row], assertMutation);
          active();
          return row;
        });
      },
      markSigning: (token, id) => {
        const assertMutation =
          require('./railgun-private-reservations').consumeRailgunRelayReservationMutation(
            token,
            instance,
            'markSigning',
            id
          );
        return change(
          id,
          (old) => {
            check(old.state === 'held');
            return { ...old, state: 'signing-local' };
          },
          assertMutation
        );
      },
      async saveSignature(id, input) {
        active();
        let signature;
        try {
          signature = normalizeRailgunSignature(capture(input, limits.signature));
        } catch {
          throw refused();
        }
        return change(id, (old) => {
          check(old.state === 'signing-local' && old.signature === null);
          return { ...old, state: 'signed', signature };
        });
      },
      async saveProof(id, input) {
        active();
        let proved;
        try {
          const inputCopy = capture(input, limits.transaction + limits.payload + 64);
          shape(inputCopy, ['transaction', 'payload']);
          shape(inputCopy.transaction, ['chainId', 'to', 'value', 'data']);
          const { normalizeRailgunRelayPrePoiPayload } = require('./railgun-relay-pre-poi-data');
          proved = freeze({
            transaction: Object.fromEntries(
              ['chainId', 'to', 'value', 'data'].map((name) => [name, inputCopy.transaction[name]])
            ),
            payload: normalizeRailgunRelayPrePoiPayload(inputCopy.payload),
          });
        } catch {
          throw refused();
        }
        return change(id, (old) => {
          check(old.state === 'signed' && old.signature !== null && old.proved === null);
          return { ...old, state: 'ready-local', proved };
        });
      },
      discardLocal: (token, id) => {
        const assertMutation =
          require('./railgun-private-reservations').consumeRailgunRelayReservationMutation(
            token,
            instance,
            'discardLocal',
            id
          );
        return change(
          id,
          (old) => {
            check(['held', 'signing-local', 'signed', 'ready-local'].includes(old.state));
            return {
              ...old,
              state: old.state === 'held' ? 'cancelled-unsigned' : 'discarded-signed',
            };
          },
          assertMutation
        );
      },
    });
    active();
    instances.set(instance, { enrollment, active });
    return instance;
  } catch {
    close();
    throw refused();
  } finally {
    opening = false;
    release();
  }
}
module.exports = {
  createRailgunRelayRecoveryStore,
  isRailgunRelayRecoveryUnavailable: (error, store) => unavailable.get(error) === store,
  assertRailgunRelayRecoveryStoreOwner: (store, enrollment) => {
    const entry = instances.get(store);
    check(entry && entry.enrollment === enrollment);
    entry.active();
  },
};
