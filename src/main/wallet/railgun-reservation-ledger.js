/** Inactive shared-ledger format prototype. Produces detached serialized
 * proposals only: no storage, receipts, signing permits or custody authority.
 * The future owner must authenticate storage/floors and complete tombstone-first
 * retirement before committing any proposal. V4 has no export/send transition.
 */
const { types } = require('util');
const MAX_ENTRIES = 512,
  MAX_SEQUENCE = 1024,
  MAX_BYTES = 512 * 1024,
  FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const PRIVATE_KINDS = [
  'railgun-private-transfer',
  'railgun-token-unshield',
  'railgun-partial-unshield',
];
const RELAY_KIND = 'railgun-relay-self-transfer';
const PRIVATE_FACTS = [
  'tree',
  'position',
  'nullifier',
  'noteHash',
  'kind',
  'intentDigest',
  'checkpointHash',
  'poiDigest',
];
const RELAY_FACTS = [
  'tree',
  'position',
  'nullifier',
  'noteHash',
  'kind',
  'checkpointHash',
  'draftDigest',
  'expectedHash',
];
const DOCUMENT = ['version', 'binding', 'walletId', 'lease', 'sequence', 'entries'];
function refuse(code = 'RAILGUN_RESERVATIONS_REFUSED') {
  throw Object.assign(new Error('Railgun reservation proposal refused'), { code });
}
const check = (value, code) => {
  if (!value) refuse(code);
};
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const field = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < FIELD;
function exact(value, keys) {
  check(value && typeof value === 'object' && !types.isProxy(value));
  check(Object.getPrototypeOf(value) === Object.prototype);
  const names = Reflect.ownKeys(value);
  check(names.length === keys.length && keys.every((key) => names.includes(key)));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}
function normalizeFacts(value, relay) {
  const keys = relay ? RELAY_FACTS : PRIVATE_FACTS;
  exact(value, keys);
  check(integer(value.tree, 65535) && integer(value.position, 65535));
  check(field(value.nullifier) && field(value.noteHash) && digest(value.checkpointHash));
  if (relay)
    check(value.kind === RELAY_KIND && digest(value.draftDigest) && field(value.expectedHash));
  else
    check(
      PRIVATE_KINDS.includes(value.kind) &&
        typeof value.intentDigest === 'string' &&
        /^0x[0-9a-f]{64}$/.test(value.intentDigest) &&
        digest(value.poiDigest)
    );
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}
function normalizeSigning(value, relay) {
  const keys = relay
    ? ['gatesDigest', 'recordDigest']
    : ['submitter', 'operationId', 'gatesDigest'];
  exact(value, keys);
  check(digest(value.gatesDigest));
  if (relay) check(digest(value.recordDigest));
  else
    check(
      typeof value.submitter === 'string' &&
        /^0x[0-9a-f]{40}$/.test(value.submitter) &&
        BigInt(value.submitter) > 0n &&
        digest(value.operationId)
    );
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}
const terminal = (entry) =>
  ['abandoned', 'cancelled-unsigned', 'discarded-signed'].includes(entry.state);
function costs(entry) {
  if (entry.origin === 'private') {
    if (entry.state === 'held') return [1, 1];
    return entry.state === 'legacy' ? [1, 0] : [2, 0];
  }
  if (entry.origin === 'relay-v3-never-signed') return entry.state === 'held' ? [1, 1] : [2, 0];
  if (entry.state === 'held') return [1, 2];
  if (entry.state === 'signing-local') return [2, 1];
  return entry.state === 'cancelled-unsigned' ? [2, 0] : [3, 0];
}
function normalizeEntry(value, version) {
  exact(
    value,
    version === 1
      ? ['id', 'facts']
      : version === 4
        ? ['id', 'origin', 'facts', 'state', 'signing']
        : ['id', 'facts', 'state', 'signing']
  );
  check(digest(value.id));
  // JSON text is the only document input. Actions reach facts through their own
  // descriptor-only validator, so no caller getter participates in this branch.
  const relay = value.facts?.kind === RELAY_KIND;
  const facts = normalizeFacts(value.facts, relay);
  const state = version === 1 ? 'legacy' : value.state;
  let origin = relay ? 'relay-v3-never-signed' : 'private',
    signing = null;
  if (version === 4) {
    origin = value.origin;
    check(
      relay ? ['relay-v3-never-signed', 'relay-local-v4'].includes(origin) : origin === 'private'
    );
  }
  if (!relay) {
    check(['legacy', 'held', 'signing', 'abandoned'].includes(state));
    if (state === 'signing') signing = normalizeSigning(value.signing, false);
    else if (version !== 1) check(value.signing === null);
  } else if (version === 3) {
    check(['held', 'abandoned'].includes(state) && value.signing === null);
  } else {
    check(version === 4);
    if (origin === 'relay-v3-never-signed')
      check(['held', 'cancelled-unsigned'].includes(state) && value.signing === null);
    else {
      check(['held', 'signing-local', 'cancelled-unsigned', 'discarded-signed'].includes(state));
      if (['signing-local', 'discarded-signed'].includes(state))
        signing = normalizeSigning(value.signing, true);
      else check(value.signing === null);
    }
  }
  return Object.freeze({
    id: value.id,
    ...(version === 4 ? { origin } : {}),
    facts,
    state,
    signing,
  });
}
function createRailgunReservationLedgerCodec(options) {
  exact(options, ['enrollment', 'binding', 'walletId']);
  // Enrollment already imports the reservation store. Resolve its fixed issuer
  // at factory admission so a future store import does not capture a partial
  // CommonJS export during that module cycle.
  const { assertRailgunFencedAccountEnrollment } = require('./railgun-account-enrollment');
  const { enrollment, binding, walletId } = options;
  check(digest(binding) && digest(walletId));
  const active = () => {
    assertRailgunFencedAccountEnrollment(enrollment);
    check(enrollment.binding === binding && enrollment.descriptor.walletId === walletId);
  };
  active();
  function decode(text) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      refuse();
    }
    exact(value, DOCUMENT);
    check(
      [1, 2, 3, 4].includes(value.version) &&
        value.binding === binding &&
        value.walletId === walletId &&
        digest(value.lease) &&
        integer(value.sequence, MAX_SEQUENCE) &&
        Array.isArray(value.entries) &&
        value.entries.length <= MAX_ENTRIES
    );
    const ids = new Set(),
      inputs = new Set();
    let spent = 0,
      remaining = 0;
    const entries = value.entries.map((input) => {
      const entry = normalizeEntry(input, value.version);
      check(!ids.has(entry.id));
      ids.add(entry.id);
      if (!terminal(entry)) {
        const key = entry.facts.tree + ':' + entry.facts.nullifier;
        check(!inputs.has(key));
        inputs.add(key);
      }
      if (value.version === 4) {
        const [past, future] = costs(entry);
        spent += past;
        remaining += future;
      } else spent += ['signing', 'abandoned'].includes(entry.state) ? 2 : 1;
      return entry;
    });
    check(spent === value.sequence);
    if (value.version === 4) check(spent + remaining <= MAX_SEQUENCE);
    return Object.freeze({
      version: value.version === 1 ? 2 : value.version,
      binding,
      walletId,
      lease: value.lease,
      sequence: value.sequence,
      entries: Object.freeze(entries),
    });
  }
  function encode(value) {
    const text = JSON.stringify(value);
    decode(text);
    return text;
  }
  const methods = {
    decode,
    create(lease) {
      check(digest(lease));
      return encode({ version: 4, binding, walletId, lease, sequence: 0, entries: [] });
    },
    upgrade(text, lease) {
      check(digest(lease));
      const value = decode(text);
      const entries = value.entries.map((entry) => {
        if (value.version === 4) return entry;
        const relay = entry.facts.kind === RELAY_KIND;
        return {
          id: entry.id,
          origin: relay ? 'relay-v3-never-signed' : 'private',
          facts: entry.facts,
          state: relay && entry.state === 'abandoned' ? 'cancelled-unsigned' : entry.state,
          signing: entry.signing,
        };
      });
      return encode({ ...value, version: 4, lease, entries });
    },
    apply(text, action) {
      const value = decode(text);
      check(value.version === 4);
      // Read the discriminator only after rejecting proxies/accessors, including
      // unknown own properties; a selected action gets its exact schema below.
      check(action && typeof action === 'object' && !types.isProxy(action));
      check(Object.getPrototypeOf(action) === Object.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(action, 'type');
      check(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
      const type = descriptor.value;
      let entries;
      if (['reserve-private', 'reserve-relay'].includes(type)) {
        exact(action, ['type', 'id', 'facts']);
        check(digest(action.id));
        const relay = type === 'reserve-relay',
          facts = normalizeFacts(action.facts, relay);
        check(!value.entries.some((entry) => entry.id === action.id));
        check(
          !value.entries.some(
            (entry) =>
              !terminal(entry) &&
              entry.facts.tree === facts.tree &&
              entry.facts.nullifier === facts.nullifier
          ),
          'RAILGUN_PRIVATE_INPUT_RESERVED'
        );
        check(value.entries.length < MAX_ENTRIES, 'RAILGUN_RESERVATIONS_CAPACITY');
        check(
          value.sequence +
            1 +
            value.entries.reduce((sum, entry) => sum + costs(entry)[1], 0) +
            (relay ? 2 : 1) <=
            MAX_SEQUENCE,
          'RAILGUN_RESERVATIONS_CAPACITY'
        );
        entries = [
          ...value.entries,
          {
            id: action.id,
            origin: relay ? 'relay-local-v4' : 'private',
            facts,
            state: 'held',
            signing: null,
          },
        ];
      } else {
        const signing = ['mark-private-signing', 'mark-relay-signing'].includes(type);
        exact(action, signing ? ['type', 'id', 'signing'] : ['type', 'id']);
        check(digest(action.id));
        const entry = value.entries.find((candidate) => candidate.id === action.id);
        check(entry);
        let state,
          nextSigning = entry.signing;
        if (type === 'mark-private-signing' || type === 'abandon-private') {
          check(entry.origin === 'private' && entry.state === 'held');
          state = signing ? 'signing' : 'abandoned';
          if (signing) nextSigning = normalizeSigning(action.signing, false);
        } else if (type === 'mark-relay-signing') {
          check(entry.origin === 'relay-local-v4' && entry.state === 'held');
          state = 'signing-local';
          nextSigning = normalizeSigning(action.signing, true);
        } else if (type === 'cancel-relay-unsigned') {
          check(entry.origin !== 'private' && entry.state === 'held');
          state = 'cancelled-unsigned';
        } else if (type === 'discard-relay-local') {
          check(entry.origin === 'relay-local-v4' && entry.state === 'signing-local');
          state = 'discarded-signed';
        } else refuse();
        entries = value.entries.map((candidate) =>
          candidate.id === entry.id ? { ...entry, state, signing: nextSigning } : candidate
        );
      }
      return encode({ ...value, sequence: value.sequence + 1, entries });
    },
  };
  // All methods are synchronous. No proposal escapes after enrollment revocation,
  // including private-kind transitions in a v4 shared document.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(methods).map(([name, method]) => [
        name,
        (...args) => {
          active();
          const result = method(...args);
          active();
          return result;
        },
      ])
    )
  );
}
module.exports = { createRailgunReservationLedgerCodec };
