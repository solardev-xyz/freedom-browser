/**
 * Integration test: with a remote node and a session proxy, every call of
 * main's Swarm executor goes through the proxy (freedom-core design 0015,
 * SWM-5's gates; the SWM-5 plan's PR 7). Every honest scenario of the
 * pinned core's `vectors/swarm-grammar.json` is played through the real
 * executor (`core/swarm-shell.js`) with the switch on, against a remote
 * node at `ant.example.test` on the default session's stack, a SOCKS proxy
 * on the session and the real Ant API guard: every form, the ready probe,
 * and the streamed uploads, which PR 6 left to this probe for a remote
 * node. It also pins what Chromium's stack does when a node hangs up on a
 * reused connection.
 *
 * Like `swarm-post-proxy.test.js`, only a real Electron main process can
 * show it: this spawns Electron on `swarm-shell-proxy-electron-probe.js`
 * and asserts the probe's report.
 *
 * Skipped when the Electron binary can't be resolved, or without the Swarm
 * vectors (test/helpers/swarm-vectors.js finds them). The CI job that runs
 * the proxy suites sets `FREEDOM_ELECTRON_NET_TEST=1`, which turns a missing
 * binary into a failure, and FREEDOM_CORE_SWARM_VECTORS, which does the
 * same for the vectors.
 */

const { spawn } = require('child_process');
const path = require('path');
const { swarmVectors, swarmVectorsRequired } = require('../../../../test/helpers/swarm-vectors');

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
const grammar = swarmVectors('swarm-grammar.json');
const VECTORS = grammar && swarmVectors('swarm.json') && swarmVectors('dweb-verify.json');
if (swarmVectorsRequired && !VECTORS) {
  throw new Error('FREEDOM_CORE_SWARM_VECTORS names no directory with the Swarm vectors');
}
const SKIPPED =
  (!ELECTRON_PATH && 'no Electron binary') ||
  (!VECTORS && 'no Swarm vectors: set FREEDOM_CORE_SWARM_VECTORS');
const describeWithElectron = SKIPPED
  ? (name, fn) => describe.skip(`${name} (skipped: ${SKIPPED})`, fn)
  : describe;

const PROBE = path.join(__dirname, 'swarm-shell-proxy-electron-probe.js');
const PROBE_TIMEOUT_MS = 300_000;

/** design 0015's forms: every one the grammar has. */
const FORMS = [
  'chunk',
  'bytes',
  'feed_head',
  'feed_latest',
  'tag',
  'addresses',
  'stamps',
  'stamp',
  'bzz_file',
  'bzz_tar',
  'bytes_up',
  'chunk_up',
  'soc_up',
  'feed_manifest',
  'pss_send',
];

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_PATH, ['--no-sandbox', '--headless', PROBE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', FREEDOM_SWARM_BACKEND: 'core' },
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

describeWithElectron("main's Swarm executor on a remote node behind a session proxy", () => {
  let results;

  beforeAll(async () => {
    results = await runProbe();
  }, PROBE_TIMEOUT_MS);

  test('the switch is on, and the session resolves every node URL to the proxy', () => {
    expect(results.switch).toBe('core');
    expect(results.resolveProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
  });

  test("every honest scenario plays as main's Admission plays it, the node's replies forwarded", () => {
    expect(results.played).toBe(grammar.honest.length);
    expect(results.played).toBeGreaterThanOrEqual(370);
    expect(results.wrong).toEqual([]);
  });

  test('every form and the ready probe reached the node through the proxy, by name, with no cookie', () => {
    const { port } = new URL(results.remote);
    expect(results.originSeen.length).toBeGreaterThan(1000);
    for (const seen of results.originSeen) {
      expect(seen).toEqual({
        viaProxy: true,
        host: `ant.example.test:${port}`,
        method: expect.stringMatching(/^(GET|POST)$/),
        form: expect.any(String),
        cookie: null,
      });
    }
    const forms = new Set(results.originSeen.map((seen) => seen.form));
    expect([...forms].sort()).toEqual([...FORMS, 'ready'].sort());
    // The proxy was asked for the node by its name, never an address.
    expect(results.socksSeen).toEqual([`ant.example.test:${port}`]);
    expect(results.stamp).toEqual({ ok: true });
  });

  test('the guard saw each dial as main its own (frameless, other) and cancelled none', () => {
    expect(results.guardKinds).toEqual(['other:false']);
    expect(results.cancelled).toEqual([]);
  });

  test('every streamed upload went to the remote node chunked, whole, the core’s bytes as they came', () => {
    // publishData's 10 MiB, publishFiles' tars up to 50 MiB, writeFeedEntry's bytes_up.
    expect(results.uploads.length).toBeGreaterThanOrEqual(30);
    for (const upload of results.uploads) {
      expect(upload.took).toMatchObject({
        viaProxy: true,
        method: 'POST',
        transferEncoding: 'chunked',
        contentLength: null,
        bytes: upload.bytes,
        digest: upload.digest,
      });
    }
    expect(Math.max(...results.uploads.map((upload) => upload.bytes))).toBeGreaterThan(50 * 1e6);
  });

  // Measured, not designed: design 0015's point 6 is one dial per admitted
  // call and no retry. On the session's stack, when a node closes a reused
  // keep-alive connection before it answers, Chromium sends the request
  // again on a new one, below the webRequest guard, a POST with a whole body
  // too (`pss_send`). A streamed body can't be sent again, and undici on
  // loopback doesn't. Every other call is one dial.
  test("a node that hangs up: Chromium's stack sends the call once more, below the guard; every other call is one dial", () => {
    const hangsUp = new Set(
      grammar.honest
        .filter((s) => s.calls.some((c) => c.reply && c.reply.status === null))
        .map((s) => s.id)
    );
    for (const extra of results.dials) {
      expect(hangsUp.has(extra.id)).toBe(true);
      expect(extra.dials).toBeLessThanOrEqual(2);
    }
    // The guard saw one request a dial: the resends never reached it.
    const resent = results.dials.reduce((sum, extra) => sum + extra.dials - 1, 0);
    expect(results.guardSaw).toBe(results.originSeen.length - resent);
    expect(results.failures).toBe(hangsUp.size);
    process.stdout.write(
      `[swarm-shell proxy] calls the node saw twice: ${JSON.stringify(results.dials)}\n`
    );
  });
});
