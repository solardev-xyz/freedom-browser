const { matchRailgunTxidEvents } = require('./railgun-txid-events');
const known = require('../../../scripts/fixtures/railgun-txid-known-omission.json');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const address = (n) => '0x' + n.toString(16).padStart(40, '0');
function row(n, standard = 1, unshield = false) {
  return {
    txid: 'a'.repeat(64),
    blockNumber: 10,
    graphID: '0x' + 'a'.padStart(64, '0') + '0'.repeat(64) + n.toString(16).padStart(64, '0'),
    nullifiers: [hash(n + 1)],
    commitments: [
      ...Array.from({ length: standard }, (_, i) => hash(100 + n * 10 + i)),
      ...(unshield ? [hash(900 + n)] : []),
    ],
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    utxoBatchStartPositionOut: 20,
    ...(unshield
      ? {
          unshield: {
            toAddress: address(1),
            tokenData: { tokenAddress: address(2), tokenType: 0, tokenSubID: hash(0) },
            value: '100',
          },
        }
      : {}),
  };
}
function fixture(rows) {
  let position = 20;
  const hashes = [];
  const events = rows.map((r, n) => ({
    name: 'Nullified',
    logIndex: n,
    tree: 0,
    values: r.nullifiers,
  }));
  for (const r of rows) {
    r.utxoBatchStartPositionOut = position;
    const standard = r.commitments.slice(0, r.commitments.length - (r.unshield ? 1 : 0));
    hashes.push(...standard);
    position += standard.length;
    if (r.unshield)
      events.push({
        name: 'Unshield',
        logIndex: events.length,
        to: address(1),
        token: address(2),
        type: 0,
        subID: '0',
        value: '100',
      });
  }
  if (hashes.length)
    events.push({ name: 'Transact', logIndex: events.length, tree: 0, start: 20, hashes });
  else for (const r of rows) r.utxoTreeOut = r.utxoBatchStartPositionOut = 99999;
  return { blockNumber: 10, txid: 'a'.repeat(64), events, rows };
}
test.each(['before', 'after', 'only'])('unshield-only %s has its exact call position', (where) => {
  const rows =
    where === 'before'
      ? [row(0, 0, true), row(1)]
      : where === 'after'
        ? [row(0), row(1, 0, true)]
        : [row(0, 0, true)];
  const input = fixture(rows);
  expect(matchRailgunTxidEvents(input)).toEqual({
    matchedRows: rows.length,
    knownOmissions: 0,
    boundParamsChecked: false,
    unshieldCommitmentHashesChecked: false,
    globalTxidCompleteness: false,
  });
  const empty = rows.find((v) => v.unshield);
  empty.utxoBatchStartPositionOut += where === 'after' ? -1 : 1;
  expect(() => matchRailgunTxidEvents(input)).toThrow();
});
test.each([
  'nullifier',
  'commitment',
  'extra-row',
  'extra-unshield',
  'unshield-value',
  'unshield-token',
  'tree',
  'order',
])('mismatched %s refuses the whole transaction', (mode) => {
  const input = fixture([row(0, 2, true), row(1)]);
  if (mode === 'nullifier') input.rows[0].nullifiers = [hash(999)];
  if (mode === 'commitment') input.rows[0].commitments[0] = hash(999);
  if (mode === 'extra-row') input.rows.push(row(2));
  if (mode === 'extra-unshield') input.rows[0].unshield = undefined;
  if (mode === 'unshield-value') input.rows[0].unshield.value = '99';
  if (mode === 'unshield-token') input.rows[0].unshield.tokenData.tokenAddress = address(3);
  if (mode === 'tree') input.rows[0].utxoTreeIn = 1;
  if (mode === 'order') input.rows.reverse();
  expect(() => matchRailgunTxidEvents(input)).toThrow();
});
test('a known omission matches the complete pinned call while its other call still must match', () => {
  expect(matchRailgunTxidEvents(known)).toMatchObject({
    matchedRows: 1,
    knownOmissions: 1,
    globalTxidCompleteness: false,
  });
  for (const mutate of [
    (v) => {
      v.events[0].values[1] = hash(1);
    },
    (v) => {
      v.events[1].hashes[1] = hash(1);
    },
    (v) => {
      v.events[1].start++;
    },
    (v) => {
      v.events.splice(0, 2);
    },
    (v) => {
      v.rows[0].commitments[0] = hash(1);
    },
    (v) => {
      v.blockNumber++;
      v.rows[0].blockNumber++;
    },
  ]) {
    const changed = structuredClone(known);
    mutate(changed);
    expect(() => matchRailgunTxidEvents(changed)).toThrow();
  }
});
test('ambiguous no-output call followed by an output call refuses without inferring calldata', () => {
  const input = fixture([row(0, 0, true), row(1)]);
  [input.events[1], input.events[2]] = [input.events[2], input.events[1]];
  input.events.forEach((v, n) => {
    v.logIndex = n;
  });
  expect(() => matchRailgunTxidEvents(input)).toThrow(
    expect.objectContaining({ reason: 'ambiguous-call' })
  );
});
test('bounded input and ordered event groups refuse malformed history', () => {
  const input = fixture([row(0)]);
  input.events.reverse();
  expect(() => matchRailgunTxidEvents(input)).toThrow();
  expect(() =>
    matchRailgunTxidEvents({ ...input, events: Array(2049).fill(input.events[0]) })
  ).toThrow();
});
test('two interleaved unshield-only calls and an omission under another transaction refuse', () => {
  const input = fixture([row(0, 0, true), row(1, 0, true)]);
  [input.events[1], input.events[2]] = [input.events[2], input.events[1]];
  input.events.forEach((v, n) => {
    v.logIndex = n;
  });
  expect(() => matchRailgunTxidEvents(input)).toThrow(
    expect.objectContaining({ reason: 'ambiguous-call' })
  );
  const changed = structuredClone(known);
  changed.txid = 'a'.repeat(64);
  changed.rows[0].txid = changed.txid;
  expect(() => matchRailgunTxidEvents(changed)).toThrow();
});
