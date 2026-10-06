'use strict';

// Reviewed offline campaign. Importing this fixture executes no crypto.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const verified = require('./inputs');
const p = require('./policy');
async function run(build, digest, output) {
  const manifest = verified.verifyBuild(build, digest);
  const out = verified.freshOutput(output, {
    ...manifest.roots,
    preparedBuild: fs.realpathSync(build),
  });
  const hash = verified.sha,
    need = verified.need;
  const json = (name) =>
    name === 'EXTRACTION-AND-BUILD.json'
      ? { sourceConfigDefaults: manifest.sourceConfigDefaults }
      : JSON.parse(fs.readFileSync(path.join(__dirname, name.toLowerCase())));
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  };
  const policy = deepFreeze(require('./policy.json'));
  const vectors = deepFreeze(require('./vectors.json'));
  const expectedCases = require('./cases.json');
  // Only after reviewed manifest/input verification and fresh output admission.
  const upstream = require(path.join(path.resolve(build), 'upstream.cjs'));
  const counters = {
    signatureCalls: 0,
    quoteSemantics: 0,
    clientEncryptCalls: 0,
    emittedOfflineEnvelopes: 0,
    upstreamReplyReads: 0,
  };
  const results = [],
    diagnostics = {};
  async function caseCheck(group, id, fn) {
    need(
      expectedCases[group].some((entry) => entry.id === id),
      `Undefined case ${id}`
    );
    need(!results.some((entry) => entry.id === id), `Duplicate case ${id}`);
    await fn();
    results.push({ group, id, passed: true });
  }
  const refuses = async (fn) => {
    await assert.rejects(async () => {
      await fn();
    });
  };
  const nodePrivate = (seedHex) =>
    crypto.createPrivateKey({
      key: Buffer.from('302e020100300506032b657004220420' + seedHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
  const nodePublic = (keyHex) =>
    crypto.createPublicKey({
      key: Buffer.from('302a300506032b6570032100' + keyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
  const keyFixtures = {};
  for (const [name, seed] of [
    ['primary', vectors.broadcasterSeedHex],
    ['other', vectors.otherBroadcasterSeedHex],
  ]) {
    const privateKey = nodePrivate(seed);
    const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    need(spki.subarray(0, 12).toString('hex') === '302a300506032b6570032100', 'Ed25519 SPKI');
    const publicKeyHex = spki.subarray(12).toString('hex');
    need(publicKeyHex.length === 64, 'Node key length');
    keyFixtures[name] = {
      seed,
      privateKey,
      publicKeyHex,
      address: upstream.encodeAddress({
        masterPublicKey: BigInt(vectors.masterPublicKeyDecimal),
        viewingPublicKey: Buffer.from(publicKeyHex, 'hex'),
        chain: policy.chain,
      }),
    };
  }
  keyFixtures.allChains = {
    ...keyFixtures.primary,
    address: upstream.encodeAddress({
      masterPublicKey: BigInt(vectors.masterPublicKeyDecimal),
      viewingPublicKey: Buffer.from(keyFixtures.primary.publicKeyHex, 'hex'),
    }),
  };
  // Registry is created exclusively from Node-derived frozen seed values, never a peer object.
  Object.freeze(keyFixtures);
  Object.values(keyFixtures).forEach(Object.freeze);
  const makeContext = (changes = {}) => ({
    topic: policy.topic,
    chain: clone(policy.chain),
    deployment: policy.deployment,
    nowMs: vectors.nowMs,
    previousNowMs: vectors.nowMs,
    activePOIListKeys: [...policy.activePOIListKeys],
    ...changes,
  });
  const makeQuote = (key = 'primary', changes = {}) => ({
    fees: { [policy.tokenAddress]: vectors.feePerUnitGas },
    feeExpiration: vectors.nowMs + vectors.quoteRemainingMs,
    feesID: vectors.feesID,
    railgunAddress: keyFixtures[key].address,
    identifier: vectors.identifier,
    availableWallets: vectors.availableWallets,
    version: vectors.version,
    relayAdapt: policy.relayAdapt,
    requiredPOIListKeys: [],
    reliability: vectors.reliability,
    ...changes,
  });
  const signText = (text, key = 'primary') =>
    encode({
      data: Buffer.from(text).toString('hex'),
      signature: crypto.sign(null, Buffer.from(text), keyFixtures[key].privateKey).toString('hex'),
    });
  const signQuote = (quote, key = 'primary') => signText(JSON.stringify(quote), key);
  const tickets = new WeakMap();
  async function admit(packetBytes, context = makeContext(), keyName = 'primary') {
    need(Object.hasOwn(keyFixtures, keyName), 'Only independently derived fixture key registry');
    const expected = keyFixtures[keyName];
    // Capture caller-owned arrays/objects before the first verification await.
    const admissionContext = deepFreeze(clone(context));
    const parsed = p.parseSignedPacket(packetBytes, policy);
    // Untrusted candidate parsing/address decode is necessary to obtain a candidate key.
    const decoded = upstream.getRailgunWalletAddressData(parsed.candidate.railgunAddress);
    p.validateCandidateKey(parsed.candidate, decoded, expected);
    counters.signatureCalls += 1;
    need(
      await upstream.verifyBroadcasterSignature(
        parsed.signatureHex,
        parsed.dataHex,
        decoded.viewingPublicKey
      ),
      'Upstream signature refusal'
    );
    need(
      crypto.verify(
        null,
        parsed.signedBytes,
        nodePublic(expected.publicKeyHex),
        Buffer.from(parsed.signatureHex, 'hex')
      ),
      'Node signature refusal'
    );
    // No semantic field reliance or encryption before both verifiers and genuine-key pin.
    counters.quoteSemantics += 1;
    const binding = p.validateQuoteFields(parsed.candidate, decoded, admissionContext, policy);
    const token = Object.freeze({});
    tickets.set(
      token,
      deepFreeze({
        quote: clone(parsed.candidate),
        context: admissionContext,
        decoded: { chain: decoded.chain ? clone(decoded.chain) : undefined },
        keyName,
        signedBytesSha256: hash(parsed.signedBytes),
        binding,
      })
    );
    return token;
  }
  function nativeDecrypt(encryptedData, sharedKey, split = 16) {
    p.validateEncryptedData(encryptedData, policy.limits.requestBytes / 2);
    const framing = Buffer.from(encryptedData[0].slice(2), 'hex');
    const iv = framing.subarray(0, split),
      tag = framing.subarray(split);
    const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedData[1].slice(2), 'hex')),
      decipher.final(),
    ]);
  }
  function nativeEncrypt(plaintext, sharedKey) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey, iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [
      '0x' + Buffer.concat([iv, cipher.getAuthTag()]).toString('hex'),
      '0x' + ciphertext.toString('hex'),
    ];
  }
  async function createOperation(ticket, gas, clock = () => vectors.nowMs) {
    const accepted = tickets.get(ticket);
    need(accepted, 'Authentic local quote ticket');
    const fixture = keyFixtures[accepted.keyName];
    let previousNowMs = accepted.context.nowMs;
    function recheckExpiry() {
      const nowMs = clock();
      p.validateQuoteFields(
        accepted.quote,
        accepted.decoded,
        { ...accepted.context, previousNowMs, nowMs },
        policy
      );
      previousNowMs = nowMs;
    }
    recheckExpiry();
    counters.clientEncryptCalls += 1;
    const encrypted = await upstream.OfflineClientEncryptor.encryptTransaction(
      policy.txidVersion,
      policy.deployment,
      vectors.data,
      fixture.address,
      accepted.quote.feesID,
      policy.chain,
      BigInt(gas),
      false,
      {}
    );
    // Awaited encryption can cross the local quote deadline: no envelope is emitted first.
    recheckExpiry();
    const wireBytes = encode({
      pubkey: encrypted.randomPubKey,
      encryptedData: encrypted.encryptedData,
    });
    const wire = p.parseRequestEnvelope(wireBytes, policy);
    let retainedKey = Uint8Array.from(encrypted.sharedKey),
      state = 'active';
    const metadata = deepFreeze({
      localId: crypto.randomBytes(16).toString('hex'),
      wireSha256: hash(wireBytes),
      signedBytesSha256: accepted.signedBytesSha256,
      publicKeyHex: fixture.publicKeyHex,
      gas,
      feesID: accepted.quote.feesID,
      keyDigest: hash(retainedKey),
      wire: clone(wire),
    });
    counters.emittedOfflineEnvelopes += 1;
    const close = () => {
      state = 'closed';
      retainedKey = undefined;
    };
    return Object.freeze({
      metadata,
      state: () => state,
      close,
      receive(ciphertext) {
        need(state === 'active', 'Local operation no longer active');
        // Wrong-key/tag errors do not consume another operation. No retry is emitted.
        const raw = nativeDecrypt(ciphertext, retainedKey);
        let parsed;
        try {
          parsed = p.parseReply(raw, policy);
          // Trust raw duplicate-aware parse before comparing original upstream JSON output.
          counters.upstreamReplyReads += 1;
          const original = upstream.decryptAESGCM256(ciphertext, retainedKey);
          need(original !== null, 'Upstream reply authentication');
          assert.deepEqual(original, JSON.parse(raw.toString('utf8')));
        } catch (error) {
          close();
          throw error;
        }
        state = 'consumed';
        retainedKey = undefined;
        return Object.freeze({
          ...parsed,
          canonicalTransactionVerified: false,
          localOperationId: metadata.localId,
        });
      },
    });
  }
  async function serverKey(
    operation,
    keyName = 'primary',
    ephemeralHex = operation.metadata.wire.pubkey
  ) {
    return upstream.ed.getSharedSecret(
      Buffer.from(keyFixtures[keyName].seed, 'hex'),
      Buffer.from(ephemeralHex, 'hex')
    );
  }
  const flip = (tuple, part, byte) => {
    const result = [...tuple],
      bytes = Buffer.from(result[part].slice(2), 'hex');
    bytes[byte] ^= 1;
    result[part] = '0x' + bytes.toString('hex');
    return result;
  };
  const baseQuote = makeQuote(),
    basePacket = signQuote(baseQuote);
  let ticket, operationA, operationB, sharedA, sharedB, replyA, replyB;
  await caseCheck('positive', 'node-seed-key-address', async () => {
    for (const fixture of Object.values(keyFixtures)) {
      const noblePublic = await upstream.ed.getPublicKey(Buffer.from(fixture.seed, 'hex'));
      assert.equal(Buffer.from(noblePublic).toString('hex'), fixture.publicKeyHex);
      p.validateCandidateKey(
        { railgunAddress: fixture.address },
        upstream.getRailgunWalletAddressData(fixture.address),
        fixture
      );
    }
  });
  await caseCheck('positive', 'node-sign-upstream-verify', async () => {
    ticket = await admit(basePacket);
  });
  await caseCheck('positive', 'noble-sign-node-verify', async () => {
    const bytes = encode(baseQuote),
      signature = await upstream.ed.sign(bytes, Buffer.from(keyFixtures.primary.seed, 'hex'));
    assert.equal(
      crypto.verify(null, bytes, nodePublic(keyFixtures.primary.publicKeyHex), signature),
      true
    );
  });
  const formattedText = JSON.stringify(
    Object.fromEntries(Object.entries(baseQuote).reverse()),
    null,
    2
  );
  await caseCheck('positive', 'resigned-reformatted-quote', () => admit(signText(formattedText)));
  await caseCheck('positive', 'required-poi-list-covered', () =>
    admit(signQuote(makeQuote('primary', { requiredPOIListKeys: [...policy.activePOIListKeys] })))
  );
  await caseCheck('positive', 'minimum-expiry-boundary', () =>
    admit(
      signQuote(
        makeQuote('primary', { feeExpiration: vectors.nowMs + policy.quoteMinimumRemainingMs })
      )
    )
  );
  await caseCheck('negative', 'changed-signed-bytes', async () => {
    const packet = JSON.parse(basePacket);
    packet.data = Buffer.from(formattedText).toString('hex');
    const before = { ...counters };
    await refuses(() => admit(encode(packet)));
    assert.equal(counters.quoteSemantics, before.quoteSemantics);
    assert.equal(counters.clientEncryptCalls, before.clientEncryptCalls);
  });
  await caseCheck('negative', 'wrong-genuine-signer', async () => {
    await refuses(() => admit(signQuote(baseQuote, 'other')));
  });
  await caseCheck('supplementalControls', 'mandatory-local-signature-no-dev-switch', async () => {
    // Actual upstream fee-handler dev bypass is outside this extracted body experiment.
    // The frozen local gate has no ambient dev/subtle branch and no bypass argument.
    assert.doesNotMatch(admit.toString(), /IS_DEV|subtle|process\.env/);
    assert.equal(json('EXTRACTION-AND-BUILD.json').sourceConfigDefaults.IS_DEV, false);
    const parsed = JSON.parse(basePacket),
      before = { ...counters };
    const absent = { data: parsed.data };
    await refuses(() => admit(encode(absent)));
    assert.equal(counters.signatureCalls, before.signatureCalls);
    await refuses(() => admit(encode({ ...parsed, signature: '00'.repeat(64) })));
    assert.equal(counters.signatureCalls, before.signatureCalls + 1);
    assert.equal(counters.quoteSemantics, before.quoteSemantics);
    assert.equal(counters.clientEncryptCalls, before.clientEncryptCalls);
    diagnostics.signaturePolicy = {
      mandatoryLocalVerification: true,
      ambientDevOrSubtleSwitch: false,
      upstreamFeeHandlerBypassExecuted: false,
      extractedEncryptionDevDefault: false,
    };
  });

  const evilPacket = (publicKeyHex) =>
    encode({
      data: encode({
        ...baseQuote,
        railgunAddress: upstream.encodeAddress({
          masterPublicKey: 1n,
          viewingPublicKey: Buffer.from(publicKeyHex, 'hex'),
          chain: policy.chain,
        }),
      }).toString('hex'),
      signature: vectors.adversarialKeyVectors.identityRZeroSUniversalSignatureHex,
    });
  await caseCheck('negative', 'identity-key-local-refusal', async () => {
    const before = { ...counters };
    await refuses(() =>
      admit(evilPacket(vectors.adversarialKeyVectors.identityCompressedPublicKeyHex))
    );
    assert.equal(counters.signatureCalls, before.signatureCalls);
    assert.equal(counters.quoteSemantics, before.quoteSemantics);
  });
  await caseCheck('negative', 'noncanonical-key-local-refusal', async () => {
    const before = { ...counters };
    for (const key of [
      vectors.adversarialKeyVectors.noncanonicalIdentityYPlusPrimeHex,
      vectors.adversarialKeyVectors.identitySignBitHex,
    ])
      await refuses(() => admit(evilPacket(key)));
    assert.equal(counters.signatureCalls, before.signatureCalls);
  });
  await caseCheck('negative', 'duplicate-signed-quote-key', async () => {
    const text = JSON.stringify(baseQuote).replace(/}$/, ',"fees\\u0049D":"duplicate"}');
    const before = { ...counters };
    await refuses(() => admit(signText(text)));
    assert.equal(counters.signatureCalls, before.signatureCalls);
  });
  await caseCheck('negative', 'required-poi-not-covered', () =>
    refuses(() =>
      admit(
        signQuote(makeQuote('primary', { requiredPOIListKeys: [...policy.activePOIListKeys] })),
        makeContext({ activePOIListKeys: [] })
      )
    )
  );
  await caseCheck('supplementalControls', 'await-context-empty-then-covered', async () => {
    const packet = signQuote(
      makeQuote('primary', { requiredPOIListKeys: [...policy.activePOIListKeys] })
    );
    const callerContext = makeContext({ activePOIListKeys: [] });
    const before = counters.signatureCalls;
    const pending = admit(packet, callerContext);
    assert.equal(counters.signatureCalls, before + 1); // Actual verifier await reached.
    callerContext.activePOIListKeys.push(...policy.activePOIListKeys);
    await refuses(() => pending);
  });
  await caseCheck('supplementalControls', 'await-context-covered-then-empty', async () => {
    const packet = signQuote(
      makeQuote('primary', { requiredPOIListKeys: [...policy.activePOIListKeys] })
    );
    const callerContext = makeContext();
    const before = counters.signatureCalls;
    const pending = admit(packet, callerContext);
    assert.equal(counters.signatureCalls, before + 1); // Actual verifier await reached.
    callerContext.activePOIListKeys.length = 0;
    const accepted = await pending;
    assert.equal(tickets.has(accepted), true);
    assert.deepEqual(tickets.get(accepted).context.activePOIListKeys, policy.activePOIListKeys);
  });

  await caseCheck('negative', 'pre-emission-expiry-recheck', async () => {
    let before = { ...counters };
    await refuses(() =>
      createOperation(
        ticket,
        '0',
        () => baseQuote.feeExpiration - policy.quoteMinimumRemainingMs + 1
      )
    );
    assert.equal(counters.clientEncryptCalls, before.clientEncryptCalls);
    assert.equal(counters.emittedOfflineEnvelopes, before.emittedOfflineEnvelopes);
    let calls = 0;
    before = { ...counters };
    await refuses(() =>
      createOperation(ticket, '0', () =>
        ++calls === 1 ? vectors.nowMs : baseQuote.feeExpiration - policy.quoteMinimumRemainingMs + 1
      )
    );
    assert.equal(counters.clientEncryptCalls, before.clientEncryptCalls + 1);
    assert.equal(counters.emittedOfflineEnvelopes, before.emittedOfflineEnvelopes);
  });
  await caseCheck('negative', 'wrong-context', async () => {
    for (const change of [
      { topic: '/railgun/v2/0-1-fees/json' },
      { chain: { type: 1, id: policy.chain.id } },
      { chain: { type: 0, id: 1 } },
      { deployment: policy.tokenAddress },
    ])
      await refuses(() => admit(basePacket, makeContext(change)));
  });
  await caseCheck('positive', 'source-common-request', async () => {
    operationA = await createOperation(ticket, '0');
    operationB = await createOperation(ticket, '1');
    sharedA = await serverKey(operationA);
    sharedB = await serverKey(operationB);
    const originalFraming = operationA.metadata.wire.encryptedData[0];
    assert.throws(() => {
      operationA.metadata.wire.encryptedData[0] = '0x00';
    });
    assert.equal(operationA.metadata.wire.encryptedData[0], originalFraming);
    assert.throws(() => {
      operationA.metadata.gas = '999';
    });
    assert.notEqual(operationA.metadata.wire.pubkey, operationB.metadata.wire.pubkey);
    assert.notEqual(operationA.metadata.keyDigest, operationB.metadata.keyDigest);
    assert.equal(hash(sharedA), operationA.metadata.keyDigest);
    assert.equal(hash(sharedB), operationB.metadata.keyDigest);
    for (const [operation, key] of [
      [operationA, sharedA],
      [operationB, sharedB],
    ]) {
      const original = await upstream.tryDecryptData(operation.metadata.wire.encryptedData, key);
      p.validateCommonPlaintext(
        original,
        {
          data: vectors.data,
          publicKeyHex: keyFixtures.primary.publicKeyHex,
          minGasPrice: operation.metadata.gas,
          feesID: vectors.feesID,
        },
        policy
      );
    }
  });
  await caseCheck('positive', 'native-gcm-request-codec', async () => {
    for (const [operation, key] of [
      [operationA, sharedA],
      [operationB, sharedB],
    ]) {
      const bytes = nativeDecrypt(operation.metadata.wire.encryptedData, key);
      const original = await upstream.tryDecryptData(operation.metadata.wire.encryptedData, key);
      assert.equal(bytes.toString('utf8'), JSON.stringify(original));
      p.validateCommonPlaintext(
        p.parseBoundedJson(bytes, policy.limits, policy.limits.requestBytes),
        {
          data: vectors.data,
          publicKeyHex: keyFixtures.primary.publicKeyHex,
          minGasPrice: operation.metadata.gas,
          feesID: vectors.feesID,
        },
        policy
      );
    }
  });
  for (const [id, part, byte] of [
    ['request-iv-tamper', 0, 0],
    ['request-tag-tamper', 0, 16],
    ['request-ciphertext-tamper', 1, 0],
  ]) {
    await caseCheck('negative', id, async () => {
      const bad = flip(operationA.metadata.wire.encryptedData, part, byte);
      assert.equal(await upstream.tryDecryptData(bad, sharedA), null);
      assert.throws(() => nativeDecrypt(bad, sharedA));
    });
  }
  await caseCheck('negative', 'request-wrong-recipient', async () => {
    const wrong = await serverKey(operationA, 'other');
    assert.equal(
      await upstream.tryDecryptData(operationA.metadata.wire.encryptedData, wrong),
      null
    );
  });
  await caseCheck('negative', 'request-wrong-ephemeral', async () => {
    const wrong = await serverKey(operationA, 'primary', operationB.metadata.wire.pubkey);
    assert.equal(
      await upstream.tryDecryptData(operationA.metadata.wire.encryptedData, wrong),
      null
    );
  });
  await caseCheck('positive', 'server-hash-response', () => {
    replyA = upstream.encryptResponseData({ txHash: vectors.responseHash }, sharedA);
    const raw = nativeDecrypt(replyA, sharedA),
      parsed = p.parseReply(raw, policy);
    assert.equal(parsed.txHash, vectors.responseHash);
    assert.deepEqual(upstream.decryptAESGCM256(replyA, sharedA), { txHash: vectors.responseHash });
  });
  await caseCheck('positive', 'native-error-response', () => {
    replyB = nativeEncrypt(encode({ error: vectors.responseError }), sharedB);
    const parsed = p.parseReply(nativeDecrypt(replyB, sharedB), policy);
    assert.equal(parsed.error, vectors.responseError);
    assert.deepEqual(upstream.decryptAESGCM256(replyB, sharedB), { error: vectors.responseError });
  });
  await caseCheck('negative', 'response-wrong-operation', () => {
    assert.throws(() => operationA.receive(replyB));
    assert.equal(operationA.state(), 'active');
    assert.equal(operationB.state(), 'active');
  });
  await caseCheck('positive', 'interleaved-two-operations', () => {
    const b = operationB.receive(replyB),
      a = operationA.receive(replyA);
    assert.equal(b.kind, 'error');
    assert.equal(a.kind, 'hash');
    assert.equal(b.localOperationId, operationB.metadata.localId);
    assert.equal(a.localOperationId, operationA.metadata.localId);
    assert.notEqual(a.localOperationId, b.localOperationId);
    assert.equal(a.canonicalTransactionVerified, false);
  });
  await caseCheck('negative', 'duplicate-response-local', () => {
    assert.throws(() => operationA.receive(replyA));
    assert.equal(operationA.state(), 'consumed');
  });
  await caseCheck('negative', 'closed-operation-local', async () => {
    const operation = await createOperation(ticket, '0'),
      key = await serverKey(operation);
    const reply = upstream.encryptResponseData({ txHash: vectors.responseHash }, key);
    operation.close();
    assert.throws(() => operation.receive(reply));
    assert.equal(operation.state(), 'closed');
  });
  await caseCheck('negative', 'authenticated-malformed-response', async () => {
    for (const raw of [
      encode({ txHash: vectors.responseHash, error: 'bad' }),
      Buffer.from('{"error":"a","err\\u006fr":"b"}'),
    ]) {
      const operation = await createOperation(ticket, '0'),
        key = await serverKey(operation);
      const bad = nativeEncrypt(raw, key),
        before = counters.upstreamReplyReads;
      assert.throws(() => operation.receive(bad));
      assert.equal(operation.state(), 'closed');
      assert.equal(counters.upstreamReplyReads, before);
    }
  });
  await caseCheck('limitationControls', 'all-chains-signed-replay', async () => {
    const packet = signQuote(makeQuote('allChains')),
      parsed = p.parseSignedPacket(packet, policy);
    await admit(packet, makeContext(), 'allChains');
    assert.equal(
      await upstream.verifyBroadcasterSignature(
        parsed.signatureHex,
        parsed.dataHex,
        Buffer.from(keyFixtures.primary.publicKeyHex, 'hex')
      ),
      true
    );
    await refuses(() =>
      admit(
        packet,
        makeContext({ topic: '/railgun/v2/0-1-fees/json', chain: { type: 0, id: 1 } }),
        'allChains'
      )
    );
    diagnostics.allChainsQuoteSignsExternalTopic = false;
  });
  await caseCheck('limitationControls', 'low-order-raw-verifiers', async () => {
    diagnostics.lowOrder = [];
    const bytes = Buffer.from('OFFLINE IDENTITY DIAGNOSTIC'),
      signature = Buffer.from(
        vectors.adversarialKeyVectors.identityRZeroSUniversalSignatureHex,
        'hex'
      );
    for (const [kind, key] of [
      ['identity', vectors.adversarialKeyVectors.identityCompressedPublicKeyHex],
      ['noncanonical', vectors.adversarialKeyVectors.noncanonicalIdentityYPlusPrimeHex],
      ['signbit', vectors.adversarialKeyVectors.identitySignBitHex],
    ]) {
      const outcome = { kind };
      try {
        outcome.node = crypto.verify(null, bytes, nodePublic(key), signature);
      } catch (error) {
        outcome.node = `throws:${error.name}`;
      }
      try {
        outcome.noble = await upstream.verifyBroadcasterSignature(
          signature,
          bytes,
          Buffer.from(key, 'hex')
        );
      } catch (error) {
        outcome.noble = `throws:${error.name}`;
      }
      diagnostics.lowOrder.push(outcome);
    }
  });
  await caseCheck('limitationControls', 'shared-native-gcm-backend', () => {
    diagnostics.cryptoComparison = {
      ed25519: 'Node versus Noble',
      aesGcm: 'Same Node backend; independently written codec/wrapper checks only',
      ecdh: 'Noble on both sides',
    };
  });
  await caseCheck('limitationControls', 'dummy-calldata-fee-scope', async () => {
    const plaintext = await upstream.tryDecryptData(
      operationA.metadata.wire.encryptedData,
      sharedA
    );
    for (const key of [
      'tokenAddress',
      'feeAmount',
      'masterPublicKey',
      'quoteDigest',
      'operationId',
    ])
      assert.equal(Object.hasOwn(plaintext, key), false);
    diagnostics.feeScope =
      'Synthetic calldata only; token/amount/master-public-key/quote digest not demonstrated as calldata commitments';
  });
  await caseCheck('distinguishingControls', 'wrong-iv-tag-split', () => {
    assert.throws(() => nativeDecrypt(operationA.metadata.wire.encryptedData, sharedA, 12));
  });
  await caseCheck('distinguishingControls', 'ignore-authentication-mutant', () => {
    const bad = flip(operationA.metadata.wire.encryptedData, 0, 16);
    function brokenDecrypt(tuple, key) {
      const framing = Buffer.from(tuple[0].slice(2), 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, framing.subarray(0, 16));
      // Deliberate mutant: returns update bytes without setting/validating tag or final().
      return decipher.update(Buffer.from(tuple[1].slice(2), 'hex'));
    }
    assert.throws(() => nativeDecrypt(bad, sharedA));
    assert.throws(() => assert.equal(brokenDecrypt(bad, sharedA), null));
    assert.equal(
      brokenDecrypt(bad, sharedA).toString(),
      nativeDecrypt(operationA.metadata.wire.encryptedData, sharedA).toString()
    );
  });
  await caseCheck('distinguishingControls', 'reserialize-before-verifying-mutant', async () => {
    const packet = p.parseSignedPacket(signText(formattedText), policy);
    assert.equal(
      await upstream.verifyBroadcasterSignature(
        packet.signatureHex,
        packet.signedBytes,
        Buffer.from(keyFixtures.primary.publicKeyHex, 'hex')
      ),
      true
    );
    assert.equal(
      await upstream.verifyBroadcasterSignature(
        packet.signatureHex,
        encode(packet.candidate),
        Buffer.from(keyFixtures.primary.publicKeyHex, 'hex')
      ),
      false
    );
  });
  await caseCheck('distinguishingControls', 'global-response-key-mutant', () => {
    const globalKey = sharedB; // Deliberate overwrite by operation B; response A must fail.
    assert.throws(() => nativeDecrypt(replyA, globalKey));
    assert.doesNotThrow(() => nativeDecrypt(replyB, globalKey));
  });
  for (const group of [
    'positive',
    'negative',
    'limitationControls',
    'distinguishingControls',
    'supplementalControls',
  ]) {
    assert.deepEqual(
      results
        .filter((entry) => entry.group === group)
        .map((entry) => entry.id)
        .sort(),
      expectedCases[group].map((entry) => entry.id).sort()
    );
  }

  verified.verifyBuild(build, digest);
  const report = {
    schema: 'offline-relay-wire-repository-campaign-v1',
    buildManifestSha256: digest,
    node: process.version,
    nodeExecutableSha256: hash(fs.readFileSync(process.execPath)),
    campaignSha256: hash(fs.readFileSync(__filename)),
    counts: Object.fromEntries(
      [
        'positive',
        'negative',
        'limitationControls',
        'distinguishingControls',
        'supplementalControls',
      ].map((group) => [group, results.filter((entry) => entry.group === group).length])
    ),
    counters,
    results,
    diagnostics,
    publicRequestEvidence: [operationA.metadata, operationB.metadata],
    canonicalTransactionVerified: false,
    liveServiceContacted: false,
    fullClientOrServerInitialized: false,
  };
  assert.deepEqual(counters, {
    signatureCalls: 16,
    quoteSemantics: 13,
    clientEncryptCalls: 6,
    emittedOfflineEnvelopes: 5,
    upstreamReplyReads: 2,
  });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  return {
    counts: report.counts,
    reportSha256: hash(fs.readFileSync(path.join(out, 'report.json'))),
  };
}
module.exports = { run };
