/** Fixed C middle process: original-signature recovery only. No submission,
 * alternate proof slot, new signature, list/TXID lookup, or acceptance issuer. */
const { assert } = require('./railgun-native-assertions');
const sticky = require('./railgun-native-assertions');
const data = require('./railgun-combined-poi-restart-data');
const handoff = require('./railgun-combined-poi-second-handoff');
const signed = require('./railgun-combined-poi-second-recovery-data');
const counts = require('./railgun-combined-poi-second-cold-counts');
const wallet = '../../src/main/wallet/';
async function run(h) {
  if (h.recoveryCompanion) return require('./railgun-recovery-companion-native').recover(h, run);
  const {
    enrollment,
    identity,
    publicAccount,
    archive,
    proverArchive,
    artifactDirectory,
    signal,
    pair,
    sealed,
    store,
    chain,
  } = h;
  assert.equal(signal.aborted, false);
  const records = await h.journal().list();
  assert.equal(records.length, 1);
  assert.deepEqual(signed.signedHashes(pair.first, pair.second, records[0]), sealed.records);
  const retained = await store.get(h.wire.retained.capsuleDigest),
    inspect = await store.inspect();
  const beforeFiles = h.profileSnapshot();
  h.recoveryStorage.arm(pair.second);
  const options = {
    identity,
    enrollment,
    coordinator: publicAccount.coordinator,
    destination: require(wallet + 'railgun-account-public').getRailgunAccountPublicDestination(
      publicAccount.coordinator,
      enrollment
    ),
    archive,
    proverArchive,
    artifactDirectory,
    signal,
    holdId: pair.second.entry.id,
    timeoutMs: 360000,
  };
  h.phase('second-proof-recovery');
  const before = h.activity();
  const result = await (h.resumeProof
    ? h.resumeProof(options.holdId)
    : require(wallet + 'railgun-private-proof-recovery').resumeRailgunAccountPrivateProof(options));
  sticky.assertEmpty();
  assert.equal(signal.aborted, false);
  assert.equal(result.status, 'proof-stored');
  assert.equal(result.holdId, pair.second.entry.id);
  assert.equal(result.submissionEnabled, false);
  assert.match(result.transactionDigest, /^0x[a-f0-9]{64}$/);
  const after = h.activity();
  const jobs = {
    'railgun-public-job.js': 2,
    'railgun-wallet-job.js': 1,
    'railgun-private-recover-job.js': 1,
    'railgun-private-verify-job.js': 1,
  };
  counts.jobs(
    before,
    after,
    jobs,
    { 'railgun-wallet-job.js': 1, 'railgun-private-recover-job.js': 1 },
    1
  );
  assert.deepEqual(counts.delta(after.audit.modes, before.audit.modes), {});
  const proxy = require(wallet + 'railgun-shield-pins.json').proxy;
  const headers = require('./railgun-combined-poi-restart-counts').expectedHeaders(
    h.wire.checkpoint,
    [...h.source.logs, ...h.wire.receipt.logs.filter((v) => v.address.toLowerCase() === proxy)]
  );
  const methods = {
    ...(h.recoveryTransportAlreadyOpen ? {} : { 'private-account:protocol-rpc:eth_chainId': 1 }),
    'private-account:protocol-rpc:eth_getBlockByNumber': headers * 2,
    'private-account:protocol-rpc:eth_getLogs': 2,
  };
  assert.deepEqual(counts.delta(after.roleMethods, before.roleMethods), methods);
  for (const k of ['attempted', 'validated'])
    assert.deepEqual(counts.delta(after.chain[k], before.chain[k]), methods);
  // Cold bootstrap has not sent RPC. The first completed-wallet read lazily
  // creates the shared transport; its source stays open until outer cleanup.
  assert.equal(before.services.transportCreates, h.recoveryTransportAlreadyOpen ? 1 : 0);
  assert.deepEqual(after.services, { ...before.services, transportCreates: 1 });
  assert.deepEqual(after.eoa, before.eoa);
  h.recoveryStorage.assertComplete();
  const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
  let updated;
  await reservations.withSigningRecovery(async (values, context) => {
    context.assertCurrent();
    assert.equal(values.length, 2);
    for (const name of ['first', 'second']) {
      const matches = values.filter((v) => v.entry.id === pair[name].entry.id);
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0].entry, pair[name].entry);
      const stored = await capsules.readSigned(matches[0].receipt);
      context.assertCurrent();
      if (name === 'first') assert.deepEqual(stored, pair.first.stored);
      else {
        assert.ok(stored.provedTransaction);
        assert.deepEqual(stored, {
          ...pair.second.stored,
          provedTransaction: stored.provedTransaction,
        });
        const matched = require(
          wallet + 'railgun-private-intent'
        ).matchRailgunPrivateProvedTransaction(
          stored.capsule.preparation.transaction,
          stored.provedTransaction,
          stored.capsule.preparation.expected
        );
        assert.equal(matched.digest, result.transactionDigest);
        updated = { entry: matches[0].entry, stored };
      }
    }
  });
  assert.deepEqual(await h.journal().list(), records);
  assert.deepEqual(await store.get(h.wire.retained.capsuleDigest), retained);
  assert.deepEqual(await store.inspect(), inspect);
  const afterFiles = h.profileSnapshot();
  const mutable = h.recoveryStorage.report().files.map((f) => f.replace(/^profile\//, ''));
  const expected = JSON.parse(JSON.stringify(beforeFiles));
  for (const file of mutable) {
    assert.ok(file.startsWith('wallet-railgun-accounts/'));
    const relative = file.slice('wallet-railgun-accounts/'.length);
    assert.ok(Object.hasOwn(expected.accounts, relative));
    assert.notEqual(afterFiles.accounts[relative], expected.accounts[relative]);
    expected.accounts[relative] = afterFiles.accounts[relative];
  }
  assert.deepEqual(afterFiles, expected);
  h.phase('second-proof-present');
  const duplicateBefore = h.activity(),
    storageBefore = h.recoveryStorage.report();
  const duplicate = await (h.resumeProof
    ? h.resumeProof(options.holdId)
    : require(wallet + 'railgun-private-proof-recovery').resumeRailgunAccountPrivateProof(options));
  assert.deepEqual(duplicate, { ...result, status: 'proof-present' });
  assert.deepEqual(h.activity(), duplicateBefore);
  assert.deepEqual(h.recoveryStorage.report(), storageBefore);
  assert.deepEqual(h.profileSnapshot(), afterFiles);
  assert.equal(chain.report().posts, 0);
  assert.equal(h.pendingChildren(), 0);
  assert.equal(h.unwipedLoans(), 0);
  sticky.assertEmpty();
  return {
    report: {
      originalSecondSignatureReused: true,
      originalProofSlotFilled: true,
      proofPresentRetryWithoutWork: true,
      secondSignedUnfinishedRecoveryQualified: false,
      secondColdSubmitQualified: false,
      firstRecordRefreshReads: 0,
      jobs,
      methods,
      storageWrites: h.recoveryStorage.report(),
      liveEligibilityOrSubmissionQualified: false,
    },
    sealed: {
      records: handoff.pairHashes(pair.first, updated, records[0]),
      retained: {
        entrySha256: data.digest(retained),
        inspectSha256: data.digest(inspect),
      },
    },
  };
}
module.exports = { run };
