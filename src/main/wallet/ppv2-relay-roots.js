/** Last pre-journal refusal check. RPC is unverified; a positive observation
 * does not establish canonical state or remove the race before inclusion.
 */
const { Interface } = require('ethers');
const { FIELD } = require('./ppv2-deposit-policy');
const { privacyError, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivateRpc } = require('../networks/private-rpc');
const ABI = new Interface([
  'function latestASPRoot() view returns(uint256)',
  'function isKnownRoot(uint256) view returns(bool)',
]);
async function assertCurrentPPv2Roots({ handle, deployment, publicSignals, signal }) {
  const fail = () =>
    privacyError('PRIVATE_PPV2_ROOTS_STALE', 'Proof roots could not be confirmed before handoff');
  const active = () => {
    if (signal?.aborted) throw fail();
  };
  let rpc;
  try {
    active();
    const { subject } = getPrivacyContext(handle);
    if (
      subject.kind !== 'private-account' ||
      subject.protocol !== 'privacy-pools-v2' ||
      subject.deployment !== 'sepolia' ||
      subject.role !== 'protocol-rpc' ||
      subject.chainId !== 11155111 ||
      !/^0x[0-9a-f]{64}$/.test(subject.operation || '')
    )
      throw fail();
    rpc = createPrivateRpc(handle, 'protocol-rpc', { signal });
    if (!Array.isArray(publicSignals) || publicSignals.length !== 8) throw fail();
    const [stateRoot, keystoreRoot, aspRoot] = publicSignals.slice(2, 5).map(BigInt);
    if ([stateRoot, keystoreRoot, aspRoot].some((v) => v < 0n || v >= FIELD)) throw fail();
    const targets = [
      deployment.aspRegistryAddress,
      deployment.poolAddress,
      deployment.keystoreAddress,
    ];
    for (const [to, name, args, expected] of [
      [targets[0], 'latestASPRoot', [], aspRoot],
      [targets[1], 'isKnownRoot', [stateRoot], true],
      [targets[2], 'isKnownRoot', [keystoreRoot], true],
    ]) {
      active();
      const { result: raw } = await rpc.request(
        'eth_call',
        [{ to, data: ABI.encodeFunctionData(name, args) }, 'latest'],
        (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)
      );
      active();
      const result = ABI.decodeFunctionResult(name, raw);
      if (
        ABI.encodeFunctionResult(name, result).toLowerCase() !== raw.toLowerCase() ||
        result[0] !== expected
      )
        throw fail();
    }
  } catch {
    throw fail();
  } finally {
    rpc?.release();
  }
}
module.exports = { assertCurrentPPv2Roots, ABI };
