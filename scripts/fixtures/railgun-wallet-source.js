/** Synthetic public history for guarded wallet integration tests. No real funds. */
const guards = require('../../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
  onRefusal: () => process.exit(2),
});
const assert = require('assert/strict'),
  fs = require('fs'),
  path = require('path'),
  { createRequire } = require('module');
async function main() {
  const filename = process.argv[2],
    mode = process.argv[3];
  assert.ok(mode === undefined || mode === 'vault-public-vector');
  assert.ok(path.isAbsolute(filename));
  const fixture = path.join(__dirname, 'railgun-engine');
  require('../railgun-fixture-integrity').assertRailgunFixture(path.join(fixture, 'node_modules'));
  const r = createRequire(path.join(fixture, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { ViewOnlyWallet } = require(path.join(root, 'wallet/view-only-wallet'));
  const { ShieldNoteERC20 } = require(path.join(root, 'note/erc20/shield-note-erc20'));
  const { TransactNote } = require(path.join(root, 'note/transact-note'));
  const { getTokenDataERC20 } = require(path.join(root, 'note/note-util'));
  const { getNoteBlindingKeys, getSharedSymmetricKey } = require(
    path.join(root, 'utils/keys-utils')
  );
  let wallet;
  if (mode === 'vault-public-vector') {
    const { WalletNode } = require(path.join(root, 'key-derivation/wallet-node'));
    const seed = WalletNode.fromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    const spending = seed.derive("m/44'/1984'/0'/0'/0'").getSpendingKeyPair();
    const viewing = await seed.derive("m/420'/1984'/0'/0'/0'").getViewingKeyPair();
    wallet = new ViewOnlyWallet('0'.repeat(64), {}, viewing, spending.pubkey, undefined, {});
    spending.privateKey.fill(0);
  } else {
    const shared = require('./railgun-wallet-snapshot-job').shared;
    wallet = await ViewOnlyWallet.createWallet(
      ViewOnlyWallet.generateID(shared),
      {},
      shared,
      undefined,
      {}
    );
  }
  require(path.join(root, 'wallet/wallet-info')).default.setWalletSource('freedomfixture');
  const token = '0x' + '12'.repeat(20),
    shields = [];
  for (const [index, value] of [1000n, 2000n].entries()) {
    const note = new ShieldNoteERC20(
      wallet.masterPublicKey,
      (index ? '22' : '11').repeat(16),
      value,
      token
    );
    shields.push(
      await note.serialize(Uint8Array.from(Buffer.alloc(32, index + 1)), wallet.viewingPublicKey)
    );
  }
  const { Interface } = require('ethers'),
    abi = new Interface(
      JSON.parse(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')))
    );
  const hash = (number) => '0x' + number.toString(16).padStart(64, '0');
  const event = (number, name, args) => ({
    ...abi.encodeEventLog(abi.getEvent(name), args),
    address: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
    blockNumber: number,
    blockHash: hash(number + 1),
    transactionHash: hash(number + 1000),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  });
  const logs = [
    event(10, 'Shield', [
      0,
      0,
      shields.map((v) => v.preimage),
      shields.map((v) => v.ciphertext),
      [0, 0],
    ]),
  ];
  logs.push(
    event(20, 'Nullified', [0, [hash(TransactNote.getNullifier(wallet.nullifyingKey, 0))]])
  );
  const note = TransactNote.createTransfer(
    wallet.addressKeys,
    wallet.addressKeys,
    700n,
    getTokenDataERC20(token),
    true,
    0,
    'public fixture'
  );
  const blind = getNoteBlindingKeys(
    wallet.viewingPublicKey,
    wallet.viewingPublicKey,
    note.random,
    note.senderRandom
  );
  const key = await getSharedSymmetricKey(
    wallet.viewingKeyPair.privateKey,
    blind.blindedReceiverViewingKey
  );
  const encrypted = note.encryptV2(
    'V2_PoseidonMerkle',
    key,
    wallet.masterPublicKey,
    note.senderRandom,
    wallet.viewingKeyPair.privateKey
  );
  key.fill(0);
  logs.push(
    event(30, 'Transact', [
      0,
      2,
      [hash(note.hash)],
      [
        {
          ciphertext: [
            '0x' + encrypted.noteCiphertext.iv + encrypted.noteCiphertext.tag,
            ...encrypted.noteCiphertext.data.map((v) => '0x' + v),
          ],
          blindedSenderViewingKey:
            '0x' + Buffer.from(blind.blindedSenderViewingKey).toString('hex'),
          blindedReceiverViewingKey:
            '0x' + Buffer.from(blind.blindedReceiverViewingKey).toString('hex'),
          annotationData: '0x' + encrypted.annotationData.replace(/^0x/, ''),
          memo: '0x' + encrypted.noteMemo.replace(/^0x/, ''),
        },
      ],
    ])
  );
  assert.equal(guards.report().attempts, 0);
  fs.writeFileSync(
    filename,
    JSON.stringify({
      logs,
      guards: guards.report(),
      ...(mode
        ? {
            publicVaultVector: true,
            walletId: ViewOnlyWallet.generateID(wallet.generateShareableViewingKey()),
            instanceId: wallet.getAddress(),
          }
        : {}),
    }),
    {
      flag: 'wx',
      mode: 0o600,
    }
  );
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
