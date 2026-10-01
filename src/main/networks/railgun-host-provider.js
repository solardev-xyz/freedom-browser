/** Runtime-injected ethers provider bridge. No engine dependency or URL transport
 * is loaded here. The host provider must itself enforce account/deployment grants.
 * This bridge never grants writes; reviewed broadcasting remains a host operation.
 */
const METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
]);
function refused(code = 'RAILGUN_RPC_REFUSED') {
  return Object.assign(new Error('Railgun host RPC unavailable'), { code });
}
const lockedFetchClasses = new WeakSet();
// Call in the isolated runtime, with that runtime's own ethers instance, before
// loading engine code. This is deliberately not invoked in Freedom's main process.
function lockRailgunHttp(FetchRequest) {
  if (lockedFetchClasses.has(FetchRequest)) return;
  if (
    typeof FetchRequest?.registerGetUrl !== 'function' ||
    typeof FetchRequest?.lockConfig !== 'function'
  )
    throw refused();
  FetchRequest.registerGetUrl(async () => {
    throw refused();
  });
  FetchRequest.lockConfig();
  lockedFetchClasses.add(FetchRequest);
}

function createRailgunHostProvider({ PollingJsonRpcProvider, provider, chainId, signal }) {
  if (
    typeof PollingJsonRpcProvider !== 'function' ||
    typeof provider?.request !== 'function' ||
    chainId !== 11155111 ||
    !(signal instanceof AbortSignal) ||
    signal.aborted ||
    provider.signal !== signal
  )
    throw refused();
  const assertActive = () => {
    if (signal.aborted) throw refused('RAILGUN_RPC_REVOKED');
  };
  class HostProvider extends PollingJsonRpcProvider {
    #closed = false;
    destroy() {
      this.#closed = true;
      return super.destroy();
    }
    async getFeeData() {
      throw refused();
    }
    async resolveName() {
      throw refused();
    }
    async lookupAddress() {
      throw refused();
    }
    async getResolver() {
      throw refused();
    }
    async getAvatar() {
      throw refused();
    }
    _getConnection() {
      // Guard even a future accidental call to the inherited URL transport.
      throw refused();
    }
    async _send(payload) {
      assertActive();
      if (this.#closed) throw refused('RAILGUN_RPC_REVOKED');
      let requests;
      try {
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized) > 65536) throw refused();
        const copy = JSON.parse(serialized);
        requests = Array.isArray(copy) ? copy : [copy];
        if (
          !requests.length ||
          requests.length > 32 ||
          requests.some(
            (r) =>
              !r ||
              r.jsonrpc !== '2.0' ||
              !Number.isSafeInteger(r.id) ||
              r.id < 0 ||
              !METHODS.has(r.method) ||
              !Array.isArray(r.params) ||
              Object.keys(r).some((k) => !['jsonrpc', 'id', 'method', 'params'].includes(k))
          ) ||
          new Set(requests.map((r) => r.id)).size !== requests.length
        )
          throw refused();
      } catch {
        throw refused();
      }
      const results = [];
      for (const request of requests) {
        assertActive();
        let result;
        try {
          result = await provider.request(
            { method: request.method, params: request.params },
            { signal }
          );
        } catch {
          assertActive();
          // Remote messages can contain URLs, queries and account data.
          throw refused();
        }
        assertActive();
        if (this.#closed) throw refused('RAILGUN_RPC_REVOKED');
        if (
          request.method === 'eth_chainId' &&
          (typeof result !== 'string' ||
            !/^0x[0-9a-f]+$/i.test(result) ||
            BigInt(result) !== BigInt(chainId))
        )
          throw refused();
        try {
          results.push({ jsonrpc: '2.0', id: request.id, result: structuredClone(result) });
        } catch {
          throw refused();
        }
      }
      return results;
    }
  }
  // The base class requires a URL, but _send and _getConnection never use it.
  const bridge = new HostProvider('https://railgun-host.invalid', chainId, 10000, 32);
  bridge.disableCcipRead = true;
  Object.defineProperty(bridge, 'disableCcipRead', { value: true, writable: false });
  signal.addEventListener('abort', () => bridge.destroy(), { once: true });
  return bridge;
}

module.exports = { createRailgunHostProvider, lockRailgunHttp };
