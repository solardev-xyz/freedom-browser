/** Offline keyless Shield selector qualification. No selector, its digest,
 * capsule or creator is written to the report. Usage: electron script ASAR NEW_DIR */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
async function main() {
  const [archive, directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok(path.isAbsolute(archive) && path.isAbsolute(directory) && !fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const files = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-poi-shield-selector.js',
    'scripts/fixtures/railgun-poi-shield-selector-input-job.js',
    'scripts/fixtures/railgun-own-txid-data.js',
    'scripts/fixtures/railgun-transact-data.js',
    ...[
      'railgun-poi-shield-selector',
      'railgun-poi-shield-selector-data',
      'railgun-poi-shield-selector-job',
    ].flatMap((f) => ['.js', '.test.js'].map((s) => 'src/main/wallet/' + f + s)),
    ...[
      'railgun-private-capsule',
      'railgun-private-preparation',
      'railgun-private-intent',
      'railgun-private-policy',
      'railgun-transact-intent',
      'railgun-transact-receipt',
      'railgun-transact-resolution',
      'privacy-journal-retention',
      'railgun-owned-poi-records',
      'railgun-poi-records',
      'railgun-engine-runtime',
      'railgun-process',
      'railgun-process-entry',
      'railgun-process-guards',
    ].map((f) => 'src/main/wallet/' + f + '.js'),
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/wallet/railgun-shield-pins.json',
    'src/main/networks/privacy-context.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      files.map((f) => [
        f,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', f)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes();
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'synthetic-poi-shield-selector',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'synthetic',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
    operation: 'poi-shield-selector',
  });
  const {
    deriveRailgunPoiShieldSelector: derive,
  } = require('../src/main/wallet/railgun-poi-shield-selector');
  const {
    normalizeRailgunPoiShieldInput: normalize,
  } = require('../src/main/wallet/railgun-poi-shield-selector-data');
  let task, vectors;
  try {
    task = require('../src/main/wallet/railgun-process').startRailgunProcess({
      handle,
      filename: require.resolve('./fixtures/railgun-poi-shield-selector-input-job'),
      input: JSON.stringify({ archive }),
      startupMs: 30000,
      lifetimeMs: 60000,
      broker: {
        signal: scope.signal,
        dispatch: async (wire) => {
          assert.equal(vectors, undefined);
          assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
          const msg = JSON.parse(wire);
          assert.deepEqual(Object.keys(msg).sort(), ['id', 'method', 'value']);
          assert.equal(msg.id, 1);
          assert.equal(msg.method, 'result');
          assert.deepEqual(Object.keys(msg.value).sort(), [
            'guardAttempts',
            'shieldCiphertextRoundtrip',
            'structuralCapsules',
            'vectors',
          ]);
          assert.equal(msg.value.guardAttempts, 0);
          assert.equal(msg.value.shieldCiphertextRoundtrip, true);
          assert.equal(msg.value.structuralCapsules, true);
          assert.ok(Array.isArray(msg.value.vectors) && msg.value.vectors.length === 3);
          vectors = msg.value.vectors;
          for (const v of vectors) {
            assert.deepEqual(Object.keys(v).sort(), [
              'capsule',
              'creator',
              'expectedBlindedCommitment',
              'otherNoteHash',
            ]);
            normalize(v.capsule, v.creator);
            assert.match(v.expectedBlindedCommitment, /^0x[0-9a-f]{64}$/);
            assert.match(v.otherNoteHash, /^0x[0-9a-f]{64}$/);
            assert.notEqual(v.otherNoteHash, v.capsule.noteHash);
          }
          return JSON.stringify({ id: 1, value: null });
        },
      },
    });
    await task.ready;
    assert.ok(vectors);
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    task = undefined;
    const runs = [];
    for (const [index, v] of vectors.entries()) {
      const started = performance.now();
      const args = () => ({
        handle,
        archive,
        ...structuredClone({ capsule: v.capsule, creator: v.creator }),
        signal: scope.signal,
      });
      const result = await derive(args());
      assert.equal(result.blindedCommitment, v.expectedBlindedCommitment);
      assert.equal(result.selectorDerived, true);
      assert.equal(result.utilityExitObserved, true);
      for (const k of [
        'ownershipAuthenticated',
        'sourceAuthenticated',
        'membershipAuthenticated',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        assert.equal(result[k], false);
      const ciphertextChange = args();
      const old = ciphertextChange.creator.ciphertext.encryptedBundle[0];
      ciphertextChange.creator.ciphertext.encryptedBundle[0] =
        old.slice(0, -1) + (old.endsWith('0') ? '1' : '0');
      const changed = await derive(ciphertextChange);
      assert.equal(changed.blindedCommitment, result.blindedCommitment);
      assert.notEqual(changed.bindingDigest, result.bindingDigest);
      assert.notEqual(changed.inputSha256, result.inputSha256);
      const refusals = [];
      for (const name of [
        'npk-hash',
        'different-note-same-position',
        'creator-position',
        'creator-tree',
        'transact-type',
        'note-hash-prefix',
        'non-weth',
      ]) {
        const x = args();
        if (name === 'npk-hash')
          x.creator.preimage.npk =
            '0x' + (BigInt(x.creator.preimage.npk) + 1n).toString(16).padStart(64, '0');
        if (name === 'different-note-same-position') x.capsule.noteHash = v.otherNoteHash;
        if (name === 'creator-position') x.creator.position = x.creator.position === 0 ? 1 : 0;
        if (name === 'creator-tree') x.creator.tree = x.creator.tree === 0 ? 1 : 0;
        if (name === 'transact-type') x.creator.type = 'Transact';
        if (name === 'note-hash-prefix') x.capsule.noteHash = x.capsule.noteHash.slice(2);
        if (name === 'non-weth') x.creator.preimage.token.tokenAddress = '0x' + '34'.repeat(20);
        if (['npk-hash', 'different-note-same-position'].includes(name))
          normalize(x.capsule, x.creator);
        await assert.rejects(() => derive(x), { code: 'RAILGUN_POI_SHIELD_SELECTOR_REFUSED' });
        refusals.push(name);
      }
      runs.push({
        vector: index,
        nonzeroTree: v.creator.tree !== 0,
        boundaryPosition: v.creator.position === 65535,
        maximumTree: v.creator.tree === 65535,
        preSpendProjectionCompared: true,
        selectorDerived: true,
        ciphertextMutationPreservesSelector: true,
        ciphertextMutationChangesBinding: true,
        exitsObserved: true,
        refusals,
        cryptographicRefusalsAfterNormalization: ['npk-hash', 'different-note-same-position'],
        elapsedMs: Math.round(performance.now() - started),
        authorityGranted: false,
      });
    }
    assert.deepEqual(hashes(), sourceSha256);
    const report = {
      fixture: 'synthetic-shield-poi-selector',
      engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
      sourceSha256,
      shieldCiphertextRoundtrip: true,
      structuralCapsules: true,
      creatingTransactionAuthenticated: false,
      viewingKeyReleased: false,
      runs,
      liveQueries: 0,
      submissions: 0,
      authorityGranted: false,
    };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        vectors: runs.length,
        sourceFiles: files.length,
        liveQueries: 0,
        submissions: 0,
      })
    );
  } finally {
    task?.close();
    if (task) await task.closed;
    scope.close();
  }
}
main()
  .then(() => app.exit(0))
  .catch(() => {
    console.error('Railgun Shield POI selector qualification failed');
    app.exit(1);
  });
