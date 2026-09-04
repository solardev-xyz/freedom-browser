// Packaged smoke — step 5 of the release-process.md §6 checklist:
// "confirm Ant, native IPFS, and Radicle start cleanly".
//
// The specs in test-e2e/packaged/ drive the packaged binary with
// FREEDOM_TEST_MODE, which stubs every node away. These ones go through the
// live fixtures instead: no test mode, so the artifact's *own* bundled antd,
// freedom-ipfs addon, libradicle addon and Arti binary are what start. That is
// the packaging bug this catches — an extraResources rule that only resolves
// in a source tree, or an addon built for the wrong arch, launches fine and
// only fails when its manager tries to use it.
//
// One test per node, each with its own app instance seeded to start only the
// node under test, so a failure names the culprit and no node pays for
// another's boot time. The live fixtures give every test a fresh temp root
// (userData + ant-data + ipfs-data + identity, with Radicle's and Tor's data
// dirs defaulting under that same scratch userData), which is what keeps the
// deb/AppImage, dmg/zip and installer/portable legs — which run back to back
// on one runner — from inheriting each other's node state.
//
// What is asserted is deliberately only "the manager reports running, within a
// bounded time" (plus, for Ant, that its local HTTP API answers /health on the
// port the app itself published). Peer counts and content retrieval depend on
// peer discovery, which is slow and nondeterministic on a CI runner.

const { test, expect } = require('../live-fixtures');

// One budget for all three, sized from the slowest thing measured rather than
// from a round number: antd's own startup poll gives up after 60 attempts × 1s
// and reports "Startup timed out", and the libradicle addon reported running
// in ~5s on an offline box but took ~60s on a networked one (it dials its
// seeds while starting). 180s is roughly 3× that worst case, which is the
// headroom a cold packaged launch on a shared arm64 runner can need.
const NODE_START_TIMEOUT_MS = 180_000;
// Arti has to bootstrap a Tor circuit before it reports running — same budget
// tor-onion.spec.js uses.
const TOR_START_TIMEOUT_MS = 180_000;
// The API is already answering by the time the manager says running (that is
// how it decides); this only covers the hop from the app's health probe to
// ours.
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

// Every node off. Each test turns exactly one back on.
const NODES_OFF = {
  startAntAtLaunch: false,
  startIpfsAtLaunch: false,
  startRadicleAtLaunch: false,
  enableTorIntegration: false,
  startTorAtLaunch: false,
};

// Poll until the manager reaches a state it will not leave on its own, then
// assert it is the right one. Waiting for 'running' directly would spend the
// whole budget on a node that already reported 'error' and then fail with a
// bare timeout instead of the manager's own message.
async function expectNodeRunning(window, api, { label, timeout }) {
  let last = null;

  await expect
    .poll(
      async () => {
        last = await window.evaluate((name) => window[name].getStatus(), api);
        return last.status === 'running' || last.status === 'error';
      },
      {
        message: `Waiting for the packaged ${label} node to finish starting`,
        timeout,
        intervals: [1_000, 2_000],
      }
    )
    .toBe(true);

  expect(last.status, `${label} did not start: ${last.error || 'no error reported'}`).toBe(
    'running'
  );

  return last;
}

// The address the app itself published for a service, e.g.
// 'http://127.0.0.1:1634' for Ant. Read from the registry rather than
// hardcoded: the configured port is per profile, and a busy port makes the
// manager fall back to the next free one (both true on a dev machine that
// already runs a node).
const registryEntry = (window, service) =>
  window.evaluate(async (name) => (await window.serviceRegistry.getRegistry())[name], service);

test.describe('packaged bundled nodes', () => {
  test.describe('Ant', () => {
    test.use({ seedSettings: { ...NODES_OFF, startAntAtLaunch: true } });

    test('the bundled Ant node starts and its local API answers /health', async ({ window }) => {
      // The artifact ships an antd for this platform and arch at all — checked
      // through the manager's own path resolution, so a missing
      // extraResources entry fails here with the reason rather than as a
      // startup timeout below.
      expect(await window.evaluate(() => window.ant.checkBinary())).toEqual({ available: true });

      await expectNodeRunning(window, 'ant', { label: 'Ant', timeout: NODE_START_TIMEOUT_MS });

      const ant = await registryEntry(window, 'ant');
      // 'bundled' — not 'reused'. If something else on the machine is already
      // serving the Ant API on the ecosystem default port (a
      // `npm run system-ant:start` node, or an antd a previous smoke leg left
      // behind), the manager adopts it and the artifact's own antd never runs,
      // which would make this leg pass without testing anything.
      expect(ant.mode, `expected the artifact's own antd, got mode "${ant.mode}"`).toBe('bundled');
      expect(ant.api).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // The status above is the app's own view. This is the same check a user
      // (or `npm run ant:status`) would make from outside the app: the node is
      // really listening on the port the app advertises.
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(`${ant.api}/health`, {
                signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
              });
              return response.status;
            } catch (error) {
              // Returned, not swallowed: the poll keeps retrying and the
              // failure message ends up carrying this string.
              return `request failed: ${error.message}`;
            }
          },
          {
            message: `Waiting for ${ant.api}/health to answer`,
            timeout: HEALTH_TIMEOUT_MS,
            intervals: [500, 1_000],
          }
        )
        .toBe(200);
    });
  });

  test.describe('native IPFS', () => {
    test.use({ seedSettings: { ...NODES_OFF, startIpfsAtLaunch: true } });

    test('the bundled native IPFS node starts', async ({ window }) => {
      await expectNodeRunning(window, 'ipfs', {
        label: 'native IPFS',
        timeout: NODE_START_TIMEOUT_MS,
      });

      // The native node has no HTTP port (getActivePort() is always null), so
      // the registry entry is the only thing that says which implementation
      // came up: 'bundled' + the freedom-ipfs backend is the addon shipped in
      // this artifact, not an external node the runner happened to have.
      const ipfs = await registryEntry(window, 'ipfs');
      expect(ipfs.mode).toBe('bundled');
      expect(ipfs.backend).toBe('freedom-ipfs');
    });
  });

  test.describe('Radicle', () => {
    test.use({ seedSettings: { ...NODES_OFF, startRadicleAtLaunch: true } });

    test('the bundled Radicle node starts', async ({ window }) => {
      await expectNodeRunning(window, 'radicle', {
        label: 'Radicle',
        timeout: NODE_START_TIMEOUT_MS,
      });

      // 'embedded' is the mode that means the libradicle addon in this
      // artifact loaded and is serving radapi:.
      const radicle = await registryEntry(window, 'radicle');
      expect(radicle.mode).toBe('embedded');
      expect(radicle.api).toBe('radapi://local');
    });
  });

  test.describe('Tor', () => {
    // Tor is off by default and gated behind the Experimental toggle, so both
    // settings are needed before the manager will start Arti at launch.
    test.use({
      seedSettings: { ...NODES_OFF, enableTorIntegration: true, startTorAtLaunch: true },
    });

    test('the bundled Arti binary starts, when the build bundles one', async ({ window }) => {
      // Arti is only bundled when the build ran `npm run tor:download`: never
      // on Windows (no arti in the win extraResources), and not on a
      // `bundle_tor=false` dispatch run. Ask the app, which resolves the path
      // through tor-manager's own getArtiBinaryPath() — resources/arti-bin/arti
      // in a package — rather than guessing a layout from the outside.
      const { available } = await window.evaluate(() => window.tor.checkBinary());
      test.skip(
        !available,
        'This build bundles no Arti binary (expected on Windows and on builds made without `npm run tor:download`)'
      );

      await expectNodeRunning(window, 'tor', { label: 'Tor', timeout: TOR_START_TIMEOUT_MS });

      // Running means Arti's SOCKS proxy is listening — that address is what
      // the session proxy routes .onion traffic through.
      const tor = await registryEntry(window, 'tor');
      expect(tor.socks).toMatch(/^127\.0\.0\.1:\d+$/);
    });
  });
});
