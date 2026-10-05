const assert = require('assert/strict');
const { createHash } = require('crypto');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const OFFSET = 5944700;
exports.derive = function (sourceBytes, inputCreator, historyMode) {
  assert.equal(
    createHash('sha256').update(sourceBytes).digest('hex'),
    'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41'
  );
  assert.ok(['Shield', 'Transact'].includes(inputCreator));
  assert.ok(['same-root', 'advanced-root'].includes(historyMode));
  const transact = inputCreator === 'Transact',
    advanced = historyMode === 'advanced-root';
  let source = JSON.parse(sourceBytes);
  assert.equal(source.publicVaultVector, true);
  if (transact) {
    const derived = require('./railgun-transact-staging-source').derive(source);
    source = derived.source;
    if (advanced) {
      const { Interface } = require('ethers');
      const { PRIVATE_EVENTS } = require('../../src/main/wallet/railgun-transact-receipt');
      const abi = new Interface(PRIVATE_EVENTS),
        foreign = source.foreignTransfers[0];
      assert.equal(foreign.amount, '700');
      assert.ok(!source.logs.some((log) => log.data.includes(foreign.commitment.slice(2))));
      const event = abi.encodeEventLog(abi.getEvent('Transact'), [
        0,
        3,
        [foreign.commitment],
        [foreign.ciphertext],
      ]);
      const decoded = abi.parseLog(event);
      assert.equal(decoded.args.startPosition, 3n);
      assert.equal(decoded.args.hash[0], foreign.commitment);
      for (const [key, value] of Object.entries(foreign.ciphertext))
        assert.deepEqual(
          Array.isArray(value)
            ? Array.from(decoded.args.ciphertext[0][key])
            : decoded.args.ciphertext[0][key],
          value
        );
      source.logs.push({
        ...source.logs.find((log) => log.blockNumber === 30),
        ...event,
        blockNumber: 40,
        blockHash: hex(41),
        transactionHash: hex(1040),
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
      });
    }
    derived.row.blockNumber += OFFSET;
    derived.row.timestamp += OFFSET;
    derived.row.graphID = hex(derived.row.blockNumber) + derived.row.graphID.slice(66);
    source.txidRows = [derived.row];
  }
  for (const log of source.logs) {
    log.blockNumber += OFFSET;
    log.blockHash = hex(log.blockNumber + 1000);
  }
  const anchor = { number: OFFSET + 100, hash: hex(OFFSET + 1100) };
  const initialTo = advanced ? OFFSET + (transact ? 39 : 29) : anchor.number;
  const advancedTo = OFFSET + 40;
  return { source, anchor, initialTo, advancedTo };
};
