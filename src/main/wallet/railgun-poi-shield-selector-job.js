/** Keyless public Shield preimage hashing. A private selector is returned to
 * main memory only; it proves neither account ownership nor disclosure consent. */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const { normalizeRailgunPoiShieldFacts } = require('./railgun-poi-shield-selector-data');
exports.run = async function run(text, { request, signal, guardReport }) {
  try {
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 8192);
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    const input = JSON.parse(text);
    assert.deepEqual(Object.keys(input).sort(), ['archive', 'bindingDigest', 'facts']);
    assert.match(input.bindingDigest, /^[0-9a-f]{64}$/);
    const facts = normalizeRailgunPoiShieldFacts(input.facts);
    const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
    const imp = (name) =>
      require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
    await imp('utils/poseidon').initPoseidonPromise;
    active();
    const { getTokenDataERC20, getTokenDataHash } = imp('note/note-util');
    const hash = imp('note/erc20/shield-note-erc20').ShieldNoteERC20.getShieldNoteHash(
      BigInt(facts.npk),
      getTokenDataHash(getTokenDataERC20(facts.token)),
      BigInt(facts.value)
    );
    assert.equal(hash, BigInt(facts.noteHash));
    const blindedCommitment = imp(
      'poi/blinded-commitment'
    ).BlindedCommitment.getForShieldOrTransact(
      facts.noteHash,
      BigInt(facts.npk),
      imp('poi/global-tree-position').getGlobalTreePosition(facts.tree, facts.position)
    );
    const [note] = require('./railgun-poi-records').normalizePoiNotes([
      { blindedCommitment, type: 'Shield' },
    ]);
    active();
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
              bindingDigest: input.bindingDigest,
              blindedCommitment: note.blindedCommitment,
              selectorDerived: true,
              ownershipAuthenticated: false,
              sourceAuthenticated: false,
              membershipAuthenticated: false,
              disclosureEnabled: false,
              spendingEnabled: false,
              guards,
              inventory: require('./railgun-engine-manifest.json').inventory.sha256,
            },
          })
        )
      ),
      { id: 1, value: null }
    );
    active();
  } catch {
    throw Object.assign(new Error('Railgun Shield POI selector unavailable'), {
      code: 'RAILGUN_POI_SHIELD_SELECTOR_REFUSED',
    });
  }
};
