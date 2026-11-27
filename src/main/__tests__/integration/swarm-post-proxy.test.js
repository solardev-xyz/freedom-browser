/**
 * Integration test: main's Swarm calls POST to a remote node through the
 * session (freedom-core design 0015, The transport): its proxy applies, a
 * streamed body is written as it is pulled, and the Ant API guard lets
 * through exactly the announced method to exactly the announced URL. It
 * also pins what the SWM-5 plan asked to measure about Chromium's stack:
 * `accept-encoding: identity` kept, a reply encoded despite it refused, a
 * header byte in U+0080–U+00FF sent as UTF-8 (#1328), and a
 * `content-length` beside a streamed body refused.
 *
 * Like `colibri-fetch-proxy.test.js`, this can only be proven from a real
 * Electron main process: the unit suites (`swarm/ant-api-call.test.js`,
 * `ipfs/gateway-transport.test.js`, `swarm/ant-api-guard.test.js`) run the
 * transport over Node's fetch and a fake `net.request`. This spawns Electron
 * on `swarm-post-proxy-electron-probe.js` and asserts the probe's report.
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

const PROBE = path.join(__dirname, 'swarm-post-proxy-electron-probe.js');
const PROBE_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
const BLOCKED = { error: 'net::ERR_BLOCKED_BY_CLIENT' };

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

describeWithElectron("main's Swarm POSTs in a real Electron process", () => {
  let results;

  beforeAll(async () => {
    results = await runProbe();
  }, PROBE_TIMEOUT_MS);

  test('with a session proxy, a streamed and a whole POST go through it, by name', () => {
    const leg = results.viaSessionProxy;
    expect(leg.resolveProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
    // Only the connections to the node's port count: a fetch of Electron's
    // own on the session (the probe turns its spell checker off) would take
    // the proxy too. Each goes by the node's name, never by an address
    // (127.0.0.1, which the resolver rules map it to, or any other).
    const { port } = new URL(results.remote);
    const toNode = leg.socksSeen.filter((seen) => seen.endsWith(`:${port}`));
    expect(toNode.length).toBeGreaterThan(0);
    for (const seen of toNode) expect(seen).toBe(`ant.example.test:${port}`);

    expect(leg.stream).toMatchObject({ status: 201, swarmTag: '7', json: { bytes: MIB } });
    expect(leg.bytes).toMatchObject({ status: 201, json: { bytes: 4104 } });
    const [stream, bytes] = leg.originSeen;
    // The stream goes chunked, every byte as the source made it.
    expect(stream).toMatchObject({
      viaProxy: true,
      method: 'POST',
      path: '/bzz?name=site.tar',
      contentType: 'application/x-tar',
      batch: 'b'.repeat(64),
      transferEncoding: 'chunked',
      contentLength: null,
      bytes: MIB,
      digest: leg.streamDigest,
      cookie: null,
    });
    // Bytes go whole, with their length.
    expect(bytes).toMatchObject({
      viaProxy: true,
      method: 'POST',
      path: '/chunks',
      contentLength: '4104',
      transferEncoding: null,
      bytes: 4104,
      cookie: null,
    });
  });

  test('the guard sees each POST frameless, as announced, and cancels none of them', () => {
    const leg = results.viaSessionProxy;
    expect(leg.guardSaw.slice(0, 2)).toEqual([
      {
        method: 'POST',
        path: '/bzz?name=site.tar',
        resourceType: 'other',
        webContentsId: null,
        frame: false,
      },
      { method: 'POST', path: '/chunks', resourceType: 'other', webContentsId: null, frame: false },
    ]);
    expect(leg.cancelled).toEqual([]);
  });

  test('the guard admits exactly the announced POST: another URL, another method, or none is cancelled', () => {
    const { guard } = results;
    expect(guard.unannounced).toEqual(BLOCKED);
    expect(guard.postWhileGetAnnounced).toEqual(BLOCKED);
    expect(guard.getOfAnnouncedPostUrlOtherPath).toEqual(BLOCKED);
    expect(guard.postToOtherPath).toEqual(BLOCKED);
    expect(guard.postToStampsPurchase).toEqual(BLOCKED);
    expect(guard.putOfAnnouncedUrl).toEqual(BLOCKED);
    expect(guard.announcedPost).toEqual({ status: 201 });
    expect(guard.postAfterRelease).toEqual(BLOCKED);
    // Only the announced POST reached the node.
    expect(guard.originPaths).toEqual(['POST /bytes']);
    expect(guard.cancelled).toHaveLength(7);
  });

  test('a node that stops reading stops the pulls: back-pressure from the node through main to the body', () => {
    const leg = results.backpressure;
    expect(leg.originAtStall).toBe(0);
    expect(leg.stalledAt).toBeGreaterThan(0);
    expect(leg.stalledAt).toBeLessThan(leg.total / 2);
    // Reading again lets the rest through, byte for byte.
    expect(leg.answer).toMatchObject({ status: 201, json: { bytes: leg.total * 64 * 1024 } });
    expect(leg.pulls).toBe(leg.total);
    expect(leg.origin).toEqual({ bytes: leg.total * 64 * 1024, digest: leg.digest });
  });

  test('a cancel mid-upload cancels the body: nothing more is pulled', () => {
    const leg = results.cancel;
    expect(leg.answer).toEqual({ error: 'AbortError: This operation was aborted' });
    expect(leg.pullsAfter).toBe(leg.stalledAt);
    expect(leg.sourceCancelled).toBe(true);
    expect(leg.originComplete).toBe(false);
  });

  test('an empty stream goes as no body', () => {
    expect(results.empty.answer).toMatchObject({ status: 201, json: { bytes: 0 } });
    expect(results.empty.origin).toEqual([
      { contentLength: '0', transferEncoding: null, bytes: 0 },
    ]);
  });

  describe("the plan's risks, measured (SWM-5 plan, section 4)", () => {
    test("Chromium keeps main's accept-encoding: identity", () => {
      expect(results.acceptEncodingSeen).toEqual(['identity', 'identity']);
      expect(results.risks.gzipAcceptEncodingSeen).toEqual(['identity', 'identity']);
    });

    // Chromium refuses an encoding it didn't ask for; undici decodes it, and
    // main drops the encoded length (point 6).
    test('a reply gzipped despite identity fails on Chromium, and is decoded by undici', () => {
      expect(results.risks.gzipNet).toEqual({ error: 'Error: net::ERR_CONTENT_DECODING_FAILED' });
      expect(results.risks.gzipUndici).toMatchObject({
        status: 200,
        contentEncoding: 'gzip',
        contentLength: null,
      });
      expect(results.risks.gzipUndici.length).toBeGreaterThan(60 * 1024);
    });

    // #1328: Node's fetch, the reference's, sends U+00E9 as the one byte
    // 0xe9, as 0015 asks; Chromium's stack sends its UTF-8, 0xc3 0xa9.
    test('a header character in U+0080–U+00FF: one byte on undici, UTF-8 on Chromium', () => {
      const prefix = Buffer.from('text/plain; name=caf').toString('hex');
      expect(results.risks.latin1Undici).toMatchObject({ status: 201 });
      expect(results.risks.latin1UndiciSeen).toEqual([`${prefix}e9`]);
      expect(results.risks.latin1UndiciGuardSaw).toBe(0);
      expect(results.risks.latin1Net).toMatchObject({ status: 201 });
      expect(results.risks.latin1NetSeen).toEqual([`${prefix}c3a9`]);
    });

    test('a content-length beside a streamed body is refused by Chromium, before anything is sent', () => {
      expect(results.risks.lengthWithStreamNet).toEqual({
        error: 'Error: net::ERR_INVALID_ARGUMENT',
      });
      expect(results.risks.lengthWithStreamNetSeen).toEqual([]);
    });
  });
});
