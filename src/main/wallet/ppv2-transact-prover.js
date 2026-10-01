/** Main-owned single-asset withdrawal proof service: at most preliminary + final proof. */
const path = require('path');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { createPrivacyArtifactLoader } = require('./privacy-artifacts');
const { runPrivacyProcess } = require('./privacy-process');
const { verifyPPv2Proof } = require('./ppv2-proof-verifier');
const { FIELD, NATIVE, validProof, formatProof } = require('./ppv2-deposit-policy');
const { ARTIFACTS, validWitness } = require('./ppv2-transact-policy');
const fail = () =>
  privacyError(
    'PRIVATE_PPV2_WITHDRAWAL_REFUSED',
    'Withdrawal proof does not match the selected note'
  );
function createPPv2TransactProver({
  handle,
  artifactHandle,
  sdkEntry,
  proverEntry,
  directory,
  manifest,
  onProgress,
}) {
  const a = getPrivacyContext(handle),
    b = getPrivacyContext(artifactHandle);
  const { role: _a, ...sa } = a.subject,
    { role: _b, ...sb } = b.subject;
  if (
    a.subject.role !== 'prover' ||
    b.subject.role !== 'artifacts' ||
    a.profileId !== b.profileId ||
    a.generation !== b.generation ||
    JSON.stringify(sa) !== JSON.stringify(sb) ||
    !path.isAbsolute(sdkEntry) ||
    !path.isAbsolute(proverEntry) ||
    ARTIFACTS.some(
      (e) =>
        manifest?.transact_1x1?.[`${e.kind}Sha256`]?.replace(/^0x/, '').toLowerCase() !== e.sha256
    )
  )
    throw fail();
  require('./ppv2-runtime').assertPPv2RuntimeEntries({ sdkEntry, proverEntry });
  const loader = createPrivacyArtifactLoader({
    handle: artifactHandle,
    directory,
    manifest: ARTIFACTS,
  });
  let current;
  const service = Object.freeze({
    async proveTransact(witness, n, m) {
      getPrivacyContext(handle);
      const op = current;
      if (
        !op ||
        op.running ||
        op.count >= 2 ||
        n !== 1 ||
        m !== 1 ||
        !validWitness(witness) ||
        BigInt(witness.tokenId) !== BigInt(op.token) ||
        BigInt(witness.ownerAddress) !== BigInt(op.owner) ||
        BigInt(witness.value[0]) !== op.value ||
        BigInt(witness.amountOut) < op.amount ||
        BigInt(witness.amountOut) > op.amount + op.maxFee
      )
        throw fail();
      op.running = true;
      op.count++;
      op.proof = null;
      const w = structuredClone(witness),
        artifacts = {};
      try {
        for (const e of ARTIFACTS) artifacts[e.kind] = await loader.load(e.name);
        const expected = [
          w.stateRoot,
          w.keystoreRoot,
          w.associationSetRoot,
          w.amountOut,
          op.token,
          `0x${(BigInt(w.context) % FIELD).toString(16)}`,
        ];
        const { result } = await runPrivacyProcess({
          handle,
          filename: path.join(__dirname, 'ppv2-transact-job.js'),
          onProgress,
          input: { sdkEntry, proverEntry, witness: w, artifacts, commitment: op.commitment },
          validateResult: (v) =>
            v?.verified === true &&
            validProof(v.proof, 8) &&
            BigInt(v.proof.publicSignals[0]) === BigInt(op.nullifier) &&
            expected.every((x, i) => BigInt(x) === BigInt(v.proof.publicSignals[i + 2])),
        });
        getPrivacyContext(handle);
        if (op !== current) throw fail();
        await verifyPPv2Proof({
          handle,
          sdkEntry,
          proverEntry,
          circuit: 'transact_1x1',
          proof: result.proof,
          vkey: artifacts.verificationKey,
        });
        getPrivacyContext(handle);
        if (op !== current) throw fail();
        const freeze = (v) => {
          if (v && typeof v === 'object') {
            Object.values(v).forEach(freeze);
            Object.freeze(v);
          }
          return v;
        };
        op.proof = freeze(result.proof);
        return op.proof;
      } finally {
        op.running = false;
      }
    },
    formatForEVM(proof) {
      getPrivacyContext(handle);
      if (!current || current.proof !== proof) throw fail();
      return formatProof(proof);
    },
  });
  return Object.freeze({
    service,
    async prepare(intent, task) {
      getPrivacyContext(handle);
      if (
        current ||
        typeof intent.amount !== 'bigint' ||
        intent.amount <= 0n ||
        typeof intent.maxFee !== 'bigint' ||
        intent.maxFee < 0n ||
        typeof intent.value !== 'bigint' ||
        intent.value < intent.amount ||
        intent.value >= 1n << 128n ||
        intent.maxFee >= 1n << 128n ||
        !/^0x[0-9a-f]{64}$/i.test(intent.commitment) ||
        typeof intent.nullifier !== 'string' ||
        !/^0x[0-9a-f]{1,64}$/i.test(intent.nullifier) ||
        BigInt(intent.nullifier) >= FIELD ||
        !/^0x[0-9a-f]{40}$/i.test(intent.owner)
      )
        throw fail();
      const token = intent.token ?? NATIVE;
      if (typeof token !== 'string' || !/^0x[0-9a-f]{40}$/i.test(token) || BigInt(token) === 0n)
        throw fail();
      current = { ...intent, token, count: 0 };
      try {
        const value = await task();
        getPrivacyContext(handle);
        if (current.running || current.count !== 2 || !current.proof) throw fail();
        return { value, proof: current.proof };
      } catch {
        getPrivacyContext(handle);
        throw fail();
      } finally {
        current = null;
      }
    },
  });
}
module.exports = { createPPv2TransactProver };
