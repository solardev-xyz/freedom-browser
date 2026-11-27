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
 * never sent twice; #1344) where Chromium's stack would break it: when a
 * reused keep-alive connection closes before a request's headers, Chromium
 * sends the request again, below the guard, and a streamed body's second
 * attempt crashes its network service (electron/electron#56077). Main
 * sends each write on a write session of its own, its connections closed
 * first (`swarm/ant-write-sessions.js`). Over HTTP and through the SOCKS
 * proxy, a node keeps connections open, takes the next write whole and
 * closes without headers: every write the executor sends, whole or
 * streamed, reaches it once, on a new connection, through the proxy, and
 * the call answers its failure, with no crash. A write session sends
 * nothing else: its own guard admits only its lease's write, and its spell
 * checker never fetches a dictionary (#1358). A whole body sent on the
 * session's kept connection, as main sent one before, is the control:
 * Chromium sends it twice. A read may be sent twice, which is idempotent
 * (design 0015's amendment of 2026-11-27). Four streamed uploads go at
 * once, and a write to a `.onion` node follows Tor's routing as
 * `tor-proxy.js` sets it on the session.
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
    // The proxy was asked for the node by its name, never an address, and
    // for nothing else: the session sends only the node's host through it,
    // a write session everything it sends (#1358).
    expect(results.socksSeen).toEqual([`ant.example.test:${port}`]);
    expect(results.stamp).toEqual({ ok: true });
  });

  // Writes go on write sessions, which run no guard: the guard saw the reads.
  test('the guard saw each read as main its own (frameless, other), no write, and cancelled none', () => {
    expect(results.guardKinds).toEqual(['other:false']);
    expect(results.guardMethods).toEqual(['GET']);
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
    // The guard saw one request a read's dial: a read sent again never
    // reached it, and a write never does.
    const reads = results.originSeen.filter((seen) => seen.method === 'GET').length;
    const resent = results.dials.reduce((sum, extra) => sum + extra.dials - 1, 0);
    expect(results.guardSaw).toBe(reads - resent);
    expect(results.failures).toBe(hangsUp.size);
    expect(results.networkGone).toEqual([]);
    process.stdout.write(
      `[swarm-shell proxy] reads the node saw twice: ${JSON.stringify(results.dials)}\n`
    );
  });

  describe.each(['http', 'socks'])(
    'a node keeps connections open, takes the next call whole and closes without headers (%s)',
    (route) => {
      let leg;
      beforeAll(() => {
        leg = results.resend[route];
      });

      test(route === 'socks' ? 'through the SOCKS proxy' : 'straight to the node', () => {
        const { port } = new URL(results.remote);
        if (route === 'socks') {
          expect(leg.resolveProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
          expect(leg.via).toEqual([true]);
          expect(leg.socks).toEqual([`ant.example.test:${port}`]);
        } else {
          expect(leg.resolveProxy).toBe('DIRECT');
          expect(leg.via).toEqual([false]);
          expect(leg.socks).toEqual([]);
        }
      });

      // The control: the condition holds, and Chromium sends a whole body
      // again on a new connection, its second delivery answered as a success.
      test('a whole body sent on the session, as main sent one before #1344, reaches the node twice', () => {
        const { control } = leg;
        expect(control.warm).toEqual({ ok: true });
        expect(control.delivered).toEqual([
          expect.objectContaining({ reused: true, contentLength: String(control.bytes) }),
          expect.objectContaining({ reused: false, contentLength: String(control.bytes) }),
        ]);
        expect(control.answer).toEqual({ status: 201 });
        expect(control.networkGone).toEqual([]);
      });

      test('every write reaches the node once, on a new connection, whole or streamed; the call answers its failure, with no crash', () => {
        expect(leg.writes.map((w) => w.form).sort()).toEqual(
          [
            'bytes_up',
            'bzz_file',
            'bzz_file',
            'bzz_tar',
            'chunk_up',
            'feed_manifest',
            'pss_send',
            'pss_send',
            'soc_up',
          ].sort()
        );
        for (const write of leg.writes) {
          // A read and a write each left a connection the node kept.
          expect({ id: write.id, warm: write.warm }).toEqual({
            id: write.id,
            warm: { read: { ok: true }, write: { status: 201, conn: expect.any(Number) } },
          });
          const framing =
            write.body === 'stream'
              ? { transferEncoding: 'chunked', contentLength: null }
              : { transferEncoding: null, contentLength: String(write.bytes) };
          expect({ id: write.id, delivered: write.delivered }).toEqual({
            id: write.id,
            delivered: [
              expect.objectContaining({
                reused: false,
                method: 'POST',
                ...framing,
                bytes: write.bytes,
                digest: write.digest,
              }),
            ],
          });
          // Not on the connection the warm write left on its session.
          expect(write.delivered[0].conn).not.toBe(write.warm.write.conn);
          expect({ id: write.id, answer: write.answer }).toEqual({
            id: write.id,
            answer: { failed: 'error' },
          });
          expect({ id: write.id, networkGone: write.networkGone, closed: write.closed }).toEqual({
            id: write.id,
            networkGone: [],
            closed: true,
          });
        }
        const bodies = Object.fromEntries(leg.writes.map((w) => [w.id, [w.body, w.bytes]]));
        expect(bodies).toMatchObject({
          'send-pss-node-hangs-up': ['whole', 2],
          'send-pss-sent-empty': ['none', 0],
          'publish-chunk-4096': ['whole', 4104],
          'create-feed-name-64': ['none', 0],
          'publish-files-one-file': ['stream', 2048],
          'write-feed-4097': ['stream', 4097],
          'publish-data-10mib': ['stream', 10485760],
        });
      });

      // No crash, so nothing in flight fails with it: the session's next
      // call goes, once, and is answered.
      test("the session's next call after each write is sent once and answered", () => {
        for (const write of leg.writes) {
          expect({ id: write.id, after: write.after }).toEqual({
            id: write.id,
            after: { answer: { ok: true }, delivered: 1 },
          });
        }
      });

      // Measured: a read has no body, so Chromium may send it again, which
      // is idempotent (design 0015's amendment of 2026-11-27).
      test('a read reaches the node at most twice; its second delivery answers it', () => {
        for (const read of leg.reads) {
          expect(read.warm.read).toEqual({ ok: true });
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

      // The node answers none of them until all four bodies are in: writes
      // that waited for each other would time out.
      test('four streamed uploads go at once, each once, on a connection of its own', () => {
        const { together } = leg;
        expect(together.answers).toEqual(Array(4).fill({ status: 201 }));
        expect(together.networkGone).toEqual([]);
        expect(together.delivered).toHaveLength(4);
        for (const upload of together.delivered) {
          expect(upload).toMatchObject({
            reused: false,
            transferEncoding: 'chunked',
            bytes: 8 * 1024 * 1024,
          });
        }
        expect(new Set(together.delivered.map((upload) => upload.conn)).size).toBe(4);
        expect(together.delivered.map((upload) => upload.digest).sort()).toEqual(
          [...together.digests].sort()
        );
        process.stdout.write(
          `[swarm-shell proxy] ${route}: four 8 MiB uploads at once in ${together.ms} ms\n`
        );
      });
    }
  );

  // The write session takes the session's proxy as Chromium resolves it
  // there: Tor's SOCKS5 for the onion host while Tor runs, DIRECT once it
  // stops, which the onion gate refuses before anything is sent.
  test("a write to a .onion node: through Tor's proxy, by name, while Tor runs; refused unsent once it stops", () => {
    const { node, running, stopped } = results.onion;
    const { host } = new URL(node);
    expect(running.resolveProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
    expect(running.answer).toEqual({ status: 201 });
    expect(running.socks).toEqual([host]);
    expect(running.delivered).toEqual([
      { viaProxy: true, reused: false, method: 'POST', bytes: 8 },
    ]);
    expect(stopped.resolveProxy).toBe('DIRECT');
    expect(stopped.answer).toEqual({
      thrown: expect.stringMatching(
        /^OnionGateRefusal: \.onion gateway is not routed through a proxy/
      ),
    });
    expect(stopped.socks).toEqual([]);
    expect(stopped.delivered).toEqual([]);
  });

  // #1358: a write session carries its lease's write and nothing else. Its
  // spell checker's dictionary is never fetched, and its own guard, armed
  // for the one write, had nothing to refuse.
  // The NetLog has every request of every session, through webRequest or
  // not (a spell checker's dictionary isn't): over HTTP and through SOCKS,
  // the app requested the node and nothing else.
  test("the app's network stack requested nothing but the node, over HTTP and through SOCKS", () => {
    const nodes = [results.remote, results.onion.node].map((node) => new URL(node).origin);
    expect(results.netLogOrigins.sort()).toEqual(nodes.sort());
  });

  test('the write sessions sent their writes and nothing else, each a POST to the node', () => {
    const { made, sent, sentAs, refused } = results.writeSessions;
    expect(made).toBeGreaterThanOrEqual(4);
    expect(made).toBeLessThanOrEqual(8);
    const nodes = [results.remote, results.onion.node].map(
      (node) => `POST ${new URL(node).origin}`
    );
    expect(sentAs.sort()).toEqual(nodes.sort());
    // One a write: every POST the node saw but the control's, which went
    // on the session.
    const plays = results.originSeen.filter((seen) => seen.method === 'POST').length;
    const legs = Object.values(results.resend);
    const control = legs.reduce((sum, leg) => sum + leg.control.delivered.length, 0);
    expect(sent).toBe(
      plays + results.resendOriginSeen.POST - control + results.onion.running.delivered.length
    );
    expect(refused).toEqual([]);
  });

  // In a real session: with no write armed, its own guard refuses the
  // node's URLs and any other, and nothing reaches the node.
  test("a write session's own guard refuses anything it wasn't armed for", () => {
    const blocked = { error: 'net::ERR_BLOCKED_BY_CLIENT' };
    expect(results.writeGuard).toEqual({
      read: blocked,
      write: blocked,
      elsewhere: blocked,
      delivered: 0,
    });
  });

  test('the resend leg: the guard saw each read once and the control, no write, and cancelled none', () => {
    const legs = Object.values(results.resend);
    const resent = legs.reduce(
      (sum, leg) => sum + leg.reads.reduce((n, r) => n + r.delivered.length - 1, 0),
      0
    );
    expect(results.resendGuardSaw).toEqual({
      GET: results.resendOriginSeen.GET - resent,
      // The control's POST, once a route: its second delivery never passed.
      POST: legs.length,
    });
    expect(results.cancelled).toEqual([]);
    expect(results.networkGone).toEqual([]);
  });
});
