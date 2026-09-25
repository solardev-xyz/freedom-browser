/**
 * Integration test: the external IPFS gateway transport really does follow the
 * session's proxy configuration (#355).
 *
 * `session.setProxy` is Chromium's, so the only way to prove a request honours
 * it is to issue that request from a real Electron main process — mocked unit
 * tests can pin the wiring (see `src/main/ipfs/gateway-transport.test.js` and
 * the `external gateway transport` block in `src/main/ipfs-manager.test.js`)
 * but not the network stack's behaviour. This spawns Electron on
 * `gateway-proxy-electron-probe.js`, which drives the real
 * `ipfs/gateway-transport.js` against the real PAC from `tor-proxy.js` with a
 * local SOCKS5 proxy standing in for Arti, and asserts the probe's report.
 *
 * Skipped when the Electron binary cannot be resolved — e.g. a checkout whose
 * `require('electron')` download failed or was blocked. Note that
 * `--ignore-scripts` does not keep the binary away: the `electron` package has
 * no postinstall, so the `requireActual` below is itself what downloads it on
 * a machine that has none (observed in the `test` CI job, which installs with
 * `--ignore-scripts` and still runs this suite after a ~100 MB fetch). The
 * `ipfs-gateway-proxy` CI job sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns
 * a missing binary into a failure instead, so the coverage cannot silently
 * disappear there.
 */

const { spawn } = require('child_process');
const path = require('path');

const REQUIRED = process.env.FREEDOM_ELECTRON_NET_TEST === '1';

function electronBinaryPath() {
  try {
    // `require('electron')` outside an Electron process resolves to the
    // installed binary's path (it reads the package's own `path.txt`), so this
    // finds it on every platform instead of assuming a Linux layout.
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

const PROBE = path.join(__dirname, 'gateway-proxy-electron-probe.js');
const PROBE_TIMEOUT_MS = 120_000;

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ELECTRON_PATH,
      // `--headless` keeps this runnable without a display (measured on
      // Electron 44.3.0); `--no-sandbox` is needed on CI runners where the
      // SUID sandbox helper is not configured.
      ['--no-sandbox', '--headless', PROBE],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }
    );
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

describeWithElectron('external IPFS gateway transport in a real Electron process', () => {
  let results;

  beforeAll(async () => {
    results = await runProbe();
  }, PROBE_TIMEOUT_MS);

  // The scope question #355 asks to settle first: the PAC tor-proxy.js installs
  // routes `.onion` through Arti and returns DIRECT for everything else. So a
  // clearnet gateway is not "outside Tor" — Tor never claimed it. A gateway on
  // a `.onion` host is the case that genuinely breaks.
  test('the Tor PAC proxies .onion and leaves every other gateway DIRECT', () => {
    expect(results.pacScript).toContain('SOCKS5');
    expect(results.resolveProxy.onionGateway).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
    expect(results.resolveProxy.remoteGateway).toBe('DIRECT');
    expect(results.resolveProxy.loopbackGateway).toBe('DIRECT');
  });

  // R2-F1: the gap between launch and Tor being up. `startIpfs()` probes the
  // configured gateway within ~1s while Arti is still bootstrapping, so the
  // session resolves the onion URL DIRECT — dialling it there hands the
  // hostname to the system resolver, the leak this transport exists to close.
  test('before the PAC lands, an .onion gateway is refused rather than resolved', () => {
    expect(results.onionGatewayBeforeTor.resolveProxy).toBe('DIRECT');
    expect(results.onionGatewayBeforeTor.transport.error).toMatch(/not routed through a proxy/);
    // The control — the same Chromium dial with no guard — is what the leak
    // looks like: it never reaches the origin (only Tor can resolve the name),
    // it reaches the resolver instead. On a runner with an ordinary resolver
    // that is `ERR_NAME_NOT_RESOLVED`; the assertion that holds either way is
    // "the gateway was never reached".
    expect(results.onionGatewayBeforeTor.unguarded.body).not.toBe('gateway-body');
    expect(results.onionGatewayBeforeTor.originSeen).toEqual([]);
    expect(results.onionGatewayBeforeTor.socksSeen).toEqual([]);
  });

  test('with Tor on, a remote (.onion) gateway request goes through the proxy', () => {
    expect(results.onionGatewayViaTor).toMatchObject({ status: 200, body: 'gateway-body' });
    // The onion *name* reached the SOCKS proxy: Chromium never resolved it
    // locally, which is both why it works and why it does not leak.
    expect(results.onionGatewayViaTor.socksSeen).toEqual([
      expect.stringMatching(/^freedomgatewayprobe\.onion:\d+$/),
    ]);
  });

  // The transport this replaces, pinned as the regression it was: undici has
  // its own socket stack and never sees session.setProxy.
  test("Node's fetch bypasses the session proxy entirely", () => {
    expect(results.onionGatewayViaNodeFetch.error).toBeTruthy();
    expect(results.onionGatewayViaNodeFetch.socksSeen).toEqual([]);
  });

  test('a loopback gateway is unaffected — no proxy hop with Tor on', () => {
    expect(results.loopbackGatewayUnderTor).toMatchObject({ status: 200, body: 'gateway-body' });
    expect(results.loopbackGatewayUnderTor.socksSeen).toEqual([]);
    expect(results.loopbackGatewayUnderTor.originSeen).toEqual([
      expect.stringContaining('127.0.0.1'),
    ]);
  });

  test('a remote gateway follows any other proxy the session carries', () => {
    expect(results.remoteGatewayViaHttpProxy).toMatchObject({
      status: 200,
      body: 'through-http-proxy',
    });
    expect(results.remoteGatewayViaHttpProxy.proxySeen).toEqual([
      expect.stringContaining('gateway.example.test'),
    ]);
    // …and the loopback gateway still does not, under the same proxy config.
    expect(results.loopbackGatewayViaHttpProxy).toMatchObject({
      status: 200,
      body: 'gateway-body',
    });
    expect(results.loopbackGatewayViaHttpProxy.proxySeen).toEqual([]);
  });

  // #351's hardening, re-proved against the real network stack rather than a
  // mocked one.
  test('a gateway redirect is surfaced, never followed', () => {
    expect(results.manualRedirect).toMatchObject({
      status: 301,
      location: '/ipfs/bafydir/docs/',
      hasBody: false,
    });
    // One request, to the URL asked for: Chromium did not take the hop.
    expect(results.manualRedirect.originRequests).toEqual([
      expect.stringContaining('/ipfs/bafydir/docs'),
    ]);
    expect(results.manualRedirect.originRequests).toHaveLength(1);
  });

  test('Chromium decodes the body but still reports the upstream encoding', () => {
    // Which is exactly why DROPPED_UPSTREAM_RESPONSE_HEADERS has to keep
    // stripping `content-encoding`/`content-length` after the transport change:
    // forwarding them would have Chromium decode the plaintext a second time.
    expect(results.contentEncoding).toMatchObject({
      status: 200,
      contentEncoding: 'gzip',
      decoded: true,
      decodedLength: 4096,
    });
    expect(Number(results.contentEncoding.contentLength)).toBeLessThan(4096);
  });

  // Chromium has an HTTP cache; undici did not. Kubo serves every
  // `/ipfs/<cid>` (the reachability probe's `bafkqaaa` included) as immutable
  // for a year, so without `cache: 'no-store'` a dead gateway reads healthy
  // forever and every visited CID lands in the profile's on-disk cache.
  test('gateway requests neither read from nor write to the HTTP cache', () => {
    expect(results.httpCache.error).toBeUndefined();
    // Both loads reached the origin, and the second saw the *second* body.
    expect(results.httpCache.transport).toMatchObject({
      firstBody: 'nostoremarker-hit-1',
      secondBody: 'nostoremarker-hit-2',
      originHits: 2,
    });
    // Control: the identical request without the option is answered from the
    // cache on its second run — so the assertion above is about `no-store`,
    // not about a headless Chromium that happens not to cache.
    expect(results.httpCache.control).toMatchObject({
      firstBody: 'controlmarker-hit-1',
      secondBody: 'controlmarker-hit-1',
      originHits: 1,
    });
    // …and on disk: the control body is there, the gateway body is not.
    expect(results.httpCache.onDisk).toEqual(['controlmarker']);
  });

  // R4-F1: the speculative warm-up in `ens-prefetch.js` dialled the same
  // configured gateway with a bare `net.request` — no onion guard, no
  // `no-store` — so both holes stayed open on it. Driven here through the
  // service registry, the way the resolver drives it.
  test('the ENS prefetch dials through the same transport', () => {
    expect(results.prefetch.error).toBeUndefined();
    // Works, over Tor: both warm-ups arrive at the origin under the onion
    // name, which nothing but the SOCKS tunnel can reach. The second reaching
    // the origin at all is the `no-store` half — the gateway serves this CID
    // `immutable` for a year, like Kubo.
    expect(results.prefetch.viaTor.originHits).toBe(2);
    expect(results.prefetch.viaTor.originSeen).toEqual([
      expect.stringMatching(/^freedomgatewayprobe\.onion:\d+\/ipfs\/bafkrei/),
      expect.stringMatching(/^freedomgatewayprobe\.onion:\d+\/ipfs\/bafkrei/),
    ]);
    // Chromium pools proxy tunnels, so a reused one records no fresh CONNECT;
    // anything it does record must still be the onion name, never an address.
    for (const seen of results.prefetch.viaTor.socksSeen) {
      expect(seen).toMatch(/^freedomgatewayprobe\.onion:\d+$/);
    }
    // Tor off, gateway still published: nothing is dialled at all. A dial that
    // dies in the system resolver reaches no server here either, so the load-
    // bearing assertion is `chromiumSaw` — Chromium was never asked for the
    // name (the same list is non-empty for the warm-ups that did go out).
    expect(results.prefetch.viaTor.chromiumSaw.length).toBeGreaterThan(0);
    expect(results.prefetch.withoutTor.resolveProxy).toBe('DIRECT');
    expect(results.prefetch.withoutTor.chromiumSaw).toEqual([]);
    expect(results.prefetch.withoutTor.originHits).toBe(2);
    expect(results.prefetch.withoutTor.socksSeen).toEqual([]);
    expect(results.prefetch.withoutTor.originSeen).toEqual([]);
    // A loopback gateway is still warmed.
    expect(results.prefetch.loopbackOriginHits).toBe(3);
    // Nothing the prefetch fetched is on disk — the control body from the
    // cache block is, which is what makes the absence meaningful.
    expect(results.prefetch.onDisk).toEqual(['controlmarker']);
  });

  test('cancelling an in-flight load aborts it and closes the socket', () => {
    expect(results.abort).toMatchObject({
      firstChunk: 'first-chunk',
      abortName: 'AbortError',
      serverSawSocketClose: true,
    });
  });
});
