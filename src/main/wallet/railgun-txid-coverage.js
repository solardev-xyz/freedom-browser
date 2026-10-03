/** Streaming TXID/event comparison inside the guarded utility. Entire inputs
 * drain and authenticate even after a semantic finding stops the checked prefix.
 * Only one Ethereum transaction from either stream is retained at a time.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { matchRailgunTxidEvents } = require('./railgun-txid-events');
const { parseRailgunSourceEvent } = require('./railgun-event-projector');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const compare = (a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex;
async function compareRailgunTxidCoverage({
  state,
  plan,
  read,
  inspectRecord,
  nextBatch,
  abi,
  ethers,
  qualifiedThrough,
}) {
  assert.ok(state.count > 0 && state.count <= 8000);
  assert.ok(Number.isSafeInteger(plan?.to?.number) && plan.to.number >= 0);
  assert.match(plan.to.hash, /^0x[0-9a-f]{64}$/);
  assert.match(plan.source?.ledgerId, /^[0-9a-f]{64}$/);
  assert.match(plan.source?.ledgerSha256, /^[0-9a-f]{64}$/);
  const last = inspectRecord(await read('txid:row:' + (state.count - 1)));
  const boundary = Math.min(plan.to.number, last.row.blockNumber);
  let rowsWithinBoundary = 0;
  async function* rowGroups() {
    let group,
      transcript = sha(''),
      after = '0x00',
      verificationHash;
    for (let index = 0; index < state.count; index++) {
      const record = inspectRecord(await read('txid:row:' + index)),
        row = record.row;
      if (row.blockNumber <= boundary) rowsWithinBoundary++;
      assert.ok(row.graphID > after);
      assert.equal(BigInt('0x' + row.graphID.slice(2, 66)), BigInt(row.blockNumber));
      const transactionIndex = Number(BigInt('0x' + row.graphID.slice(66, 130)));
      assert.ok(Number.isSafeInteger(transactionIndex) && transactionIndex >= 0);
      const identity = { blockNumber: row.blockNumber, transactionIndex, txid: row.txid };
      if (group && compare(group, identity) !== 0) {
        assert.ok(compare(group, identity) < 0);
        yield group;
        group = null;
      }
      if (!group) group = { ...identity, rows: [], records: [], bytes: 0 };
      assert.equal(group.txid, row.txid);
      group.bytes += Buffer.byteLength(JSON.stringify(record));
      assert.ok(group.rows.length < 1024 && group.bytes <= 2 * 1024 * 1024);
      group.rows.push(row);
      group.records.push(record);
      transcript = sha(transcript + '\n' + JSON.stringify(record));
      group.transcript = transcript;
      after = row.graphID;
      verificationHash = row.verificationHash;
    }
    if (group) yield group;
    assert.equal(transcript, state.transcript);
    assert.equal(after, state.after);
    assert.equal(verificationHash, state.verificationHash);
  }
  async function* eventGroups() {
    let group,
      previous,
      count = 0,
      bytes = 0;
    for (;;) {
      const batch = await nextBatch();
      if (batch === null) break;
      assert.ok(Array.isArray(batch) && batch.length > 0 && batch.length <= 128);
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 2 * 1024 * 1024);
      for (const log of batch) {
        assert.ok(++count <= 100000);
        bytes += Buffer.byteLength(JSON.stringify(log));
        assert.ok(bytes <= 128 * 1024 * 1024);
        assert.equal(log.address, '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea');
        for (const key of ['blockNumber', 'transactionIndex', 'logIndex'])
          assert.ok(Number.isSafeInteger(log[key]) && log[key] >= 0);
        assert.ok(log.blockNumber <= plan.to.number);
        assert.match(log.transactionHash, /^0x[0-9a-f]{64}$/);
        if (previous) {
          assert.ok(
            log.blockNumber > previous.blockNumber ||
              (log.blockNumber === previous.blockNumber &&
                log.logIndex > previous.logIndex &&
                log.transactionIndex >= previous.transactionIndex)
          );
          if (
            log.blockNumber === previous.blockNumber &&
            log.transactionIndex === previous.transactionIndex
          )
            assert.equal(log.transactionHash, previous.transactionHash);
        }
        previous = log;
        const identity = {
          blockNumber: log.blockNumber,
          transactionIndex: log.transactionIndex,
          txid: log.transactionHash.slice(2),
        };
        if (group && compare(group, identity) !== 0) {
          if (group.events.length) yield group;
          group = null;
        }
        if (!group) group = { ...identity, events: [], bytes: 0 };
        const event = parseRailgunSourceEvent(abi, log, qualifiedThrough, ethers),
          args = event.args;
        let normalized;
        if (event.name === 'Nullified')
          normalized = {
            name: event.name,
            logIndex: log.logIndex,
            tree: Number(args.treeNumber),
            values: [...args.nullifier],
          };
        if (event.name === 'Transact')
          normalized = {
            name: event.name,
            logIndex: log.logIndex,
            tree: Number(args.treeNumber),
            start: Number(args.startPosition),
            hashes: [...args.hash],
          };
        if (event.name === 'Unshield')
          normalized = {
            name: event.name,
            logIndex: log.logIndex,
            to: args.to.toLowerCase(),
            token: args.token.tokenAddress.toLowerCase(),
            type: Number(args.token.tokenType),
            subID: args.token.tokenSubID.toString(),
            value: (args.amount + args.fee).toString(),
          };
        if (normalized) {
          group.bytes += Buffer.byteLength(JSON.stringify(normalized));
          assert.ok(group.events.length < 2048 && group.bytes <= 2 * 1024 * 1024);
          group.events.push(normalized);
        }
      }
    }
    if (group?.events.length) yield group;
  }
  const rows = rowGroups(),
    events = eventGroups();
  let row = await rows.next(),
    event = await events.next(),
    checkedCount = 0,
    matchedTransactions = 0,
    checkedTranscript = sha(''),
    discrepancy = null,
    unindexedTail = null;
  const checkedRows = createHash('sha256'),
    omissions = [];
  while (
    (!row.done && row.value.blockNumber <= boundary) ||
    (!event.done && event.value.blockNumber <= boundary)
  ) {
    const r = !row.done && row.value.blockNumber <= boundary ? row.value : null;
    const e = !event.done && event.value.blockNumber <= boundary ? event.value : null;
    const order = !r ? 1 : !e ? -1 : compare(r, e);
    const identity = order <= 0 ? r : e;
    if (
      row.done &&
      e &&
      e.blockNumber === last.row.blockNumber &&
      e.transactionIndex > Number(BigInt('0x' + last.row.graphID.slice(66, 130)))
    ) {
      // No mirrored row claims this later transaction. Preserve the observation
      // without guessing whether it is temporary lag or a service omission.
      unindexedTail = {
        blockNumber: e.blockNumber,
        transactionIndex: e.transactionIndex,
        txid: e.txid,
      };
      break;
    }
    let reason;
    if (order !== 0) reason = order < 0 ? 'missing-events' : 'missing-rows';
    else if (r.txid !== e.txid) reason = 'transaction';
    else {
      try {
        const matched = matchRailgunTxidEvents({
          blockNumber: r.blockNumber,
          txid: r.txid,
          rows: r.rows,
          events: e.events,
        });
        assert.equal(matched.matchedRows, r.rows.length);
        if (matched.knownOmissions) omissions.push({ blockNumber: r.blockNumber, txid: r.txid });
        assert.ok(omissions.length <= 1);
      } catch (error) {
        if (error.code !== 'RAILGUN_TXID_EVENTS_REFUSED') throw error;
        reason = error.reason;
      }
    }
    if (reason) {
      discrepancy = {
        blockNumber: identity.blockNumber,
        transactionIndex: identity.transactionIndex,
        txid: identity.txid,
        reason,
      };
      break;
    }
    checkedCount += r.rows.length;
    matchedTransactions++;
    checkedTranscript = r.transcript;
    for (const record of r.records) checkedRows.update(record.rowSha256 + '\n');
    row = await rows.next();
    event = await events.next();
  }
  // A mismatch is a finding, not a source-integrity exception. Finish both
  // streams so the full TXID transcript and every source range digest verify.
  while (!row.done) row = await rows.next();
  while (!event.done) event = await events.next();
  return {
    version: 1,
    boundary,
    checkedCount,
    rowsWithinBoundary,
    uncheckedBeyondBoundary: state.count - rowsWithinBoundary,
    matchedTransactions,
    checkedRowsSha256: checkedRows.digest('hex'),
    checkedTranscript,
    txid: { count: state.count, root: state.root, transcript: state.transcript },
    source: {
      ledgerId: plan.source.ledgerId,
      ledgerSha256: plan.source.ledgerSha256,
      to: { ...plan.to },
    },
    omissions,
    discrepancy,
    unindexedTail,
    trust: 'indexer-versus-unverified-rpc-consistency',
    boundParamsChecked: false,
    unshieldCommitmentHashesChecked: false,
    globalTxidCompleteness: false,
    spendingEnabled: false,
  };
}
module.exports = { compareRailgunTxidCoverage };
