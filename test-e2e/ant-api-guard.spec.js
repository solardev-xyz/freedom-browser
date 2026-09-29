// Web content must not reach the local Ant API (security audit O-1, #428).
//
// Drives the real `ant-api-guard` onBeforeRequest handler in the real tab
// <webview>: the guard keys on the requesting frame and webContents type,
// which only a real guest produces. The harness stubs http(s) in-process, so
// a request the guard lets through *succeeds* (against the stub) and one it
// cancels fails with a network error — that difference is what is asserted,
// with a request to a non-node port on the same page as the control.
//
// The harness registry points the Ant API at http://127.0.0.1:11633. A tiny
// fake node listens there so the chrome's node-status menu (which now reads
// the node over IPC from the main process, not by fetching it) has something
// to show.

const http = require('http');
const { test, expect } = require('./fixtures');

const ANT_PORT = 11633;
const HASH = 'a'.repeat(64);

async function navigateTo(page, url) {
  const input = page.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
}

// Run `script` in the active webview once `ready` (a guest expression) holds.
async function evalInGuest(page, ready, script) {
  let value;
  await expect
    .poll(
      async () => {
        value = await page.evaluate(
          async ([readyExpr, guestScript]) => {
            const wv = document.querySelector('webview:not(.hidden)');
            if (!wv || typeof wv.executeJavaScript !== 'function') return undefined;
            try {
              if (!(await wv.executeJavaScript(readyExpr))) return undefined;
              return await wv.executeJavaScript(guestScript);
            } catch {
              return undefined;
            }
          },
          [ready, script]
        );
        return value !== undefined;
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  return value;
}

// Every request shape the audit showed reaching the node, plus a control
// request to a port that is not the node's.
const PROBES = `(async () => {
  const run = async (url, init) => {
    try { await fetch(url, init); return 'reached'; } catch { return 'blocked'; }
  };
  return {
    control: await run('http://127.0.0.1:11999/x', { method: 'POST', mode: 'no-cors' }),
    stampsPost: await run('http://127.0.0.1:${ANT_PORT}/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
    walletGet: await run('http://127.0.0.1:${ANT_PORT}/wallet', { mode: 'no-cors' }),
    localhost: await run('http://localhost:${ANT_PORT}/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
    ipv6: await run('http://[::1]:${ANT_PORT}/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
    defaultPort: await run('http://127.0.0.1:1633/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
    // A node bound to 0.0.0.0 (a reused / Docker Bee) answers on every
    // address of the machine: the docker bridge, the LAN IP (#445 R1-F1).
    dockerBridge: await run('http://172.17.0.1:${ANT_PORT}/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
    lanIp: await run('http://192.168.1.20:1633/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
    sandboxedFrame: await new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-scripts';
      frame.srcdoc = '<script>fetch("http://127.0.0.1:${ANT_PORT}/stamps/1/17",{method:"POST",mode:"no-cors"})'
        + '.then(()=>parent.postMessage("reached","*"),()=>parent.postMessage("blocked","*"))<\\/script>';
      addEventListener('message', (e) => resolve(e.data), { once: true });
      document.body.appendChild(frame);
    }),
  };
})()`;

const ALL_BLOCKED = {
  control: 'reached',
  stampsPost: 'blocked',
  walletGet: 'blocked',
  localhost: 'blocked',
  ipv6: 'blocked',
  defaultPort: 'blocked',
  dockerBridge: 'blocked',
  lanIp: 'blocked',
  sandboxedFrame: 'blocked',
};

test.describe('Ant API guard (O-1)', () => {
  let server;
  let nodeRequests;

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      nodeRequests.push(`${req.method} ${req.url}`);
      const body = {
        '/peers': { peers: [{ address: '1' }, { address: '2' }, { address: '3' }] },
        '/topology': { bins: { bin_0: { population: 4 }, bin_1: { population: 5 } } },
        '/health': { status: 'ok', version: 'antd/0.5.45-e2e' },
      }[req.url];
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body || { code: 404 }));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(ANT_PORT, '127.0.0.1', resolve);
    });
  });

  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test.beforeEach(() => {
    nodeRequests = [];
  });

  test('an http page cannot reach the node API', async ({ window }) => {
    await navigateTo(window, 'http://attacker.test/');
    const result = await evalInGuest(
      window,
      '!!document.querySelector(\'[data-test="harness-http-stub-url"]\')',
      PROBES
    );
    expect(result).toEqual(ALL_BLOCKED);
  });

  test('a bzz page cannot reach the node API', async ({ window, harness }) => {
    await harness.setContentFixture(`bzz://${HASH}/`, {
      body: '<!doctype html><title>swarm page</title><p id="swarm">swarm</p>',
      contentType: 'text/html',
    });
    await navigateTo(window, `bzz://${HASH}/`);
    const result = await evalInGuest(window, "!!document.getElementById('swarm')", PROBES);
    expect(result).toEqual(ALL_BLOCKED);
  });

  test('a top-level GET navigation to the node still loads', async ({ window }) => {
    const url = `http://127.0.0.1:${ANT_PORT}/health`;
    await navigateTo(window, url);
    const shown = await evalInGuest(
      window,
      '!!document.querySelector(\'[data-test="harness-http-stub-url"]\')',
      'document.querySelector(\'[data-test="harness-http-stub-url"]\').textContent'
    );
    expect(shown).toBe(url);
  });

  // #445 R2-F1: an external node on a scheme-default port (`https://localhost`
  // behind a reverse proxy) used to make every host on 443 "the node", so
  // every site lost its subresources for the rest of the session.
  test('a node on https://localhost guards loopback only, not every site', async ({
    electronApp,
    window,
  }) => {
    await electronApp.evaluate(() => {
      process.mainModule.require('./src/main/swarm/ant-api-guard').noteAntApiUrl(
        'https://localhost'
      );
    });
    await navigateTo(window, 'http://news.test/');
    const result = await evalInGuest(
      window,
      '!!document.querySelector(\'[data-test="harness-http-stub-url"]\')',
      `(async () => {
        const run = async (url, init) => {
          try { await fetch(url, init); return 'reached'; } catch { return 'blocked'; }
        };
        return {
          cdnScript: await run('https://cdn.example.com/app.js', { mode: 'no-cors' }),
          pageCss: await run('https://news.test/x.css', { mode: 'no-cors' }),
          plainHttp: await run('http://example.org/img.png', { mode: 'no-cors' }),
          node: await run('https://localhost/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
          nodeByIp: await run('https://127.0.0.1/stamps/1/17', { method: 'POST', mode: 'no-cors' }),
        };
      })()`
    );
    expect(result).toEqual({
      cdnScript: 'reached',
      pageCss: 'reached',
      plainHttp: 'reached',
      node: 'blocked',
      nodeByIp: 'blocked',
    });
  });

  test('the chrome node menu reads the node through the main process', async ({ window }) => {
    await window.click('#bee-menu-button');
    await expect(window.locator('#bee-peers-count')).toHaveText('3');
    await expect(window.locator('#bee-network-peers')).toHaveText('9');
    await expect(window.locator('#bee-version-text')).toHaveText('Ant v0.5.45');
    // The chrome renderer's own fetch() would have hit the harness http stub,
    // never this server: every hit here came over IPC from the main process.
    expect(nodeRequests).toEqual(expect.arrayContaining(['GET /peers', 'GET /health']));
  });
});
