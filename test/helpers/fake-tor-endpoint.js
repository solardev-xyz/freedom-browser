/**
 * tor-manager's endpoint API for IPFS (`getIpfsSocksEndpoint`,
 * `onIpfsSocksEndpointChange`) and for Radicle (`getRadicleSocksEndpoint`,
 * `onRadicleSocksEndpointChange`), which offer the same endpoint, with
 * `offer()` to change what it offers: an endpoint `{ ip, port }`, or null.
 */
function fakeTorEndpoint() {
  const listeners = new Set();
  let endpoint = null;
  const get = () => ({ endpoint, refused: null });
  const on = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    listeners,
    getIpfsSocksEndpoint: get,
    onIpfsSocksEndpointChange: on,
    getRadicleSocksEndpoint: get,
    onRadicleSocksEndpointChange: on,
    offer(next) {
      endpoint = next;
      for (const listener of [...listeners]) listener({ endpoint, refused: null });
    },
  };
}

module.exports = { fakeTorEndpoint };
