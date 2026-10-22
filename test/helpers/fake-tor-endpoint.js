/**
 * tor-manager's endpoint API for IPFS (`getIpfsSocksEndpoint`,
 * `onIpfsSocksEndpointChange`), with `offer()` to change what it offers:
 * an endpoint `{ ip, port }`, or null.
 */
function fakeTorEndpoint() {
  const listeners = new Set();
  let endpoint = null;
  return {
    listeners,
    getIpfsSocksEndpoint: () => ({ endpoint, refused: null }),
    onIpfsSocksEndpointChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    offer(next) {
      endpoint = next;
      for (const listener of [...listeners]) listener({ endpoint, refused: null });
    },
  };
}

module.exports = { fakeTorEndpoint };
