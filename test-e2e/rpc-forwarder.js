// A second JSON-RPC endpoint for the Safe E2E's anvil fork: a plain
// forwarder on a loopback port of its own.
//
// The chain router counts providers, not URLs (#1094), and every loopback
// endpoint is one provider, whatever its port: a local process can listen
// on, or forward itself to, as many ports as it likes. So this forwarder
// alone is no second provider. The fixtures name anvil and the forwarder as
// two through a test-only seam, FREEDOM_E2E_PROVIDER_IDENTITIES
// (src/main/networks/e2e-provider-identities.js), which only an unpackaged
// app honors. The fork's answers through both then make a verified quorum,
// as two providers that agree would. It exercises the Safe flow's labels,
// not independent providers: both answers are the same anvil's.
//
// Two anvil processes forking the same chain can't stand in for it. A
// broadcast goes to one endpoint (Direct walks them in order), so the other
// fork never sees the Safe's deployment and the two never agree on its code;
// and each mines its own blocks, so their receipts never agree either.

const http = require('http');

/** `method(first param)` for a JSON-RPC body, for the log. */
function describeCall(body) {
  try {
    const call = JSON.parse(body.toString('utf8'));
    const calls = Array.isArray(call) ? call : [call];
    return calls
      .map((c) => `${c?.method}(${JSON.stringify(c?.params?.[0] ?? '').slice(0, 66)})`)
      .join(', ');
  } catch {
    return '(unparsed body)';
  }
}

/** The JSON-RPC error in an answer, if any, for the log. */
function describeError(body) {
  try {
    const answer = JSON.parse(body.toString('utf8'));
    const errors = (Array.isArray(answer) ? answer : [answer]).map((a) => a?.error).filter(Boolean);
    return errors.length ? ` error ${JSON.stringify(errors).slice(0, 300)}` : '';
  } catch {
    return ' (unparsed answer)';
  }
}

/**
 * Forward every JSON-RPC POST on 127.0.0.1:`port` to `targetUrl`.
 *
 * `log(line)`, when given, gets one line per exchange: the call, how long
 * the target took, and its status or error, so a failed attempt's
 * diagnostics show what the fork answered (#1101).
 *
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function startRpcForwarder(targetUrl, port, { log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const request = Buffer.concat(chunks);
      const started = Date.now();
      try {
        const upstream = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: request,
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        log(
          `${describeCall(request)} -> ${upstream.status} in ${Date.now() - started} ms` +
            describeError(body)
        );
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch (err) {
        log(
          `${describeCall(request)} -> 502 in ${Date.now() - started} ms: ` +
            `${err?.message}${err?.cause ? ` (${err.cause.code || err.cause.message})` : ''}`
        );
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
