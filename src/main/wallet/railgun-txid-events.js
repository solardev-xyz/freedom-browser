/** Bounded comparison of one complete Ethereum transaction's public events and
 * mirrored TXID rows. The caller owns source/row authentication and ordering.
 * Agreement is not chain verification, POI, or a spending capability.
 */
const assert = require('assert/strict');
const omitted = Object.freeze({
  blockNumber: 11816741,
  txid: '4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932',
  events: Object.freeze([
    Object.freeze({
      name: 'Nullified',
      logIndex: 98,
      tree: 0,
      values: Object.freeze([
        '0x0e751f51883b1120214ad87f5307782e32f7098f0bd71f2f8bfdd478065b0089',
        '0x23cc65c270e180c631780cf5c0960951d37300dc9fbd091cce76c69050de5a29',
        '0x104ba067d0c1d88680ddc2ff0ce40d4f67b481fcaf3dbe474bc58a1b673a55dc',
      ]),
    }),
    Object.freeze({
      name: 'Transact',
      logIndex: 99,
      tree: 0,
      start: 10136,
      hashes: Object.freeze([
        '0x227fe66ceaebc0dce64d8fcba0b91c653c3c20d587e63bc497b2a69f86e9f6b0',
        '0x2f794e2b477d57cb037da7862dbe519e2a5d2c9d93e285ad8ddf0c14cad48b07',
      ]),
    }),
  ]),
});
const fail = (reason) =>
  Object.assign(new Error('Railgun TXID event coverage unavailable'), {
    code: 'RAILGUN_TXID_EVENTS_REFUSED',
    reason,
  });
const check = (value, reason) => {
  if (!value) throw fail(reason);
};
const equal = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};
const hex = (v, size = 64) =>
  typeof v === 'string' && new RegExp('^0x[0-9a-f]{' + size + '}$').test(v);
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
function matchRailgunTxidEvents({ blockNumber, txid, events, rows }) {
  check(
    integer(blockNumber) && typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid),
    'transaction'
  );
  check(
    Array.isArray(events) && events.length <= 2048 && Array.isArray(rows) && rows.length <= 1024,
    'capacity'
  );
  check(Buffer.byteLength(JSON.stringify({ events, rows })) <= 2 * 1024 * 1024, 'capacity');
  let previousLog = -1;
  for (const event of events) {
    check(event && integer(event.logIndex) && event.logIndex > previousLog, 'event-order');
    previousLog = event.logIndex;
    check(['Nullified', 'Transact', 'Unshield'].includes(event.name), 'event-type');
    if (event.name === 'Nullified')
      check(
        integer(event.tree, 65535) &&
          Array.isArray(event.values) &&
          event.values.length > 0 &&
          event.values.length <= 13 &&
          event.values.every((v) => hex(v)),
        'nullifiers'
      );
    if (event.name === 'Transact')
      check(
        integer(event.tree, 65535) &&
          integer(event.start, 65535) &&
          Array.isArray(event.hashes) &&
          event.hashes.length > 0 &&
          event.start + event.hashes.length <= 65536 &&
          event.hashes.every((v) => hex(v)),
        'commitments'
      );
    if (event.name === 'Unshield')
      check(
        hex(event.to, 40) &&
          hex(event.token, 40) &&
          integer(event.type, 2) &&
          typeof event.subID === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(event.subID) &&
          typeof event.value === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(event.value),
        'unshield'
      );
  }
  let previousGraph = '0x00';
  for (const row of rows) {
    check(
      row.txid === txid &&
        row.blockNumber === blockNumber &&
        typeof row.graphID === 'string' &&
        /^0x[0-9a-f]{192}$/.test(row.graphID) &&
        row.graphID > previousGraph,
      'row-order'
    );
    previousGraph = row.graphID;
    check(
      Array.isArray(row.nullifiers) &&
        row.nullifiers.length > 0 &&
        Array.isArray(row.commitments) &&
        row.commitments.length > 0,
      'row'
    );
  }
  const groups = [];
  let group = [];
  for (const event of events) {
    group.push(event);
    if (event.name === 'Transact') {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);
  let consumed = 0,
    omissionCount = 0;
  for (const call of groups) {
    if (
      blockNumber === omitted.blockNumber &&
      txid === omitted.txid &&
      equal(call, omitted.events)
    ) {
      check(omissionCount++ === 0, 'omission');
      continue;
    }
    const batch = call.at(-1).name === 'Transact' ? call.at(-1) : null;
    const nullifiers = call.filter((e) => e.name === 'Nullified');
    const unshields = call.filter((e) => e.name === 'Unshield');
    check(nullifiers.length > 0, 'missing-nullifiers');
    // Without calldata, a no-output call immediately followed by another call
    // can be ambiguous. Refuse interleaved nullifier/unshield phases rather
    // than guessing which batch owns an unshield-only row's ordinary position.
    check(
      call.slice(0, nullifiers.length).every((e) => e.name === 'Nullified'),
      'ambiguous-call'
    );
    let position = batch?.start ?? 99999,
      unshieldIndex = 0;
    const hashes = [];
    for (const event of nullifiers) {
      const row = rows[consumed++];
      check(
        row && row.utxoTreeIn === event.tree && equal(row.nullifiers, event.values),
        'nullifiers'
      );
      const standard = row.commitments.slice(0, row.commitments.length - (row.unshield ? 1 : 0));
      check(
        row.utxoTreeOut === (batch?.tree ?? 99999) && row.utxoBatchStartPositionOut === position,
        'output-position'
      );
      check(batch || standard.length === 0, 'missing-batch');
      hashes.push(...standard);
      position += standard.length;
      if (row.unshield) {
        const actual = unshields[unshieldIndex++],
          value = row.unshield;
        check(
          actual &&
            actual.to === value.toAddress.toLowerCase() &&
            actual.token === value.tokenData.tokenAddress.toLowerCase() &&
            actual.type === value.tokenData.tokenType &&
            actual.subID === BigInt(value.tokenData.tokenSubID).toString() &&
            actual.value === value.value,
          'unshield'
        );
      }
    }
    check(unshieldIndex === unshields.length, 'extra-unshield');
    check(equal(hashes, batch?.hashes ?? []), 'commitments');
  }
  check(consumed === rows.length, 'extra-row');
  if (txid === omitted.txid)
    check(blockNumber === omitted.blockNumber && omissionCount === 1, 'omission');
  return Object.freeze({
    matchedRows: consumed,
    knownOmissions: omissionCount,
    boundParamsChecked: false,
    unshieldCommitmentHashesChecked: false,
    globalTxidCompleteness: false,
  });
}
module.exports = { matchRailgunTxidEvents };
