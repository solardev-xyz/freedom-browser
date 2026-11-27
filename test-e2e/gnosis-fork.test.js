// The Safe E2E fork's failover proxy (gnosis-fork.js, #536): a provider
// that stalls, errors or answers with a JSON-RPC error must not become
// anvil's answer while another provider can give a good one.

const http = require('http');
const {
  localReply,
  parseChainIdProbe,
  startForkUpstream,
  usableReply,
  warmSharedState,
} = require('./gnosis-fork');

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

  test('refuse() answers pending and new reads at once until resumed', async () => {
    let stall = true;
    const a = await open(await fakeUpstream(() => (stall ? 'stall' : { status: 200, body: OK })));
    const proxy = await open(await startForkUpstream([a.url], { attemptTimeoutMs: 20_000 }));
    const pending = post(proxy.url);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resume = proxy.refuse();
    expect(await pending).toEqual({ status: 500, text: '' });
    expect(await post(proxy.url)).toEqual({ status: 500, text: '' });
    expect(a.hits).toHaveLength(1); // the refused new read never went upstream
    resume();
    stall = false;
    expect(await post(proxy.url)).toEqual({ status: 200, text: OK });
  });
});

describe('gnosis-fork warm-up', () => {
  const opened = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((thing) => thing.close()));
  });

  test('a warm-up past its budget has its upstream reads stopped, not left running', async () => {
    // The warm-up's reads stand for anvil's: anvil keeps reading for a call
    // whose client has gone, so only the proxy can stop them.
    let stall = true;
    const a = await fakeUpstream(() => (stall ? 'stall' : { status: 200, body: OK }));
    opened.push(a);
    const proxy = await startForkUpstream([a.url], { attemptTimeoutMs: 20_000 });
    opened.push(proxy);
    const reads = [];
    const lines = [];
    const started = Date.now();
    await warmSharedState(null, proxy, (line) => lines.push(line), {
      budgetMs: 200,
      warm: async () => {
        // Like an anvil call, a chain of reads that fails on a failed read.
        for (let i = 0; i < 3; i += 1) {
          const reply = await post(proxy.url);
          reads.push(reply);
          if (reply.status !== 200) throw new Error(`read failed: HTTP ${reply.status}`);
        }
      },
    });
    expect(Date.now() - started).toBeLessThan(1500);
    // The chain failed at its first refused read and issued no more.
    expect(reads).toEqual([{ status: 500, text: '' }]);
    expect(a.hits).toHaveLength(1);
    expect(lines.join('\n')).toMatch(
      /stopped at its 200ms budget, its upstream reads refused \(settled\)/
    );
    // ...and the proxy forwards again for the app.
    stall = false;
    expect(await post(proxy.url)).toEqual({ status: 200, text: OK });
  });

  test('a warm-up inside its budget refuses nothing', async () => {
    const a = await fakeUpstream(() => ({ status: 200, body: OK }));
    opened.push(a);
    const proxy = await startForkUpstream([a.url]);
    opened.push(proxy);
    const lines = [];
    await warmSharedState(null, proxy, (line) => lines.push(line), {
      budgetMs: 2000,
      warm: async () => {
        expect(await post(proxy.url)).toEqual({ status: 200, text: OK });
      },
    });
    expect(lines.join('\n')).toMatch(/^warmed /);
    expect(await post(proxy.url)).toEqual({ status: 200, text: OK });
  });
});

describe('gnosis-fork upstream probe', () => {
  test('the probe time is what follows the last newline, so a trailing newline in the body is not 0 ms', () => {
    // publicnode's body ends in a newline of its own (measured 2026-11-27).
    const publicnode = parseChainIdProbe('{"jsonrpc":"2.0","id":1,"result":"0x64"}\n\n0.0667');
    expect(publicnode.chainId).toBe(100);
    expect(publicnode.ms).toBeCloseTo(66.7);
    expect(parseChainIdProbe('{"jsonrpc":"2.0","id":1,"result":"0x64"}\n0.25')).toEqual({
      chainId: 100,
      ms: 250,
    });
    expect(
      parseChainIdProbe('{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "result": "0x64"\n}\n1.5')
    ).toEqual({ chainId: 100, ms: 1500 });
  });

  test('an unreadable time sorts last, and a non-JSON body is no answer', () => {
    expect(parseChainIdProbe('{"result":"0x64"}\n')).toEqual({ chainId: 100, ms: Infinity });
    expect(parseChainIdProbe('{"result":"0x64"}\nabc')).toEqual({ chainId: 100, ms: Infinity });
    expect(parseChainIdProbe('<html>\n0.1')).toBeNull();
    expect(parseChainIdProbe('{"result":"0x64"}')).toBeNull();
  });
});
