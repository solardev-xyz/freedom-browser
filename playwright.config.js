// Playwright config for renderer E2E tests.
//
// Three projects:
//   - `harness` (default `npm run test:e2e`): fixture-driven specs that run
//     against the in-process test harness. No actual Ant, IPFS, ENS, or
//     network. Fast, deterministic, safe in CI.
//   - `live` (`npm run test:e2e:live`): drives the full app against live
//     services — actual antd node, live ENS resolution, real bzz:// /
//     ipfs:// protocol handlers. Requires `npm run ant:download` first
//     and is slow (Swarm cold-start can take several minutes). Skipped
//     automatically if the antd binary for the current platform isn't
//     present.
//   - `packaged` (`npm run test:e2e:packaged`): the release smoke test.
//     Same harness stubs, but Electron is launched from a *built* binary
//     named by `FREEDOM_E2E_EXECUTABLE` instead of from the source tree,
//     which is what catches packaging-class bugs (see
//     docs/agent-playbooks/release-process.md §6). Its `packaged-preflight`
//     setup project fails the run before any spec starts when that variable
//     is missing or does not name an executable file.
//
// Layout:
//   - `test-e2e/live/**/*.spec.js`         → `live` project
//   - `test-e2e/packaged/preflight.setup.js` → `packaged-preflight` project
//   - `test-e2e/packaged/**/*.spec.js`     → `packaged` project
//   - `test-e2e/*.spec.js`                 → `harness` project (everything else)

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test-e2e',
  // Sequential runs only — Electron launches multiple processes per app
  // instance and parallel runs would fight over the privileged-protocol
  // scheme cache and (in live mode) over Bee's default-port detection.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'harness',
      testMatch: /^(?!.*[\\/](?:live|packaged)[\\/]).*\.spec\.js$/,
      // Bee/IPFS startup is stubbed in test mode, but Electron + first-
      // window ready can still take 10–15s on cold cache. 30s gives
      // headroom without hiding genuine hangs.
      timeout: 30_000,
      expect: { timeout: 7_500 },
      retries: process.env.CI ? 2 : 0,
    },
    {
      name: 'live',
      testMatch: /[\\/]live[\\/].*\.spec\.js$/,
      // Live Swarm cold-start to a useful peer count typically takes
      // 30–120s, ENS resolution adds 1–5s, and the navigation probe
      // adds another few seconds. 10 min covers worst-case startup +
      // single-test work without inviting infinite hangs.
      timeout: 10 * 60_000,
      expect: { timeout: 30_000 },
    },
    {
      // Runs automatically ahead of `packaged` (and only then): a missing or
      // unusable FREEDOM_E2E_EXECUTABLE fails here, with the fix in the
      // message, instead of launching Electron from source and reporting a
      // green smoke test for an artifact nothing ever opened.
      name: 'packaged-preflight',
      testMatch: /[\\/]packaged[\\/]preflight\.setup\.js$/,
      timeout: 10_000,
    },
    {
      name: 'packaged',
      testMatch: /[\\/]packaged[\\/].*\.spec\.js$/,
      dependencies: ['packaged-preflight'],
      // `harness` plus headroom: a just-installed package launches with a
      // cold asar and cold shared libraries, and the persistence spec pays
      // that cost twice in a single test (launch, quit, relaunch).
      timeout: 120_000,
      expect: { timeout: 10_000 },
      retries: process.env.CI ? 2 : 0,
    },
  ],
});
