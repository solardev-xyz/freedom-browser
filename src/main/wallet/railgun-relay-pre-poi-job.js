/** Fixed fresh viewing-only pre-key binding. The complete assembler result is
 * utility-private and is never serialized. No signing/proving admission here. */
const assert = require('assert/strict');
const path = require('path');
const { shape } = require('./railgun-relay-quote-data');
const { parseRailgunRelayDraft, assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
let attempted = false;
exports.run = async (inputText, context) => {
  assert.equal(attempted, false);
  attempted = true;
  // The entire init frame, including escaped draft and history, is bounded.
  assert.ok(typeof inputText === 'string' && Buffer.byteLength(inputText) <= 65536);
  const input = JSON.parse(inputText);
  shape(input, [
    'archive',
    'descriptor',
    'checkpoint',
    'walletId',
    'restore',
    'prefixes',
    'draftText',
    'history',
  ]);
  assert.equal(input.restore, true);
  assert.ok(typeof input.archive === 'string' && path.isAbsolute(input.archive));
  assert.equal(path.extname(input.archive), '.asar');
  assert.match(input.walletId, /^[0-9a-f]{64}$/);
  assert.equal(input.descriptor.walletId, input.walletId);
  const draft = parseRailgunRelayDraft(input.draftText, input.walletId);
  const history = normalizeRailgunRelayPoiHistory(input.history);
  assert.equal(history.data.draftDigest, draft.digest);
  assertRailgunRelaySignal(context.signal);
  return require('./railgun-wallet-job').withWallet(
    inputText,
    context,
    'relay-pre-poi',
    async (restored) => {
      const active = () => assertRailgunRelaySignal(restored.signal);
      active();
      assert.equal(restored.exchangePrivateIntent, undefined);
      assert.equal(restored.readRelayProofRecord, undefined);
      const assembled =
        await require('./railgun-relay-pre-poi-witness').prepareRailgunRelayPrePoiWitness({
          archive: restored.archive,
          wallet: restored.wallet,
          descriptor: restored.descriptor,
          checkpoint: restored.checkpoint,
          scan: restored.scan,
          signal: restored.signal,
          draftText: input.draftText,
          history: history.data,
        });
      active();
      const binding = normalizeRailgunRelayPrePoiBinding(assembled.binding);
      assert.equal(binding.draftDigest, draft.digest);
      assert.deepEqual(binding.listWitness, history.data.proof);
      assert.equal(assembled.historyDigest, history.digest);
      return Object.freeze({
        relayPrePoiBinding: Object.freeze({
          binding,
          historyDigest: history.digest,
          draftDigest: draft.digest,
          expectedHash: draft.data.intent.expectedHash,
        }),
      });
    }
  );
};
