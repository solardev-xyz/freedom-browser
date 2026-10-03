const { createHash } = require('crypto');
const ethers = require('ethers');
const { compareRailgunTxidCoverage } = require('./railgun-txid-coverage');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const abi = new ethers.Interface([
  'event Nullified(uint256 treeNumber, bytes32[] nullifier)',
  'event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash)',
]);
function fixture() {
  const records = [],
    logs = [];
  let transcript = sha('');
  for (let n = 0; n < 2; n++) {
    const row = {
      txid: hex(n + 1).slice(2),
      blockNumber: 10 + n,
      graphID: hex(10 + n) + '0'.repeat(128),
      nullifiers: [hex(n + 10)],
      commitments: [hex(n + 100)],
      utxoTreeIn: 0,
      utxoTreeOut: 0,
      utxoBatchStartPositionOut: n,
      verificationHash: hex(n + 200),
    };
    const record = {
      row,
      leaf: hex(n + 300).slice(2),
      railgunTxid: hex(n + 400).slice(2),
      rowSha256: sha(JSON.stringify(row)),
    };
    records.push(record);
    transcript = sha(transcript + '\n' + JSON.stringify(record));
    for (const [name, args] of [
      ['Nullified', [0, row.nullifiers]],
      ['Transact', [0, n, row.commitments]],
    ]) {
      const event = abi.encodeEventLog(abi.getEvent(name), args);
      logs.push({
        address: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
        blockNumber: row.blockNumber,
        transactionHash: '0x' + row.txid,
        transactionIndex: 0,
        logIndex: name === 'Nullified' ? 0 : 1,
        ...event,
      });
    }
  }
  const state = {
    count: 2,
    root: 'e'.repeat(64),
    transcript,
    after: records.at(-1).row.graphID,
    verificationHash: records.at(-1).row.verificationHash,
  };
  const plan = {
    to: { number: 20, hash: hex(20) },
    source: { ledgerId: 'a'.repeat(64), ledgerSha256: 'b'.repeat(64) },
  };
  let offset = 0;
  const nextBatch = jest.fn(async () =>
    offset < logs.length ? logs.slice(offset, (offset += 2)) : null
  );
  const read = jest.fn(async (key) => JSON.stringify(records[Number(key.split(':').at(-1))]));
  return {
    state,
    plan,
    read,
    inspectRecord: JSON.parse,
    nextBatch,
    abi,
    ethers,
    qualifiedThrough: 20,
    records,
    logs,
  };
}
test('merges complete transaction groups, binds both histories and drains source EOF', async () => {
  const input = fixture(),
    result = await compareRailgunTxidCoverage(input);
  expect(result).toMatchObject({
    checkedCount: 2,
    matchedTransactions: 2,
    boundary: 11,
    checkedTranscript: input.state.transcript,
    discrepancy: null,
    omissions: [],
    globalTxidCompleteness: false,
    spendingEnabled: false,
  });
  expect(result.checkedRowsSha256).toBe(sha(input.records.map((r) => r.rowSha256 + '\n').join('')));
  expect(result.txid.transcript).toBe(input.state.transcript);
  expect(result.source.ledgerSha256).toBe(input.plan.source.ledgerSha256);
  expect(input.nextBatch).toHaveBeenCalledTimes(3);
});
test('a completed public checkpoint bounds coverage while the remaining TXID rows still authenticate', async () => {
  const input = fixture();
  input.plan.to.number = 10;
  input.logs.splice(2);
  const result = await compareRailgunTxidCoverage(input);
  expect(result.checkedCount).toBe(1);
  expect(result.boundary).toBe(10);
  expect(result.rowsWithinBoundary).toBe(1);
  expect(result.uncheckedBeyondBoundary).toBe(1);
  expect(input.read).toHaveBeenCalledWith('txid:row:1');
});
test('a partially indexed final transaction stops before that transaction but drains both streams', async () => {
  const input = fixture();
  const extra = {
    ...input.logs[2],
    logIndex: 1,
    ...abi.encodeEventLog(abi.getEvent('Nullified'), [0, [hex(999)]]),
  };
  input.logs[3].logIndex = 2;
  input.logs.splice(3, 0, extra);
  const result = await compareRailgunTxidCoverage(input);
  expect(result).toMatchObject({
    checkedCount: 1,
    matchedTransactions: 1,
    discrepancy: { blockNumber: 11, reason: 'nullifiers' },
  });
  expect(input.nextBatch).toHaveBeenCalledTimes(4);
});
test.each(['missing-rows', 'missing-events'])(
  'unknown %s stop the prefix without aborting acquisition',
  async (mode) => {
    const input = fixture();
    if (mode === 'missing-events') input.logs.splice(0, 2);
    else {
      const extra = input.logs
        .slice(0, 2)
        .map((log) => ({ ...log, blockNumber: 9, transactionHash: hex(99) }));
      input.logs.unshift(...extra);
    }
    const result = await compareRailgunTxidCoverage(input);
    expect(result.checkedCount).toBe(0);
    expect(result.discrepancy.reason).toBe(mode);
    expect(await input.nextBatch()).toBeNull();
  }
);
test('late integrity failures reject even when a semantic discrepancy has already stopped matching', async () => {
  const input = fixture();
  input.logs.splice(0, 2);
  input.state.transcript = '0'.repeat(64);
  await expect(compareRailgunTxidCoverage(input)).rejects.toThrow();
  const other = fixture();
  const next = other.nextBatch.getMockImplementation();
  other.nextBatch.mockImplementation(async () => {
    const value = await next();
    if (value === null) throw Error('ledger digest');
    return value;
  });
  await expect(compareRailgunTxidCoverage(other)).rejects.toThrow('ledger digest');
});
test('unordered logs and a row cursor from another transaction index refuse', async () => {
  const input = fixture();
  input.logs.reverse();
  await expect(compareRailgunTxidCoverage(input)).rejects.toThrow();
  const changed = fixture();
  changed.records[1].row.graphID = changed.records[0].row.graphID;
  await expect(compareRailgunTxidCoverage(changed)).rejects.toThrow();
});
test('later events in the last mirrored block are recorded as an unindexed tail without guessing its cause', async () => {
  const input = fixture();
  input.logs.push(
    ...input.logs
      .slice(2)
      .map((log) => ({
        ...log,
        transactionIndex: 1,
        transactionHash: hex(99),
        logIndex: log.logIndex + 2,
      }))
  );
  const result = await compareRailgunTxidCoverage(input);
  expect(result).toMatchObject({
    checkedCount: 2,
    rowsWithinBoundary: 2,
    uncheckedBeyondBoundary: 0,
    discrepancy: null,
    unindexedTail: { blockNumber: 11, transactionIndex: 1, txid: hex(99).slice(2) },
  });
  expect(await input.nextBatch()).toBeNull();
});
