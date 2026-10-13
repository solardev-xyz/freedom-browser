/**
 * Integration test: the real `bzz:` handler's Range, redirect, cancel and
 * backpressure behaviour as Chromium sees it, through `protocol.handle`.
 *
 * Roadmap 4.7, design 0006 ("Tests first"). `swarm/bzz-protocol.http.test.js`
 * pins the handler against a fake Ant in plain Node; what it cannot show is
 * that Electron's Response → Chromium conversion keeps a 206 a 206 (status,
 * Content-Range, Content-Length), that Chromium resolves the handler's
 * relative redirect into the right `bzz:` URL, and that an abort on the
 * Chromium side reaches the handler's body and stops the node. This spawns
 * Electron on `dweb-range-electron-probe.js`, which registers the real handler
 * on the default session and drives it with `session.fetch` (no window: the
 * CI `test` job has no display), and asserts the probe's report.
 *
 * Not covered here, because they need a renderer: a `<video>` seek (bursts of
 * cancel and re-request) and a download resumed by Range.
 *
 * Skipped when the Electron binary cannot be resolved, like
 * `ipfs-gateway-proxy.test.js`; `FREEDOM_ELECTRON_NET_TEST=1` turns a missing
 * binary into a failure instead.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED = process.env.FREEDOM_ELECTRON_NET_TEST === '1';

function electronBinaryPath() {
  try {
    // Outside an Electron process `require('electron')` resolves to the
    // installed binary's path.
    const resolved = jest.requireActual('electron');
    // ELECTRON_OVERRIDE_DIST_PATH can name a path that doesn't exist: a
    // path is installed only if the executable is there.
    return typeof resolved === 'string' && fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

const ELECTRON_PATH = electronBinaryPath();
if (REQUIRED && !ELECTRON_PATH) {
  throw new Error(
    'FREEDOM_ELECTRON_NET_TEST=1 but no Electron binary is installed — fetch it with ' +
      '`node -e "require(\'electron\')"`'
  );
}
const describeWithElectron = ELECTRON_PATH ? describe : describe.skip;

const PROBE = path.join(__dirname, 'dweb-range-electron-probe.js');
const PROBE_TIMEOUT_MS = 120_000;
const HASH = 'ab'.repeat(32);
const MIB = 1024 * 1024;

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

describeWithElectron('bzz: through protocol.handle in a real Electron process', () => {
  let results;
  let content;

  beforeAll(async () => {
    results = await runProbe();
    content = Buffer.from(results.content, 'base64');
  }, PROBE_TIMEOUT_MS);

  afterAll(() => {
    // The probe's throwaway profile, removed once Electron has exited.
    if (results?.userData?.startsWith(os.tmpdir())) {
      fs.rmSync(results.userData, { recursive: true, force: true });
    }
  });

  const bytes = (summary) => Buffer.from(summary.body, 'base64');

  test('a 206 reaches Chromium as a 206, with Content-Range and Content-Length intact', () => {
    expect(results.range).toMatchObject({
      status: 206,
      contentRange: 'bytes 100-199/1000',
      contentLength: '100',
    });
    expect(bytes(results.range)).toEqual(content.subarray(100, 200));
    expect(results.seen[0]).toMatchObject({
      url: `/bzz/${HASH}/video.mp4`,
      range: 'bytes=100-199',
    });
  });

  test('a 416 reaches Chromium with its Content-Range', () => {
    expect(results.unsatisfiable).toMatchObject({ status: 416, contentRange: 'bytes */1000' });
  });

  test('If-Range survives the trip: fresh keeps the 206, stale gets the whole 200', () => {
    expect(results.freshIfRange).toMatchObject({ status: 206, contentRange: 'bytes 0-9/1000' });
    expect(bytes(results.freshIfRange)).toEqual(content.subarray(0, 10));
    expect(results.staleIfRange).toMatchObject({ status: 200, contentRange: null });
    expect(bytes(results.staleIfRange)).toEqual(content);
  });

  test('HEAD answers with the headers', () => {
    expect(results.head).toEqual({ status: 200, contentLength: '1000' });
  });

  // #95: the handler re-expresses Ant's gateway-space Location relative to the
  // request; Chromium must resolve it to the same bzz: directory, never to a
  // doubled /bzz/<ref>/ path.
  test("Chromium resolves the handler's relative redirect to the bzz: directory", () => {
    expect(results.redirect).toEqual({
      status: 200,
      body: 'blog index',
      nodeSaw: [`/bzz/${HASH}/blog`, `/bzz/${HASH}/blog/`],
    });
  });

  test('a consumer that stops reading holds the node back through Chromium too', () => {
    expect(results.pausedClosed).toBe(false);
    // Generous: socket buffers on both hops plus Chromium's own pipe.
    expect(results.pausedSent).toBeLessThan(32 * MIB);
  });

  test("an abort on Chromium's side mid-body reaches the handler and stops the node", () => {
    expect(results.abortError).toBe('AbortError');
    expect(results.abortReachedNode).toBe(true);
    expect(results.abortedAtNode).toBe(true);
  });
});
