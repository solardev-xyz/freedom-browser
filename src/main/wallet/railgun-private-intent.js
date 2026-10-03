/** Bind pre-proof calldata to the final transaction without treating structural
 * checks as proof verification. Only the eight proof coordinates may change.
 */
const assert = require('assert/strict');
const { Interface } = require('ethers');
const { TRANSACT_ABI, validateRailgunPrivateTransaction } = require('./railgun-private-policy');
const abi = new Interface([TRANSACT_ABI]);
function validateRailgunPrivateSigningIntent(transaction, expected) {
  const checked = validateRailgunPrivateTransaction(transaction, expected);
  const [[tx]] = abi.decodeFunctionData('transact', transaction.data);
  const proof = tx.proof;
  assert.ok(
    [proof.a.x, proof.a.y, ...proof.b.x, ...proof.b.y, proof.c.x, proof.c.y].every(
      (value) => value === 0n
    )
  );
  return checked;
}
function matchRailgunPrivateProvedTransaction(intent, transaction, expected) {
  validateRailgunPrivateSigningIntent(intent, expected);
  const checked = validateRailgunPrivateTransaction(transaction, expected);
  const [[tx]] = abi.decodeFunctionData('transact', transaction.data);
  const withoutProof = [
    [0n, 0n],
    [
      [0n, 0n],
      [0n, 0n],
    ],
    [0n, 0n],
  ];
  assert.equal(
    abi.encodeFunctionData('transact', [
      [
        [
          withoutProof,
          tx.merkleRoot,
          tx.nullifiers,
          tx.commitments,
          tx.boundParams,
          tx.unshieldPreimage,
        ],
      ],
    ]),
    intent.data
  );
  return checked;
}
module.exports = { validateRailgunPrivateSigningIntent, matchRailgunPrivateProvedTransaction };
