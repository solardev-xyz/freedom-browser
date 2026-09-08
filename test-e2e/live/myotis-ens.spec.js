// Live E2E for the experimental Myotis tier: the fully-P2P light client
// resolving ENS inside the real app. Requires the myotis-node addon
// (MYOTIS_NODE_PATH) and network access; ideally MYOTIS_DATA_DIR points at a
// warm data dir (a prior sync) so readiness arrives in seconds, not minutes.
//
//   MYOTIS_NODE_PATH=/path/to/myotis-node.node \
//   MYOTIS_DATA_DIR=/path/to/warm-data \
//   MYOTIS_E2E_IGNORE_KNOWN_STALL=1 \
//   npx playwright test --project=live myotis-ens
//
// Budgets (minutes): MYOTIS_E2E_READY_TIMEOUT_MIN caps each chain's readiness
// wait, MYOTIS_E2E_STALL_TIMEOUT_MIN caps how long a beacon light client may
// make zero catch-up progress before the wait gives up. The stall window must
// stay strictly below the readiness window or the guard can never fire — see
// myotis-sync-guard.js, which owns both defaults and warns on an inverted pair.
const path = require('path');
const { test, expect } = require('../live-fixtures');
const {
  envFlagEnabled,
  resolveTimeoutBudgets,
  createStallTracker,
} = require('./myotis-sync-guard');

const repoRoot = path.resolve(__dirname, '..', '..');
const MYOTIS_ENABLED = Boolean(process.env.MYOTIS_NODE_PATH);

// The pinned addon (biafra23/myotis v0.1.7, the newest published release)
// bootstraps every COLD start from a checkpoint embedded in the binary and
// then wedges: the catch-up applies periods 1825 -> 1840 and can never obtain
// the update for period 1840, so `beaconState` never leaves CATCHING_UP and
// readiness — which requires SYNCED — is unreachable. Deterministic, not
// network weather, and not fixable from this repo: the checkpoint is compiled
// in, the napi surface is only create(network, dataDir)/start(handle), and the
// binary exposes no MYOTIS_* knobs. See issue #200 for the captured evidence.
// Set MYOTIS_E2E_IGNORE_KNOWN_STALL=1 to run anyway — that is how we check
// whether a newer addon (or a warm MYOTIS_DATA_DIR) clears the stall.
const KNOWN_STALL_ISSUE = 'https://github.com/solardev-xyz/freedom-browser/issues/200';
const IGNORE_KNOWN_STALL = envFlagEnabled('MYOTIS_E2E_IGNORE_KNOWN_STALL');

// Cold sync can take many minutes; a warm data dir reaches ready in ~10-30 s.
// CI lets the production app perform the one and only native-client launch,
// so it grants the cold-sync budget directly instead of pre-warming through a
// separate process whose immediate restart can inherit peer backoff.
//
// A light client that is genuinely catching up advances (currentPeriod,
// finalizedSlot) in seconds — the last successful cold run applied nine
// periods in 15 s. When neither moves for minutes the sync is wedged, not
// slow, and no extra budget rescues it. Abort on the stall instead of sitting
// out the whole readiness budget (which cost ~1.3 h per platform before).
const budgets = resolveTimeoutBudgets();
if (budgets.warning) console.warn(budgets.warning);
const READY_TIMEOUT_MINUTES = budgets.readyTimeoutMinutes;
const READY_TIMEOUT_MS = READY_TIMEOUT_MINUTES * 60 * 1000;
const STALL_TIMEOUT_MINUTES = budgets.stallTimeoutMinutes;
const STALL_TIMEOUT_MS = STALL_TIMEOUT_MINUTES * 60 * 1000;

const POLL_INTERVAL_MS = 5000;

function readinessSummary(state) {
  const status = state?.status || {};
  return {
    ready: state?.ready === true,
    beaconState: status.beaconState || null,
    elReaderAvailable: status.elReaderAvailable === true,
    elHunting: status.elHunting === true,
    peerCount: status.peerCount ?? 0,
    readyPeers: status.readyPeers ?? 0,
    snapPeers: status.snapPeers ?? 0,
    probeStatus: state?.probe?.status || null,
    probeError: state?.probe?.error || null,
  };
}

// Poll `read()` until `satisfied()`, bounded by both the readiness budget and
// the beacon-sync stall guard. Shared by the Ethereum and Gnosis waits so a
// wedged client on either chain fails fast with the same diagnostics.
async function waitForVerifiedRead({ label, read, satisfied }) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastReadinessLog = '';
  const stall = createStallTracker(Date.now());
  for (;;) {
    const state = await read();
    const serializedSummary = JSON.stringify(readinessSummary(state));
    if (serializedSummary !== lastReadinessLog) {
      console.log(`[myotis-e2e] waiting for ${label}:`, serializedSummary);
      lastReadinessLog = serializedSummary;
    }
    if (satisfied(state)) return state;

    const stalledForMs = stall.update(state.status, Date.now());
    if (stalledForMs !== null && stalledForMs > STALL_TIMEOUT_MS) {
      throw new Error(
        `${label} Myotis light client sync is wedged: no beacon progress for ` +
          `${STALL_TIMEOUT_MINUTES} min (see ${KNOWN_STALL_ISSUE}); ` +
          `last state: ${JSON.stringify(state)}`
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label} myotis never served a verified read; last state: ${JSON.stringify(state)}`
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function resolveRecordsThroughMyotis(electronApp, paths, options) {
  let lastAttempt = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    // eslint-disable-next-line no-empty-pattern
    lastAttempt = await electronApp.evaluate(async ({}, options) => {
      const manager = process.mainModule.require(options.manager);
      const registry = process.mainModule.require(options.registry);
      const resolver = process.mainModule.require(options.resolver);
      const readyBefore = manager.isReady();
      const statusBefore = manager.getStatus();
      let probe = null;
      if (readyBefore) {
        try {
          probe = await manager.resolveContenthash('vitalik.eth');
        } catch (err) {
          probe = { error: err.message };
        }
      }
      if (!readyBefore || probe?.status !== 'ok') {
        return { readyBefore, statusBefore, probe };
      }

      registry.updateNetwork(1, {
        verification: {
          primary: 'colibri',
          order: ['myotis', 'colibri', 'quorum'],
          preferVerified: options.policyPreferVerified,
        },
      });
      resolver.clearEnsResolutionCaches();
      try {
        return {
          readyBefore,
          statusBefore,
          probe,
          address: options.includeEns
            ? await resolver.resolveEnsAddress('vitalik.eth')
            : null,
          reverse: options.includeEns
            ? await resolver.resolveEnsReverse(options.vitalik)
            : null,
          wns: await resolver.resolveEnsContent('meinhard.wei'),
          gns: await resolver.resolveEnsContent('apoorv.gwei'),
          readyAfter: manager.isReady(),
          statusAfter: manager.getStatus(),
        };
      } catch (err) {
        return {
          readyBefore,
          statusBefore,
          error: { code: err.code || null, message: err.message },
          readyAfter: manager.isReady(),
          statusAfter: manager.getStatus(),
        };
      } finally {
        registry.updateNetwork(1, {
          verification: {
            primary: 'colibri',
            order: ['myotis', 'colibri', 'quorum'],
            preferVerified: true,
          },
        });
        resolver.clearEnsResolutionCaches();
      }
    }, { ...paths, ...options });

    console.log(
      `[myotis-e2e] integrated attempt ${attempt} ` +
        `preferVerified=${options.policyPreferVerified} includeEns=${options.includeEns}: ` +
        JSON.stringify(lastAttempt).slice(0, 1800)
    );
    const records = [lastAttempt.wns, lastAttempt.gns];
    if (options.includeEns) records.push(lastAttempt.address, lastAttempt.reverse);
    if (records.every((record) => record?.trust?.method === 'myotis')) {
      return lastAttempt;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }

  return lastAttempt || {};
}

test.describe('myotis live ENS resolution', () => {
  test.skip(!MYOTIS_ENABLED, 'MYOTIS_NODE_PATH not set — myotis spike disabled');
  test.skip(
    MYOTIS_ENABLED && !IGNORE_KNOWN_STALL,
    `myotis v0.1.7 cold sync wedges at beacon period 1840 upstream (${KNOWN_STALL_ISSUE}) — ` +
      'set MYOTIS_E2E_IGNORE_KNOWN_STALL=1 to run this spec anyway'
  );

  test('P2P node serves ENS and NameNFT records through Freedom; page renders', async ({
    electronApp,
    window: win,
  }) => {
    // Two independent network readiness budgets plus bounded resolver retries
    // and final UI navigation.
    test.setTimeout(READY_TIMEOUT_MS * 2 + 10 * 60 * 1000);

    // 1. Wait (in the app's main process) for the node to report ready and
    //    prove that a verified read is actually servable. A warm restart can
    //    briefly restore a SYNCED beacon snapshot before the live peer context
    //    needed by ENS reads has settled, so status alone is not sufficient.
    const managerPath = path.join(repoRoot, 'src', 'main', 'myotis', 'myotis-manager.js');
    const status = await waitForVerifiedRead({
      label: 'Ethereum',
      read: () =>
        // eslint-disable-next-line no-empty-pattern
        electronApp.evaluate(async ({}, p) => {
          // Playwright's evaluate sandbox has no `require` global; go through
          // the main process's own module system instead.
          const m = process.mainModule.require(p);
          const ready = m.isReady();
          let probe = null;
          if (ready) {
            try {
              probe = await m.resolveContenthash('vitalik.eth');
            } catch (err) {
              probe = { error: err.message };
            }
          }
          return { ready, probe, status: m.getStatus() };
        }, managerPath),
      satisfied: (state) =>
        state.ready && state.probe?.status === 'ok' && state.probe.verified === true,
    });
    console.log(
      '[myotis-e2e] node ready and direct read verified:',
      JSON.stringify({ status: status.status, probe: status.probe }).slice(0, 1000)
    );

    // 2. Resolve through the REAL resolver pipeline in the main process and
    //    assert the myotis tier carried the answer. The first read after
    //    readiness can still fail on a cold head context (the tier then
    //    falls through to colibri by design and the answer caches), so
    //    retry with cache invalidation until myotis carries it.
    const resolverPath = path.join(repoRoot, 'src', 'main', 'ens-resolver.js');
    const registryPath = path.join(
      repoRoot,
      'src',
      'main',
      'networks',
      'network-registry.js'
    );
    let result;
    for (let attempt = 1; attempt <= 6; attempt++) {
      // eslint-disable-next-line no-empty-pattern
      const resolution = await electronApp.evaluate(async ({}, paths) => {
        const manager = process.mainModule.require(paths.manager);
        const registry = process.mainModule.require(paths.registry);
        const resolver = process.mainModule.require(paths.resolver);
        const readyBefore = manager.isReady();
        const statusBefore = manager.getStatus();
        resolver.invalidateEnsContent('vitalik.eth');
        const resolved = await resolver.resolveEnsContent('vitalik.eth');
        return {
          result: resolved,
          diagnostic: {
            readyBefore,
            readyAfter: manager.isReady(),
            epoch: manager.getAvailabilityEpoch(),
            statusBefore,
            statusAfter: manager.getStatus(),
            verification: registry.getNetwork(1)?.verification || null,
          },
        };
      }, { manager: managerPath, registry: registryPath, resolver: resolverPath });
      result = resolution.result;
      console.log(
        `[myotis-e2e] resolution attempt ${attempt}: method=${result?.trust?.method} ` +
          JSON.stringify({ result, diagnostic: resolution.diagnostic }).slice(0, 1500)
      );
      if (result?.trust?.method === 'myotis') break;
      await new Promise((r) => setTimeout(r, 15000));
    }

    expect(result.type).toBe('ok');
    expect(result.trust.method).toBe('myotis');
    expect(result.trust.level).toBe('verified');
    expect(result.protocol).toBe('ipfs');

    // 3. Gnosis uses a second native handle and profile-local state directory.
    // Prove both the native account path and Freedom's capability router while
    // the already-verified Ethereum client remains running.
    await waitForVerifiedRead({
      label: 'Gnosis',
      read: () =>
        // eslint-disable-next-line no-empty-pattern
        electronApp.evaluate(async ({}, { managerPath: p, address }) => {
          const m = process.mainModule.require(p);
          m.startMyotis({ chainId: 100 });
          const ready = m.isReady(100);
          let probe = null;
          if (ready) {
            try {
              probe = await m.getAccount(address, 100);
            } catch (err) {
              probe = { error: err.message };
            }
          }
          return { ready, probe, status: m.getStatus(100) };
        }, { managerPath, address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' }),
      satisfied: (state) =>
        state.ready &&
        state.probe?.peerProofValid === true &&
        state.probe?.beaconChainVerified === true,
    });

    const routerPath = path.join(repoRoot, 'src', 'main', 'networks', 'chain-data-router.js');
    const routedGnosis = await electronApp.evaluate(
      // eslint-disable-next-line no-empty-pattern
      async ({}, { p, address }) => {
        const router = process.mainModule.require(p);
        return router.request(100, 'eth_getBalance', [address, 'latest']);
      },
      { p: routerPath, address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' }
    );
    expect(routedGnosis).toMatchObject({ source: 'myotis', verified: true });
    expect(routedGnosis.result).toMatch(/^0x[0-9a-f]+$/i);

    // 4. Exercise the other production integration surfaces through the same
    //    resolver module: ENS addr + forward-verified reverse, then WNS/GNS
    //    NameNFT calls through Myotis's generic local EVM executor. Retry the
    //    pair as one proof because a transient peer miss correctly falls back
    //    to Colibri in production but does not prove the Myotis integration.
    //    Finally, prove preferVerified still accepts Myotis's authenticated
    //    optimistic-root answers as verified.
    const integratedPaths = {
      manager: managerPath,
      registry: registryPath,
      resolver: resolverPath,
    };
    const myotisAttempt = await resolveRecordsThroughMyotis(
      electronApp,
      integratedPaths,
      {
        includeEns: true,
        policyPreferVerified: false,
        vitalik: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      }
    );
    const preferredAttempt = await resolveRecordsThroughMyotis(
      electronApp,
      integratedPaths,
      { includeEns: false, policyPreferVerified: true }
    );
    const integration = {
      address: myotisAttempt.address,
      reverse: myotisAttempt.reverse,
      myotis: { wns: myotisAttempt.wns, gns: myotisAttempt.gns },
      preferred: { wns: preferredAttempt.wns, gns: preferredAttempt.gns },
    };
    console.log('[myotis-e2e] integrated record reads:', JSON.stringify(integration).slice(0, 1500));

    expect(integration.address).toMatchObject({
      success: true,
      system: 'ens',
      trust: { method: 'myotis', level: 'verified' },
    });
    expect(integration.address.address.toLowerCase()).toBe(
      '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
    );
    expect(integration.reverse).toMatchObject({
      success: true,
      name: 'vitalik.eth',
      system: 'ens',
      trust: { method: 'myotis', level: 'verified' },
    });
    expect(integration.myotis.wns).toMatchObject({
      type: 'ok',
      system: 'wns',
      trust: { method: 'myotis', level: 'verified', finality: 'optimistic' },
    });
    expect(integration.myotis.gns).toMatchObject({
      type: 'ok',
      system: 'gns',
      trust: { method: 'myotis', level: 'verified', finality: 'optimistic' },
    });
    expect(integration.preferred.wns).toMatchObject({
      type: 'ok',
      system: 'wns',
      trust: { method: 'myotis', level: 'verified', finality: 'optimistic' },
    });
    expect(integration.preferred.gns).toMatchObject({
      type: 'ok',
      system: 'gns',
      trust: { method: 'myotis', level: 'verified', finality: 'optimistic' },
    });

    // 5. Drive the UI: navigate to the name and let the page render through
    //    the local IPFS gateway (same assertion style as eth-sites.spec.js).
    await win.fill('[data-test="address-input"]', 'vitalik.eth');
    await win.press('[data-test="address-input"]', 'Enter');
    await win.waitForFunction(
      () => {
        const webview = document.querySelector('webview.active, webview');
        return Boolean(webview && webview.getURL && webview.getURL().length > 0);
      },
      { timeout: 90_000 }
    );
    const url = await win.evaluate(() => {
      const webview = document.querySelector('webview.active, webview');
      return webview?.getURL?.() || '';
    });
    console.log('[myotis-e2e] webview url:', url);
    expect(url).toBeTruthy();
  });
});
