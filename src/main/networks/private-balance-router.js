/** Experimental balance-only route. It never enters ordinary source fallback. */
const { getPrivacyContext, privacyError } = require('./privacy-context');
const { createPrivateRpc, isQuantity } = require('./private-rpc');

function assertBalanceRequest(context, method, params) {
  const { subject, requirements } = context;
  if (subject.chainId !== 11155111 || subject.kind !== 'public-address' || subject.role !== 'balance-rpc' ||
      requirements.content !== 'public' || requirements.correctness !== 'any' || requirements.maxAgeMs !== null) {
    throw privacyError('UNSUPPORTED_PRIVACY_REQUIREMENTS', 'Experimental balance route cannot meet these requirements');
  }
  const native = method === 'eth_getBalance' && params?.length === 2 &&
    params[0]?.toLowerCase?.() === subject.principal && params[1] === 'latest';
  const call = params?.[0];
  const token = method === 'eth_call' && params?.length === 2 && params[1] === 'latest' &&
    call && Object.keys(call).every((key) => ['to', 'data'].includes(key)) &&
    /^0x[0-9a-f]{40}$/i.test(call.to) && typeof call.data === 'string' &&
    (call.data.toLowerCase() === '0x313ce567' ||
      call.data.toLowerCase() === `0x70a08231${'0'.repeat(24)}${subject.principal.slice(2)}`);
  if (!native && !token) throw privacyError('PRIVATE_BALANCE_REQUEST_REFUSED', 'Only single-account balance reads are supported');
}

async function requestPrivateBalance(chainId, method, params, { privacyContext, includeTrust, signal } = {}) {
  const context = getPrivacyContext(privacyContext, chainId);
  const { isWalletTorExperimentAvailable, loadSettings } = require('../settings-store');
  if (!isWalletTorExperimentAvailable() || loadSettings().walletTorBalanceReads !== true) {
    throw privacyError('PRIVACY_TRANSPORT_UNAVAILABLE', 'Experimental wallet transport is unavailable');
  }
  assertBalanceRequest(context, method, params);
  const client = createPrivateRpc(privacyContext, 'balance-rpc', { signal });
  const response = await client.request(method, params, isQuantity);
  if (!includeTrust) delete response.trust;
  return response;
}

module.exports = { requestPrivateBalance };
