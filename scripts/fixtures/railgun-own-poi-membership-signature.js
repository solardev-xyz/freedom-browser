/** Qualification-only trust substitution. Never imported by application code.
 * Keep production event parsing and Ed25519 verification, replacing only the
 * fixed service public key with a disposable fixture key in one module import.
 */
const assert = require('assert/strict');
const crypto = require('crypto');
exports.install = () => {
  const recordsPath = require.resolve('../../src/main/wallet/railgun-poi-records');
  const consumerPaths = [
    recordsPath,
    require.resolve('../../src/main/wallet/railgun-poi-source'),
    require.resolve('../../src/main/wallet/railgun-poi-membership'),
    require.resolve('../../src/main/wallet/railgun-account-poi'),
    require.resolve('../../src/main/wallet/railgun-own-poi-membership'),
  ];
  for (const filename of consumerPaths) assert.equal(require.cache[filename], undefined);
  const originalVerify = crypto.verify;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const requiredList = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';
  const serviceDer = Buffer.from('302a300506032b6570032100' + requiredList, 'hex');
  const serviceKey = crypto.createPublicKey({ key: serviceDer, format: 'der', type: 'spki' });
  let active = true,
    attempts = 0;
  const encode = (event) =>
    Buffer.from(
      JSON.stringify({
        index: event.index,
        blindedCommitment: event.blindedCommitment,
        type: event.type,
      })
    );
  try {
    crypto.verify = (algorithm, data, key, signature, ...rest) => {
      const matches = key?.export?.({ format: 'der', type: 'spki' }).equals(serviceDer);
      if (!matches) return originalVerify(algorithm, data, key, signature, ...rest);
      attempts++;
      assert.equal(active, true);
      assert.equal(algorithm, null);
      assert.equal(rest.length, 0);
      assert.ok(Buffer.isBuffer(data) && data.length <= 512);
      assert.ok(Buffer.isBuffer(signature) && signature.length === 64);
      return originalVerify(null, data, publicKey, signature);
    };
    const records = require(recordsPath);
    assert.equal(records.REQUIRED_LIST, requiredList);
  } finally {
    crypto.verify = originalVerify;
  }
  // This must fail with the real REQUIRED_LIST key, independently of the seam.
  const probe = { index: 5, blindedCommitment: '0x' + '1'.repeat(64), type: 'Shield' };
  const probeSignature = crypto.sign(null, encode(probe), privateKey);
  assert.equal(originalVerify(null, encode(probe), publicKey, probeSignature), true);
  assert.equal(originalVerify(null, encode(probe), serviceKey, probeSignature), false);
  return Object.freeze({
    sign(event) {
      assert.equal(active, true);
      const signature = crypto.sign(null, encode(event), privateKey);
      assert.equal(originalVerify(null, encode(event), serviceKey, signature), false);
      return signature.toString('hex');
    },
    attempts: () => attempts,
    close() {
      active = false;
      assert.equal(crypto.verify, originalVerify);
      // All consumers must have drained first. Do not leave the captured seam
      // available to a later load in this disposable qualification process.
      for (const filename of consumerPaths) delete require.cache[filename];
    },
  });
};
