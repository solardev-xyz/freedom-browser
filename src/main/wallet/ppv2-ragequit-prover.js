/** Main binds emergency exit to the recovered native note and public owner. */
const path = require('path');
const { Interface } = require('ethers');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { createPrivacyArtifactLoader } = require('./privacy-artifacts');
const { runPrivacyProcess } = require('./privacy-process');
const { FIELD, NATIVE, validProof, formatProof } = require('./ppv2-deposit-policy');
const { ARTIFACTS, RAGEQUIT_ABI, validWitness } = require('./ppv2-ragequit-policy');
const abi = new Interface([RAGEQUIT_ABI]);
const fail = () => privacyError('PRIVATE_PPV2_EXIT_REFUSED', 'Exit does not match its reviewed note');

function createPPv2RagequitProver({ handle, artifactHandle, sdkEntry, proverEntry, directory, manifest, onProgress }) {
  const context = getPrivacyContext(handle), artifactContext = getPrivacyContext(artifactHandle);
  const { role: _role, ...subject } = context.subject;
  const { role: _artifactRole, ...artifactSubject } = artifactContext.subject;
  if (context.subject.role !== 'prover' || artifactContext.subject.role !== 'artifacts' ||
      context.profileId !== artifactContext.profileId || context.generation !== artifactContext.generation ||
      JSON.stringify(subject) !== JSON.stringify(artifactSubject) || !path.isAbsolute(sdkEntry) || !path.isAbsolute(proverEntry) ||
      ARTIFACTS.some((entry) => manifest?.ragequit?.[`${entry.kind}Sha256`]?.replace(/^0x/, '').toLowerCase() !== entry.sha256) ||
      (onProgress !== undefined && typeof onProgress !== 'function')) throw fail();
  const loader = createPrivacyArtifactLoader({ handle: artifactHandle, directory, manifest: ARTIFACTS });
  let operation = null;
  const service = Object.freeze({
    async proveRagequit(witness) {
      getPrivacyContext(handle);
      if (!operation || operation.started || !validWitness(witness) || BigInt(witness.ownerAddress) !== BigInt(operation.ownerAddress) ||
          BigInt(witness.tokenId) !== BigInt(NATIVE) || BigInt(witness.value) !== operation.amount) throw fail();
      const current = operation; current.started = true;
      const input = { sdkEntry, proverEntry, witness: { ...witness, keystoreSiblings: [...witness.keystoreSiblings] }, artifacts: {} };
      const expected = [null, BigInt(current.commitment), BigInt(witness.keystoreRoot), BigInt(current.ownerAddress),
        current.amount, BigInt(NATIVE), BigInt(witness.label)];
      for (const entry of ARTIFACTS) input.artifacts[entry.kind] = await loader.load(entry.name);
      const { result } = await runPrivacyProcess({ handle, filename: path.join(__dirname, 'ppv2-ragequit-job.js'), input, onProgress,
        validateResult: (value) => value?.verified === true && validProof(value.proof, 7) &&
          expected.every((v, index) => v === null || BigInt(value.proof.publicSignals[index]) === v) });
      getPrivacyContext(handle);
      if (operation !== current) throw fail();
      const proof = result.proof.proof;
      proof.pi_b.forEach(Object.freeze); Object.freeze(proof.pi_b); Object.freeze(proof.pi_a); Object.freeze(proof.pi_c);
      Object.freeze(proof); Object.freeze(result.proof.publicSignals); Object.freeze(result.proof);
      current.proof = result.proof;
      return result.proof;
    },
    formatForEVM(proof) {
      getPrivacyContext(handle);
      if (!operation?.proof || operation.proof !== proof) throw fail();
      return formatProof(proof);
    },
  });
  return Object.freeze({ service,
    async prepare({ ownerAddress, poolAddress, commitment, amount }, prepare) {
      getPrivacyContext(handle);
      if (operation || !/^0x[0-9a-f]{64}$/i.test(commitment) || BigInt(commitment) >= FIELD ||
          typeof amount !== 'bigint' || amount <= 0n || amount >= (1n << 128n)) throw fail();
      const current = { ownerAddress, commitment, amount, started: false }; operation = current;
      try {
        const result = await prepare(); getPrivacyContext(handle);
        if (!current.proof || result?.__type !== 'publicOperation' || !Array.isArray(result.txs) || result.txs.length !== 1) throw fail();
        const tx = result.txs[0];
        if (tx.to?.toLowerCase() !== poolAddress.toLowerCase() || tx.value !== 0n || typeof tx.data !== 'string' ||
            abi.encodeFunctionData('ragequit', [formatProof(current.proof)]).toLowerCase() !== tx.data.toLowerCase()) throw fail();
        return Object.freeze({ kind: 'ppv2-native-ragequit', chainId: 11155111, from: ownerAddress, to: poolAddress,
          value: 0n, data: tx.data, commitment: commitment.toLowerCase(), amount, fee: 0n,
          proofVerified: true, chainStateVerified: false });
      } catch (error) {
        getPrivacyContext(handle);
        if (error?.code === 'PRIVACY_REQUEST_ABORTED') throw error;
        throw fail();
      } finally { operation = null; }
    } });
}
module.exports = { createPPv2RagequitProver };
