/** Exact internal viewing-job messages. These checks grant no wallet authority. */
const assert = require('assert/strict');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayUnsignedContext } = require('./railgun-relay-intent');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { isProxy } = require('util').types;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

function assertRailgunRelaySignal(signal) {
  assert.ok(!isProxy(signal));
  assert.equal(Object.getPrototypeOf(signal), AbortSignal.prototype);
  // AbortSignal.any reads these properties, even after an intrinsic brand check.
  for (const key of ['aborted', 'reason'])
    assert.equal(Object.getOwnPropertyDescriptor(signal, key), undefined);
  assert.equal(aborted.call(signal), false);
}

function normalizeRailgunRelayRequest(value, walletId) {
  shape(value, ['selection', 'context']);
  shape(value.selection, ['tree', 'position']);
  for (const key of ['tree', 'position'])
    assert.ok(
      Number.isSafeInteger(value.selection[key]) &&
        value.selection[key] >= 0 &&
        value.selection[key] <= 65535
    );
  const context = normalizeRailgunRelayUnsignedContext(value.context);
  assert.equal(context.walletId, walletId);
  return freeze({ selection: { ...value.selection }, context });
}

function parseRailgunRelayDraft(text, walletId) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const draft = normalizeRailgunRelayDraftCapsule(JSON.parse(text));
  assert.equal(JSON.stringify(draft.data), text);
  assert.equal(draft.data.walletId, walletId);
  return draft;
}

function normalizeRailgunRelayReconstruction(value, draft) {
  shape(value, ['draftDigest', 'expectedHash', 'recoveredOutputs']);
  assert.equal(value.draftDigest, draft.digest);
  assert.equal(value.expectedHash, draft.data.intent.expectedHash);
  assert.equal(value.recoveredOutputs, 2);
  return Object.freeze({ ...value });
}

function bindRailgunRelayDraft(value, request, { walletId, read, ownedPoi, trees }) {
  const draft = normalizeRailgunRelayDraftCapsule(value),
    data = draft.data;
  assert.equal(data.walletId, walletId);
  assert.equal(data.engineSha256, require('./railgun-engine-manifest.json').sha256);
  assert.deepEqual(data.selection, request.selection);
  assert.deepEqual(data.intent.context, request.context);
  assert.equal(data.intent.context.self.address, read.instanceId);
  const id = `${data.selection.tree}:${data.selection.position}`;
  const notes = read.received.filter((note) => note.id === id);
  const records = ownedPoi.filter((record) => record.id === id);
  const matchingTrees = trees.filter((tree) => tree.tree === data.selection.tree);
  assert.equal(notes.length, 1);
  assert.equal(records.length, 1);
  assert.equal(matchingTrees.length, 1);
  const note = notes[0],
    record = records[0];
  assert.equal(note.spentTxid, false);
  assert.equal(note.hash, data.noteHash);
  assert.equal(record.hash, data.noteHash);
  assert.equal(record.txid, note.txid);
  assert.equal(note.asset.__type, 'erc20');
  assert.equal(note.asset.contract, require('./railgun-shield-pins.json').wrappedNative);
  assert.equal(note.amount.toString(), data.intent.context.inputAmount);
  assert.equal(data.intent.expected.nullifier, record.nullifier);
  assert.equal(data.intent.expected.merkleRoot, matchingTrees[0].root);
  return draft;
}

function normalizeRailgunRelayPrePoiInput(value, walletId) {
  shape(value, ['draftText', 'history']);
  const draft = parseRailgunRelayDraft(value.draftText, walletId);
  const history = require('./railgun-relay-poi-history').normalizeRailgunRelayPoiHistory(
    value.history
  );
  assert.equal(history.data.draftDigest, draft.digest);
  return freeze({ draftText: value.draftText, history: history.data });
}
function normalizeRailgunRelayPrePoiResult(value, input, walletId) {
  shape(value, ['binding', 'historyDigest', 'draftDigest', 'expectedHash']);
  const checked = normalizeRailgunRelayPrePoiInput(input, walletId);
  const draft = parseRailgunRelayDraft(checked.draftText, walletId);
  const history = require('./railgun-relay-poi-history').normalizeRailgunRelayPoiHistory(
    checked.history
  );
  const binding = require('./railgun-relay-pre-poi-data').normalizeRailgunRelayPrePoiBinding(
    value.binding
  );
  assert.equal(value.draftDigest, draft.digest);
  assert.equal(value.expectedHash, draft.data.intent.expectedHash);
  assert.equal(value.historyDigest, history.digest);
  assert.equal(binding.draftDigest, draft.digest);
  assert.deepEqual(binding.listWitness, history.data.proof);
  return freeze({
    binding,
    historyDigest: history.digest,
    draftDigest: draft.digest,
    expectedHash: draft.data.intent.expectedHash,
  });
}

module.exports = {
  assertRailgunRelaySignal,
  normalizeRailgunRelayPrePoiInput,
  normalizeRailgunRelayPrePoiResult,
  normalizeRailgunRelayRequest,
  parseRailgunRelayDraft,
  normalizeRailgunRelayReconstruction,
  bindRailgunRelayDraft,
};
