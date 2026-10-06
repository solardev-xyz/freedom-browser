/** Fixture-only, one production keyless C call per fresh guarded process.
 * Observers delegate unchanged; malformed/parser-only failures never qualify.
 * No key/storage broker, witness, producer, cache reset or transport capability.
 */
const assert = require('assert/strict');
const path = require('path');
const { types } = require('util');
const { createHash } = require('crypto');
const { Interface } = require('ethers');
const { shape } = require('../../src/main/wallet/railgun-relay-quote-data');
const { assertRailgunRelaySignal } = require('../../src/main/wallet/railgun-relay-wallet-data');
const {
  createRailgunRelayVerifyRecordReader,
} = require('../../src/main/wallet/railgun-relay-record-stream');
const {
  decodeRailgunRelayLocalRecord,
  digestRailgunRelayLocalIntent,
  matchRailgunRelayLocalReservation,
} = require('../../src/main/wallet/railgun-relay-recovery-data');
const {
  matchRailgunRelayProvedTransaction,
} = require('../../src/main/wallet/railgun-relay-transaction');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const { EXPECTED_GUARDS } = require('../qualify-railgun-relay-proof');
const abi = new Interface([TRANSACT_ABI]);
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const SUBGROUP = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const CASES = ['unmodified', 'signature', 'transaction-proof', 'pre-poi-proof'];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const expectedResults = (name) =>
  name === 'signature'
    ? [{ domain: 'signature', verified: false }]
    : [
        { domain: 'signature', verified: true },
        { domain: '01x02', verified: name !== 'transaction-proof' },
        ...(name === 'transaction-proof'
          ? []
          : [{ domain: 'POI_3x3', verified: name !== 'pre-poi-proof' }]),
      ];
let attempted = false;
function negate(x, y) {
  x = BigInt(x);
  y = BigInt(y);
  assert.ok(x >= 0n && x < BASE && y > 0n && y < BASE);
  assert.equal((y * y) % BASE, (((x * x) % BASE) * x + 3n) % BASE);
  const changed = (BASE - y) % BASE;
  assert.notEqual(changed, y);
  assert.equal((changed * changed) % BASE, (((x * x) % BASE) * x + 3n) % BASE);
  return changed;
}
function checked(text, entry) {
  const record = decodeRailgunRelayLocalRecord(text);
  assert.equal(record.state, 'ready-local');
  matchRailgunRelayProvedTransaction(record.draft.intent, record.proved.transaction);
  const pair = matchRailgunRelayLocalReservation(text, entry);
  assert.equal(pair.interruptedStep, null);
  assert.equal(pair.reservationState, 'signing-local');
  return record;
}
function mutation(text, auditCase) {
  const original = JSON.parse(text),
    value = JSON.parse(text);
  if (auditCase === 'signature') {
    value.signature.S =
      '0x' + ((BigInt(value.signature.S) + 1n) % SUBGROUP).toString(16).padStart(64, '0');
    assert.notEqual(value.signature.S, original.signature.S);
    const restored = JSON.parse(JSON.stringify(value));
    restored.signature.S = original.signature.S;
    assert.deepEqual(restored, original);
  } else if (auditCase === 'transaction-proof') {
    const [[tx]] = abi.decodeFunctionData('transact', value.proved.transaction.data);
    const proof = [
      [tx.proof.a.x, negate(tx.proof.a.x, tx.proof.a.y)],
      [tx.proof.b.x, tx.proof.b.y],
      [tx.proof.c.x, tx.proof.c.y],
    ];
    value.proved.transaction.data = abi.encodeFunctionData('transact', [
      [[proof, tx.merkleRoot, tx.nullifiers, tx.commitments, tx.boundParams, tx.unshieldPreimage]],
    ]);
    const restored = JSON.parse(JSON.stringify(value));
    restored.proved.transaction.data = original.proved.transaction.data;
    assert.deepEqual(restored, original);
  } else if (auditCase === 'pre-poi-proof') {
    const a = value.proved.payload.snarkProof.pi_a;
    a[1] = negate(a[0], a[1]).toString();
    const restored = JSON.parse(JSON.stringify(value));
    restored.proved.payload.snarkProof.pi_a[1] = original.proved.payload.snarkProof.pi_a[1];
    assert.deepEqual(restored, original);
  }
  const result = JSON.stringify(value);
  if (auditCase === 'unmodified') assert.equal(result, text);
  else assert.notEqual(result, text);
  return result;
}
exports.run = async (inputText, { request, signal, guardReport }) => {
  assert.equal(attempted, false);
  attempted = true;
  assert.ok(typeof inputText === 'string' && Buffer.byteLength(inputText) <= 65536);
  const input = JSON.parse(inputText);
  shape(input, [
    'archive',
    'proverArchive',
    'artifactDirectory',
    'identityText',
    'entryText',
    'recordStream',
    'auditCase',
  ]);
  assert.ok(CASES.includes(input.auditCase));
  for (const key of ['archive', 'proverArchive', 'artifactDirectory'])
    assert.ok(typeof input[key] === 'string' && path.isAbsolute(input[key]));
  for (const key of ['archive', 'proverArchive']) assert.equal(path.extname(input[key]), '.asar');
  assert.ok(typeof input.identityText === 'string' && Buffer.byteLength(input.identityText) <= 512);
  const identity = JSON.parse(input.identityText);
  assert.equal(JSON.stringify(identity), input.identityText);
  shape(identity, ['walletId', 'spendingPublicKey']);
  assert.match(identity.walletId, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(identity.spendingPublicKey) && identity.spendingPublicKey.length === 2);
  for (const value of identity.spendingPublicKey) assert.match(value, /^[0-9a-f]{64}$/);
  assert.ok(typeof input.entryText === 'string' && Buffer.byteLength(input.entryText) <= 4096);
  const entry = JSON.parse(input.entryText);
  assert.equal(JSON.stringify(entry), input.entryText);
  const active = () => assertRailgunRelaySignal(signal);
  active();
  let sequence = 0;
  const exchange = async (message) => {
    active();
    const id = ++sequence,
      wire = JSON.stringify({ id, ...message });
    assert.ok(Buffer.byteLength(wire) < 65536);
    const reply = await request(wire);
    active();
    assert.ok(typeof reply === 'string' && Buffer.byteLength(reply) < 65536);
    const response = JSON.parse(reply);
    shape(response, ['id', 'value']);
    assert.equal(response.id, id);
    return response.value;
  };
  const originalText = await createRailgunRelayVerifyRecordReader({
    manifest: input.recordStream,
    request: exchange,
    signal,
  }).read();
  active();
  const original = checked(originalText, entry);
  assert.equal(identity.walletId, original.walletId);
  const canonicalEntry = {
    id: entry.id,
    origin: entry.origin,
    facts: Object.fromEntries(
      [
        'tree',
        'position',
        'nullifier',
        'noteHash',
        'kind',
        'checkpointHash',
        'draftDigest',
        'expectedHash',
      ].map((key) => [key, entry.facts[key]])
    ),
    state: entry.state,
    signing: { gatesDigest: entry.signing.gatesDigest, recordDigest: entry.signing.recordDigest },
  };
  assert.equal(JSON.stringify(canonicalEntry), input.entryText);
  const recordText = mutation(originalText, input.auditCase);
  checked(recordText, entry);
  const recordDigest = digestRailgunRelayLocalIntent(originalText);
  assert.equal(digestRailgunRelayLocalIntent(recordText), recordDigest);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const keys = require(
    path.join(archive, 'node_modules/@railgun-community/engine/dist/utils/keys-utils')
  );
  const serial = require('../../src/main/wallet/railgun-prover-runtime').loadRailgunProverRuntime(
    input.proverArchive
  );
  const artifacts = require('../../src/main/wallet/railgun-artifacts');
  const primitiveResults = [],
    settlements = [],
    restored = [],
    vkeys = new WeakMap();
  let observationFailed = false,
    productionResult,
    productionError;
  const observe = (value, onValue) => {
    try {
      assert.ok(types.isPromise(value) && !types.isProxy(value));
      settlements.push(
        new Promise((resolve) => {
          try {
            Promise.prototype.then.call(
              value,
              (result) => {
                try {
                  onValue(result);
                } catch {
                  observationFailed = true;
                }
                resolve();
              },
              () => {
                observationFailed = true;
                resolve();
              }
            );
          } catch {
            observationFailed = true;
            resolve();
          }
        })
      );
    } catch {
      observationFailed = true;
    }
  };
  const wrap = (object, name, after) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    assert.ok(descriptor && typeof descriptor.value === 'function' && descriptor.writable);
    const originalFunction = descriptor.value;
    const wrapper = function (...args) {
      let result;
      try {
        result = Reflect.apply(originalFunction, this, args);
      } catch (error) {
        observationFailed = true;
        throw error;
      }
      try {
        after(args, result);
      } catch {
        observationFailed = true;
      }
      return result;
    };
    Object.defineProperty(object, name, { ...descriptor, value: wrapper });
    assert.equal(object[name], wrapper);
    restored.push(() => {
      assert.equal(object[name], wrapper);
      Object.defineProperty(object, name, descriptor);
    });
  };
  try {
    wrap(keys, 'verifyEDDSA', (_args, result) => {
      assert.equal(typeof result, 'boolean');
      assert.equal(primitiveResults.length, 0);
      primitiveResults.push({ domain: 'signature', verified: result });
    });
    wrap(artifacts, 'loadRailgunArtifacts', (args, result) => {
      assert.equal(args.length, 1);
      const { variant, directory } = args[0];
      assert.equal(directory, input.artifactDirectory);
      assert.ok(['01x02', 'POI_3x3'].includes(variant));
      observe(result, (artifact) => {
        assert.ok(!vkeys.has(artifact.vkey));
        vkeys.set(artifact.vkey, variant);
      });
    });
    wrap(serial, 'verify', (args, result) => {
      assert.equal(args.length, 3);
      const domain = vkeys.get(args[0]);
      assert.ok(domain);
      observe(result, (verified) => {
        assert.equal(typeof verified, 'boolean');
        primitiveResults.push({ domain, verified });
      });
    });
    try {
      productionResult =
        await require('../../src/main/wallet/railgun-relay-proof-verifier').verifyRailgunRelayProofs(
          {
            archive: input.archive,
            proverArchive: input.proverArchive,
            artifactDirectory: input.artifactDirectory,
            identityText: input.identityText,
            recordText,
            signal,
          }
        );
    } catch (error) {
      productionError = error;
    }
    await Promise.all(settlements);
    active();
    assert.equal(observationFailed, false);
    assert.deepEqual(primitiveResults, expectedResults(input.auditCase));
    if (input.auditCase === 'unmodified') {
      assert.equal(productionError, undefined);
      assert.ok(productionResult);
      assert.equal(productionResult.recordDigest, recordDigest);
      for (const key of [
        'transactionVerified',
        'prePoiVerified',
        'historicalEventSignatureVerified',
        'historicalMembershipPathVerified',
      ])
        assert.equal(productionResult[key], true);
      for (const key of ['inputOwnershipVerified', 'currentMembershipVerified', 'authorityGranted'])
        assert.equal(productionResult[key], false);
    } else {
      assert.equal(productionResult, undefined);
      assert.equal(productionError?.code, 'RAILGUN_RELAY_PROOF_VERIFICATION_REFUSED');
    }
  } finally {
    await Promise.all(settlements);
    for (const restore of restored.reverse()) {
      try {
        restore();
      } catch {
        observationFailed = true;
      }
    }
    assert.equal(observationFailed, false);
  }
  active();
  const guards = guardReport();
  assert.deepEqual(guards, EXPECTED_GUARDS);
  const inventory = {
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    proverSha256: require('../../src/main/wallet/railgun-prover-manifest.json').sha256,
    artifactVkeys: Object.fromEntries(
      ['01x02', 'POI_3x3'].map((variant) => [
        variant,
        artifacts.manifest[variant].find((v) => v.kind === 'vkey').sha256,
      ])
    ),
  };
  if (productionResult)
    for (const key of Object.keys(inventory))
      assert.deepEqual(productionResult[key], inventory[key]);
  const value = {
    auditCase: input.auditCase,
    recordDigest,
    originalRecordSha256: sha(originalText),
    checkedRecordSha256: sha(recordText),
    codecAccepted: true,
    transactionMatcherAccepted: true,
    pairMatcherAccepted: true,
    primitiveResults,
    productionOutcome: productionError ? 'refused' : 'verified',
    productionCode: productionError?.code ?? null,
    guards,
    inventory,
  };
  assert.equal(await exchange({ method: 'result', value }), null);
  active();
};
