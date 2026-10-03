/** Public-vector wallet scan with independent public and derived remote stores. */
const assert = require('assert/strict'),
  path = require('path'),
  { createRequire } = require('module');
const shared =
  '82a57670726976d94034326232623861643234306331323630396633623265363865656137613636373330306437373332633335346238373338343266373433313135313836303066a473707562d94061316166356531353935616330303736303734646465653034323737356230363365366434653666313966613632633333323935636336643363646635313165';
async function run(inputText, { request, signal, guardReport }) {
  const input = JSON.parse(inputText),
    fixture = path.join(__dirname, 'railgun-engine');
  const inventory = require('../railgun-fixture-integrity').assertRailgunFixture(
    path.join(fixture, 'node_modules')
  );
  const r = createRequire(path.join(fixture, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  let sequence = 0,
    poiCalls = 0;
  const remote = (channel) =>
    require('../../src/main/wallet/railgun-remote').createRailgunRemote({
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
  // createWallet constructs from the public vector without persisting viewing material.
  const id = ViewOnlyWallet.generateID(shared);
  assert.equal(id, input.walletId);
  const wallet = await ViewOnlyWallet.createWallet(
    id,
    walletDb,
    shared,
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
  const result = await require('../../src/main/wallet/railgun-wallet-scan').scanRailgunWallet({
    wallet,
    tree,
    checkpoint: input.checkpoint,
    runtime,
    signal,
    restore: input.restore,
  });
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
  publicRemote.close();
  walletRemote.close();
}
module.exports = { run, shared };
