/** Main-owned, allowlisted standard ERC-20 deposit policy. Amounts are raw units. */
const { Interface } = require('ethers');
const { privacyError } = require('../networks/privacy-context');
const { NATIVE } = require('./ppv2-deposit-policy');
const TOKEN_ABI = [
  'function allowance(address,address) view returns(uint256)',
  'function balanceOf(address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
];
const tokenABI = new Interface(TOKEN_ABI);
const poolABI = new Interface([
  'function assets(address) view returns(tuple(bool enabled,uint256 minAmount,uint256 vettingFeeBPS,uint256 maxRelayFee))',
]);
const address = (v) => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && BigInt(v) !== 0n;
const fail = () =>
  privacyError('PRIVATE_PPV2_TOKEN_REFUSED', 'Token operation does not match its reviewed intent');
function createPPv2TokenPolicy({ configuration, provider }) {
  const allowed = configuration.erc20Tokens ?? [];
  if (
    !Array.isArray(allowed) ||
    allowed.length > 12 ||
    !allowed.every(
      (v) =>
        address(v) &&
        v.toLowerCase() !== NATIVE &&
        configuration.contracts.some((c) => c.address.toLowerCase() === v.toLowerCase())
    ) ||
    new Set(allowed.map((v) => v.toLowerCase())).size !== allowed.length
  )
    throw fail();
  const tokens = new Set(allowed.map((v) => v.toLowerCase()));
  const owner = configuration.ownerAddress.toLowerCase(),
    spender = configuration.deployment.entrypointAddress.toLowerCase();
  function assertToken(token) {
    if (!address(token) || !tokens.has(token.toLowerCase())) throw fail();
  }
  async function read({ token, amount, maxFee }) {
    if (
      !address(token) ||
      !tokens.has(token.toLowerCase()) ||
      typeof amount !== 'bigint' ||
      amount <= 0n ||
      amount >= 1n << 128n ||
      typeof maxFee !== 'bigint' ||
      maxFee < 0n ||
      maxFee >= 1n << 128n
    )
      throw fail();
    token = token.toLowerCase();
    const call = async (abi, to, name, args) => {
      const raw = await provider.call({ to, data: abi.encodeFunctionData(name, args) });
      const decoded = abi.decodeFunctionResult(name, raw);
      if (abi.encodeFunctionResult(name, decoded).toLowerCase() !== raw.toLowerCase()) throw fail();
      return decoded[0];
    };
    try {
      const asset = await call(poolABI, spender, 'assets', [token]);
      const fee = (amount * asset.vettingFeeBPS) / 10000n,
        total = amount + fee;
      if (!asset.enabled || amount < asset.minAmount || fee > maxFee || total >= 1n << 128n)
        throw fail();
      const allowance = await call(tokenABI, token, 'allowance', [owner, spender]);
      const balance = await call(tokenABI, token, 'balanceOf', [owner]);
      if (balance < total) throw fail();
      return Object.freeze({ token, amount, maxFee, fee, total, allowance, balance });
    } catch {
      throw fail();
    }
  }
  async function approval(intent) {
    const state = await read(intent);
    if (state.allowance === state.total) return null;
    const approvalAmount = state.allowance === 0n ? state.total : 0n;
    return Object.freeze({
      ...state,
      kind: 'ppv2-token-approval',
      chainId: 11155111,
      from: owner,
      to: state.token,
      spender,
      approvalAmount,
      value: 0n,
      data: tokenABI.encodeFunctionData('approve', [spender, approvalAmount]),
      proofVerified: false,
      chainStateVerified: false,
    });
  }
  async function check(prepared) {
    const state = await read(prepared);
    if (state.fee !== prepared.fee) throw fail();
    if (prepared.kind === 'ppv2-token-deposit' && state.allowance !== state.total) throw fail();
    if (
      prepared.kind === 'ppv2-token-approval' &&
      (state.allowance !== prepared.allowance ||
        state.allowance === state.total ||
        prepared.approvalAmount !== (state.allowance === 0n ? state.total : 0n))
    )
      throw fail();
  }
  return Object.freeze({ read, approval, check, assertToken });
}
module.exports = { createPPv2TokenPolicy, TOKEN_ABI };
