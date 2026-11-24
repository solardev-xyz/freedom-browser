/**
 * Integration test: the Colibri service's fetches (`shell.colibri_fetch`,
 * `src/main/ens/colibri-fetch.js`; freedom-core design 0014, "Main's
 * fetches") go through the session: its proxy and Tor's PAC apply, the onion
 * gate refuses an onion server before the PAC lands, no cookie or cache is
 * used, Chromium decodes a compressed body and main counts the decoded
 * bytes, and a redirect is followed by main's rule, never by Chromium.
 *
 * Like `ens-ccip-proxy.test.js` (#359), this can only be proven from a real
 * Electron main process: the unit suite (`src/main/ens/colibri-fetch.test.js`)
 * runs the executor over Node's fetch. This spawns Electron on
 * `colibri-fetch-proxy-electron-probe.js` and asserts the probe's report.
 *
 * Skipped when the Electron binary cannot be resolved; the CI job that runs
 * the proxy suites sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns a missing
 * binary into a failure instead (see `ipfs-gateway-proxy.test.js`).
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

const PROBE = path.join(__dirname, 'colibri-fetch-proxy-electron-probe.js');
const PROBE_TIMEOUT_MS = 120_000;
const PAYLOAD = JSON.stringify({ method: 'eth_blockNumber', params: [], version: 196611 });
const PROOF = { head: { node: 0, bytes: 11 }, length: 11 };

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

describeWithElectron('Colibri fetches in a real Electron process', () => {
  let results;

  beforeAll(async () => {
    results = await runProbe();
  }, PROBE_TIMEOUT_MS);

  test('with a session proxy, every Colibri fetch goes through it, by name', () => {
    const leg = results.viaSessionProxy;
    expect([leg.post, leg.get, leg.finality]).toEqual([PROOF, PROOF, PROOF]);
    expect(leg.socksSeen.length).toBeGreaterThan(0);
    for (const seen of leg.socksSeen) expect(seen).toMatch(/^ccip\.example\.test:\d+$/);
    expect(leg.originSeen.map((seen) => seen.viaProxy)).toEqual([true, true, true]);
  });

  test('the Tor PAC proxies an .onion prover and leaves a clearnet one DIRECT', () => {
    expect(results.resolveProxy.onion).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
    expect(results.resolveProxy.clearnet).toBe('DIRECT');
    expect([results.onionViaTor.post, results.onionViaTor.get]).toEqual([PROOF, PROOF]);
    expect(results.onionViaTor.socksSeen.length).toBeGreaterThan(0);
    for (const seen of results.onionViaTor.socksSeen) {
      expect(seen).toMatch(/^ccipgatewayprobe\.onion:\d+$/);
    }
    expect(results.onionViaTor.originSeen.map((seen) => seen.viaProxy)).toEqual([true, true]);
    expect(results.clearnetWithTor.post).toEqual(PROOF);
    expect(results.clearnetWithTor.socksSeen).toEqual([]);
    expect(results.clearnetWithTor.originSeen.map((seen) => seen.viaProxy)).toEqual([false]);
  });

  test('before the PAC lands, an .onion prover is refused, never dialled: a transport failure to the service', () => {
    const leg = results.onionBeforeTor;
    expect(leg.resolveProxy).toBe('DIRECT');
    expect(leg.answer).toEqual({
      error: `Request to <url> with payload ${PAYLOAD} failed: fetch failed`,
    });
    expect(leg.chromiumSaw).toEqual([]);
    expect(leg.socksSeen).toEqual([]);
    expect(leg.originSeen).toEqual([]);
  });

  test('with no proxy, a clearnet prover is dialled DIRECT, with the headers the contract allows and no cookie', () => {
    const leg = results.clearnetDirect;
    expect(leg.resolveProxy).toBe('DIRECT');
    expect([leg.post, leg.get]).toEqual([PROOF, PROOF]);
    expect(leg.socksSeen).toEqual([]);
    expect(leg.originSeen.map((seen) => seen.viaProxy)).toEqual([false, false]);
    const [post, get] = leg.originSeen;
    expect(post).toMatchObject({
      method: 'POST',
      path: '/prover',
      accept: 'application/octet-stream',
      contentType: 'application/json',
      cacheControl: null,
      body: PAYLOAD,
    });
    expect(get).toMatchObject({
      method: 'GET',
      path: '/prover/tx_cache?max_blocks=256',
      accept: 'application/octet-stream',
      contentType: null,
      cacheControl: 'max-age=6',
      body: '',
    });
    // Control: the cookie is on the session and would be sent.
    expect(results.cookieControl).toEqual(['session=must-not-travel']);
    for (const leg of ['clearnetDirect', 'onionViaTor', 'viaSessionProxy']) {
      for (const seen of results[leg].originSeen) {
        expect(seen.cookie).toBeNull();
        expect(seen.authorization).toBeNull();
      }
    }
  });

  test('Chromium decodes a gzip body and main counts its decoded bytes: one inflating past the maximum fails', () => {
    expect(results.gzip.fits.head.bytes).toBe(results.gzip.fits.length);
    expect(results.gzip.fits.length).toBeGreaterThan(60 * 1024);
    expect(results.gzip.bomb).toEqual({
      error: 'Request to <url> failed: response over 65536 bytes',
    });
  });

  test('main follows a same-variant redirect itself, and refuses one to another origin, its target never asked', () => {
    expect(results.redirectSame.answer).toEqual(PROOF);
    expect(results.redirectSame.originPaths).toHaveLength(2);
    expect(results.redirectAway.answer).toEqual({
      error: 'HTTP error! Status: 302, Details: redirect refused',
    });
    expect(results.redirectAway.originPaths).toHaveLength(1);
    expect(results.redirectAway.chromiumSaw).toHaveLength(1);
  });

  test('no cache: an answer cacheable for a year is fetched again', () => {
    expect(results.noCache.originPaths).toEqual([
      '/prover/tx_cache?max_blocks=256',
      '/prover/tx_cache?max_blocks=256',
    ]);
  });
});
