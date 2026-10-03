/** One-purpose, no-network identity utility. Spending material is requested only
 * by the public-spending-key process; the separate viewing process never gets it.
 * This job offers no signing, database, scan or arbitrary digest capability.
 */
const assert = require('assert/strict'),
  path = require('path');
exports.run = async function run(inputText, { request, requestKey, signal, guardReport }) {
  const input = JSON.parse(inputText);
  assert.ok(['spending-public', 'viewing-identity'].includes(input.purpose));
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive),
    root = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  await require(path.join(root, 'utils/poseidon')).initPoseidonPromise;
  const { getPublicSpendingKey, getPublicViewingKey } = require(
    path.join(root, 'utils/keys-utils')
  );
  const bytes = await requestKey(JSON.stringify({ id: 1, method: 'key', purpose: input.purpose }));
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength === 32);
  const key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hex = (n) => n.toString(16).padStart(64, '0');
  let value;
  try {
    assert.ok(!signal.aborted);
    if (input.purpose === 'spending-public') {
      assert.equal(input.spendingPublicKey, undefined);
      value = { spendingPublicKey: getPublicSpendingKey(key).map(hex) };
    } else {
      assert.ok(Array.isArray(input.spendingPublicKey) && input.spendingPublicKey.length === 2);
      const spending = input.spendingPublicKey.map((s) => {
        assert.match(s, /^[0-9a-f]{64}$/);
        return BigInt('0x' + s);
      });
      const { ViewOnlyWallet } = require(path.join(root, 'wallet/view-only-wallet'));
      const denied = new Proxy(
        {},
        {
          get: () => {
            throw Error('No identity database or prover');
          },
        }
      );
      const wallet = new ViewOnlyWallet(
        '0'.repeat(64),
        denied,
        { privateKey: key, pubkey: await getPublicViewingKey(key) },
        spending,
        undefined,
        denied
      );
      // The shareable viewing key is secret. Only its SDK wallet identifier
      // leaves this process; neither the key nor its serialization is reported.
      value = {
        spendingPublicKey: [...input.spendingPublicKey],
        viewingPublicKey: Buffer.from(wallet.viewingPublicKey).toString('hex'),
        masterPublicKey: hex(wallet.masterPublicKey),
        walletId: ViewOnlyWallet.generateID(wallet.generateShareableViewingKey()),
        instanceId: wallet.getAddress(),
      };
    }
  } finally {
    key.fill(0);
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(await request(JSON.stringify({ id: 2, method: 'result', value, guards }))),
    { id: 2, value: null }
  );
};
