/** Real guarded utilities and pinned Poseidon; synthetic public data only.
 * No live RPC, POI, keys, wallet store, signing or spending is used.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
const { verifyRailgunNoteProvenance } = require('../src/main/wallet/railgun-note-provenance');
const sources = [
  'scripts/qualify-railgun-note-provenance.js',
  'scripts/fixtures/railgun-note-provenance-job.js',
  'src/main/wallet/railgun-note-provenance.test.js',
  ...[
    'railgun-note-provenance',
    'railgun-note-provenance-job',
    'railgun-poi-creator-data',
    'railgun-txid-projection',
    'railgun-txid-note-witness',
    'railgun-txid-events',
    'railgun-txid-omissions',
    'railgun-public-records',
    'railgun-frontier',
    'railgun-engine-runtime',
    'railgun-process',
    'railgun-process-entry',
    'railgun-process-guards',
    'railgun-session',
    'railgun-session-worker',
    'railgun-session-worker-entry',
  ].map((name) => 'src/main/wallet/' + name + '.js'),
  'src/main/wallet/railgun-engine-manifest.json',
  'src/main/wallet/railgun-shield-pins.json',
  'src/main/networks/privacy-context.js',
];
const sha = (v) => createHash('sha256').update(v).digest('hex');
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
async function main() {
  const [directory, archive, mode] = process.argv.slice(2);
  assert.ok(mode === undefined || ['partial', 'generic'].includes(mode));
  const partial = mode === 'partial',
    generic = mode === 'generic';
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(archive));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const before = hashes();
  const scope = createPrivacyScope({
    profileId: 'synthetic-note-provenance',
    signal: new AbortController().signal,
  });
  const subject = {
    kind: 'private-account',
    principal: 'synthetic',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
    operation: 'note-provenance',
  };
  const handle = scope.getContext(subject);
  let task, payload, fixtureWireBytes;
  let fixtureJobs = 0,
    fixtureExits = 0,
    maxVerifierInputBytes = 0;
  const started = performance.now();
  try {
    const loadFixture = async (sampleIndex) => {
      payload = undefined;
      fixtureJobs++;
      task = startRailgunProcess({
        handle,
        filename: require.resolve('./fixtures/railgun-note-provenance-job'),
        input: JSON.stringify({
          archive,
          ...(partial || generic ? { mode } : {}),
          ...(generic ? { sampleIndex } : {}),
        }),
        lifetimeMs: 60000,
        broker: {
          signal: scope.signal,
          async dispatch(wire) {
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 65536);
            fixtureWireBytes = Math.max(fixtureWireBytes ?? 0, Buffer.byteLength(wire));
            const message = JSON.parse(wire);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            assert.equal(payload, undefined);
            assert.deepEqual(
              Object.keys(message.value).sort(),
              partial || generic
                ? ['guards', 'samples']
                : ['events', 'guards', 'note', 'noteWitness', 'state']
            );
            assert.equal(message.value.guards.attempts, 0);
            payload = message.value;
            return JSON.stringify({ id: 1, value: null });
          },
        },
      });
      await task.ready;
      task.close();
      assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
      fixtureExits++;
      assert.ok(payload);
      return payload;
    };
    await loadFixture(generic ? 0 : undefined);
    if (generic) {
      const samples = [...payload.samples];
      assert.equal(samples.length, 1);
      for (let sampleIndex = 1; sampleIndex < 10; sampleIndex++) {
        const next = await loadFixture(sampleIndex);
        assert.equal(next.samples.length, 1);
        samples.push(next.samples[0]);
      }
      payload = { guards: payload.guards, samples };
      assert.deepEqual(
        samples.map((sample) => sample.name),
        [
          'erc20-multi-output',
          'maximum-cardinality',
          'erc721',
          'erc1155',
          'wrong-final-hash',
          'wrong-value',
          'wrong-recipient',
          'swapped-final',
          'ordinary-multi-output',
          'erc721-invalid-value',
        ]
      );
      assert.equal(fixtureJobs, 10);
      assert.equal(fixtureExits, fixtureJobs);
      for (const sample of samples) {
        const { noteWitness } = sample.evidence;
        assert.ok(noteWitness.outputIndex > 0);
        const row = noteWitness.witness.row;
        assert.ok(row.nullifiers.length >= 1 && row.nullifiers.length <= 13);
        assert.ok(row.commitments.length <= 13);
        if (row.unshield)
          assert.notEqual(
            row.unshield.tokenData.tokenAddress,
            require('../src/main/wallet/railgun-shield-pins.json').wrappedNative
          );
        const expected = {
          'erc20-multi-output': [2, 4, 2, 0, '0', '400'],
          'maximum-cardinality': [13, 13, 11, 0, '0', '400'],
          erc721: [1, 3, 1, 1, '7', '1'],
          'erc721-invalid-value': [1, 3, 1, 1, '7', '2'],
          erc1155: [3, 3, 1, 2, '9', '400'],
          'ordinary-multi-output': [2, 3, 2],
        }[sample.name];
        if (expected) {
          assert.equal(row.nullifiers.length, expected[0]);
          assert.equal(row.commitments.length, expected[1]);
          assert.equal(noteWitness.outputIndex, expected[2]);
          if (sample.name === 'ordinary-multi-output') assert.equal(row.unshield, undefined);
          else {
            assert.equal(row.unshield.tokenData.tokenType, expected[3]);
            assert.equal(BigInt(row.unshield.tokenData.tokenSubID).toString(), expected[4]);
            assert.equal(row.unshield.value, expected[5]);
          }
        }
        if (sample.name === 'maximum-cardinality') {
          assert.equal(row.nullifiers.length, 13);
          assert.equal(row.commitments.length, 13);
          assert.equal(noteWitness.outputIndex, 11);
        }
      }
    }
    const { guards: _guards, ...legacyEvidence } = payload;
    if (partial)
      assert.deepEqual(
        payload.samples.map((sample) => sample.name),
        ['valid', 'wrong-final-hash', 'wrong-value', 'wrong-recipient', 'swapped']
      );
    const evidence = partial || generic ? payload.samples[0].evidence : legacyEvidence;
    const runs = [];
    const verify = (value) => {
      const inputBytes = Buffer.byteLength(JSON.stringify({ archive, ...value }));
      assert.ok(inputBytes <= 65536);
      maxVerifierInputBytes = Math.max(maxVerifierInputBytes, inputBytes);
      return verifyRailgunNoteProvenance({ handle, archive, ...value, signal: scope.signal });
    };
    const result = await verify(evidence);
    assert.equal(result.pathVerified, true);
    assert.equal(result.utilityExitObserved, true);
    if (partial || generic) assert.equal(result.unshieldCommitmentVerified, true);
    else assert.equal(Object.hasOwn(result, 'unshieldCommitmentVerified'), false);
    for (const flag of [
      'ownershipVerified',
      'eventSourceAuthenticated',
      'rootAccepted',
      'spendingEnabled',
    ])
      assert.equal(result[flag], false);
    runs.push({ mode: generic ? 'erc20-multi-output' : 'valid', result });
    if (partial || generic) {
      for (const sample of payload.samples.slice(1)) {
        const { evidence: altered } = sample;
        const coverage = require('../src/main/wallet/railgun-txid-events').matchRailgunTxidEvents({
          blockNumber: altered.note.blockNumber,
          txid: altered.note.txid.slice(2),
          events: altered.events,
          rows: [altered.noteWitness.witness.row],
        });
        assert.equal(coverage.matchedRows, 1);
        assert.equal(coverage.knownOmissions, 0);
        if (
          generic &&
          ['maximum-cardinality', 'erc721', 'erc1155', 'ordinary-multi-output'].includes(
            sample.name
          )
        ) {
          const checked = await verify(altered);
          assert.equal(checked.pathVerified, true);
          assert.equal(checked.utilityExitObserved, true);
          if (sample.name === 'ordinary-multi-output') {
            assert.equal(Object.hasOwn(checked, 'unshieldCommitmentVerified'), false);
            assert.deepEqual(
              Object.keys(checked).sort(),
              [
                'inputSha256',
                'pathVerified',
                'suppliedCreatorEventsMatched',
                'ownershipVerified',
                'eventSourceAuthenticated',
                'rootAccepted',
                'spendingEnabled',
                'coverage',
                'utilityExitObserved',
              ].sort()
            );
          } else assert.equal(checked.unshieldCommitmentVerified, true);
          for (const flag of [
            'ownershipVerified',
            'eventSourceAuthenticated',
            'rootAccepted',
            'spendingEnabled',
          ])
            assert.equal(checked[flag], false);
          runs.push({
            mode: sample.name,
            selectedOrdinaryIndex: altered.noteWitness.outputIndex,
            result: checked,
          });
          continue;
        }
        if (sample.name === 'erc721-invalid-value')
          require('../src/main/wallet/railgun-txid-note-witness').normalizeRailgunNoteTxidWitness(
            altered.noteWitness,
            altered.state,
            altered.note
          );
        await assert.rejects(verify(altered), { code: 'RAILGUN_NOTE_PROVENANCE_REFUSED' });
        runs.push({
          mode: sample.name,
          refused: true,
          structurallyMatched: true,
          fixturePathVerifiedBeforeAdmission: true,
          ...(sample.name === 'erc721-invalid-value'
            ? {
                structuralNoteAccepted: true,
                pinnedTokenRuleInvalid: true,
                fixtureHashBoundToInvalidQuantity: true,
              }
            : {}),
        });
      }
    }
    if (generic) {
      const altered = structuredClone(evidence);
      const row = altered.noteWitness.witness.row;
      const finalIndex = row.commitments.length - 1;
      altered.note.hash = row.commitments[finalIndex];
      altered.note.position = row.utxoBatchStartPositionOut + finalIndex;
      altered.noteWitness.note = structuredClone(altered.note);
      altered.noteWitness.outputIndex = finalIndex;
      assert.throws(
        () =>
          require('../src/main/wallet/railgun-txid-note-witness').normalizeRailgunNoteTxidWitness(
            altered.noteWitness,
            altered.state,
            altered.note
          ),
        { code: 'RAILGUN_TXID_NOTE_WITNESS_REFUSED' }
      );
      await assert.rejects(verify(altered), { code: 'RAILGUN_NOTE_PROVENANCE_REFUSED' });
      runs.push({
        mode: 'final-unshield-selected-as-note',
        refused: true,
        structuralSelectionRefused: true,
        selectedNoteWitnessValid: false,
      });
    }
    for (const mode of [
      'sibling',
      'index',
      'row-hash',
      'txid',
      'note',
      'events',
      'omitted-creator',
    ]) {
      const altered = structuredClone(evidence);
      if (mode === 'sibling') altered.noteWitness.witness.elements[0] = '0'.repeat(64);
      if (mode === 'index') altered.noteWitness.witness.index = 0;
      if (mode === 'row-hash') {
        altered.noteWitness.witness.row.boundParamsHash = '0x' + '0'.repeat(64);
        altered.noteWitness.witness.rowSha256 = sha(
          JSON.stringify(altered.noteWitness.witness.row)
        );
      }
      if (mode === 'txid') altered.noteWitness.witness.railgunTxid = '0'.repeat(64);
      if (mode === 'note') altered.note.position++;
      if (mode === 'events') altered.events.at(-1).hashes[0] = '0x' + '0'.repeat(64);
      if (mode === 'omitted-creator') {
        const txid = '4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932';
        altered.note.txid = altered.noteWitness.note.txid = '0x' + txid;
        altered.noteWitness.witness.row.txid = txid;
        altered.noteWitness.witness.rowSha256 = sha(
          JSON.stringify(altered.noteWitness.witness.row)
        );
      }
      await assert.rejects(verify(altered), { code: 'RAILGUN_NOTE_PROVENANCE_REFUSED' });
      runs.push({ mode, refused: true });
    }
    assert.deepEqual(hashes(), before);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
          engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
          sourceSha256: before,
          ...(partial || generic
            ? {
                mode,
                fixtureWireBytes,
                ...(generic
                  ? {
                      fixtureJobs,
                      fixtureExits,
                      maxVerifierInputBytes,
                      maxTotalCommitments: 13,
                      maxMixedOrdinaryCommitments: 12,
                      genericShapes: payload.samples.map(({ name, evidence: { noteWitness } }) => ({
                        name,
                        nullifierCount: noteWitness.witness.row.nullifiers.length,
                        ordinaryOutputCount:
                          noteWitness.witness.row.commitments.length -
                          Number(!!noteWitness.witness.row.unshield),
                        selectedOrdinaryIndex: noteWitness.outputIndex,
                        tokenType: noteWitness.witness.row.unshield?.tokenData.tokenType ?? null,
                      })),
                      genericProvenanceOnly: true,
                      retainedPoiScopeExpanded: false,
                    }
                  : {}),
                spendProofValidityVerified: false,
                changeOwnershipVerified: false,
                mainPartialAdmissionEnabled: false,
                combinedPoiVerified: false,
                restartSecondSpendVerified: false,
              }
            : {}),
          runs,
          syntheticDataOnly: true,
          liveQueries: 0,
          submissions: 0,
          spendingEnabled: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(JSON.stringify({ report: path.join(directory, 'report.json'), runs: runs.length }));
  } finally {
    scope.close();
    task?.close();
    if (task) await task.closed;
  }
}
main().then(
  () => app.exit(0),
  () => {
    console.error('Detached note provenance qualification failed');
    app.exit(1);
  }
);
