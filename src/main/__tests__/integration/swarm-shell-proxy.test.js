/**
 * Integration test: with a remote node and a session proxy, every call of
 * main's Swarm executor goes through the proxy (freedom-core design 0015,
 * SWM-5's gates; the SWM-5 plan's PR 7). Every honest scenario of the
 * pinned core's `vectors/swarm-grammar.json` is played through the real
 * executor (`core/swarm-shell.js`) with the switch on, against a remote
 * node at `ant.example.test` on the default session's stack, a SOCKS proxy
 * on the session and the real Ant API guard: every form, the ready probe,
 * and the streamed uploads, which PR 6 left to this probe for a remote
 * node.
 *
 * It also holds design 0015's point 6 (one dial per admitted call, a POST
 * never sent twice) where Chromium's stack would break it: when a reused
 * keep-alive connection closes before a request's headers, Chromium sends
 * the request again, below the guard. Over HTTP and through the SOCKS
 * proxy, a node keeps a connection open, takes the next write whole and
 * closes without headers: every write the executor sends reaches it once,
 * and the call answers its failure. A whole body, as main sent one before,
 * is the control: Chromium sends it twice. A read may be sent twice, which
 * is idempotent and can't be stopped from Electron.
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

  // Point 6 in the grammar's plays: a node that hangs up on a read may get
  // it twice; every write, the hang-up's `pss_send` among them, and every
  // other call reaches it once.
  test('a node that hangs up: a read reaches it at most twice, below the guard; every write and every other call once', () => {
    const hangsUp = new Set(
      grammar.honest
        .filter((s) => s.calls.some((c) => c.reply && c.reply.status === null))
        .map((s) => s.id)
    );
    expect(hangsUp.has('send-pss-node-hangs-up')).toBe(true);
    for (const extra of results.dials) {
      expect(hangsUp.has(extra.id)).toBe(true);
      expect(extra).toMatchObject({ method: 'GET', dials: 2 });
    }
    // The guard saw one request a dial: a read sent again never reached it.
    const resent = results.dials.reduce((sum, extra) => sum + extra.dials - 1, 0);
    expect(results.guardSaw).toBe(results.originSeen.length - resent);
    expect(results.failures).toBe(hangsUp.size);
    process.stdout.write(
      `[swarm-shell proxy] reads the node saw twice: ${JSON.stringify(results.dials)}\n`
    );
  });

  describe.each(['http', 'socks'])(
    'a node keeps a connection open, takes the next call whole and closes without headers (%s)',
    (route) => {
      let leg;
      beforeAll(() => {
        leg = results.resend[route];
      });

      test(route === 'socks' ? 'through the SOCKS proxy' : 'straight to the node', () => {
        if (route === 'socks') expect(leg.resolveProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
        else expect(leg.resolveProxy).toBe('DIRECT');
      });

      // The control: the condition holds, and Chromium sends a whole body
      // again on a new connection, its second delivery answered as a success.
      test('a whole body, as main sent one before, reaches the node twice', () => {
        const { control } = leg;
        expect(control.warm).toEqual({ ok: true });
        expect(control.delivered).toEqual([
          expect.objectContaining({ reused: true, contentLength: String(control.bytes) }),
          expect.objectContaining({ reused: false, contentLength: String(control.bytes) }),
        ]);
        expect(control.answer).toEqual({ status: 201 });
      });

      test('every write reaches the node once, on the kept connection, chunked and whole; the call answers its failure', () => {
        expect(leg.writes.map((w) => w.form).sort()).toEqual(
          ['bzz_file', 'chunk_up', 'feed_manifest', 'pss_send', 'pss_send', 'soc_up'].sort()
        );
        for (const write of leg.writes) {
          expect(write.warm).toEqual({ ok: true });
          expect({ id: write.id, delivered: write.delivered }).toEqual({
            id: write.id,
            delivered: [
              expect.objectContaining({
                reused: true,
                method: 'POST',
                transferEncoding: 'chunked',
                contentLength: null,
                bytes: write.bytes,
                digest: write.digest,
              }),
            ],
          });
          expect({ id: write.id, answer: write.answer }).toEqual({
            id: write.id,
            answer: { failed: 'error' },
          });
        }
        // A message, an empty one (no body), a chunk's 4104 bytes, a feed
        // manifest (no body).
        const bytes = Object.fromEntries(leg.writes.map((w) => [w.id, w.bytes]));
        expect(bytes).toMatchObject({
          'send-pss-node-hangs-up': 2,
          'send-pss-sent-empty': 0,
          'publish-chunk-4096': 4104,
          'create-feed-name-64': 0,
        });
      });

      // Measured: Chromium's second attempt at a chunked write fails before
      // it sends anything, and leaves the session's next request to the
      // node failing once, unsent. Never a second delivery.
      test("the session's next call after a write: never sent twice", () => {
        for (const write of leg.writes) expect(write.after.delivered).toBeLessThanOrEqual(1);
        process.stdout.write(
          `[swarm-shell proxy] ${route}: the call after each write: ${JSON.stringify(
            leg.writes.map((w) => ({ id: w.id, ...w.after }))
          )}\n`
        );
      });

      // Measured: a read has no body, so Chromium may send it again, which
      // is idempotent and can't be stopped from Electron.
      test('a read reaches the node at most twice; its second delivery answers it', () => {
        for (const read of leg.reads) {
          expect(read.warm).toEqual({ ok: true });
          expect(read.delivered.length).toBeGreaterThanOrEqual(1);
          expect(read.delivered.length).toBeLessThanOrEqual(2);
          expect(read.delivered[0]).toMatchObject({ reused: true, method: 'GET' });
          if (read.delivered.length === 2) expect(read.answer).toEqual({ ok: true });
          else expect(read.answer).toEqual({ failed: 'error' });
        }
        process.stdout.write(
          `[swarm-shell proxy] ${route}: a read the node hung up on: ${JSON.stringify(
            leg.reads.map((r) => ({ id: r.id, delivered: r.delivered.length, answer: r.answer }))
          )}\n`
        );
      });
    }
  );

  test('the resend leg: the guard saw one request a dial, and cancelled none', () => {
    // Every request the guard saw reached the node, or failed unsent (the
    // call after a write); a resend the node got never passed the guard.
    const legs = Object.values(results.resend);
    const resent = legs.reduce(
      (sum, leg) =>
        sum +
        (leg.control.delivered.length - 1) +
        leg.reads.reduce((n, r) => n + r.delivered.length - 1, 0),
      0
    );
    const unsent = legs.reduce(
      (sum, leg) => sum + leg.writes.filter((w) => w.after.delivered === 0).length,
      0
    );
    expect(results.resendGuardSaw).toBe(results.resendOriginSeen - resent + unsent);
    expect(results.cancelled).toEqual([]);
  });
});
