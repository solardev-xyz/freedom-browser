/** Keyless, offline POI verification. No engine, account, store or key import.
 * List/checkpoint metadata are bound in the payload digest, not authenticated
 * by the circuit. All authority must be established by a later controller.
 */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
exports.run = async function run(text, { request, signal, guardReport }) {
  let artifacts, scope;
  try {
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 32768);
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    const input = JSON.parse(text);
    assert.deepEqual(Object.keys(input).sort(), ['artifactDirectory', 'payload', 'proverArchive']);
    assert.ok(
      typeof input.artifactDirectory === 'string' && path.isAbsolute(input.artifactDirectory)
    );
    const payload = normalizeRailgunPoiPayload(input.payload);
    const serial = require('./railgun-prover-runtime').loadRailgunProverRuntime(
      input.proverArchive
    );
    assert.equal(typeof serial.verify, 'function');
    assert.equal(globalThis.curve_bn128, null);
    scope = createPrivacyScope({ profileId: 'railgun-keyless-poi-verify', signal });
    // Reuse the authenticated bounded loader; its unused WASM/zkey are wiped.
    artifacts = await require('./railgun-artifacts').loadRailgunArtifacts({
      handle: scope.getContext({
        kind: 'private-account',
        principal: 'verification',
        protocol: 'railgun',
        deployment: 'offline',
        chainId: 11155111,
        role: 'artifacts',
      }),
      directory: input.artifactDirectory,
      variant: 'POI_3x3',
    });
    active();
    // Pinned engine Merkle zero, distinct from the blinded-output zero padding.
    const zero = BigInt('0x' + require('./railgun-public-records').ZERO_NODES[0]);
    const signals = [
      payload.blindedCommitmentsOut.length ? BigInt(payload.blindedCommitmentsOut[0]) : 0n,
      0n,
      0n,
      BigInt('0x' + payload.txidMerkleroot),
      BigInt(payload.railgunTxidIfHasUnshield),
      BigInt('0x' + payload.poiMerkleroots[0]),
      zero,
      zero,
    ];
    assert.equal(await serial.verify(artifacts.vkey, signals, payload.proof), true);
    active();
    const changed = [...signals];
    changed[3] = (changed[3] + 1n) % FIELD;
    assert.equal(await serial.verify(artifacts.vkey, changed, payload.proof), false);
    active();
    assert.equal(globalThis.curve_bn128, null);
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 1,
            method: 'result',
            value: {
              inputSha256: createHash('sha256').update(text).digest('hex'),
              payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
              proofVerified: true,
              sourceAuthenticated: false,
              membershipAuthenticated: false,
              rootAccepted: false,
              disclosureEnabled: false,
              spendingEnabled: false,
              proverSha256: require('./railgun-prover-manifest.json').sha256,
              guards,
            },
          })
        )
      ),
      { id: 1, value: null }
    );
    active();
  } catch {
    throw Object.assign(new Error('Railgun POI verification unavailable'), {
      code: 'RAILGUN_POI_VERIFICATION_REFUSED',
    });
  } finally {
    artifacts?.wasm.fill(0);
    artifacts?.zkey.fill(0);
    scope?.close();
  }
};
