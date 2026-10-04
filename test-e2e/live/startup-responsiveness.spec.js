// Real-node startup smoke test: the main process must stay responsive (#498).
//
// #495's ~30 s startup freeze shipped to nightly unnoticed: unit and routing
// tests replace Colibri with an instant fake, and the harness e2e project runs
// in FREEDOM_TEST_MODE, which stubs Ant, Myotis and the network. This spec
// launches the app the way a user does — live fixtures, so no test mode, a
// fresh profile, default settings, the bundled Ant from `npm run
// ant:download` — and for the first ~90 s round-trips a no-op through the main
// process (`electronApp.evaluate`) back to back. A round trip can only be as
// slow as the main thread is blocked, so the slowest one bounds the worst
// stall a user would have seen as a frozen window. It fails if any exceeds the
// threshold, or if the main process's own event-loop watchdog
// (src/main/event-loop-watchdog.js) logged a stall.
//
// Needs network and the downloaded node binaries, so it is not part of the
// per-PR CI matrix: run it on demand with `npm run test:e2e:startup-smoke`
// (under `xvfb-run -a` on a headless Linux box), or let the nightly workflow
// (.github/workflows/startup-smoke.yml) run it.
//
// Opt-in: the `live` project's testMatch picks up every file under live/, so
// a plain `npm run test:e2e:live` would otherwise also spend 90 s+ on a
// real-network check unrelated to most changes. The spec skips unless
// FREEDOM_STARTUP_SMOKE=1, which the npm script and the workflow set.
//
// Knobs (all optional):
//   FREEDOM_STARTUP_SMOKE_SECONDS     how long to poll (default 90)
//   FREEDOM_STARTUP_SMOKE_MAX_RTT_MS  fail above this round trip (default 1000)

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test: liveTest, expect, HAS_ANT_BINARY, ANT_BINARY_PATH } = require('../live-fixtures');

function positiveNumberFromEnv(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

const POLL_SECONDS = positiveNumberFromEnv('FREEDOM_STARTUP_SMOKE_SECONDS', 90);
const MAX_RTT_MS = positiveNumberFromEnv('FREEDOM_STARTUP_SMOKE_MAX_RTT_MS', 1000);
// A breather between round trips so the poll itself is not a busy loop on the
// CDP connection; small against the threshold, so a stall can't hide in it.
const POLL_GAP_MS = 50;
// Round trips slower than this are listed in the report even when they pass.
const NOTABLE_RTT_MS = 250;

// The embedded Radicle node binds $RAD_HOME/node/control.sock, which must fit
// sockaddr_un (~104 bytes on macOS) — same short home nodes.spec.js and
// radicle-fixtures.js use, for the same reason.
function makeShortRadicleHome() {
  const prefix = process.platform === 'win32' ? path.join(os.tmpdir(), 'rad-') : '/tmp/rad-';
  return fs.mkdtempSync(prefix);
}

const test = liveTest.extend({
  // eslint-disable-next-line no-empty-pattern
  launchEnv: async ({}, use) => {
    const radicleHome = makeShortRadicleHome();
    await use({ FREEDOM_RADICLE_DATA: radicleHome });
    try {
      fs.rmSync(radicleHome, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  },
});

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const OPTED_IN = (process.env.FREEDOM_STARTUP_SMOKE || '').trim() === '1';

test.describe('startup responsiveness (real nodes)', () => {
  test.skip(
    !OPTED_IN,
    'opt-in: run `npm run test:e2e:startup-smoke` (or set FREEDOM_STARTUP_SMOKE=1)'
  );
  test.skip(
    !HAS_ANT_BINARY && !process.env.CI,
    `antd not found at ${ANT_BINARY_PATH} — run \`npm run ant:download\` first`
  );

  test(`main process never blocks > ${MAX_RTT_MS} ms in the first ${POLL_SECONDS} s`, async ({
    electronApp,
  }, testInfo) => {
    // In CI a missing binary is a broken job, not a reason to pass.
    expect(HAS_ANT_BINARY, `antd not found at ${ANT_BINARY_PATH}`).toBe(true);
    test.setTimeout((POLL_SECONDS + 120) * 1000);

    // The live fixtures point the log file here (src/main/logger.js).
    const userData = await electronApp.evaluate(() => process.env.FREEDOM_TEST_USER_DATA);
    const logPath = path.join(userData, 'logs', 'main.log');

    const startedAt = Date.now();
    const samples = []; // { atMs, rttMs }
    while (Date.now() - startedAt < POLL_SECONDS * 1000) {
      const t0 = performance.now();
      await electronApp.evaluate(() => 0);
      samples.push({
        atMs: Math.round(Date.now() - startedAt),
        rttMs: Math.round(performance.now() - t0),
      });
      await new Promise((resolve) => setTimeout(resolve, POLL_GAP_MS));
    }

    // Not vacuous: the app's own Ant must have been the one running. A node
    // already on the default port gets adopted ('reused') and the bundled one
    // — and its chain reads through the router — never start.
    const window = await electronApp.firstWindow();
    const ant = await window.evaluate(async () => (await window.serviceRegistry.getRegistry()).ant);

    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    const watchdogLines = log
      .split('\n')
      .filter((line) => line.includes('[main] event loop blocked'));
    const antChainReads = log.split('\n').filter((line) => line.includes('[Ant chain]'));

    const rtts = samples.map((s) => s.rttMs).sort((a, b) => a - b);
    const worst = samples.reduce((a, b) => (b.rttMs > a.rttMs ? b : a), { rttMs: -1 });
    const notable = samples.filter((s) => s.rttMs >= NOTABLE_RTT_MS);
    const report = [
      `round trips: ${samples.length} over ${POLL_SECONDS} s`,
      `p50 ${percentile(rtts, 50)} ms, p99 ${percentile(rtts, 99)} ms, ` +
        `max ${worst.rttMs} ms at +${(worst.atMs / 1000).toFixed(1)} s`,
      `threshold ${MAX_RTT_MS} ms; >= ${NOTABLE_RTT_MS} ms: ` +
        (notable.length
          ? notable.map((s) => `${s.rttMs} ms @ +${(s.atMs / 1000).toFixed(1)} s`).join(', ')
          : 'none'),
      `ant: mode ${ant?.mode ?? 'unknown'}, ${antChainReads.length} [Ant chain] reads logged`,
      `watchdog lines: ${watchdogLines.length ? '\n  ' + watchdogLines.join('\n  ') : 'none'}`,
    ].join('\n');
    console.log(`[startup-smoke]\n${report}`);
    // Written under test-results/ (not just attached: the list reporter drops
    // in-memory attachments) so the nightly uploads them, pass or fail.
    fs.writeFileSync(testInfo.outputPath('startup-smoke-report.txt'), `${report}\n`);
    if (log) fs.writeFileSync(testInfo.outputPath('main.log'), log);
    // The nightly workflow shows the numbers on the run page, pass or fail.
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Startup responsiveness smoke\n\n\`\`\`\n${report}\n\`\`\`\n`
      );
    }

    expect(ant?.mode, `expected the bundled Ant, got mode "${ant?.mode}"`).toBe('bundled');
    expect(worst.rttMs, `slowest main-process round trip\n${report}`).toBeLessThanOrEqual(
      MAX_RTT_MS
    );
    expect(watchdogLines, `the event-loop watchdog reported a stall\n${report}`).toEqual([]);
  });
});
