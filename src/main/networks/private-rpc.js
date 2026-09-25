/** Main-only RPC connection pinned to one context, endpoint and Tor generation.
 * Callers own method/intent authorization and result schemas. No retry/fallback.
 */
const { randomUUID } = require('crypto');
const registry = require('./network-registry');
const { getPrivacyContext, privacyError } = require('./privacy-context');
const { createWalletTorTransport } = require('./wallet-tor-transport');
let transport;

function createPrivateRpc(handle, role, { signal } = {}) {
  const context = getPrivacyContext(handle);
  const { subject, requirements } = context;
  if (!require('../settings-store').isWalletTorExperimentAvailable()) {
    throw privacyError('PRIVACY_TRANSPORT_UNAVAILABLE', 'Experimental wallet transport is unavailable');
  }
  const allowedSubject = role === 'protocol-rpc' ? subject.kind === 'private-account' : subject.kind === 'public-address';
  if (subject.chainId !== 11155111 || !allowedSubject || subject.role !== role ||
      requirements.content !== 'public' || requirements.correctness !== 'any' || requirements.maxAgeMs !== null) {
    throw privacyError('UNSUPPORTED_PRIVACY_REQUIREMENTS', 'Experimental RPC cannot meet these requirements');
  }
  const network = registry.getNetwork(subject.chainId);
  if (!network || !(network.access?.readOrder || ['colibri', 'quorum', 'direct']).includes('direct')) {
    throw privacyError('PRIVATE_SOURCE_UNAVAILABLE', 'No eligible source under this chain policy');
  }
  const sources = registry.getEndpointSources(subject.chainId, 'rpc');
  const eligible = new Set(sources.filter((source) => !source.keyed).map((source) => source.coverage?.[String(subject.chainId)]));
  const url = registry.getEndpoints(subject.chainId, 'rpc').find((value) => {
    if (!eligible.has(value)) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch { return false; }
  });
  if (!url) throw privacyError('PRIVATE_SOURCE_UNAVAILABLE', 'No eligible unkeyed HTTPS RPC endpoint');
  const tor = require('../tor-manager');
  const endpoint = tor.getWalletSocksEndpoint();
  if (!endpoint || endpoint.signal.aborted) throw privacyError('TOR_NOT_READY', 'Managed Tor is not ready');
  const lifetime = AbortSignal.any([context.signal, endpoint.signal, ...(signal ? [signal] : [])]);
  const trust = Object.freeze({ level: 'unverified', method: 'direct', block: null,
    agreed: Object.freeze([new URL(url).host]), dissented: Object.freeze([]), queried: Object.freeze([new URL(url).host]),
    quorum: Object.freeze({ k: 1, m: 1, achieved: false }),
  });
  const privacy = Object.freeze({ mode: 'tor-experimental', transport: 'authenticated-socks', circuitIsolation: 'unqualified' });
  let chainCheck;
  function assertActive() {
    getPrivacyContext(handle);
    if (lifetime.aborted || endpoint !== tor.getWalletSocksEndpoint()) {
      throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private RPC lifetime ended');
    }
  }
  async function raw(method, params) {
    assertActive();
    transport ||= createWalletTorTransport();
    const id = randomUUID();
    const response = await transport.request(handle, url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: lifetime,
      timeoutMs: Math.min(120000, Math.max(500, Number(network.quorum?.timeoutMs) || 30000)),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    assertActive();
    let data;
    try { data = JSON.parse(response.body.toString('utf8')); } catch {
      throw privacyError('PRIVATE_RPC_INVALID', 'Invalid private RPC response');
    }
    if (response.status !== 200 || !data || Array.isArray(data) || data.jsonrpc !== '2.0' || data.id !== id ||
        Object.hasOwn(data, 'error') || !Object.hasOwn(data, 'result')) {
      throw privacyError('PRIVATE_RPC_INVALID', 'Invalid private RPC response');
    }
    return data.result;
  }
  async function ready() {
    assertActive();
    chainCheck ||= raw('eth_chainId', []).then((chain) => {
      if (!isQuantity(chain) || BigInt(chain) !== BigInt(subject.chainId)) {
        throw privacyError('PRIVATE_CHAIN_MISMATCH', 'RPC endpoint returned a different chain');
      }
    });
    await chainCheck;
    assertActive();
  }
  async function request(method, params, validate) {
    await ready();
    const result = await raw(method, params);
    if (!validate(result)) throw privacyError('PRIVATE_RPC_INVALID', 'Invalid private RPC result');
    return { result, source: 'direct', verified: false, trust, privacy, observedAt: new Date().toISOString() };
  }
  return Object.freeze({ request, ready, assertActive, signal: lifetime, trust, privacy });
}

function isQuantity(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value);
}

module.exports = { createPrivateRpc, isQuantity };
