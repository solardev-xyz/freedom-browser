/** Non-secret, fsynced reconstruction data for one already-journaled funding
 * transfer. It never stores a private key or serialized signed transaction.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { Transaction } = require('ethers');
const exact = (value, keys) =>
  value && Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
function assertFundingPlan(plan, expected) {
  assert.ok(
    exact(plan, ['version', 'profileBinding', 'destinationSha256', 'from', 'hash', 'transaction'])
  );
  assert.equal(plan.version, 1);
  assert.equal(plan.profileBinding, expected.profileBinding);
  assert.equal(plan.destinationSha256, expected.destinationSha256);
  assert.equal(plan.from, expected.from);
  assert.match(plan.hash, /^0x[0-9a-f]{64}$/);
  const tx = plan.transaction;
  assert.ok(exact(tx, ['chainId', 'to', 'value', 'data', 'nonce', 'gasLimit', 'gasPrice', 'type']));
  assert.equal(tx.chainId, 11155111);
  assert.equal(tx.to, expected.to);
  assert.equal(tx.value, expected.amount.toString());
  assert.equal(tx.data, '0x');
  assert.equal(tx.type, 0);
  assert.equal(tx.gasLimit, '21000');
  assert.ok(Number.isSafeInteger(tx.nonce) && tx.nonce >= 0);
  assert.ok(
    typeof tx.gasPrice === 'string' &&
      /^[1-9][0-9]{0,20}$/.test(tx.gasPrice) &&
      BigInt(tx.gasPrice) * 21000n <= expected.maxGasFee
  );
  return tx;
}
function createFundingPlan(raw, expected) {
  const signed = Transaction.from(raw);
  assert.ok(signed.isSigned());
  assert.equal(signed.from.toLowerCase(), expected.from);
  const transaction = {
    chainId: Number(signed.chainId),
    to: signed.to.toLowerCase(),
    value: signed.value.toString(),
    data: signed.data,
    nonce: signed.nonce,
    gasLimit: signed.gasLimit.toString(),
    gasPrice: signed.gasPrice?.toString(),
    type: signed.type,
  };
  const plan = {
    version: 1,
    profileBinding: expected.profileBinding,
    destinationSha256: expected.destinationSha256,
    from: expected.from,
    hash: signed.hash,
    transaction,
  };
  assertFundingPlan(plan, expected);
  return plan;
}
function writeFundingPlan(filename, plan) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(plan, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dir = fs.openSync(path.dirname(filename), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
async function resignFundingPlan(signer, plan, expected) {
  const tx = assertFundingPlan(plan, expected);
  assert.equal((await signer.getAddress()).toLowerCase(), expected.from);
  const raw = await signer.signTransaction({ ...tx }),
    signed = Transaction.from(raw);
  assert.equal(signed.hash, plan.hash);
  assert.equal(signed.from.toLowerCase(), expected.from);
  assert.equal(signed.unsignedSerialized, Transaction.from(tx).unsignedSerialized);
  return raw;
}
module.exports = { assertFundingPlan, createFundingPlan, writeFundingPlan, resignFundingPlan };
