/** Synthetic public TXID evidence for detached-verifier qualification only. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const { archive, mode, sampleIndex } = JSON.parse(text);
  assert.ok(mode === undefined || ['partial', 'generic'].includes(mode));
  assert.ok(
    mode === 'generic'
      ? Number.isSafeInteger(sampleIndex) && sampleIndex >= 0 && sampleIndex < 10
      : sampleIndex === undefined
  );
  const verified =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const r = createRequire(path.join(verified, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const projection =
    require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
    });
  const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
  const makeRows = () => {
    let previous;
    return Array.from({ length: 3 }, (_, i) => {
      const nullifiers = [hex(10 + i)];
      previous = calculateRailgunTransactionVerificationHash(previous, nullifiers[0]);
      return {
        version: 'V2',
        graphID: hex(i + 1) + '0'.repeat(128),
        commitments: [hex(20 + i)],
        nullifiers,
        boundParamsHash: hex(30 + i),
        blockNumber: i + 1,
        txid: hex(40 + i).slice(2),
        timestamp: i + 1,
        utxoTreeIn: 0,
        utxoTreeOut: 0,
        utxoBatchStartPositionOut: i,
        verificationHash: previous,
      };
    });
  };
  const publish = async (value) => {
    assert.ok(!signal.aborted);
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    const wire = JSON.stringify({ id: 1, method: 'result', value: { ...value, guards } });
    assert.ok(Buffer.byteLength(wire) <= 65536);
    assert.deepEqual(JSON.parse(await request(wire)), { id: 1, value: null });
  };
  if (mode === 'generic') {
    // One sample per child keeps both fixture reply and verifier input below
    // their existing 64 KiB caps, including the maximum 13 total commitments.
    const cases = [
      {
        name: 'erc20-multi-output',
        nullifiers: 2,
        ordinary: 3,
        selected: 2,
        type: 0,
        subID: 0,
        value: '400',
      },
      {
        name: 'maximum-cardinality',
        nullifiers: 13,
        ordinary: 12,
        selected: 11,
        type: 0,
        subID: 0,
        value: '400',
      },
      { name: 'erc721', nullifiers: 1, ordinary: 2, selected: 1, type: 1, subID: 7, value: '1' },
      { name: 'erc1155', nullifiers: 3, ordinary: 2, selected: 1, type: 2, subID: 9, value: '400' },
      ...['wrong-final-hash', 'wrong-value', 'wrong-recipient', 'swapped-final'].map((name) => ({
        name,
        nullifiers: 2,
        ordinary: 3,
        selected: 2,
        type: 0,
        subID: 0,
        value: '400',
      })),
      {
        name: 'ordinary-multi-output',
        nullifiers: 2,
        ordinary: 3,
        selected: 2,
        type: 0,
        subID: 0,
        value: '400',
        noUnshield: true,
      },
      {
        name: 'erc721-invalid-value',
        nullifiers: 1,
        ordinary: 2,
        selected: 1,
        type: 1,
        subID: 7,
        value: '1',
      },
    ];
    const config = cases[sampleIndex];
    const { getNoteHash, assertValidNoteToken } = require(path.join(root, 'note/note-util'));
    const tokenData = {
      tokenType: config.type,
      tokenAddress: '0x' + '56'.repeat(20),
      tokenSubID: hex(config.subID),
    };
    assertValidNoteToken(tokenData, BigInt(config.value));
    const recipient = '0x' + '12'.repeat(20);
    const finalHash =
      '0x' + getNoteHash(recipient, tokenData, BigInt(config.value)).toString(16).padStart(64, '0');
    const rows = makeRows(),
      row = rows[1];
    row.nullifiers = Array.from({ length: config.nullifiers }, (_, i) => hex(1000 + i));
    row.commitments = Array.from({ length: config.ordinary }, (_, i) => hex(2000 + i));
    row.utxoBatchStartPositionOut = 100;
    rows[2].utxoBatchStartPositionOut = 200;
    if (!config.noUnshield) {
      row.commitments.push(finalHash);
      row.unshield = { tokenData, toAddress: recipient, value: config.value };
      if (config.name === 'erc721-invalid-value') {
        // getNoteHash is the pinned raw hash primitive and does not enforce
        // ERC721 quantity. Bind the invalid quantity exactly so the later hash
        // comparison cannot mask omission of assertValidNoteToken in the job.
        row.unshield.value = '2';
        assert.throws(() => assertValidNoteToken(tokenData, 2n));
        row.commitments[row.commitments.length - 1] =
          '0x' + getNoteHash(recipient, tokenData, 2n).toString(16).padStart(64, '0');
      }
      if (config.name === 'wrong-final-hash')
        row.commitments[row.commitments.length - 1] = hex(999);
      if (config.name === 'wrong-value') row.unshield.value = '401';
      if (config.name === 'wrong-recipient') row.unshield.toAddress = '0x' + '13'.repeat(20);
      if (config.name === 'swapped-final') {
        const last = row.commitments.length - 1;
        [row.commitments[0], row.commitments[last]] = [row.commitments[last], row.commitments[0]];
      }
    }
    let previous;
    for (const item of rows) {
      previous = calculateRailgunTransactionVerificationHash(previous, item.nullifiers[0]);
      item.verificationHash = previous;
    }
    const values = new Map(),
      read = async (key) => values.get(key) ?? null;
    const { state, writes } = await projection.append(projection.empty(), rows, read);
    writes.forEach(({ key, value }) => values.set(key, value));
    const note = {
      type: 'Transact',
      txid: '0x' + row.txid,
      hash: row.commitments[config.selected],
      tree: 0,
      position: row.utxoBatchStartPositionOut + config.selected,
      blockNumber: 2,
    };
    const noteWitness =
      await require('../../src/main/wallet/railgun-txid-note-witness').findRailgunNoteTxidWitness({
        state,
        note,
        read,
        projection,
      });
    assert.equal(noteWitness.outputIndex, config.selected);
    projection.verifyWitness(state, noteWitness.witness);
    const events = [
      { name: 'Nullified', logIndex: 1, tree: 0, values: row.nullifiers },
      ...(!config.noUnshield
        ? [
            {
              name: 'Unshield',
              logIndex: 2,
              to: row.unshield.toAddress,
              token: tokenData.tokenAddress,
              type: tokenData.tokenType,
              subID: String(config.subID),
              value: row.unshield.value,
            },
          ]
        : []),
      {
        name: 'Transact',
        logIndex: 3,
        tree: 0,
        start: row.utxoBatchStartPositionOut,
        hashes: row.commitments.slice(0, config.ordinary),
      },
    ];
    const coverage = require('../../src/main/wallet/railgun-txid-events').matchRailgunTxidEvents({
      blockNumber: note.blockNumber,
      txid: row.txid,
      events,
      rows: [row],
    });
    assert.equal(coverage.matchedRows, 1);
    assert.equal(coverage.knownOmissions, 0);
    await publish({
      samples: [{ name: config.name, evidence: { state, note, noteWitness, events } }],
    });
    return;
  }
  if (mode === 'partial') {
    const pins = require('../../src/main/wallet/railgun-shield-pins.json');
    const { getNoteHash } = require(path.join(root, 'note/note-util'));
    const tokenData = { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) };
    const recipient = '0x' + '12'.repeat(20);
    const finalHash = '0x' + getNoteHash(recipient, tokenData, 400n).toString(16).padStart(64, '0');
    const samples = [];
    for (const name of ['valid', 'wrong-final-hash', 'wrong-value', 'wrong-recipient', 'swapped']) {
      const rows = makeRows(),
        row = rows[1];
      row.commitments.push(finalHash);
      row.unshield = { tokenData, toAddress: recipient, value: '400' };
      if (name === 'wrong-final-hash') row.commitments[1] = hex(999);
      if (name === 'wrong-value') row.unshield.value = '401';
      if (name === 'wrong-recipient') row.unshield.toAddress = '0x' + '13'.repeat(20);
      if (name === 'swapped') row.commitments.reverse();
      const values = new Map(),
        read = async (key) => values.get(key) ?? null;
      const { state, writes } = await projection.append(projection.empty(), rows, read);
      writes.forEach(({ key, value }) => values.set(key, value));
      const note = {
        type: 'Transact',
        txid: '0x' + row.txid,
        hash: row.commitments[0],
        tree: 0,
        position: 1,
        blockNumber: 2,
      };
      const noteWitness =
        await require('../../src/main/wallet/railgun-txid-note-witness').findRailgunNoteTxidWitness(
          { state, note, read, projection }
        );
      projection.verifyWitness(state, noteWitness.witness);
      const events = [
        { name: 'Nullified', logIndex: 1, tree: 0, values: row.nullifiers },
        {
          name: 'Unshield',
          logIndex: 2,
          to: row.unshield.toAddress,
          token: pins.wrappedNative,
          type: 0,
          subID: '0',
          value: row.unshield.value,
        },
        { name: 'Transact', logIndex: 3, tree: 0, start: 1, hashes: [row.commitments[0]] },
      ];
      const coverage = require('../../src/main/wallet/railgun-txid-events').matchRailgunTxidEvents({
        blockNumber: note.blockNumber,
        txid: row.txid,
        events,
        rows: [row],
      });
      assert.equal(coverage.matchedRows, 1);
      assert.equal(coverage.knownOmissions, 0);
      samples.push({ name, evidence: { state, note, noteWitness, events } });
    }
    await publish({ samples });
    return;
  }
  const rows = makeRows();
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const { state, writes } = await projection.append(projection.empty(), rows, read);
  writes.forEach(({ key, value }) => values.set(key, value));
  const row = rows[1],
    note = {
      type: 'Transact',
      txid: '0x' + row.txid,
      hash: row.commitments[0],
      tree: 0,
      position: 1,
      blockNumber: 2,
    };
  const noteWitness =
    await require('../../src/main/wallet/railgun-txid-note-witness').findRailgunNoteTxidWitness({
      state,
      note,
      read,
      projection,
    });
  const events = [
    { name: 'Nullified', logIndex: 1, tree: 0, values: row.nullifiers },
    { name: 'Transact', logIndex: 2, tree: 0, start: 1, hashes: row.commitments },
  ];
  await publish({ state, note, noteWitness, events });
};
