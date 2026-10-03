/** One-use enrolled viewing key verifies that the prepared shield is recoverable
 * by this recipient. No spending key, database or network capability is present.
 */
const assert = require('assert/strict'),
  path = require('path'),
  { createRequire } = require('module');
const pins = require('./railgun-shield-pins.json');
exports.run = async function run(text, { request, requestKey, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), ['archive', 'descriptor', 'prepared']);
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  assert.ok(root.startsWith(archive + path.sep));
  await require(path.join(root, 'utils/poseidon')).initPoseidonPromise;
  const { ViewOnlyWallet } = require(path.join(root, 'wallet/view-only-wallet'));
  const { ShieldNoteERC20 } = require(path.join(root, 'note/erc20/shield-note-erc20'));
  const { getSharedSymmetricKey, getPublicViewingKey } = require(
    path.join(root, 'utils/keys-utils')
  );
  const bytes = await requestKey(
    JSON.stringify({ id: 1, method: 'key', purpose: 'shield-receive' })
  );
  assert.ok(bytes instanceof Uint8Array);
  const key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let symmetric;
  try {
    assert.equal(key.length, 32);
    assert.ok(!signal.aborted);
    const { descriptor, prepared } = input;
    const pubkey = await getPublicViewingKey(key);
    assert.equal(Buffer.from(pubkey).toString('hex'), descriptor.viewingPublicKey);
    const denied = new Proxy(
      {},
      {
        get() {
          throw Error('No receiver storage or prover');
        },
      }
    );
    const wallet = new ViewOnlyWallet(
      descriptor.walletId,
      denied,
      { privateKey: key, pubkey },
      descriptor.spendingPublicKey.map((v) => BigInt('0x' + v)),
      undefined,
      denied
    );
    assert.equal(wallet.masterPublicKey.toString(16).padStart(64, '0'), descriptor.masterPublicKey);
    assert.equal(wallet.getAddress(), descriptor.instanceId);
    assert.equal(prepared.recipient, descriptor.instanceId);
    assert.equal(prepared.to, pins.relayAdapt);
    assert.equal(prepared.chainId, pins.chainId);
    const abi = new (r('ethers').Interface)(require(path.join(root, 'abi/V2/RelayAdapt.json')));
    const [required, calls] = abi.decodeFunctionData('multicall', prepared.data);
    assert.equal(required, true);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.to.toLowerCase(), pins.relayAdapt);
      assert.equal(call.value, 0n);
    }
    assert.equal(abi.decodeFunctionData('wrapBase', calls[0].data)[0], BigInt(prepared.value));
    const [requests] = abi.decodeFunctionData('shield', calls[1].data);
    assert.equal(requests.length, 1);
    const { preimage, ciphertext } = requests[0];
    assert.equal(preimage.value, BigInt(prepared.value));
    assert.ok(preimage.value > 0n);
    assert.equal(preimage.token.tokenType, 0n);
    assert.equal(preimage.token.tokenSubID, 0n);
    assert.equal(preimage.token.tokenAddress.toLowerCase(), pins.wrappedNative);
    assert.equal(preimage.npk, prepared.npk);
    symmetric = await getSharedSymmetricKey(key, Buffer.from(ciphertext.shieldKey.slice(2), 'hex'));
    assert.ok(symmetric);
    const random = ShieldNoteERC20.decryptRandom([...ciphertext.encryptedBundle], symmetric);
    const note = new ShieldNoteERC20(
      wallet.masterPublicKey,
      random,
      preimage.value,
      pins.wrappedNative
    );
    assert.equal('0x' + note.notePublicKey.toString(16).padStart(64, '0'), prepared.npk);
    const net = preimage.value - (preimage.value * BigInt(pins.shieldFeeBps)) / 10000n;
    assert.equal(net.toString(), prepared.noteValue);
    assert.equal(
      prepared.commitment,
      '0x' +
        ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, net)
          .toString(16)
          .padStart(64, '0')
    );
  } finally {
    key.fill(0);
    symmetric?.fill(0);
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 2,
          method: 'result',
          value: {
            verified: true,
            commitment: input.prepared.commitment,
            noteValue: input.prepared.noteValue,
            npk: input.prepared.npk,
            recipient: input.prepared.recipient,
            guards,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          },
        })
      )
    ),
    { id: 2, value: null }
  );
};
