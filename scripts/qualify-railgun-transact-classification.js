/** Differential classification of archived Transact notes for a public viewing vector.
 * No plaintext, token, amount, address or reconstructed key material is reported.
 */
const path = require('path'),
  fs = require('fs'),
  assert = require('assert/strict'),
  { createRequire } = require('module');
const base = path.join(__dirname, '..');
const [captureDirectory, walletReport, output] = process.argv.slice(2);
for (const value of [captureDirectory, walletReport, output]) assert.ok(path.isAbsolute(value));
assert.ok(!fs.existsSync(output));
const { createHash } = require('crypto');
const sources = [
  'scripts/qualify-railgun-transact-classification.js',
  'scripts/fixtures/railgun-wallet-snapshot-job.js',
  'scripts/railgun-fixture-integrity.js',
  'scripts/railgun-log-capture-data.js',
  'src/main/wallet/railgun-wallet-records.js',
  'src/main/wallet/railgun-process-guards.js',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashes = () =>
  Object.fromEntries(sources.map((file) => [file, hash(fs.readFileSync(path.join(base, file)))]));
const sourceSha256 = hashes();
const guards = require(
  path.join(base, 'src/main/wallet/railgun-process-guards')
).installRailgunProcessGuards({ onRefusal: () => process.exit(2) });
async function main() {
  const fixture = path.join(base, 'scripts/fixtures/railgun-engine');
  require(path.join(base, 'scripts/railgun-fixture-integrity')).assertRailgunFixture(
    path.join(fixture, 'node_modules')
  );
  const r = createRequire(path.join(fixture, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const imp = (p) => require(path.join(root, p));
  await imp('utils/poseidon').initPoseidonPromise;
  const { ViewOnlyWallet } = imp('wallet/view-only-wallet'),
    { V2Events } = imp('contracts/railgun-smart-wallet/V2/V2-events');
  const { Interface } = require('ethers'),
    abi = new Interface(
      JSON.parse(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')))
    );
  const shared = require(path.join(base, 'scripts/fixtures/railgun-wallet-snapshot-job')).shared;
  let writes = 0;
  const wallet = await ViewOnlyWallet.createWallet(
    ViewOnlyWallet.generateID(shared),
    {
      batch: async (rows) => {
        writes += rows.length;
        assert.equal(rows.length, 0);
      },
    },
    shared,
    undefined,
    {}
  );
  const reportBytes = fs.readFileSync(walletReport),
    report = JSON.parse(reportBytes);
  const selected = new Set(report.runs[0].unrecoverableSent.map((x) => `${x.tree}:${x.position}`));
  const capture = require(
    path.join(base, 'scripts/railgun-log-capture-data')
  ).readRailgunLogCapture(captureDirectory);
  assert.equal(capture.logSetSha256, report.logSetSha256);
  const leaves = [],
    tokens = [];
  for (const log of capture.logs()) {
    let parsed;
    try {
      parsed = abi.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === 'Shield') {
      const ev = V2Events.formatShieldEvent(
        parsed.args,
        log.transactionHash,
        log.blockNumber,
        parsed.args.fees,
        undefined
      );
      tokens.push(...ev.commitments.map((x) => x.preImage.token));
    }
    if (parsed.name === 'Transact') {
      const ev = V2Events.formatTransactEvent(
        parsed.args,
        log.transactionHash,
        log.blockNumber,
        undefined
      );
      for (const leaf of ev.commitments)
        if (selected.has(`${leaf.utxoTree}:${leaf.utxoIndex}`)) leaves.push(leaf);
    }
  }
  const runtime = {
    ...imp('note/note-util'),
    ...imp('note/shield-note'),
    ...imp('note/transact-note'),
    ...imp('utils/keys-utils'),
    ...imp('utils/encryption/aes'),
    ...imp('note/memo'),
    ...imp('utils/bytes'),
  };
  const { createRailgunTokenResolver } = require(
    path.join(base, 'src/main/wallet/railgun-wallet-records')
  );
  const tokenMap = new Map(tokens.map((t) => [runtime.getTokenDataHash(t), t]));
  wallet.tokenDataGetter = createRailgunTokenResolver({
    ...runtime,
    sourceTokens: [...tokenMap.values()],
  });
  const version = 'V2_PoseidonMerkle',
    chain = { type: 0, id: 11155111 },
    rows = [];
  for (const leaf of leaves) {
    let directions = [];
    const bundle = leaf.ciphertext;
    for (const sent of [false, true]) {
      const sender = Buffer.from(bundle.blindedSenderViewingKey.replace(/^0x/, ''), 'hex'),
        receiver = Buffer.from(bundle.blindedReceiverViewingKey.replace(/^0x/, ''), 'hex');
      const key = await runtime.getSharedSymmetricKey(
        wallet.viewingKeyPair.privateKey,
        sent ? receiver : sender
      );
      if (!key) {
        directions.push({ sent, key: false });
        continue;
      }
      try {
        const plain = runtime.AES.decryptGCM(
          {
            ...bundle.ciphertext,
            data: [...bundle.ciphertext.data, bundle.memo.replace(/^0x/, '')],
          },
          key
        ).map((v) => runtime.ByteUtils.hexlify(v).replace(/^0x/, ''));
        const annotation = sent
          ? runtime.Memo.decryptNoteAnnotationData(
              bundle.annotationData,
              wallet.viewingKeyPair.privateKey
            )
          : undefined;
        const mpk = sent
          ? runtime.TransactNote.getDecodedMasterPublicKey(
              wallet.masterPublicKey,
              BigInt('0x' + plain[0]),
              annotation?.senderRandom,
              false
            )
          : wallet.masterPublicKey;
        const npk = runtime.ShieldNote.getNotePublicKey(mpk, plain[2].slice(0, 32)),
          hash = runtime.TransactNote.getHash(npk, plain[1], BigInt('0x' + plain[2].slice(32)));
        const raw = await runtime.TransactNote.decrypt(
          version,
          chain,
          wallet.addressKeys,
          bundle.ciphertext,
          key,
          bundle.memo,
          bundle.annotationData,
          wallet.viewingKeyPair.privateKey,
          receiver,
          sender,
          sent,
          false,
          wallet.tokenDataGetter,
          leaf.blockNumber,
          undefined
        );
        assert.equal(raw.hash, hash);
        assert.notEqual(hash.toString(16).padStart(64, '0'), leaf.hash.replace(/^0x/, ''));
        directions.push({
          sent,
          authenticated: true,
          annotationDecoded: !!annotation,
          senderRandomPresent: annotation?.senderRandom !== undefined,
          sdkMatchesPreflight: true,
          commitmentMatches: false,
        });
      } catch (e) {
        assert.equal(e.message, 'Unable to decrypt ciphertext.');
        assert.equal(e.cause?.message, 'Unsupported state or unable to authenticate data');
        directions.push({ sent, authenticated: false });
      } finally {
        key.fill(0);
      }
    }
    const before = writes;
    await wallet.scanLeaves(version, [leaf], leaf.utxoTree, chain, leaf.utxoIndex, () => {});
    rows.push({
      tree: leaf.utxoTree,
      position: leaf.utxoIndex,
      txid: leaf.txid,
      directions,
      rawWrites: writes - before,
    });
  }
  assert.equal(rows.length, selected.size);
  assert.equal(writes, 0);
  assert.deepEqual(hashes(), sourceSha256);
  assert.equal(guards.report().attempts, 0);
  const out = {
    observedAt: new Date().toISOString(),
    sourceSha256,
    walletReportSha256: hash(reportBytes),
    logSetSha256: capture.logSetSha256,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    publicViewingVector: true,
    directEngineScan: true,
    inMemoryBatchSink: true,
    submissions: 0,
    count: rows.length,
    rawWrites: writes,
    authenticatedDirections: rows.flatMap((x) => x.directions).filter((x) => x.authenticated)
      .length,
    guards: guards.report(),
    rows,
  };
  fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      count: out.count,
      rawWrites: out.rawWrites,
      authenticatedDirections: out.authenticatedDirections,
    })
  );
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
