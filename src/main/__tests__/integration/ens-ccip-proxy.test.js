/**
 * Integration test: ENS CCIP-Read gateway fetches really do follow the
 * session's proxy configuration (#359), and every bound `ccipReadFetch` had on
 * undici survives the move onto Chromium's network stack.
 *
 * Like `ipfs-gateway-proxy.test.js` (#355), this can only be proven from a real
 * Electron main process — the unit suite (`src/main/ens/ccip-fetch.test.js`)
 * pins the wiring on a fake `net.request`, not Chromium's behaviour. This
 * spawns Electron on `ccip-proxy-electron-probe.js`, which drives the real
 * `ens/ccip-fetch.js` against the real PAC from `tor-proxy.js`, an HTTPS
 * origin with a throwaway test certificate, and a local SOCKS5 proxy standing
 * in for Arti, and asserts the probe's report.
 *
 * Skipped when the Electron binary cannot be resolved; the `ipfs-gateway-proxy`
 * CI job sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns a missing binary into
 * a failure instead (see `ipfs-gateway-proxy.test.js` for the details, including
 * why CI fetches the binary before jest starts).
 */

const { spawn } = require('child_process');
const path = require('path');

const REQUIRED = process.env.FREEDOM_ELECTRON_NET_TEST === '1';

function electronBinaryPath() {
  try {
    // Outside Electron, `require('electron')` resolves to the installed
    // binary's path (the package's own `path.txt`), on every platform.
    const resolved = jest.requireActual('electron');
    return typeof resolved === 'string' ? resolved : null;
  } catch {
    return null;
  }
}

const ELECTRON_PATH = electronBinaryPath();
if (REQUIRED && !ELECTRON_PATH) {
  throw new Error(
    'FREEDOM_ELECTRON_NET_TEST=1 but no Electron binary is installed — fetch it with ' +
      '`node -e "require(\'electron\')"` (npm ci does not, at any --ignore-scripts setting)'
  );
}
const describeWithElectron = ELECTRON_PATH ? describe : describe.skip;

const PROBE = path.join(__dirname, 'ccip-proxy-electron-probe.js');
// The probe waits out the real 15s CCIP deadline once.
const PROBE_TIMEOUT_MS = 120_000;
const CCIP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_PATH, ['--no-sandbox', '--headless', PROBE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms\n${stdout}\n${stderr}`));
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((entry) => entry.startsWith('PROBE-RESULT '));
      if (!line) {
        reject(new Error(`probe produced no result\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice('PROBE-RESULT '.length)));
    });
  });
}

describeWithElectron('ENS CCIP-Read gateway fetch in a real Electron process', () => {
  let results;

  beforeAll(async () => {
    results = await runProbe();
  }, PROBE_TIMEOUT_MS);

  test('the Tor PAC proxies an .onion CCIP gateway and leaves clearnet DIRECT', () => {
    expect(results.resolveProxy.onion).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
    expect(results.resolveProxy.clearnet).toBe('DIRECT');
  });

  // The concrete #359 case: `OffchainLookup` names `https://<name>.onion/…`.
  test('with Tor up, an .onion gateway is reached through the proxy, by name', () => {
    expect(results.onionViaTor.value).toBe('0xcafe');
    expect(results.onionViaTor.socksSeen).toEqual([
      expect.stringMatching(/^ccipgatewayprobe\.onion:\d+$/),
    ]);
  });

  // The control: what `ccip-fetch.js` did before — undici never sees the PAC,
  // so the onion name goes to the system resolver instead of the proxy.
  test('the undici fetch it replaces bypasses the proxy for the same URL', () => {
    expect(results.onionViaNodeFetch.socksSeen).toEqual([]);
    expect(results.onionViaNodeFetch.error).toBeDefined();
  });

  // The launch window: Arti still bootstrapping, no PAC on the session yet.
  // The gateway fails like any other and the name never leaves the process.
  test('before the PAC lands, an .onion gateway is refused, never dialled', () => {
    expect(results.onionBeforeTor.resolveProxy).toBe('DIRECT');
    expect(results.onionBeforeTor.code).toBe('CCIP_GATEWAY_FAILED');
    expect(results.onionBeforeTor.chromiumSaw).toEqual([]);
    expect(results.onionBeforeTor.socksSeen).toEqual([]);
    expect(results.onionBeforeTor.originSeen).toEqual([]);
  });

  test('any proxy on the session is followed, not only the Tor PAC', () => {
    expect(results.clearnetViaSessionProxy.value).toBe('0xcafe');
    expect(results.clearnetViaSessionProxy.socksSeen).toEqual([
      expect.stringMatching(/^ccip\.example\.test:\d+$/),
    ]);
  });

  test('with no proxy, a clearnet gateway is dialled DIRECT as before', () => {
    expect(results.clearnetDirect.resolveProxy).toBe('DIRECT');
    expect(results.clearnetDirect.value).toBe('0xcafe');
    expect(results.clearnetDirect.socksSeen).toEqual([]);
  });

  // #462 R1-M1/M2: a transport dial reaches the session's webRequest
  // listeners with no webContents, and the app's page-facing handlers
  // (adblock, x402-detect) must be able to recognise it at both events they
  // act on — while a bare net.request that isn't the transport's stays theirs.
  test("the app's webRequest handlers can tell a CCIP dial is the transport's own", () => {
    const events = results.clearnetDirect.listenerSaw.map(({ event, webContentsId, own }) => ({
      event,
      webContentsId,
      own,
    }));
    expect(events).toEqual([
      { event: 'onBeforeRequest', webContentsId: null, own: true },
      { event: 'onHeadersReceived', webContentsId: null, own: true },
    ]);
    expect(results.clearnetDirect.ownAfterwards).toBe(false);
    expect(results.listenerControl.length).toBeGreaterThan(0);
    expect(results.listenerControl.every((entry) => entry.own === false)).toBe(true);
  });

  test('no session cookie or credential travels to a gateway', () => {
    // Control: the cookie is really on the session and would be sent.
    expect(results.cookieControl).toEqual(['session=must-not-travel']);
    for (const leg of ['clearnetDirect', 'onionViaTor', 'post']) {
      for (const seen of results[leg].originSeen) {
        expect(seen.cookie).toBeNull();
        expect(seen.authorization).toBeNull();
      }
    }
  });

  test('a template without {data} is POSTed with the JSON body', () => {
    expect(results.post.value).toBe('0xcafe');
    const [seen] = results.post.originSeen;
    expect(seen.method).toBe('POST');
    expect(seen.contentType).toBe('application/json');
    expect(JSON.parse(seen.body)).toEqual({
      sender: '0xeeeeeeee14d718c2b47d9923deab1335e144eeee',
      data: '0x',
    });
  });

  // `redirect: 'error'`: the redirecting gateway fails, its Location is never
  // requested, and the next URL answers.
  test('a redirect is never followed; the next gateway is tried', () => {
    expect(results.redirect.value).toBe('0xcafe');
    expect(results.redirect.originPaths).toEqual(['/redirect/0x', '/ok/0x']);
  });

  test('an over-large declared content-length is rejected and the socket closed', () => {
    expect(results.hugeDeclared.code).toBe('CCIP_GATEWAY_FAILED');
    expect(results.hugeDeclared.serverSawSocketClose).toBe(true);
  });

  test('a body that outgrows the cap mid-stream is cut off and the socket closed', () => {
    expect(results.endless.code).toBe('CCIP_GATEWAY_FAILED');
    expect(results.endless.serverSawSocketClose).toBe(true);
    // Stopped near the cap, not after streaming for the full deadline. The
    // slack covers bytes in flight in socket/proxy buffers when it fired.
    expect(results.endless.bytesSentByServer).toBeLessThan(CCIP_MAX_RESPONSE_BYTES * 2);
    expect(results.endless.ms).toBeLessThan(10_000);
  });

  test("the caller's abort tears the request down and skips remaining gateways", () => {
    expect(results.callerAbort.code).toBe('CCIP_GATEWAY_FAILED');
    expect(results.callerAbort.serverSawSocketClose).toBe(true);
    expect(results.callerAbort.originPaths).toEqual(['/stall/0x']);
    expect(results.callerAbort.ms).toBeLessThan(5_000);
  });

  test('a gateway that never answers is torn down at the 15s deadline', () => {
    expect(results.deadline.code).toBe('CCIP_GATEWAY_FAILED');
    expect(results.deadline.ms).toBeGreaterThanOrEqual(14_900);
    expect(results.deadline.ms).toBeLessThan(30_000);
    expect(results.deadline.serverSawSocketClose).toBe(true);
  });
});
