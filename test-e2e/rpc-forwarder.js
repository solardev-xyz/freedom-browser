// A second JSON-RPC endpoint for the Safe E2E's anvil fork: a plain
// forwarder on a loopback port of its own.
//
// The chain router counts providers, not URLs (#1094): `127.0.0.1` and
// `localhost` are one loopback host, so the fork listed under both names is
// one endpoint and no quorum. A loopback port is a process of its own, so
// this forwarder is a second endpoint, and the fork's answers through both
// make a verified quorum, as two providers that agree would. It exercises
// the Safe flow's labels, not independent providers: both answers are the
// same anvil's.
//
// Two anvil processes forking the same chain can't stand in for it. A
// broadcast goes to one endpoint (Direct walks them in order), so the other
// fork never sees the Safe's deployment and the two never agree on its code;
// and each mines its own blocks, so their receipts never agree either.

const http = require('http');

/**
 * Forward every JSON-RPC POST on 127.0.0.1:`port` to `targetUrl`.
 *
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function startRpcForwarder(targetUrl, port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const upstream = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.concat(chunks),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      })
    );
  });
}

module.exports = { startRpcForwarder };
