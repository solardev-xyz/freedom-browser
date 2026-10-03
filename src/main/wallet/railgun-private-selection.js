/** Main-only, snapshot-bound input selection. A prepared result proves only
 * that public transaction intent names this recovered input. It never grants
 * signing, reservation, POI, proof or recipient-recovery authority.
 */
const { readRailgunAccountOwnedNotes } = require('./railgun-account-wallet');
const { validateRailgunPrivateTransaction } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const selections = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun private input unavailable'), {
    code: 'RAILGUN_PRIVATE_INPUT_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
function openRailgunPrivateSelection({ wallet, identity, enrollment, coordinator, noteId }) {
  const owners = { identity, enrollment, coordinator };
  const baseline = readRailgunAccountOwnedNotes(wallet, owners);
  const checkpointHash = baseline.checkpointHash;
  check(typeof noteId === 'string');
  const note = baseline.read.received.find((item) => item.id === noteId);
  const record = baseline.ownedPoi.find((item) => item.id === noteId);
  const tree = baseline.trees?.find((item) => item.tree === note?.tree);
  check(note && record && tree);
  check(['Shield', 'Transact'].includes(record.type));
  check(
    note.spentTxid === false &&
      note.amount > 0n &&
      note.amount <= BigInt(pins.maxQualificationAmount) &&
      note.asset.__type === 'erc20' &&
      note.asset.contract === pins.wrappedNative &&
      note.position < tree.length &&
      record.hash === note.hash &&
      record.txid === note.txid
  );
  const controller = new AbortController();
  const signal = AbortSignal.any([
    wallet.signal,
    identity.signal,
    enrollment.signal,
    controller.signal,
  ]);
  const current = () => {
    check(!signal.aborted);
    const value = readRailgunAccountOwnedNotes(wallet, owners);
    check(value.checkpointHash === checkpointHash);
    check(
      value.read.received.includes(note) &&
        value.ownedPoi.includes(record) &&
        value.trees.includes(tree)
    );
    check(note.spentTxid === false && note.amount > 0n);
  };
  current();
  const receipts = new WeakMap();
  function prepare(transaction, expected) {
    current();
    const checked = validateRailgunPrivateTransaction(transaction, expected);
    check(checked.tree === note.tree && checked.nullifier === record.nullifier);
    check(checked.merkleRoot === '0x' + tree.root.replace(/^0x/, ''));
    if (checked.kind === 'railgun-token-unshield') check(BigInt(checked.amount) === note.amount);
    // For a private transfer, conservation and receiver recovery are private
    // witness checks. They are not inferred from the commitment alone.
    const value = Object.freeze({
      transaction: checked,
      publicCheckpointHash: checkpointHash,
      ownedInputAtSnapshot: true,
      inputType: record.type,
      creatingTxidRequired: record.type === 'Transact',
      creatingTxidVerified: false,
      inputValueVerified: checked.kind === 'railgun-token-unshield',
      reservationsChecked: false,
      poiVerified: false,
      spendingEnabled: false,
    });
    const receipt = Object.freeze({});
    receipts.set(receipt, value);
    return Object.freeze({ receipt, observation: value });
  }
  function assertResult(receipt) {
    current();
    const value = receipts.get(receipt);
    check(value);
    return value;
  }
  const selection = Object.freeze({
    prepare,
    assertResult,
    signal,
    close: () => controller.abort(),
  });
  selections.set(selection, { wallet, owners });
  return selection;
}
function assertRailgunPrivateSelection(selection, receipt, wallet, owners) {
  const entry = selections.get(selection);
  check(
    entry &&
      entry.wallet === wallet &&
      entry.owners.identity === owners.identity &&
      entry.owners.enrollment === owners.enrollment &&
      entry.owners.coordinator === owners.coordinator
  );
  return selection.assertResult(receipt);
}
module.exports = { openRailgunPrivateSelection, assertRailgunPrivateSelection };
