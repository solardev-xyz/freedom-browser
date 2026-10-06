/** Internal unpersisted draft, with no durable-version compatibility promise.
 * Existing capsule/store/permit APIs must continue to refuse this data. */
const { types } = require('util');
const { createHash } = require('crypto');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun relay draft capsule refused'), {
    code: 'RAILGUN_RELAY_DRAFT_CAPSULE_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const field = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) < FIELD;
function normalizeRailgunRelayDraftCapsule(value) {
  try {
    shape(value, [
      'schema',
      'walletId',
      'engineSha256',
      'selection',
      'noteHash',
      'pathElements',
      'intent',
    ]);
    check(value.schema === 'railgun-relay-unsigned-draft-v1');
    shape(value.selection, ['tree', 'position']);
    for (const key of ['tree', 'position'])
      check(
        Number.isSafeInteger(value.selection[key]) &&
          value.selection[key] >= 0 &&
          value.selection[key] <= 65535
      );
    for (const key of ['walletId', 'engineSha256'])
      check(typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key]));
    check(field(value.noteHash));
    const elements = value.pathElements;
    check(
      !types.isProxy(elements) &&
        Array.isArray(elements) &&
        Object.getPrototypeOf(elements) === Array.prototype
    );
    const keys = Reflect.ownKeys(elements);
    check(keys.length === 17 && keys.includes('length'));
    check(Object.getOwnPropertyDescriptor(elements, 'length').value === 16);
    const pathElements = [];
    for (let i = 0; i < 16; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(elements, String(i));
      check(
        descriptor &&
          descriptor.enumerable &&
          Object.hasOwn(descriptor, 'value') &&
          field(descriptor.value)
      );
      pathElements.push(descriptor.value);
    }
    const intent = normalizeRailgunRelayUnsignedIntent(value.intent);
    check(
      value.walletId === intent.data.context.walletId &&
        value.selection.tree === intent.data.expected.tree
    );
    const data = freeze({
      schema: value.schema,
      walletId: value.walletId,
      engineSha256: value.engineSha256,
      selection: { tree: value.selection.tree, position: value.selection.position },
      noteHash: value.noteHash,
      pathElements,
      intent: intent.data,
    });
    const digest = createHash('sha256')
      .update('freedom:railgun:relay-unsigned-capsule-draft-v1\0')
      .update(JSON.stringify(data))
      .digest('hex');
    return freeze({
      ...intent,
      data,
      digest,
      capsulePersisted: false,
      merklePathVerified: false,
      engineAuthenticated: false,
    });
  } catch {
    throw fail();
  }
}
function digestRailgunRelayDraftCapsule(value) {
  return normalizeRailgunRelayDraftCapsule(value).digest;
}
module.exports = { normalizeRailgunRelayDraftCapsule, digestRailgunRelayDraftCapsule };
