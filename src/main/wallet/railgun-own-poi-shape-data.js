/** Pure capsule/payload shape agreement, never ownership or POI authority.
 * A nonzero marker category does not establish the own TXID. Genuine hosts
 * must separately join the exact derived TXID, roots, index and source facts.
 */
const assert = require('assert/strict');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');

function getRailgunOwnPoiShape(capsule) {
  const normalized = normalizeRailgunPrivateCapsule(capsule);
  const kind = normalized.selection.kind;
  const partial = kind === 'railgun-partial-unshield';
  assert.ok(
    ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
      kind
    )
  );
  assert.equal(normalized.version, partial ? 2 : 1);
  const hasPrivateOutput = kind !== 'railgun-token-unshield';
  return Object.freeze({
    kind,
    capsuleVersion: normalized.version,
    outputCount: Number(hasPrivateOutput),
    hasPrivateOutput,
    hasUnshield: kind !== 'railgun-private-transfer',
    selectorDomain: `freedom:railgun:own-selector-v${partial ? 2 : 1}\0`,
  });
}

function assertRailgunOwnPoiPayloadShape(payload, capsule) {
  const shape = getRailgunOwnPoiShape(capsule);
  const normalized = normalizeRailgunPoiPayload(payload);
  assert.equal(normalized.blindedCommitmentsOut.length, shape.outputCount);
  assert.equal(normalized.railgunTxidIfHasUnshield !== '0x00', shape.hasUnshield);
}

module.exports = { getRailgunOwnPoiShape, assertRailgunOwnPoiPayloadShape };
