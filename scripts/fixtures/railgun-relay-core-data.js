/** Fixed PUBLIC disposable keys and synthetic note adapters. No enrolled owner,
 * storage restoration, spending key, service signer or prover capability. */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const {
  normalizeRailgunRelayDraftCapsule,
} = require('../../src/main/wallet/railgun-relay-capsule');
const {
  normalizeRailgunRelayPoiHistory,
} = require('../../src/main/wallet/railgun-relay-poi-history');
const {
  normalizeRailgunRelayPrePoiBinding,
} = require('../../src/main/wallet/railgun-relay-pre-poi-data');
const { REQUIRED_LIST } = require('../../src/main/wallet/railgun-poi-records');
const hex = (v) => BigInt(v).toString(16).padStart(64, '0');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const copy = (v) => JSON.parse(JSON.stringify(v));
const SPENDING_PUBLIC = Object.freeze([
  14422859473778768188622151430526693594403470008420308922992775064941455773685n,
  7592518773672929099542717438998516546396504563265155469693554058278098107299n,
]);
function rootFor(leaf, elements, index, poseidon) {
  let value = BigInt(leaf);
  for (let level = 0; level < elements.length; level++) {
    const sibling = BigInt('0x' + elements[level]);
    value = poseidon(
      (BigInt(index) & (1n << BigInt(level))) === 0n ? [value, sibling] : [sibling, value]
    );
  }
  return hex(value);
}
function treePair(first, second, zeros, poseidon) {
  assert.equal(zeros.length, 16);
  const originalElements = [...zeros];
  const grownElements = [hex(second), ...zeros.slice(1)];
  const original = {
    leaf: hex(first),
    elements: originalElements,
    indices: hex(0),
    root: rootFor(first, originalElements, 0, poseidon),
  };
  const grown = {
    leaf: hex(first),
    elements: grownElements,
    indices: hex(0),
    root: rootFor(first, grownElements, 0, poseidon),
  };
  assert.notEqual(first, second);
  assert.notEqual(original.root, grown.root);
  // Check the appended note against the same actual two-leaf root.
  assert.equal(rootFor(second, [hex(first), ...zeros.slice(1)], 1, poseidon), grown.root);
  return { original, grown };
}
function capturedHistory(draftText) {
  const draft = normalizeRailgunRelayDraftCapsule(JSON.parse(draftText));
  assert.equal(JSON.stringify(draft.data), draftText);
  const report = require('../../docs/qualification/railgun-poi-read-2026-10-03.json');
  const events = require('./railgun-poi-signed-event.json');
  const vector = require('./railgun-owned-poi-public-vector.json');
  assert.deepEqual(report.serviceObservation.proofs, report.membership.proofs);
  assert.deepEqual(report.serviceObservation.events, report.membership.events);
  assert.deepEqual(report.serviceObservation.events[0].signedPOIEvent, events[0].signedPOIEvent);
  assert.equal(report.serviceObservation.proofs.length, 1);
  assert.equal(report.serviceObservation.events.length, 1);
  const proof = copy(report.serviceObservation.proofs[0]);
  assert.equal('0x' + proof.leaf, vector.blindedCommitment);
  return normalizeRailgunRelayPoiHistory({
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest: draft.digest,
    listKey: REQUIRED_LIST,
    note: { blindedCommitment: vector.blindedCommitment, type: 'Shield' },
    proof,
    event: copy(report.serviceObservation.events[0]),
  }).data;
}
async function createVector(archive, signal) {
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  archive = require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
    archive
  );
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  const { poseidon, initPoseidonPromise } = imp('utils/poseidon');
  await initPoseidonPromise;
  active();
  const viewingKey = Buffer.alloc(32, 8),
    peerKey = Buffer.alloc(32, 10);
  const close = () => {
    viewingKey.fill(0);
    peerKey.fill(0);
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    const { getPublicViewingKey } = imp('utils/keys-utils');
    const viewingPublicKey = await getPublicViewingKey(viewingKey);
    active();
    const peerPublicKey = await getPublicViewingKey(peerKey);
    active();
    const peerNullifyingKey = poseidon([BigInt('0x' + peerKey.toString('hex'))]);
    peerKey.fill(0);
    const { ViewOnlyWallet } = imp('wallet/view-only-wallet');
    const denied = new Proxy(
      {},
      {
        get() {
          throw Error('No fixture storage or prover');
        },
      }
    );
    const pair = { privateKey: viewingKey, pubkey: viewingPublicKey };
    const provisional = new ViewOnlyWallet(
      '11'.repeat(32),
      denied,
      pair,
      [...SPENDING_PUBLIC],
      undefined,
      denied
    );
    const id = ViewOnlyWallet.generateID(provisional.generateShareableViewingKey());
    const wallet = new ViewOnlyWallet(id, denied, pair, [...SPENDING_PUBLIC], undefined, denied);
    const self = wallet.addressKeys;
    assert.equal(wallet.getNullifyingKey(), poseidon([BigInt('0x' + viewingKey.toString('hex'))]));
    const peer = {
      masterPublicKey: imp('key-derivation/wallet-node').WalletNode.getMasterPublicKey(
        [...SPENDING_PUBLIC],
        peerNullifyingKey
      ),
      viewingPublicKey: peerPublicKey,
      chain: { type: 0, id: pins.chainId },
    };
    const { encodeAddress } = imp('key-derivation/bech32');
    const peerAddress = encodeAddress(peer);
    const { TransactNote } = imp('note/transact-note');
    const token = imp('note/note-util').getTokenDataERC20(pins.wrappedNative);
    imp('wallet/wallet-info').default.setWalletSource('freedomfixture');
    // Shield scans materialize a TransactNote carrying the shield plaintext.
    const note = new TransactNote(
      self,
      undefined,
      '01'.repeat(16),
      1000n,
      token,
      undefined,
      undefined,
      undefined,
      undefined
    );
    const added = new TransactNote(
      self,
      undefined,
      '06'.repeat(16),
      500n,
      token,
      undefined,
      undefined,
      undefined,
      undefined
    );
    const roots = treePair(
      note.hash,
      added.hash,
      require('../../src/main/wallet/railgun-public-records').ZERO_NODES.slice(0, 16),
      poseidon
    );
    const { verifyMerkleProof } = imp('merkletree/merkle-proof');
    assert.equal(verifyMerkleProof(roots.original), true);
    assert.equal(verifyMerkleProof(roots.grown), true);
    const { BlindedCommitment } = imp('poi/blinded-commitment');
    const { getGlobalTreePosition } = imp('poi/global-tree-position');
    const nullifier = '0x' + hex(TransactNote.getNullifier(wallet.getNullifyingKey(), 0));
    const blind = BlindedCommitment.getForShieldOrTransact(
      '0x' + hex(note.hash),
      note.notePublicKey,
      getGlobalTreePosition(0, 0)
    );
    const txo = {
      tree: 0,
      position: 0,
      commitmentType: 'ShieldCommitment',
      spendtxid: false,
      note,
      nullifier,
      blindedCommitment: blind,
    };
    const leaf = {
      utxoTree: 0,
      utxoIndex: 0,
      commitmentType: 'ShieldCommitment',
      hash: '0x' + hex(note.hash),
      preImage: { npk: '0x' + hex(note.notePublicKey) },
      txid: hex(1),
      blockNumber: 5944700,
    };
    const owned =
      require('../../src/main/wallet/railgun-owned-poi-records').projectRailgunOwnedPoiRecord(
        txo,
        leaf,
        { TransactNote, BlindedCommitment, getGlobalTreePosition },
        nullifier
      );
    // Explicit fixture adapters: this is NOT a restored database or scan receipt.
    wallet.TXOs = async (version, chain) => {
      assert.equal(version, 'V2_PoseidonMerkle');
      assert.deepEqual(chain, { type: 0, id: pins.chainId });
      return [txo];
    };
    wallet.getSpendingKeyPair = () => {
      throw Error('No spending credential');
    };
    wallet.tokenDataGetter = {
      getTokenDataFromHash: async (version, chain, hash) => {
        assert.equal(version, 'V2_PoseidonMerkle');
        assert.deepEqual(chain, { type: 0, id: pins.chainId });
        assert.equal(hash.replace(/^0x/, ''), note.tokenHash);
        return token;
      },
    };
    const descriptor = {
      walletId: id,
      instanceId: wallet.getAddress(),
      spendingPublicKey: SPENDING_PUBLIC.map(hex),
    };
    const scan = {
      instanceId: descriptor.instanceId,
      received: [{ tree: 0, position: 0, spentTxid: false, hash: hex(note.hash), value: '1000' }],
      ownedPoi: [owned],
    };
    const checkpoint = {
      state: { trees: [{ tree: 0, length: 1, root: '0x' + roots.original.root }] },
    };
    const tree = {
      getMerkleProof: async (number, position) => {
        assert.equal(number, 0);
        assert.equal(position, 0);
        return copy(roots.original);
      },
    };
    const fields = {
      fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
      feeExpiration: 1,
      feesID: 'public-core-vector',
      railgunAddress: peerAddress,
      availableWallets: 1,
      version: '8.0.0',
      relayAdapt: pins.relayAdapt,
      requiredPOIListKeys: [],
      reliability: -1,
    };
    const context = {
      walletId: id,
      self: {
        address: descriptor.instanceId,
        masterPublicKey: self.masterPublicKey.toString(),
        viewingPublicKey: Buffer.from(viewingPublicKey).toString('hex'),
      },
      peer: {
        address: peerAddress,
        masterPublicKey: peer.masterPublicKey.toString(),
        viewingPublicKey: Buffer.from(peerPublicKey).toString('hex'),
      },
      quote: {
        data: Buffer.from(JSON.stringify(fields)).toString('hex'),
        signature: '00'.repeat(64),
      },
      gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
      inputAmount: '1000',
      feeAmount: '100',
      selfAmount: '900',
      feeCap: '100',
    };
    return {
      args: { archive, wallet, tree, descriptor, checkpoint, scan, signal },
      request: { selection: { tree: 0, position: 0 }, context },
      note,
      roots,
      imp,
      active,
      close() {
        signal.removeEventListener('abort', close);
        close();
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', close);
    close();
    throw error;
  }
}
function bindingFor(draftText, history, core, imp) {
  const draft = normalizeRailgunRelayDraftCapsule(JSON.parse(draftText));
  const pub = core.witness.publicInputs;
  const { getRailgunTransactionIDFromBigInts, getRailgunTxidLeafHash } = imp(
    'transaction/railgun-txid'
  );
  const { BlindedCommitment } = imp('poi/blinded-commitment');
  const start = imp('poi/global-tree-position').getGlobalTreePositionPreTransactionPOIProof();
  assert.equal(start, 199999n * 65536n + 199999n);
  const txid = getRailgunTransactionIDFromBigInts(
    pub.nullifiers,
    pub.commitmentsOut,
    pub.boundParamsHash
  );
  const leaf = getRailgunTxidLeafHash(txid, BigInt(draft.data.selection.tree), start);
  const proof = imp('merkletree/merkle-proof').createDummyMerkleProof(leaf);
  const blinds = pub.commitmentsOut.map((commitment, index) =>
    BlindedCommitment.getForShieldOrTransact(
      '0x' + hex(commitment),
      core.prePoi.npksOut[index],
      start + BigInt(index)
    )
  );
  return normalizeRailgunRelayPrePoiBinding({
    schema: 'railgun-relay-pre-poi-binding-v1',
    draftDigest: draft.digest,
    chainId: pins.chainId,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    listWitness: history.proof,
    txidLeafHash: leaf,
    txidMerkleroot: proof.root,
    blindedCommitmentsOut: blinds,
  });
}
module.exports = {
  hex,
  sha,
  copy,
  SPENDING_PUBLIC,
  rootFor,
  treePair,
  capturedHistory,
  createVector,
  bindingFor,
};
