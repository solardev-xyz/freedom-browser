/** Qualification-only trust substitution. Never imported by application code.
 * Keep production event parsing and Ed25519 verification, replacing only the
 * fixed service public key with a disposable fixture key in one module import.
 */
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
exports.install = () => {
  const recordsPath = require.resolve('../../src/main/wallet/railgun-poi-records');
  // Resolve from the wrapper importer: the installed implementation captures
  // crypto.verify, and the eager host entry retains that function object.
  const packageEntry = require.resolve('@freedom/railgun-kohaku-adapter/host/poi', {
    paths: [path.dirname(recordsPath)],
  });
  const consumerPaths = [
    recordsPath,
    packageEntry,
    require.resolve(path.join(path.dirname(packageEntry), 'src/data/railgun-poi-records.js')),
    require.resolve('../../src/main/wallet/railgun-poi-source'),
    require.resolve('../../src/main/wallet/railgun-poi-membership'),
    require.resolve('../../src/main/wallet/railgun-account-poi'),
    require.resolve('../../src/main/wallet/railgun-own-poi-membership'),
  ];
  // Avoid formatting a whole cached module/dependency graph on refusal.
  for (const filename of consumerPaths) assert.equal(require.cache[filename] === undefined, true);
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
    exportPublicKey() {
      assert.equal(active, true);
      return publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
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

/** Replay only previously signed disposable service evidence. This public key
 * substitution is fixture trust, never a production list or account capability.
 * No private key is imported, generated or returned by this installer. */
exports.installReplay = (options) => {
  const { isProxy } = require('util').types;
  const plain = (value, keys) => {
    assert.ok(value && typeof value === 'object' && !isProxy(value));
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert.ok(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    }
  };
  plain(options, ['publicKeySpki', 'listKey', 'event', 'signature']);
  const { publicKeySpki, listKey, event, signature } = options;
  const requiredList = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';
  const prefix = '302a300506032b6570032100';
  assert.equal(listKey, requiredList);
  assert.equal(typeof publicKeySpki, 'string');
  assert.match(publicKeySpki, /^302a300506032b6570032100[0-9a-f]{64}$/);
  assert.notEqual(publicKeySpki, prefix + requiredList);
  // DER round-trip alone does not establish canonical/safe curve encoding.
  // Some OpenSSL versions accept a low-order identity with a signature that
  // verifies arbitrary messages, so reject these encodings before crypto.verify.
  const point = publicKeySpki.slice(prefix.length);
  const encoded = Buffer.from(point, 'hex');
  const sign = encoded[31] >>> 7;
  encoded[31] &= 0x7f;
  const y = BigInt('0x' + Buffer.from(encoded).reverse().toString('hex'));
  const modulus = (1n << 255n) - 19n;
  assert.ok(y < modulus);
  assert.ok(!(sign && (y === 1n || y === modulus - 1n)));
  const lowOrder = new Set([
    '0100000000000000000000000000000000000000000000000000000000000000',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0000000000000000000000000000000000000000000000000000000000000080',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  ]);
  assert.equal(lowOrder.has(point), false);
  plain(event, ['index', 'blindedCommitment', 'type']);
  assert.ok(Number.isSafeInteger(event.index) && event.index >= 0 && event.index < 65536);
  assert.ok(['Shield', 'Transact'].includes(event.type));
  assert.equal(typeof event.blindedCommitment, 'string');
  // Preserve either spelling permitted by the real normalizer; the signature
  // binds its exact string, including an optional 0x prefix.
  assert.match(event.blindedCommitment, /^(0x)?[0-9a-f]{64}$/);
  assert.ok(
    BigInt(
      event.blindedCommitment.startsWith('0x')
        ? event.blindedCommitment
        : '0x' + event.blindedCommitment
    ) < 21888242871839275222246405745257275088548364400416034343698204186575808495617n
  );
  assert.equal(typeof signature, 'string');
  assert.match(signature, /^[0-9a-f]{128}$/);
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeySpki, 'hex'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(publicKey.asymmetricKeyType, 'ed25519');
  assert.equal(publicKey.export({ format: 'der', type: 'spki' }).toString('hex'), publicKeySpki);
  const serviceDer = Buffer.from(prefix + requiredList, 'hex');
  const serviceKey = crypto.createPublicKey({ key: serviceDer, format: 'der', type: 'spki' });
  const originalVerify = crypto.verify;
  const message = Buffer.from(
    JSON.stringify({
      index: event.index,
      blindedCommitment: event.blindedCommitment,
      type: event.type,
    })
  );
  const signed = Buffer.from(signature, 'hex');
  assert.equal(originalVerify(null, message, publicKey, signed), true);
  assert.equal(originalVerify(null, message, serviceKey, signed), false);
  const recordsPath = require.resolve('../../src/main/wallet/railgun-poi-records');
  // Resolve from the wrapper importer: the installed implementation captures
  // crypto.verify, and the eager host entry retains that function object.
  const packageEntry = require.resolve('@freedom/railgun-kohaku-adapter/host/poi', {
    paths: [path.dirname(recordsPath)],
  });
  const consumerPaths = [
    recordsPath,
    packageEntry,
    require.resolve(path.join(path.dirname(packageEntry), 'src/data/railgun-poi-records.js')),
    require.resolve('../../src/main/wallet/railgun-poi-source'),
    require.resolve('../../src/main/wallet/railgun-poi-membership'),
    require.resolve('../../src/main/wallet/railgun-account-poi'),
    require.resolve('../../src/main/wallet/railgun-own-poi-membership'),
  ];
  // Avoid formatting a whole cached module/dependency graph on refusal.
  for (const filename of consumerPaths) assert.equal(require.cache[filename] === undefined, true);
  let active = true,
    attempts = 0;
  try {
    crypto.verify = (algorithm, data, key, bytes, ...rest) => {
      const matches = key?.export?.({ format: 'der', type: 'spki' }).equals(serviceDer);
      if (!matches) return originalVerify(algorithm, data, key, bytes, ...rest);
      attempts++;
      assert.equal(active, true);
      assert.equal(algorithm, null);
      assert.equal(rest.length, 0);
      assert.ok(Buffer.isBuffer(data) && data.length <= 512);
      assert.ok(Buffer.isBuffer(bytes) && bytes.length === 64);
      return originalVerify(null, data, publicKey, bytes);
    };
    const records = require(recordsPath);
    assert.equal(records.REQUIRED_LIST, requiredList);
  } finally {
    crypto.verify = originalVerify;
  }
  return Object.freeze({
    attempts: () => attempts,
    close() {
      active = false;
      assert.equal(crypto.verify, originalVerify);
      for (const filename of consumerPaths) delete require.cache[filename];
    },
  });
};
