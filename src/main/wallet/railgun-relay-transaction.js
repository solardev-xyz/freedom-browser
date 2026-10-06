/** Bind a relay proof result to the original unsigned calldata. Only its eight
 * proof coordinates may change. This is structural equality, not cryptographic
 * verification, current quote validity, signing authority or permission to send.
 */
const assert = require('assert/strict');
const { Interface } = require('ethers');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const abi = new Interface([TRANSACT_ABI]);
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
function matchRailgunRelayProvedTransaction(input, transaction) {
  try {
    const intent = normalizeRailgunRelayUnsignedIntent(input);
    shape(transaction, ['chainId', 'to', 'value', 'data']);
    const original = intent.data.transaction;
    for (const key of ['chainId', 'to', 'value']) assert.equal(transaction[key], original[key]);
    assert.equal(typeof transaction.data, 'string');
    assert.ok(/^0x(?:[0-9a-f]{2})+$/.test(transaction.data));
    assert.equal(transaction.data.length, original.data.length);
    const [transactions] = abi.decodeFunctionData('transact', transaction.data);
    assert.equal(transactions.length, 1);
    assert.equal(abi.encodeFunctionData('transact', [transactions]), transaction.data);
    const tx = transactions[0],
      proof = tx.proof;
    for (const coordinate of [
      proof.a.x,
      proof.a.y,
      ...proof.b.x,
      ...proof.b.y,
      proof.c.x,
      proof.c.y,
    ])
      assert.ok(coordinate >= 0n && coordinate < BASE);
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
      original.data
    );
    return freeze({
      transaction: { ...transaction },
      intentDigest: intent.digest,
      expectedHash: intent.data.expectedHash,
      proofVerified: false,
    });
  } catch {
    throw Object.assign(new Error('Railgun relay proof transaction mismatch'), {
      code: 'RAILGUN_RELAY_TRANSACTION_REFUSED',
    });
  }
}
module.exports = { matchRailgunRelayProvedTransaction };
