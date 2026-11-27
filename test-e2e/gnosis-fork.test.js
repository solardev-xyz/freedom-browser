// The Safe E2E fork's failover proxy (gnosis-fork.js, #536): a provider
// that stalls, errors or answers with a JSON-RPC error must not become
// anvil's answer while another provider can give a good one.

const http = require('http');
const { localReply, startForkUpstream, usableReply } = require('./gnosis-fork');

const OK = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';

/** A local upstream: `behave(req)` returns { status, body } or 'stall'. */
function fakeUpstream(behave) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hits.push(body);
      const reply = behave(body);
      if (reply === 'stall') return; // never answers
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.body);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      })
    )
  );
}

async function post(url, body = '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":[]}') {
  const res = await fetch(url, { method: 'POST', body });
  return { status: res.status, text: await res.text() };
}

describe('gnosis-fork upstream proxy', () => {
  const opened = [];
  const open = async (thing) => {
    opened.push(thing);
    return thing;
  };
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((thing) => thing.close()));
  });

  test('usableReply accepts only a 200 JSON reply without a JSON-RPC error', () => {
    expect(usableReply(200, OK)).toBeNull();
    expect(usableReply(200, `[${OK},${OK}]`)).toBeNull();
    expect(usableReply(429, OK)).toMatch(/HTTP 429/);
    expect(usableReply(200, '<html>')).toMatch(/not JSON/);
    expect(usableReply(200, '{"id":1,"error":{"code":-32002,"message":"No state"}}')).toMatch(
      /JSON-RPC error/
    );
    expect(usableReply(200, `[${OK},{"id":2,"error":{"code":-32005}}]`)).toMatch(/JSON-RPC error/);
  });

  test('a stalled provider is hedged: the next one answers well inside 5 s', async () => {
    const stalled = await open(await fakeUpstream(() => 'stall'));
    const good = await open(await fakeUpstream(() => ({ status: 200, body: OK })));
    const lines = [];
    const proxy = await open(
      await startForkUpstream([stalled.url, good.url], {
        hedgeAfterMs: 200,
        log: (line) => lines.push(line),
      })
    );

    const started = Date.now();
    const reply = await post(proxy.url);
    expect(reply).toEqual({ status: 200, text: OK });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(stalled.hits).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/hedge eth_getCode: .* silent for 200ms/);
  });

  test('an error reply fails over at once, without waiting for the hedge', async () => {
    const erroring = await open(
      await fakeUpstream(() => ({
        status: 200,
        body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"header not found"}}',
      }))
    );
    const limited = await open(await fakeUpstream(() => ({ status: 429, body: '{}' })));
    const good = await open(await fakeUpstream(() => ({ status: 200, body: OK })));
    const lines = [];
    const proxy = await open(
      await startForkUpstream([erroring.url, limited.url, good.url], {
        hedgeAfterMs: 5000,
        log: (line) => lines.push(line),
      })
    );

    const started = Date.now();
    expect(await post(proxy.url)).toEqual({ status: 200, text: OK });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines.join('\n')).toMatch(/header not found/);
    expect(lines.join('\n')).toMatch(/HTTP 429/);
  });

  test('a provider that stalled goes to the back, so the next read does not wait on it', async () => {
    let stalling = true;
    const flaky = await open(
      await fakeUpstream(() => (stalling ? 'stall' : { status: 200, body: OK }))
    );
    const good = await open(await fakeUpstream(() => ({ status: 200, body: OK })));
    const proxy = await open(
      await startForkUpstream([flaky.url, good.url], { hedgeAfterMs: 200, benchMs: 60_000 })
    );

    await post(proxy.url); // hedged once, flaky benched
    stalling = false;
    await post(proxy.url);
    expect(flaky.hits).toHaveLength(1);
    expect(good.hits).toHaveLength(2);
  });

  test('providers are tried in the order given (fastest first) while healthy', async () => {
    const a = await open(await fakeUpstream(() => ({ status: 200, body: OK })));
    const b = await open(await fakeUpstream(() => ({ status: 200, body: OK })));
    const proxy = await open(await startForkUpstream([a.url, b.url]));
    await post(proxy.url);
    await post(proxy.url);
    expect(a.hits).toHaveLength(2);
    expect(b.hits).toHaveLength(0);
  });

  test("anvil's extension methods are answered locally, never forwarded", async () => {
    const a = await open(await fakeUpstream(() => ({ status: 200, body: OK })));
    const proxy = await open(await startForkUpstream([a.url]));
    const reply = await post(
      proxy.url,
      '{"jsonrpc":"2.0","id":7,"method":"eth_getAccountInfo","params":["0x00","0x1"]}'
    );
    expect(JSON.parse(reply.text)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'method not found' },
    });
    expect(
      JSON.parse(
        (await post(proxy.url, '[{"jsonrpc":"2.0","id":1,"method":"anvil_nodeInfo","params":[]}]'))
          .text
      )
    ).toHaveLength(1);
    expect(a.hits).toHaveLength(0);
    expect(localReply('{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":[]}')).toBeNull();
  });

  test('when every provider fails, anvil gets the last failure, not a hang', async () => {
    const body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope"}}';
    const a = await open(await fakeUpstream(() => ({ status: 200, body })));
    const b = await open(await fakeUpstream(() => ({ status: 200, body })));
    const proxy = await open(await startForkUpstream([a.url, b.url], { hedgeAfterMs: 5000 }));
    expect(await post(proxy.url)).toEqual({ status: 200, text: body });
  });

  test('every provider stalling still ends at the per-attempt timeout', async () => {
    const a = await open(await fakeUpstream(() => 'stall'));
    const proxy = await open(
      await startForkUpstream([a.url], { hedgeAfterMs: 50, attemptTimeoutMs: 300 })
    );
    expect(await post(proxy.url)).toEqual({ status: 502, text: '' });
  });
});
