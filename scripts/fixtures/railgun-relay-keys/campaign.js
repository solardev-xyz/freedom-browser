'use strict';

// Node-only qualification fixture. Importing this module executes no upstream crypto.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const verified = require('../railgun-relay-wire/inputs');
const { createAdmission } = require('./admission');
const nobleInput = 'engineDependencies:@noble/ed25519/lib/index.js';
const noblePin = Object.freeze({
  bytes: 31131,
  sha256: '85e967d2b67d830b75ac033d5faae0b5a19212e6404cf49fa5abf3bb4325c2d9',
});
function verifyKeyBuild(build, digest) {
  const manifest = verified.verifyBuild(build, digest);
  assert.deepEqual(verified.pins.files[nobleInput], noblePin);
  verified.need(
    manifest.graphInputs.includes(nobleInput),
    'Pinned Noble input absent from verified graph'
  );
  return manifest;
}
function recipePins() {
  const names = [
    'admission.js',
    'campaign.js',
    'cases.json',
    'vectors.json',
    '../../qualify-railgun-relay-keys.js',
  ];
  return Object.fromEntries(
    names.sort().map((name) => {
      const bytes = fs.readFileSync(path.join(__dirname, name));
      return [name, { bytes: bytes.length, sha256: verified.sha(bytes) }];
    })
  );
}
async function run(build, digest, output) {
  const manifest = verifyKeyBuild(build, digest);
  const recipe = recipePins();
  const out = verified.freshOutput(output, {
    ...manifest.roots,
    preparedBuild: fs.realpathSync(build),
    keyRecipe: __dirname,
  });
  const sha = verified.sha,
    need = verified.need;
  const read = (name) => {
    const file = { 'VECTORS.json': 'vectors.json', 'EXPECTED-CASES.json': 'cases.json' }[name];
    need(file, 'Unknown key fixture input');
    return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  };
  // Only after reviewed build/source pins and fresh output checks.
  const upstream = require(path.join(path.resolve(build), 'upstream.cjs'));
  const noble = upstream.ed;
  need(
    noble &&
      typeof noble.Point?.fromHex === 'function' &&
      typeof noble.ExtendedPoint?.fromAffine === 'function' &&
      typeof noble.Point?.prototype?.isTorsionFree === 'function' &&
      typeof noble.ExtendedPoint?.prototype?.isSmallOrder === 'function' &&
      typeof noble.verify === 'function' &&
      typeof noble.getSharedSecret === 'function' &&
      typeof noble.sign === 'function' &&
      typeof noble.CURVE?.l === 'bigint' &&
      Array.isArray(noble.utils?.TORSION_SUBGROUP),
    'Verified bundle Noble API unavailable'
  );
  const gate = createAdmission(noble, crypto);
  let walletEncryptCalls = 0;
  async function encryptForRecipient(payload, publicKey) {
    const detachedPeer = gate.keyBytes(gate.admitPublicKey(publicKey));
    const detachedPayload = JSON.parse(JSON.stringify(payload));
    walletEncryptCalls += 1;
    // Original wallet helper awaits ephemeral key derivation; pass only our detached key.
    const encrypted = await upstream.encryptDataWithSharedKey(detachedPayload, detachedPeer);
    gate.admitPublicKey(Buffer.from(encrypted.randomPubKey, 'hex'));
    return encrypted;
  }
  const vectors = read('VECTORS.json'),
    expectedCases = read('EXPECTED-CASES.json').cases;
  const results = [],
    diagnostics = {};
  async function run(id, fn) {
    const expected = expectedCases.find((entry) => entry.id === id);
    need(expected && !results.some((entry) => entry.id === id), `Unexpected case ${id}`);
    await fn();
    results.push({ id, kind: expected.kind, passed: true });
  }
  const bytes = (hex) => Buffer.from(hex, 'hex');
  const littleEndian = (value) => {
    let out = 0n;
    for (let i = value.length - 1; i >= 0; i -= 1) out = (out << 8n) | BigInt(value[i]);
    return out;
  };
  function encodeScalar(value) {
    need(value >= 0n && value < 1n << 256n, 'Scalar encoding domain');
    const out = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = Number(value & 255n);
      value >>= 8n;
    }
    return out;
  }
  const privateObject = (seed) =>
    crypto.createPrivateKey({
      key: Buffer.concat([bytes('302e020100300506032b657004220420'), seed]),
      format: 'der',
      type: 'pkcs8',
    });
  const publicObject = (publicKey) =>
    crypto.createPublicKey({
      key: Buffer.concat([bytes('302a300506032b6570032100'), publicKey]),
      format: 'der',
      type: 'spki',
    });
  const message = Buffer.from(vectors.message);
  const identities = vectors.seedHexes.map((seedHex) => {
    const seed = bytes(seedHex),
      secretObject = privateObject(seed);
    const der = crypto.createPublicKey(secretObject).export({ format: 'der', type: 'spki' });
    assert.equal(der.subarray(0, 12).toString('hex'), '302a300506032b6570032100');
    return { seed, secretObject, publicKey: Uint8Array.from(der.subarray(12)) };
  });
  const torsion = noble.utils.TORSION_SUBGROUP.map(bytes);
  let signature, mixedA, mixedR;
  await run('genuine-three-keys', async () => {
    assert.equal(identities.length, 3);
    assert.notEqual(vectors.seedHexes[2], vectors.seedHexes[0]);
    assert.notEqual(vectors.seedHexes[2], vectors.seedHexes[1]);
    for (const identity of identities) {
      assert.deepEqual(
        Uint8Array.from(await noble.getPublicKey(identity.seed)),
        identity.publicKey
      );
      const token = gate.admitPublicKey(identity.publicKey);
      assert.deepEqual(gate.keyBytes(token), identity.publicKey);
      const address = upstream.encodeAddress({
        masterPublicKey: BigInt(vectors.masterPublicKeyDecimal),
        viewingPublicKey: identity.publicKey,
        chain: vectors.chain,
      });
      const decoded = upstream.getRailgunWalletAddressData(address);
      assert.deepEqual(Uint8Array.from(decoded.viewingPublicKey), identity.publicKey);
      gate.admitPublicKey(decoded.viewingPublicKey);
    }
  });
  await run('genuine-node-noble-signatures', async () => {
    for (const identity of identities) {
      const nodeSig = crypto.sign(null, message, identity.secretObject),
        nobleSig = await noble.sign(message, identity.seed);
      gate.admitSignature(nodeSig);
      gate.admitSignature(nobleSig);
      await gate.verify(identity.publicKey, nodeSig, message);
      await gate.verify(identity.publicKey, nobleSig, message);
      assert.deepEqual(Uint8Array.from(nodeSig), Uint8Array.from(nobleSig));
    }
    signature = Uint8Array.from(crypto.sign(null, message, identities[0].secretObject));
  });
  await run('canonical-and-length-refusals', () => {
    const before = gate.counts();
    for (const input of [new Uint8Array(31), new Uint8Array(33)])
      assert.throws(() => gate.admitPublicKey(input), { code: 'A_LENGTH' });
    for (const hex of [vectors.noncanonicalYPrimeHex, vectors.noncanonicalYPrimePlusOneHex])
      assert.throws(() => gate.admitPublicKey(bytes(hex)), { code: 'A_DECODE' });
    assert.throws(() => gate.admitPublicKey(bytes(vectors.identitySignBitHex)), {
      code: 'A_CANONICAL',
    });
    assert.deepEqual(gate.counts(), before);
  });
  await run('eight-torsion-A-refusals', () => {
    assert.equal(torsion.length, 8);
    need(
      torsion.some((value) => value.every((byte) => byte === 0)),
      'Allzero vector'
    );
    for (const value of torsion) {
      const point = noble.Point.fromHex(value, true);
      assert.equal(noble.ExtendedPoint.fromAffine(point).isSmallOrder(), true);
      assert.throws(() => gate.admitPublicKey(value), {
        code: point.equals(noble.Point.ZERO) ? 'A_IDENTITY' : 'A_SMALL_ORDER',
      });
    }
  });
  await run('mixed-torsion-A-distinguishes', () => {
    const point = noble.Point.fromHex(identities[0].publicKey, true).add(
      noble.Point.fromHex(torsion[4], true)
    );
    mixedA = point.toRawBytes();
    assert.deepEqual(noble.Point.fromHex(mixedA, true).toRawBytes(), mixedA);
    assert.equal(noble.ExtendedPoint.fromAffine(point).isSmallOrder(), false);
    assert.equal(point.isTorsionFree(), false);
    assert.throws(() => gate.admitPublicKey(mixedA), { code: 'A_TORSION' });
  });
  await run('identity-torsionfree-insufficient', () => {
    const identity = noble.Point.fromHex(bytes(vectors.identityHex), true);
    assert.equal(identity.isTorsionFree(), true);
    assert.throws(() => gate.admitPublicKey(bytes(vectors.identityHex)), { code: 'A_IDENTITY' });
  });
  await run('R-independent-gate', async () => {
    const rPoint = noble.Point.fromHex(signature.subarray(0, 32), true);
    mixedR = rPoint.add(noble.Point.fromHex(torsion[4], true)).toRawBytes();
    for (const [r, code] of [
      [torsion[0], 'R_IDENTITY'],
      [torsion[4], 'R_SMALL_ORDER'],
      [torsion[1], 'R_SMALL_ORDER'],
      [bytes(vectors.identitySignBitHex), 'R_CANONICAL'],
      [bytes(vectors.noncanonicalYPrimePlusOneHex), 'R_DECODE'],
      [mixedR, 'R_TORSION'],
    ]) {
      const altered = Uint8Array.from(signature);
      altered.set(r, 0);
      const before = gate.counts();
      await assert.rejects(() => gate.verify(identities[0].publicKey, altered, message), { code });
      assert.deepEqual(gate.counts(), before);
    }
  });
  await run('S-range-and-equation', async () => {
    const originalS = littleEndian(signature.subarray(32));
    for (const s of [
      noble.CURVE.l,
      noble.CURVE.l + 1n,
      originalS + noble.CURVE.l,
      (1n << 256n) - 1n,
    ]) {
      const altered = Uint8Array.from(signature);
      altered.set(encodeScalar(s), 32);
      const before = gate.counts();
      await assert.rejects(() => gate.verify(identities[0].publicKey, altered, message), {
        code: 'S_RANGE',
      });
      assert.deepEqual(gate.counts(), before);
    }
    for (const count of [63, 65])
      assert.throws(() => gate.admitSignature(new Uint8Array(count)), { code: 'SIGNATURE_LENGTH' });
    const zeroS = Uint8Array.from(signature);
    zeroS.fill(0, 32);
    gate.admitSignature(zeroS); // Zero is a canonical scalar; equation rejection is separate.
    await assert.rejects(() => gate.verify(identities[0].publicKey, zeroS, message), {
      code: 'SIGNATURE_EQUATION',
    });
  });
  await run('valid-identity-R-limitation', async () => {
    const identity = identities[0],
      r = bytes(vectors.identityHex);
    const digest = crypto.createHash('sha512').update(identity.seed).digest();
    const head = Buffer.from(digest.subarray(0, 32));
    head[0] &= 248;
    head[31] &= 63;
    head[31] |= 64;
    const a = littleEndian(head) % noble.CURVE.l;
    const k =
      littleEndian(
        crypto.createHash('sha512').update(r).update(identity.publicKey).update(message).digest()
      ) % noble.CURVE.l;
    const sig = Buffer.concat([r, encodeScalar((k * a) % noble.CURVE.l)]);
    assert.equal(await noble.verify(sig, message, identity.publicKey), true);
    assert.equal(crypto.verify(null, message, publicObject(identity.publicKey), sig), true);
    const before = gate.counts();
    await assert.rejects(() => gate.verify(identity.publicKey, sig, message), {
      code: 'R_IDENTITY',
    });
    assert.deepEqual(gate.counts(), before);
    diagnostics.identityR = {
      rawNode: true,
      rawNoble: true,
      localHardenedSubset: 'refused',
      mathematicallyInvalidOrForged: false,
      equation: 'R=0, S=k*a modulo ell',
      compatibility: 'Intentional application subset, not RFC or ZIP validity claim',
    };
  });
  await run('wrong-message-and-key', async () => {
    await assert.rejects(
      () => gate.verify(identities[0].publicKey, signature, Buffer.from('changed')),
      { code: 'SIGNATURE_EQUATION' }
    );
    await assert.rejects(() => gate.verify(identities[1].publicKey, signature, message), {
      code: 'SIGNATURE_EQUATION',
    });
  });
  await run('signature-await-snapshot', async () => {
    const a = Uint8Array.from(identities[0].publicKey),
      sig = Uint8Array.from(signature),
      msg = Uint8Array.from(message);
    const before = gate.counts().signatureCalls;
    const pending = gate.verify(a, sig, msg);
    assert.equal(gate.counts().signatureCalls, before + 1); // Real Noble await entered.
    a.fill(0);
    sig.fill(0);
    msg.fill(0);
    const result = await pending;
    assert.equal(result.publicKeyHex, Buffer.from(identities[0].publicKey).toString('hex'));
    assert.equal(result.messageSha256, sha(message));
  });
  await run('immutable-token-bytes', () => {
    const a = Uint8Array.from(identities[0].publicKey),
      sig = Uint8Array.from(signature);
    const aToken = gate.admitPublicKey(a),
      sigToken = gate.admitSignature(sig);
    a.fill(0);
    sig.fill(0);
    gate.keyBytes(aToken).fill(0);
    gate.signatureBytes(sigToken).fill(0);
    assert.deepEqual(gate.keyBytes(aToken), identities[0].publicKey);
    assert.deepEqual(gate.signatureBytes(sigToken), signature);
    assert.throws(() => gate.keyBytes(Object.freeze({})), { code: 'KEY_TOKEN' });
    assert.throws(() => gate.signatureBytes(Object.freeze({})), { code: 'SIGNATURE_TOKEN' });
  });
  await run('actual-ECDH-two-roles', async () => {
    for (const [index, identity] of identities.entries()) {
      gate.admitPublicKey(identity.publicKey); // Long-term receiver before actual wallet exchange.
      const payload = { kind: 'OFFLINE_KEY_GATE', index };
      const encrypted = await encryptForRecipient(payload, identity.publicKey);
      const ephemeral = bytes(encrypted.randomPubKey);
      gate.admitPublicKey(ephemeral); // Outgoing ephemeral and receiving-side boundary.
      const shared = await gate.sharedSecret(identity.seed, ephemeral);
      assert.equal(shared.length, 32);
      assert.equal(
        shared.every((value) => value === 0),
        false
      );
      assert.deepEqual(Uint8Array.from(shared), Uint8Array.from(encrypted.sharedKey));
      assert.deepEqual(await upstream.tryDecryptData(encrypted.encryptedData, shared), payload);
      const reply = upstream.encryptResponseData({ error: 'OFFLINE_KEY_GATE' }, shared);
      assert.deepEqual(upstream.decryptAESGCM256(reply, encrypted.sharedKey), {
        error: 'OFFLINE_KEY_GATE',
      });
    }
  });
  await run('ECDH-invalid-peers-before-call', async () => {
    for (const peer of [
      bytes(vectors.identityHex),
      new Uint8Array(32),
      mixedA,
      bytes(vectors.noncanonicalYPrimePlusOneHex),
    ]) {
      const before = gate.counts().ecdhCalls,
        beforeWallet = walletEncryptCalls;
      await assert.rejects(() => gate.sharedSecret(identities[0].seed, peer));
      await assert.rejects(() => encryptForRecipient({ kind: 'OFFLINE_INVALID_KEY' }, peer));
      assert.equal(gate.counts().ecdhCalls, before);
      assert.equal(walletEncryptCalls, beforeWallet);
    }
  });
  await run('wallet-recipient-await-snapshot', async () => {
    const peer = Uint8Array.from(identities[2].publicKey),
      payload = { kind: 'ORIGINAL' };
    const before = walletEncryptCalls,
      pending = encryptForRecipient(payload, peer);
    assert.equal(walletEncryptCalls, before + 1);
    peer.fill(0);
    payload.kind = 'MUTATED';
    const encrypted = await pending;
    const key = await gate.sharedSecret(identities[2].seed, bytes(encrypted.randomPubKey));
    assert.deepEqual(await upstream.tryDecryptData(encrypted.encryptedData, key), {
      kind: 'ORIGINAL',
    });
  });
  await run('ECDH-await-snapshot', async () => {
    const original = await gate.sharedSecret(identities[0].seed, identities[1].publicKey);
    const seed = Uint8Array.from(identities[0].seed),
      peer = Uint8Array.from(identities[1].publicKey);
    const before = gate.counts().ecdhCalls,
      pending = gate.sharedSecret(seed, peer);
    assert.equal(gate.counts().ecdhCalls, before + 1);
    seed.fill(0);
    peer.fill(0);
    assert.deepEqual(await pending, original);
  });
  await run('no-trust-or-chain-upgrade', () => {
    diagnostics.scope = {
      arbitraryCanonicalPrimeSubgroupKeysAcceptedMathematically: true,
      operatorIdentityEstablished: false,
      wakuPeerBound: false,
      topicSigned: false,
      transactionAuthority: false,
      finality: false,
      RPolicyIsHardenedSubset: true,
      curveMathIndependentlyImplemented: false,
      offCurveAdversarialVectorQualified: false,
    };
  });
  assert.deepEqual(
    results.map((entry) => entry.id).sort(),
    expectedCases.map((entry) => entry.id).sort()
  );

  verifyKeyBuild(build, digest);
  assert.deepEqual(recipePins(), recipe);
  const counts = Object.fromEntries(
    ['positive', 'negative', 'control', 'limitation'].map((kind) => [
      kind,
      results.filter((entry) => entry.kind === kind).length,
    ])
  );
  const cryptoCalls = { ...gate.counts(), walletEncryptCalls };
  assert.deepEqual(counts, { positive: 3, negative: 6, control: 6, limitation: 2 });
  assert.deepEqual(cryptoCalls, { signatureCalls: 10, ecdhCalls: 6, walletEncryptCalls: 4 });
  const report = {
    schema: 'railgun-key-admission-repository-campaign-v1',
    scope:
      'Actual pinned Noble point/math helpers via verified upstream namespace and Node differential checks; public synthetic keys only; no production activation',
    buildManifestSha256: digest,
    keyRecipe: recipe,
    nobleSource: { input: nobleInput, ...noblePin },
    node: process.version,
    openssl: process.versions.openssl,
    nodeExecutableSha256: sha(fs.readFileSync(process.execPath)),
    campaignSha256: sha(fs.readFileSync(__filename)),
    admissionSha256: sha(fs.readFileSync(path.join(__dirname, 'admission.js'))),
    counts,
    cryptoCalls,
    results,
    diagnostics,
    liveServiceContacted: false,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  return { counts, reportSha256: sha(fs.readFileSync(path.join(out, 'report.json'))) };
}
module.exports = { run, verifyKeyBuild, recipePins };
