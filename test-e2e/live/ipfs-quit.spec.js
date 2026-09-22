// Regression guard for issue #345: quitting with the bundled native IPFS node
// running aborted the main process (SIGABRT) instead of exiting 0.
//
// This has to be a live spec. Under FREEDOM_TEST_MODE the node managers are
// stubbed away, so no freedom-ipfs event dispatcher worker exists and the
// quit path being guarded here is never taken — `harness` and `packaged`
// would both pass against the bug. Here the real addon starts, its dispatcher
// worker polls `gatewayWaitNextEvent` every 100ms, and the quit tears it down
// for real.
//
// What made it abort: the re-entrant `before-quit` that 'window-all-closed'
// triggers returned without preventDefault(), so Electron tore the process
// down while the wind-down was still awaiting the node stops — destroying the
// dispatcher worker's env mid-`gatewayWaitNextEvent`, whose throw then hit
// node-addon-api's fatal `Error::ThrowAsJavaScriptException napi_throw` path.
// So both of watchProcessExit()'s assertions matter: the exit status, and the
// absence of that line on stderr. Before the fix this reproduced on 7 of 10
// runs. The packaged artifact's own copy of this check lives in
// test-e2e/packaged-live/nodes.spec.js — #345 reproduces there too, and a
// wrong-arch or stale freedom-ipfs addon can only differ on teardown there.

const { test, expect, watchProcessExit, HAS_IPFS_NATIVE_ADDON } = require('../live-fixtures');

// Only IPFS. Ant, Radicle and Tor have nothing to do with this quit path and
// their boot time (and flakiness) would be paid for nothing.
const IPFS_ONLY = {
  startAntAtLaunch: false,
  startIpfsAtLaunch: true,
  startRadicleAtLaunch: false,
  enableTorIntegration: false,
  startTorAtLaunch: false,
};

const NODE_START_TIMEOUT_MS = 120_000;
const QUIT_TIMEOUT_MS = 60_000;

test.describe('quitting with the native IPFS node running', () => {
  test.skip(
    !HAS_IPFS_NATIVE_ADDON,
    'freedom-ipfs native addon not built — run `npm run ipfs:download`'
  );

  test.use({ seedSettings: IPFS_ONLY });

  test('the main process exits 0 instead of aborting in the event dispatcher', async ({
    window,
    electronApp,
  }) => {
    // Armed before the node starts so nothing the shutdown prints can be
    // missed. Asserted after the quit below.
    const expectCleanExit = watchProcessExit(electronApp, { timeout: QUIT_TIMEOUT_MS });

    // The dispatcher worker only exists once the node is actually running.
    await expect
      .poll(async () => (await window.evaluate(() => window.ipfs.getStatus())).status, {
        message: 'Waiting for the native IPFS node to start',
        timeout: NODE_START_TIMEOUT_MS,
        intervals: [1_000, 2_000],
      })
      .toBe('running');

    // 'bundled' + freedom-ipfs, not an external gateway this machine happens
    // to be running: an adopted external node has no dispatcher worker, and
    // this spec would then pass without exercising anything.
    const ipfs = await window.evaluate(
      async () => (await window.serviceRegistry.getRegistry()).ipfs
    );
    expect(ipfs.mode).toBe('bundled');
    expect(ipfs.backend).toBe('freedom-ipfs');

    try {
      await electronApp.close();
    } catch {
      // A crashing quit can break the CDP connection before close() returns;
      // the exit status below is what this spec is actually asserting on.
    }

    await expectCleanExit();
  });
});
