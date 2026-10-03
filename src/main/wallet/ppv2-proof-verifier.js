/** Verify in a fresh utility process after the witness-bearing prover exits.
 * Uses the same pinned cryptographic implementation, not an independent audit.
 */
const path = require('path');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { runPrivacyProcess } = require('./privacy-process');
const { validProof } = require('./ppv2-deposit-policy');
const CIRCUITS = Object.freeze({ deposit: 4, ragequit: 7, transact_1x1: 8 });
async function verifyPPv2Proof({ handle, sdkEntry, proverEntry, circuit, proof, vkey }) {
  getPrivacyContext(handle);
  if (
    !Object.hasOwn(CIRCUITS, circuit) ||
    !validProof(proof, CIRCUITS[circuit]) ||
    !(vkey instanceof Uint8Array) ||
    vkey.length > 8192
  )
    throw privacyError('PRIVATE_PPV2_PROOF_INVALID', 'Proof verification refused');
  const entry = require('./ppv2-runtime').getPPv2VerifierEntry({ sdkEntry, proverEntry });
  const input = {
    sdkEntry,
    proverEntry: entry,
    circuit,
    proof: structuredClone(proof),
    vkey: Uint8Array.from(vkey),
  };
  const { peakRssBytes } = await runPrivacyProcess({
    handle,
    filename: path.join(__dirname, 'ppv2-proof-verify-job.js'),
    input,
    timeoutMs: 30000,
    heapMb: 256,
    rssMb: 768,
    validateResult: (result) => result?.verified === true,
  });
  getPrivacyContext(handle);
  return Object.freeze({ peakRssBytes });
}
module.exports = { verifyPPv2Proof };
