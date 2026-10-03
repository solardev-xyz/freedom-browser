/** Vault-bound viewing-only scan. No spending credential, direct RPC or POI capability. */
const assert = require('assert/strict'),
  path = require('path'),
  { createRequire } = require('module');
async function withWallet(
  inputText,
  { request, requestKey, signal, guardReport },
  purpose,
  prepare
) {
  const input = JSON.parse(inputText),
    archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive),
    r = createRequire(path.join(archive, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine')),
    inventory = require('./railgun-engine-manifest.json').inventory;
  const { initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  let sequence = 1,
    poiCalls = 0;
  const remote = (channel) =>
    require('./railgun-remote').createRailgunRemote({
      ...r('abstract-leveldown'),
      signal,
      send: async (wire) => {
        const id = ++sequence;
        const reply = JSON.parse(await request(JSON.stringify({ id, channel, wire })));
        assert.equal(reply.id, id);
        return reply.value;
      },
    });
  const publicRemote = remote('public'),
    walletRemote = remote('wallet');
  const { Database } = require(path.join(root, 'database/database'));
  const { ViewOnlyWallet } = require(path.join(root, 'wallet/view-only-wallet'));
  const { UTXOMerkletree } = require(path.join(root, 'merkletree/utxo-merkletree'));
  const { POI } = require(path.join(root, 'poi/poi'));
  POI.init(
    [{ key: 'public-fixture-list', type: 'Active', name: 'Fixture', description: 'Offline test' }],
    new Proxy(
      {},
      {
        get: () => async () => {
          poiCalls++;
          throw Error('No POI capability');
        },
      }
    )
  );
  require(path.join(root, 'wallet/wallet-info')).default.setWalletSource('freedomfixture');
  const publicDb = new Database(publicRemote.leveldown),
    walletDb = new Database(walletRemote.leveldown);
  const descriptor = input.descriptor;
  assert.equal(input.walletId, descriptor.walletId);
  const keyBytes = await requestKey(JSON.stringify({ id: 1, method: 'key', purpose }));
  assert.ok(keyBytes instanceof Uint8Array && keyBytes.byteLength === 32);
  const viewingKey = Buffer.from(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength);
  try {
    const { getPublicViewingKey } = require(path.join(root, 'utils/keys-utils'));
    const spending = descriptor.spendingPublicKey.map((v) => BigInt('0x' + v));
    const wallet = new ViewOnlyWallet(
      descriptor.walletId,
      walletDb,
      { privateKey: viewingKey, pubkey: await getPublicViewingKey(viewingKey) },
      spending,
      undefined,
      new Proxy(
        {},
        {
          get: () => () => {
            throw Error('No prover');
          },
        }
      )
    );
    assert.equal(
      ViewOnlyWallet.generateID(wallet.generateShareableViewingKey()),
      descriptor.walletId
    );
    assert.equal(wallet.getAddress(), descriptor.instanceId);
    const tree = await UTXOMerkletree.create(
      publicDb,
      { type: 0, id: 11155111 },
      'V2_PoseidonMerkle',
      async () => {
        throw Error('No public tree mutation');
      }
    );
    const chain = { type: 0, id: 11155111 };
    assert.deepEqual(input.prefixes, {
      public: [Database.pathToKey(tree.getMerkletreeDBPrefix())],
      wallet: [
        Database.pathToKey(wallet.getWalletDBPrefix(chain)),
        Database.pathToKey(wallet.getWalletSentCommitmentDBPrefix(chain)),
      ],
    });
    const runtime = {
      ...require(path.join(root, 'note/note-util')),
      ...require(path.join(root, 'note/shield-note')),
      ...require(path.join(root, 'note/transact-note')),
      ...require(path.join(root, 'utils/keys-utils')),
      ...require(path.join(root, 'utils/encryption/aes')),
      ...require(path.join(root, 'note/memo')),
      ...require(path.join(root, 'utils/bytes')),
      ...require(path.join(root, 'poi/blinded-commitment')),
      ...require(path.join(root, 'poi/global-tree-position')),
    };
    const result = await require('./railgun-wallet-scan').scanRailgunWallet({
      wallet,
      tree,
      checkpoint: input.checkpoint,
      runtime,
      signal,
      restore: input.restore,
    });
    const extra = prepare
      ? await prepare({
          archive,
          wallet,
          tree,
          descriptor,
          checkpoint: input.checkpoint,
          scan: result,
          signal,
          async exchangePrivateIntent(value) {
            assert.equal(purpose, 'private-operate');
            assert.ok(!signal.aborted);
            const id = ++sequence;
            const response = JSON.parse(
              await request(JSON.stringify({ id, method: 'private-intent', value }))
            );
            assert.ok(!signal.aborted);
            assert.deepEqual(Object.keys(response).sort(), ['id', 'value']);
            assert.equal(response.id, id);
            return response.value;
          },
        })
      : {};
    assert.equal(poiCalls, 0);
    assert.equal(guardReport().attempts, 0);
    const messageId = ++sequence;
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: messageId,
            method: 'result',
            value: {
              ...result,
              ...extra,
              inventory: inventory.sha256,
              guards: guardReport(),
              poiCalls,
              electron: process.versions.electron,
            },
          })
        )
      ),
      { id: messageId, value: null }
    );
  } finally {
    viewingKey.fill(0);
    publicRemote.close();
    walletRemote.close();
  }
}
const run = (inputText, context) => withWallet(inputText, context, 'wallet-viewing');
module.exports = { run, withWallet };
