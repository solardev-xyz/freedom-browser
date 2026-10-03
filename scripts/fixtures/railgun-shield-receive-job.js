/** Decrypt a constructed shield with the existing public viewing-key vector.
 * No account data or live funds. Never emit the note random or viewing key.
 */
const assert = require('assert/strict'),
  path = require('path'),
  { createRequire } = require('module');
exports.run = async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  await require(path.join(root, 'utils/poseidon')).initPoseidonPromise;
  const { ViewOnlyWallet } = require(path.join(root, 'wallet/view-only-wallet'));
  const { ShieldNoteERC20 } = require(path.join(root, 'note/erc20/shield-note-erc20'));
  const { getSharedSymmetricKey } = require(path.join(root, 'utils/keys-utils'));
  const { shared } = require('./railgun-wallet-snapshot-job');
  const wallet = await ViewOnlyWallet.createWallet(
    ViewOnlyWallet.generateID(shared),
    {},
    shared,
    undefined,
    {}
  );
  const { viewingPrivateKey } = ViewOnlyWallet.getKeysFromShareableViewingKey(shared);
  const reply = JSON.parse(await request(JSON.stringify({ id: 1, method: 'input' })));
  assert.equal(reply.id, 1);
  const payload = reply.value;
  assert.equal(payload.recipient, wallet.getAddress());
  const abi = new (r('ethers').Interface)(require(path.join(root, 'abi/V2/RelayAdapt.json')));
  const [, calls] = abi.decodeFunctionData('multicall', payload.transaction.data);
  const [[shield]] = abi.decodeFunctionData('shield', calls[1].data);
  const key = Buffer.from(viewingPrivateKey, 'hex');
  let wrongKeyRefused = false;
  try {
    const shieldKey = Buffer.from(shield.ciphertext.shieldKey.slice(2), 'hex');
    const symmetric = await getSharedSymmetricKey(key, shieldKey);
    const random = ShieldNoteERC20.decryptRandom([...shield.ciphertext.encryptedBundle], symmetric);
    const note = new ShieldNoteERC20(
      wallet.masterPublicKey,
      random,
      shield.preimage.value,
      shield.preimage.token.tokenAddress
    );
    assert.equal('0x' + note.notePublicKey.toString(16).padStart(64, '0'), shield.preimage.npk);
    const net = shield.preimage.value - (shield.preimage.value * 25n) / 10000n;
    assert.equal(payload.noteValue, net.toString());
    assert.equal(
      payload.commitment,
      '0x' +
        ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, net)
          .toString(16)
          .padStart(64, '0')
    );
    symmetric.fill(0);
    const wrong = await getSharedSymmetricKey(Buffer.alloc(32, 1), shieldKey);
    try {
      ShieldNoteERC20.decryptRandom([...shield.ciphertext.encryptedBundle], wrong);
    } catch {
      wrongKeyRefused = true;
    }
    wrong.fill(0);
    assert.equal(wrongKeyRefused, true);
  } finally {
    key.fill(0);
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  const value = { matched: true, wrongKeyRefused, guards };
  assert.deepEqual(JSON.parse(await request(JSON.stringify({ id: 2, method: 'result', value }))), {
    id: 2,
    value: null,
  });
};
