/** Build exactly one native shield for a host-provided Railgun recipient.
 * Fresh ephemeral encryption material is generated here and never returned.
 * This job has no wallet secret, network, store or transaction-signing access.
 */
const assert = require('assert/strict'),
  path = require('path');
const { randomBytes } = require('crypto'),
  { createRequire } = require('module');
const pins = require('./railgun-shield-pins.json');
exports.run = async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input), ['archive']);
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  assert.ok(root.startsWith(archive + path.sep));
  await require(path.join(root, 'utils/poseidon')).initPoseidonPromise;
  const reply = JSON.parse(await request(JSON.stringify({ id: 1, method: 'input' })));
  assert.deepEqual(Object.keys(reply).sort(), ['id', 'value']);
  assert.equal(reply.id, 1);
  const payload = reply.value;
  assert.deepEqual(Object.keys(payload).sort(), ['amount', 'recipient']);
  assert.equal(typeof payload.recipient, 'string');
  assert.ok(payload.recipient.length <= 256);
  assert.match(payload.amount, /^[1-9][0-9]{0,16}$/);
  const amount = BigInt(payload.amount);
  assert.ok(amount <= BigInt(pins.maxQualificationAmount));
  const { decodeAddress, encodeAddress } = require(path.join(root, 'key-derivation/bech32'));
  const decoded = decodeAddress(payload.recipient);
  assert.equal(encodeAddress(decoded), payload.recipient);
  const { masterPublicKey, viewingPublicKey, chain } = decoded;
  assert.ok(chain === undefined || (chain.type === 0 && chain.id === pins.chainId));
  assert.ok(
    masterPublicKey > 0n &&
      masterPublicKey <
        21888242871839275222246405745257275088548364400416034343698204186575808495617n
  );
  assert.equal(viewingPublicKey.length, 32);
  const { ShieldNoteERC20 } = require(path.join(root, 'note/erc20/shield-note-erc20'));
  const { RelayAdaptV2Contract } = require(
    path.join(root, 'contracts/relay-adapt/V2/relay-adapt-v2')
  );
  const shieldKey = randomBytes(32),
    random = randomBytes(16);
  let tx, npk, commitment;
  const noteValue = amount - (amount * BigInt(pins.shieldFeeBps)) / 10000n;
  try {
    assert.ok(!signal.aborted);
    const shield = new ShieldNoteERC20(
      masterPublicKey,
      random.toString('hex'),
      amount,
      pins.wrappedNative
    );
    const shieldRequest = await shield.serialize(shieldKey, viewingPublicKey);
    npk = shieldRequest.preimage.npk.toLowerCase();
    commitment =
      '0x' +
      ShieldNoteERC20.getShieldNoteHash(shield.notePublicKey, shield.tokenHash, noteValue)
        .toString(16)
        .padStart(64, '0');
    tx = await new RelayAdaptV2Contract(pins.relayAdapt, undefined).populateShieldBaseToken(
      shieldRequest
    );
  } finally {
    shieldKey.fill(0);
    random.fill(0);
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  const value = {
    npk,
    commitment,
    noteValue: noteValue.toString(),
    transaction: {
      chainId: pins.chainId,
      to: tx.to.toLowerCase(),
      value: tx.value.toString(),
      data: tx.data.toLowerCase(),
    },
    guards,
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
  };
  assert.deepEqual(JSON.parse(await request(JSON.stringify({ id: 2, method: 'result', value }))), {
    id: 2,
    value: null,
  });
};
