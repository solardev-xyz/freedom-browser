/** Deposit-only SDK proof service. Main bounds the witness, pins artifacts,
 * owns process lifetime and binds prepared calldata to the verified proof.
 */
const path = require('path');
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { createPrivacyArtifactLoader } = require('./privacy-artifacts');
const { runPrivacyProcess } = require('./privacy-process');
const { FIELD, NATIVE, ARTIFACTS, DEPOSIT_ABI, validWitness, validProof, formatProof } = require('./ppv2-deposit-policy');
const abi = new Interface([DEPOSIT_ABI]);
const coder = AbiCoder.defaultAbiCoder();
const fail = () => privacyError('PRIVATE_PPV2_DEPOSIT_REFUSED', 'Deposit does not match its reviewed intent');

function createPPv2DepositProver({ handle, artifactHandle, sdkEntry, directory, manifest, onProgress, inspectNote }) {
  const context = getPrivacyContext(handle), artifactsContext = getPrivacyContext(artifactHandle);
  const { role: _role, ...subject } = context.subject;
  const { role: _artifactRole, ...artifactSubject } = artifactsContext.subject;
  if (context.subject.role !== 'prover' || artifactsContext.subject.role !== 'artifacts' ||
      context.profileId !== artifactsContext.profileId || context.generation !== artifactsContext.generation ||
      JSON.stringify(subject) !== JSON.stringify(artifactSubject) || !path.isAbsolute(sdkEntry) ||
      ARTIFACTS.some((entry) => manifest?.deposit?.[`${entry.kind}Sha256`]?.replace(/^0x/, '').toLowerCase() !== entry.sha256) ||
      (onProgress !== undefined && typeof onProgress !== 'function') || typeof inspectNote !== 'function') throw fail();
  require('./ppv2-runtime').assertPPv2RuntimeEntries({ sdkEntry });
  const loader = createPrivacyArtifactLoader({ handle: artifactHandle, directory, manifest: ARTIFACTS });
  let operation = null;
  const unsupported = () => { getPrivacyContext(handle); throw fail(); };
  const service = Object.freeze({
    async proveDeposit(witness) {
      getPrivacyContext(handle);
      if (!operation || operation.started || !validWitness(witness) || BigInt(witness.tokenId) !== BigInt(operation.token) ||
          BigInt(witness.value) !== operation.amount) throw fail();
      const current = operation;
      current.started = true;
      // Copy before any await; only five scalar strings enter the process.
      const input = { sdkEntry, witness: { ...witness }, artifacts: {} };
      current.context = BigInt(witness.context) % FIELD;
      for (const entry of ARTIFACTS) input.artifacts[entry.kind] = await loader.load(entry.name);
      const { result } = await runPrivacyProcess({ handle, filename: path.join(__dirname, 'ppv2-deposit-job.js'), input,
        onProgress, validateResult: (value) => value?.verified === true && validProof(value.proof) &&
          BigInt(value.proof.publicSignals[1]) === BigInt(current.token) && BigInt(value.proof.publicSignals[2]) === current.amount &&
          BigInt(value.proof.publicSignals[3]) === current.context });
      getPrivacyContext(handle);
      if (operation !== current) throw fail();
      // Immutable accepted result. formatForEVM accepts only this exact object.
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
    proveTransact: unsupported, proveRagequit: unsupported, verifyDeposit: unsupported,
    verifyTransact: unsupported, verifyRagequit: unsupported, loadCircuit: unsupported,
  });
  return Object.freeze({
    service,
    async prepare({ amount, maxFee, ownerAddress, entrypointAddress, token = NATIVE, fee = 0n }, prepare) {
      getPrivacyContext(handle);
      if (operation || typeof amount !== 'bigint' || amount <= 0n || amount >= (1n << 128n) ||
          typeof maxFee !== 'bigint' || maxFee < 0n || maxFee >= (1n << 128n)) throw fail();
      if (typeof token !== 'string' || !/^0x[0-9a-f]{40}$/i.test(token) || BigInt(token) === 0n ||
          typeof fee !== 'bigint' || fee < 0n || fee > maxFee || amount + fee >= 1n << 128n) throw fail();
      token = token.toLowerCase();
      const native = token === NATIVE;
      const current = { amount, token, started: false };
      operation = current;
      try {
        const result = await prepare();
        getPrivacyContext(handle);
        if (!current.proof || result?.__type !== 'publicOperation' || !Array.isArray(result.txs) || result.txs.length !== 1) throw fail();
        const tx = result.txs[0];
        if (!tx || typeof tx.to !== 'string' || tx.to.toLowerCase() !== entrypointAddress.toLowerCase() ||
            typeof tx.value !== 'bigint' || (native ? tx.value < amount || tx.value - amount > maxFee : tx.value !== 0n) ||
            typeof tx.data !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(tx.data) || tx.data.length > 16386) throw fail();
        const decoded = abi.decodeFunctionData('deposit', tx.data);
        const expected = formatProof(current.proof);
        const note = { hint: decoded._noteData.hint, data: decoded._noteData.data };
        if (note.data.length <= 2 || note.data.length > 4098 || decoded._aspCiphertext.length <= 66 || decoded._aspCiphertext.length > 4098 ||
            BigInt(keccak256(coder.encode(['tuple(bytes32 hint,bytes data)'], [note]))) % FIELD !== current.context ||
            abi.encodeFunctionData('deposit', [expected, note, decoded._aspCiphertext]).toLowerCase() !== tx.data.toLowerCase()) throw fail();
        const recovered = await inspectNote(ownerAddress, [note]);
        getPrivacyContext(handle);
        if (BigInt(recovered.commitment) !== BigInt(current.proof.publicSignals[0]) ||
            BigInt(recovered.value) !== amount || BigInt(recovered.tokenId) !== BigInt(token)) throw fail();
        return Object.freeze({ kind: native ? 'ppv2-native-deposit' : 'ppv2-token-deposit', chainId: 11155111, from: ownerAddress,
          to: entrypointAddress, value: tx.value, data: tx.data, amount, fee: native ? tx.value - amount : fee,
          ...(native ? {} : { token, maxFee }),
          proofVerified: true, chainStateVerified: false });
      } catch (error) {
        getPrivacyContext(handle);
        if (error?.code === 'PRIVACY_REQUEST_ABORTED') throw error;
        throw fail();
      } finally { operation = null; }
    },
  });
}
module.exports = { createPPv2DepositProver };
