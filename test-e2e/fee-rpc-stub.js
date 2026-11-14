// Two loopback JSON-RPC endpoints for one chain that answer a fee quote, and
// nothing else, so the identity core has fee evidence of its own in a spec
// whose chain is otherwise stubbed in main.
//
// From APB-1b (freedom-core design 0012) a site's standing rule answers a
// send through the core, which judges its fee on the newest
// `chain.fee_reference` reply it served itself: a figure main sends is never
// used, so the harness's fee fixture, which main reads instead of the core,
// gives the core none. A spec that wants a rule to answer a send points the
// chain at these endpoints (network-config.json), names them as two
// providers through the test-only seam FREEDOM_E2E_PROVIDER_IDENTITIES
// (src/main/networks/e2e-provider-identities.js), and has main ask the core
// for its evidence (the harness's `setFeeReferenceFixture('core')`).
//
// They answer `eth_gasPrice` with the spec's gas price, `eth_chainId` with
// the chain, and the latest block with no base fee (a legacy quote); every
// other method is an error. The quote they make together is the fixture's:
// a legacy gas price from two endpoints.

const http = require('http');

function answer(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function failure(id, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message } };
}

/**
 * @param {object} options
 * @param {number} options.chainId
 * @param {string} options.gasPrice - wei, decimal
 * @returns {Promise<{urls: string[], setGasPrice: (wei: string) => void, close: () => Promise<void>}>}
 */
async function startFeeRpcStub({ chainId, gasPrice }) {
  let price = BigInt(gasPrice);
  const respond = (call) => {
    switch (call?.method) {
      case 'eth_chainId':
        return answer(call.id, '0x' + chainId.toString(16));
      case 'eth_gasPrice':
        return answer(call.id, '0x' + price.toString(16));
      case 'eth_getBlockByNumber':
        return answer(call.id, {
          number: '0x1',
          hash: '0x' + '11'.repeat(32),
          parentHash: '0x' + '22'.repeat(32),
          timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          transactions: [],
        });
      default:
        return failure(call?.id, `${call?.method} is not served here`);
    }
  };
  const servers = [];
  const urls = [];
  for (let i = 0; i < 2; i += 1) {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body;
        try {
          const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          body = Array.isArray(call) ? call.map(respond) : respond(call);
        } catch {
          body = failure(null, 'unparsed request');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    urls.push(`http://127.0.0.1:${server.address().port}/`);
  }
  return {
    urls,
    setGasPrice: (wei) => {
      price = BigInt(wei);
    },
    close: () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve())))),
  };
}

module.exports = { startFeeRpcStub };
