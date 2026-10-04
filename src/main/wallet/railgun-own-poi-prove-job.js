/** Dedicated viewing-only local POI job. A fresh process makes one proof;
 * private witnesses and SDK key strings die with its observed exit. No stores,
 * network, spending material or disclosure authority are available here.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { verifyRailgunProverRuntime } = require('./railgun-prover-runtime');
const { loadRailgunArtifacts } = require('./railgun-artifacts');
const {
  normalizeRailgunOwnPoiProofInput,
  expectedRailgunOwnPoiFields,
  bindRailgunOwnPoiPayload,
} = require('./railgun-own-poi-proof-data');
const sha = (v) => createHash('sha256').update(v).digest('hex');
let attempted = false;
exports.run = async function run(text, { request, requestKey, signal, guardReport }) {
  let key, artifacts, scope;
  try {
    assert.equal(attempted, false);
    attempted = true;
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
    const input = normalizeRailgunOwnPoiProofInput(JSON.parse(text));
    const expected = expectedRailgunOwnPoiFields(input);
    const inputSha256 = sha(text);
    verifyRailgunEngineRuntime(input.archive);
    verifyRailgunProverRuntime(input.proverArchive);
    // Authenticate local artifacts before asking for a credential. The prover
    // reopens them under its own scope; no mutable artifact injection is added.
    scope = createPrivacyScope({ profileId: 'railgun-own-poi-artifacts', signal });
    artifacts = await loadRailgunArtifacts({
      handle: scope.getContext({
        kind: 'private-account',
        principal: 'proof',
        protocol: 'railgun',
        deployment: 'offline',
        chainId: 11155111,
        role: 'artifacts',
      }),
      directory: input.artifactDirectory,
      variant: 'POI_3x3',
    });
    artifacts.wasm.fill(0);
    artifacts.zkey.fill(0);
    artifacts = undefined;
    scope.close();
    scope = undefined;
    active();
    const bytes = await requestKey(
      JSON.stringify({
        id: 1,
        method: 'key',
        purpose: 'poi-prove',
        inputSha256,
      })
    );
    assert.ok(bytes instanceof Uint8Array);
    key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(key.length, 32);
    active();
    let payload;
    try {
      const proved = await require('./railgun-poi-prover').proveRailgunPoi({
        archive: input.archive,
        proverArchive: input.proverArchive,
        artifactDirectory: input.artifactDirectory,
        descriptor: input.descriptor,
        ...input.preparation,
        listProofs: input.listProofs,
        viewingKey: key,
        signal,
      });
      active();
      assert.equal(proved.locallyVerified, true);
      assert.equal(proved.independentlyVerified, false);
      payload = bindRailgunOwnPoiPayload(proved.payload, expected);
    } finally {
      key.fill(0);
    }
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 2,
            method: 'result',
            value: {
              inputSha256,
              payloadSha256: sha(JSON.stringify(payload)),
              payload,
              locallyVerified: true,
              independentlyVerified: false,
              sourceAuthenticated: false,
              membershipAuthenticated: false,
              rootAccepted: false,
              disclosureEnabled: false,
              spendingEnabled: false,
              engineSha256: require('./railgun-engine-manifest.json').sha256,
              proverSha256: require('./railgun-prover-manifest.json').sha256,
              guards,
            },
          })
        )
      ),
      { id: 2, value: null }
    );
    active();
  } catch {
    throw Object.assign(new Error('Railgun own POI proof unavailable'), {
      code: 'RAILGUN_OWN_POI_PROOF_REFUSED',
    });
  } finally {
    key?.fill(0);
    artifacts?.wasm.fill(0);
    artifacts?.zkey.fill(0);
    scope?.close();
  }
};
