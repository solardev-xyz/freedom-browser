// Set app name early, before electron-log initializes (it uses app name for log path)
const { app, dialog } = require('electron');
const appName = app.isPackaged
  ? process.platform === 'linux'
    ? 'freedom'
    : 'Freedom'
  : 'Freedom Dev';

// Suppress Electron security warnings in development (CSP handles security in production)
if (!app.isPackaged) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

app.name = appName;
app.setName(appName);

// E2E test mode (Playwright). `FREEDOM_TEST_MODE=1` activates the
// fixture-driven harness in src/main/test-harness.js (stubbed protocols,
// no real Bee/IPFS spawn). `FREEDOM_TEST_USER_DATA` redirects userData
// to a per-run temp dir so each spec gets a clean settings/bookmarks/
// history store — honoured independently of FREEDOM_TEST_MODE so the
// live-network E2E suite can also opt into a clean userData without
// activating the harness. Both must be applied before any other module
// touches userData.
if (process.env.FREEDOM_TEST_USER_DATA) {
  app.setPath('userData', process.env.FREEDOM_TEST_USER_DATA);
  // Keep E2E download artifacts inside the per-run temp dir instead of
  // polluting the real ~/Downloads folder.
  app.setPath(
    'downloads',
    require('path').join(process.env.FREEDOM_TEST_USER_DATA, 'downloads')
  );
}
const TEST_MODE = process.env.FREEDOM_TEST_MODE === '1';
const { migrateBeeDataToAntData, migrateUserData } = require('./migrate-user-data');
if (app.isPackaged && !process.env.FREEDOM_TEST_USER_DATA) {
  migrateUserData({ logger: console });
}
const { initializeProfile, warnAboutLegacyDevData } = require('./profile-resolver');
let activeProfile = null;
try {
  activeProfile = initializeProfile(app);
} catch (error) {
  dialog.showErrorBox(
    'Freedom profile could not open',
    `Freedom could not initialize the selected profile.\n\n${error?.message || error}`
  );
  app.exit(1);
  process.exit(1);
}
const {
  acquireProfileLock,
  isLockUnavailableError,
  releaseProfileLock,
} = require('./profile-lock');
const {
  requestProfileFocusSync,
  startProfileFocusRequestWatcher,
} = require('./profile-focus-handoff');
let activeProfileLock = null;
try {
  activeProfileLock = acquireProfileLock(activeProfile, { logger: console });
} catch (error) {
  if (isLockUnavailableError(error)) {
    const profileName = activeProfile.displayName || activeProfile.id || 'selected';
    const focusResult = requestProfileFocusSync(activeProfile);
    if (!focusResult.ok) {
      dialog.showErrorBox(
        'Freedom profile is already open',
        `The "${profileName}" profile is already open, but Freedom could not focus it.\n\nClose that Freedom window or launch a different profile.`
      );
    }
    app.exit(0);
    process.exit(0);
  }
  throw error;
}
// Deep-link the profile manager's edit button lands an opened profile on. The
// intent crosses process boundaries as a boolean (focus request field / the
// `--open-settings` launch flag); this is the only place it becomes a URL.
const PROFILE_SETTINGS_DEEPLINK = 'freedom://settings/profile';
let focusCurrentProfileWindow = null;
const profileFocusWatcher = startProfileFocusRequestWatcher(
  activeProfile,
  (request) =>
    app.whenReady().then(() => {
      if (typeof focusCurrentProfileWindow !== 'function') {
        throw new Error('Main window focus handler is not ready');
      }
      return focusCurrentProfileWindow(request?.openSettings ? PROFILE_SETTINGS_DEEPLINK : null);
    }),
  {
    logger: console,
    // Another Freedom process asked us to close — e.g. it is deleting this
    // profile and needs our lock released first. Quit on the next tick so the
    // ack is written before shutdown begins.
    onQuit: () => {
      setTimeout(() => app.quit(), 0);
      return Promise.resolve();
    },
  }
);

const { version } = require('../../package.json');
const iconPath = app.isPackaged
  ? require('path').join(process.resourcesPath, 'assets', 'icon.png')
  : require('path').join(__dirname, '..', '..', 'assets', 'icon.png');

app.setAboutPanelOptions({
  applicationName: 'Freedom',
  applicationVersion: version,
  version: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
  copyright: '© 2025-2026 Freedom Team\nCopyleft — MPL-2.0',
  credits: 'A browser for the decentralized web\nSwarm · IPFS · ENS',
  website: 'https://freedombrowser.eth.limo/',
  iconPath,
});

const log = require('./logger');

// Global error handlers - must be set up early
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, _promise) => {
  log.error('Unhandled rejection:', reason);
});

const { registerShutdownSignalHandlers } = require('./shutdown-signals');
const unregisterShutdownSignalHandlers = registerShutdownSignalHandlers({ app, logger: log });
const { BrowserWindow, protocol, session } = require('electron');
const { registerBaseIpcHandlers, broadcastProfileUpdated } = require('./ipc-handlers');
const { watchProfileRegistry } = require('./profile-registry-watcher');
const { installRequestRewriter } = require('./request-rewriter');
const { installAdblockInterception, registerAdblockIpc } = require('./adblock/service');
const { installAdblockUpdater } = require('./adblock/update-scheduler');
const { attachWebRequestDispatcher } = require('./webrequest-dispatcher');
const { installX402Interception } = require('./x402/intercept');
const { registerX402Ipc } = require('./x402/ipc');
const { registerBzzProtocol } = require('./swarm/bzz-protocol');
const { registerIpfsProtocol, registerIpnsProtocol } = require('./ipfs/ipfs-protocol');
const { registerRadProtocol } = require('./radicle/rad-protocol');
const {
  installOnchainProvenanceCapture,
  registerOnchainAppProtocol,
  registerOnchainProvenanceIpc,
} = require('./onchain/onchain-app-protocol');
const { registerRadicleApiProtocol } = require('./radicle-api-protocol');

// Register `bzz:`, `ipfs:`, `ipns:`, and `web3:` as privileged standard schemes.
// Must run before `app.whenReady()` —
// see https://www.electronjs.org/docs/latest/api/protocol.
// See README "Swarm Content Retrieval" and "IPFS / IPNS Content Retrieval"
// for why these exist.
const DWEB_PROTOCOL_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
  allowServiceWorkers: true,
};
protocol.registerSchemesAsPrivileged([
  { scheme: 'bzz', privileges: DWEB_PROTOCOL_PRIVILEGES },
  { scheme: 'ipfs', privileges: DWEB_PROTOCOL_PRIVILEGES },
  { scheme: 'ipns', privileges: DWEB_PROTOCOL_PRIVILEGES },
  // ERC-8244 documents are single onchain HTML responses. They need a
  // standard, secure origin and Fetch-compatible Response handling, but
  // deliberately do not get service-worker privileges: their response CSP
  // denies ambient network access and mutable offchain dependencies.
  {
    scheme: 'web3',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  // Embedded Radicle API (radicle-api-protocol.js). Standard host casing
  // is fine here — RIDs travel in the path, not the host.
  { scheme: 'radapi', privileges: DWEB_PROTOCOL_PRIVILEGES },
  // `rad` is deliberately NOT `standard`: standard schemes get their host
  // lowercased by URL canonicalization, which would destroy case-sensitive
  // base58 RIDs (`rad://z3gqcJUoA1n9…`). Non-standard keeps the URL opaque
  // and case-intact; the handler parses it by hand. See rad-protocol.js.
  {
    scheme: 'rad',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const { registerSettingsIpc, loadSettings } = require('./settings-store');
const { registerShortcutsIpc } = require('./shortcuts-ipc');
const { registerBookmarksIpc } = require('./bookmarks-store');
const { registerHistoryIpc, closeDb: closeHistoryDb } = require('./history');
const {
  registerDownloadsIpc,
  attachDownloadsManager,
  cancelPartitionDownloads: cancelPrivateDownloads,
} = require('./downloads/downloads-manager');
const { closeDb: closeDownloadsDb } = require('./downloads/downloads-store');
const { dropPartition: dropPrivateDownloads } = require('./downloads/private-downloads-store');
const { registerFaviconsIpc } = require('./favicons');
const { registerEnsIpc } = require('./ens-resolver');
const myotisManager = require('./myotis/myotis-manager');
const { registerTezosDomainsIpc } = require('./tezos-domains-resolver');
const {
  registerAntIpc,
  createAntLifecycle,
  stopAnt,
  startAnt,
  setUseInjectedIdentity: setAntInjectedIdentity,
} = require('./ant-manager');
const {
  registerIpfsIpc,
  stopIpfs,
  startIpfs,
  syncProfileMode: syncIpfsProfileMode,
  setUseInjectedIdentity: setIpfsInjectedIdentity,
} = require('./ipfs-manager');
const {
  registerRadicleIpc,
  stopRadicle,
  startRadicle,
  syncProfileMode: syncRadicleProfileMode,
  setUseInjectedIdentity: setRadicleInjectedIdentity,
} = require('./radicle-manager');
const {
  registerTorIpc,
  stopTor,
  startTor,
  registerOnionRoutingSession,
  unregisterOnionRoutingSession,
} = require('./tor-manager');
const { registerIdentityIpc, hasVault, setBeeLifecycle } = require('./identity-manager');
const { registerQuickUnlockIpc } = require('./quick-unlock');
const { registerWalletIpc } = require('./wallet/wallet-ipc');
const { registerLedgerIpc } = require('./wallet/ledger/ipc');
const { registerRemoteSignerIpc } = require('./wallet/remote/bridge');
const { registerTokenRegistryIpc } = require('./token-registry');
const { registerRpcManagerIpc } = require('./wallet/rpc-manager');
const { registerNetworkConfigIpc } = require('./networks/network-ipc');
const { registerDappPermissionsIpc } = require('./wallet/dapp-permissions');
const {
  installPermissionHandlers,
  registerPermissionsIpc,
  clearPrivateDecisions: clearPrivatePermissionDecisions,
} = require('./permissions/permissions-manager');
const { registerSwarmIpc } = require('./swarm/stamp-service');
const { registerPublishIpc } = require('./swarm/publish-service');
const {
  registerPublishHistoryIpc,
  closeDb: closePublishHistoryDb,
} = require('./swarm/publish-history');
const paymentHistory = require('./payment-history');
const { getTransactionStatus: getTxStatus } = require('./wallet/transaction-service');
const { registerSwarmPermissionsIpc } = require('./swarm/swarm-permissions');
const { registerSwarmProviderIpc } = require('./swarm/swarm-provider-ipc');
const { registerRadiclePermissionsIpc } = require('./radicle/radicle-permissions');
const { registerRadicleProviderIpc } = require('./radicle/radicle-provider-ipc');
const { registerFeedStoreIpc } = require('./swarm/feed-store');
const { registerPermissionManifestIpc } = require('./swarm/permission-manifests');
const { registerGithubBridgeIpc, cleanupTempDirs } = require('./github-bridge');
const { registerServiceRegistryIpc } = require('./service-registry');
const { promptForDefaultExternalCandidates } = require('./profile-external-candidates');
const {
  createMainWindow,
  focusOrCreateMainWindow,
  setWindowTitle,
  getMainWindows,
} = require('./windows/mainWindow');
focusCurrentProfileWindow = focusOrCreateMainWindow;
const {
  createPrivateWindow,
  setPrivateSessionConfigurator,
  registerPrivateCleanup,
} = require('./private/private-windows');
const { initUpdater } = require('./updater');
const { setupApplicationMenu, updateTabMenuItems } = require('./menu');
const { registerWebContentsHandlers } = require('./webcontents-setup');
const { installTestHarness, registerStubProtocols } = require('./test-harness');

app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');
log.info('[profile] Active profile:', {
  id: activeProfile.id,
  source: activeProfile.source,
  userDataDir: activeProfile.userDataDir,
  appRoot: activeProfile.appRoot,
});
warnAboutLegacyDevData(activeProfile, { logger: log });
app.on('will-quit', () => {
  unregisterShutdownSignalHandlers();
  profileFocusWatcher.stop();
  if (activeProfileLock) {
    releaseProfileLock(activeProfileLock, { logger: log });
    activeProfileLock = null;
  }
});

async function bootstrap() {
  // Carry the injected Swarm identity from the Bee-era bee-data/ into
  // ant-data/. Must run before the Ant node is started below, or antd
  // self-generates a throwaway identity on the empty directory.
  migrateBeeDataToAntData();

  const defaultSession = session.defaultSession;
  await defaultSession.clearCache();
  registerBaseIpcHandlers({
    onSetTitle: setWindowTitle,
    onNewWindow: createMainWindow,
    onNewPrivateWindow: createPrivateWindow,
  });
  registerSettingsIpc();
  registerAdblockIpc();
  registerShortcutsIpc();
  registerBookmarksIpc();
  registerHistoryIpc();
  registerDownloadsIpc();
  registerFaviconsIpc();
  registerEnsIpc();
  registerTezosDomainsIpc();
  registerAntIpc();
  registerIpfsIpc();
  myotisManager.registerMyotisIpc();
  registerRadicleIpc();
  registerTorIpc();
  registerGithubBridgeIpc();
  registerServiceRegistryIpc();
  registerIdentityIpc();
  registerQuickUnlockIpc();
  registerWalletIpc();
  registerLedgerIpc();
  registerRemoteSignerIpc();

  // Let identity (re)injection stop the Bee node before wiping its statestore
  // (which it holds a LevelDB lock on) and restart it with the new key. Without
  // this, the wipe fails with EPERM on Windows during onboarding (issue #90).
  setBeeLifecycle(createAntLifecycle());
  registerTokenRegistryIpc();
  registerRpcManagerIpc();
  registerNetworkConfigIpc();
  registerDappPermissionsIpc();
  registerPermissionsIpc();
  registerX402Ipc();
  registerOnchainProvenanceIpc();
  paymentHistory.registerPaymentHistoryIpc();
  registerSwarmIpc();
  registerPublishIpc();
  registerPublishHistoryIpc();
  registerSwarmPermissionsIpc();
  registerSwarmProviderIpc();
  registerRadiclePermissionsIpc();
  registerRadicleProviderIpc();
  registerFeedStoreIpc();
  registerPermissionManifestIpc();

  // Resolve any pending broadcast txs that didn't get a final receipt
  // before the previous run exited. Fire-and-forget — the wallet stack
  // is up by now (registerWalletIpc above wires the provider pool) and
  // the sweep updates rows in place.
  paymentHistory.repollPending(getTxStatus).catch((err) => {
    log.warn(`[App] payment-history repoll failed: ${err.message}`);
  });

  if (!TEST_MODE) {
    // Skip registering the real bzz/ipfs/ipns/web3 handlers in test mode —
    // installTestHarness() registers fixture-driven stubs on the same
    // schemes below. Electron only allows one handler per scheme per
    // session, so the harness must own them outright in test mode.
    registerBzzProtocol(defaultSession);
    registerIpfsProtocol(defaultSession);
    registerIpnsProtocol(defaultSession);
    registerRadProtocol(defaultSession);
    // Before attachWebRequestDispatcher() below: this also installs the
    // process-wide `radapi-guard` onBeforeRequest handler.
    registerRadicleApiProtocol(defaultSession);
    registerOnchainAppProtocol(defaultSession);
  }
  // All consumers register their handlers first, then the dispatcher
  // attaches exactly one Electron listener per event to the session.
  installRequestRewriter();
  // After the rewriter (which owns scheme/gateway rewriting) and before
  // x402, so blocked requests never reach the payment flow.
  installAdblockInterception();
  // Also installs the `onchain-app-guard` onBeforeRequest handler, which keeps
  // web content out of the `web3:` trust gate. Runs unconditionally — the test
  // harness owns the `web3:` bytes in test mode, but the guard is browser
  // policy either way.
  installOnchainProvenanceCapture();
  installX402Interception();
  attachWebRequestDispatcher(defaultSession);
  // Per-site permission prompts (camera, mic, notifications, …) with
  // deny-by-default for everything unhandled. Webviews don't set a
  // `partition` attribute, so the default session is the one they use.
  installPermissionHandlers(defaultSession);
  // All webviews run on the default session (no partitions today), so this
  // one hook covers every download source — including the bzz:/ipfs:/ipns:
  // protocol handlers, whose responses route through Chromium's download
  // manager like any http(s) response.
  attachDownloadsManager(defaultSession);
  // Private windows: each gets a unique non-persisted `private-<uuid>`
  // partition whose session is configured here, before the window's first
  // webview loads — same protocol handlers (or their test-mode stubs),
  // request rewriter and downloads hook (rows kept in memory only, never
  // in the profile database) as the default session, and permission
  // prompts whose decisions stay session-only. One deliberate exception:
  // PRIVATE MODE GUARD (x402): payment interception is NOT attached to
  // private sessions. The wallet providers are unavailable in private
  // windows, so no payment could ever be signed; excluding the x402
  // handlers keeps 402 responses flowing to the page untouched.
  setPrivateSessionConfigurator((privateSession, { partition }) => {
    // The dweb protocol handlers log request URLs (and, underneath, the
    // names they resolve) to the persistent main.log. Passing the partition
    // marks this session's registrations private so those lines are
    // redacted — see src/main/private/private-log-context.js.
    if (TEST_MODE) {
      registerStubProtocols(privateSession, { privatePartition: partition });
    } else {
      registerBzzProtocol(privateSession, { privatePartition: partition });
      registerIpfsProtocol(privateSession, { privatePartition: partition });
      registerIpnsProtocol(privateSession, { privatePartition: partition });
      registerRadProtocol(privateSession, { privatePartition: partition });
      registerRadicleApiProtocol(privateSession, { privatePartition: partition });
      registerOnchainAppProtocol(privateSession, { privatePartition: partition });
    }
    attachWebRequestDispatcher(privateSession, {
      exclude: (name) => name.startsWith('x402-'),
    });
    attachDownloadsManager(privateSession, { privatePartition: partition });
    installPermissionHandlers(privateSession, { privatePartition: partition });
    // `.onion` routing is per-session: the PAC on the default session does
    // not cover this partition, so without this registration a private window
    // resolves *.onion DIRECT and hands the onion hostname to the system
    // resolver. Applies the live policy immediately when Tor is already up.
    registerOnionRoutingSession(partition, privateSession);
  });
  // On private-window close: cancel the window's still-running downloads
  // FIRST (once its rows are gone nothing can see or stop them, and a
  // finished file would leave no record anywhere), then drop the window's
  // in-memory download rows (they never touch SQLite — completed files stay
  // on disk, Chromium semantics) and its session-only permission decisions.
  // The session's storage is cleared by the private-windows module itself.
  registerPrivateCleanup((partition) => cancelPrivateDownloads(partition));
  registerPrivateCleanup((partition) => dropPrivateDownloads(partition));
  registerPrivateCleanup((partition) => clearPrivatePermissionDecisions(partition));
  registerPrivateCleanup((partition) => unregisterOnionRoutingSession(partition));

  registerWebContentsHandlers();
  setupApplicationMenu();

  // Profiles are shared across processes (one process per profile). When any
  // process renames / creates / deletes a profile, the registry file changes;
  // pick that up here so this process rebuilds its native Profiles menu and
  // refreshes its renderers, keeping every window's profile list in sync.
  if (!TEST_MODE && activeProfile?.source === 'catalog' && activeProfile?.appRoot) {
    watchProfileRegistry(activeProfile.appRoot, () => {
      setupApplicationMenu();
      broadcastProfileUpdated();
    });
  }

  // Test harness is installed AFTER all production IPC + protocol
  // registrations, so it can override (via removeHandler + re-register)
  // the channels it needs to stub — ENS resolution, the bzz: probe,
  // and bee/ipfs/radicle start/stop. No-op when FREEDOM_TEST_MODE is
  // unset, so the production path is unaffected.
  installTestHarness({ defaultSession });

  // If a vault exists, flag the node managers so bee/ipfs/radicle start with
  // the user's derived keys. Without a vault, nodes start with their own
  // randomly-generated keys; users opt in to vault-backed identity later via
  // the wallet sidebar's "Get Started" flow, which re-keys and restarts them.
  try {
    if (await hasVault()) {
      log.info('[App] Identity vault found, enabling injected identity mode');
      setAntInjectedIdentity(true);
      setIpfsInjectedIdentity(true);
      setRadicleInjectedIdentity(true);
    }
  } catch (err) {
    log.error('[App] Failed to check vault status:', err.message);
  }

  const settings = loadSettings();
  // A profile cold-started from another window's "edit" button (Profiles
  // manager) carries --open-settings; land its first tab on Profile settings.
  const coldStartUrl = process.argv.includes('--open-settings') ? PROFILE_SETTINGS_DEEPLINK : null;
  const mainWindow = createMainWindow(coldStartUrl);

  if (!TEST_MODE) {
    await promptForDefaultExternalCandidates(activeProfile, {
      window: mainWindow,
      enabledProtocols: {
        bee: settings.startBeeAtLaunch !== false,
        ipfs: settings.startIpfsAtLaunch !== false,
        tor: settings.enableTorIntegration === true && settings.startTorAtLaunch === true,
      },
      logger: log,
    });
  }

  // In test mode the harness has already seeded service-registry with
  // fake endpoints. Starting real Ant / IPFS / Radicle runtimes against
  // a temp userData would fail port checks, take seconds, and defeat
  // the purpose of fixture-driven tests.
  if (!TEST_MODE) {
    if (settings.startAntAtLaunch) {
      startAnt();
    }
    if (settings.startIpfsAtLaunch) {
      startIpfs();
    } else {
      // Same reason as Radicle below: publish the profile's IPFS mode even when
      // the node is not started at launch, so the nodes-menu toggle knows an
      // external gateway is controllable (and a disabled profile routes
      // `ipfs://` to its panel) instead of seeing a registry that still says
      // 'none'.
      void syncIpfsProfileMode();
    }
    if (settings.startRadicleAtLaunch) {
      startRadicle();
    } else {
      // Publish the profile's Radicle mode even when the node is not started
      // at launch: the renderer routes a rad: navigation to the "disabled for
      // this profile" panel off the registry entry, and without this the
      // registry would still say 'none' for a disabled profile.
      void syncRadicleProfileMode();
    }
    // EXPERIMENTAL: Myotis P2P light client. Opt-in via the settings toggle
    // (requires the addon — myotis:download or packaged resource); the
    // MYOTIS_NODE_PATH env var force-starts regardless (spike/e2e harness).
    // Syncs invisibly in the background; the ENS resolver starts preferring
    // it once the node reports ready.
    if (
      myotisManager.isEnabled() &&
      (settings.startMyotisAtLaunch || process.env.MYOTIS_NODE_PATH)
    ) {
      myotisManager.startMyotis();
    }
    if (myotisManager.isEnabled() && settings.startMyotisGnosisAtLaunch) {
      myotisManager.startMyotis({ chainId: 100 });
    }
    if (settings.enableTorIntegration && settings.startTorAtLaunch) {
      startTor({ targetSession: defaultSession });
    }
  }

  // Initialize auto-updater (pass menu update callback). Skipped in
  // test mode so specs don't trigger background network checks against
  // freedom.baby.
  if (!TEST_MODE) {
    initUpdater(mainWindow, setupApplicationMenu, { profile: activeProfile });
    // Schedule Swarm filter-list update checks. No-op until a feed trust
    // anchor is compiled in (WP5); safe to install unconditionally.
    installAdblockUpdater();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  updateTabMenuItems();
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // Note: Bee is stopped in 'before-quit' handler, not here,
  // so it keeps running on macOS when all windows are closed
});

let isQuitting = false;
// Flipped once windDown() has finished (or its watchdog gave up), so the
// app.quit() that follows is let straight through instead of being held again.
let shutdownSettled = false;

// Bound on how long a re-entrant quit is held back. Holding it unconditionally
// would let one wedged manager keep the app alive forever. Measured wind-downs
// on a dev box are ~30-120ms, but this has to stay above the *longest* stop
// budget underneath it, or the watchdog fires while a manager is still inside
// its own budget and the quit proceeds with the wind-down unfinished. Longest
// first, as of this commit: Tor SIGKILLs arti 10s after the SIGTERM
// (tor-manager.js), Ant SIGKILLs antd after 5s (ant-manager.js), Myotis waits
// 5s for its child to exit (myotis-process.js EXIT_WAIT_MS), and the IPFS
// dispatcher falls back to terminate() after 2s
// (freedom-ipfs-native-node.js DISPATCHER_STOP_TIMEOUT_MS). Re-derive against
// those four before trimming this number.
const SHUTDOWN_WATCHDOG_MS = 20_000;

// Everything that has to happen before the process may go away. Split out of
// the before-quit handler so the handler can bound it and still be the only
// place that decides when quitting is allowed.
async function windDown() {
  const myotisStopped = myotisManager.stopAllMyotis({ shutdown: true });

  // Close all DevTools first to prevent crashes during cleanup
  log.info('[App] Closing all DevTools...');
  for (const win of getMainWindows()) {
    try {
      win.webContents.send('devtools:close-all');
    } catch {
      // Window might already be closing
    }
  }

  // Small delay to allow DevTools to close
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Close all windows first, before winding down peers
  log.info('[App] Closing all windows...');
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length > 0) {
    await Promise.all(
      allWindows.map((win) => {
        return new Promise((resolve) => {
          if (win.isDestroyed()) {
            resolve();
            return;
          }
          win.once('closed', resolve);
          win.destroy();
        });
      })
    );
  }
  log.info('[App] All windows closed');

  // Close history databases
  log.info('[App] Closing history databases...');
  closeHistoryDb();
  closeDownloadsDb();
  closePublishHistoryDb();
  paymentHistory.closeDb();

  // Clean up any GitHub bridge temp directories
  cleanupTempDirs();

  log.info('[App] Waiting for Ant, IPFS, Myotis, Radicle, and Tor to stop...');
  // allSettled, not all: Promise.all settles on the *first* rejection, so one
  // manager throwing would release the quit while the other legs are still in
  // flight — notably stopIpfs(), whose dispatcher ack is the very window this
  // wind-down exists to hold open (issue #345). Every leg has to finish, and
  // a rejecting one is logged rather than abandoning the others. The
  // SHUTDOWN_WATCHDOG_MS timer above still bounds the total wait, so waiting
  // for more legs can't wedge the quit.
  const LEGS = [
    ['Myotis', () => myotisStopped],
    ['Ant', stopAnt],
    ['IPFS', stopIpfs],
    ['Radicle', stopRadicle],
    ['Tor', stopTor],
  ];
  // The async wrapper keeps a *synchronous* throw from a stop function inside
  // the join too: thrown straight into Promise.allSettled's argument array it
  // would escape past every sibling leg, the same short-circuit one step
  // earlier. Each leg still starts in this tick, as before.
  const settled = await Promise.allSettled(LEGS.map(async ([, start]) => start()));
  settled.forEach((result, i) => {
    if (result.status === 'rejected') log.error(`[App] ${LEGS[i][0]} stop failed:`, result.reason);
  });
  // A rejected Myotis leg proves nothing about its children, so treat it the
  // same as an unconfirmed exit rather than as a clean stop.
  const myotisExits = settled[0].status === 'fulfilled' ? settled[0].value : null;
  if (!myotisExits || myotisExits.some((exited) => !exited)) {
    log.warn('[App] Myotis child exit unconfirmed; data-directory reuse remains blocked');
  }
  log.info(myotisExits && myotisExits.every(Boolean)
    ? '[App] All processes stopped, quitting...'
    : '[App] Quitting with Myotis exit unconfirmed');
}

app.on('before-quit', async (event) => {
  if (isQuitting) {
    // Re-entrant quit. Destroying the last window inside windDown() makes
    // Electron fire 'window-all-closed', whose handler calls app.quit() again
    // — and a before-quit that returns without preventDefault() lets Electron
    // shut the process down right there, while the wind-down is still in
    // flight. That is what took the main process out with
    // `Error::ThrowAsJavaScriptException napi_throw` on most quits (issue
    // #345): the IPFS dispatcher worker's env was destroyed while it sat
    // inside a native gatewayWaitNextEvent call. It also meant no node was
    // reliably stopped on quit — the wind-down was racing the process exit
    // every time, and usually losing.
    if (!shutdownSettled) event.preventDefault();
    return;
  }

  event.preventDefault();
  isQuitting = true;

  const watchdog = setTimeout(() => {
    log.warn('[App] Shutdown watchdog fired; quitting with the wind-down unfinished');
    shutdownSettled = true;
    app.quit();
  }, SHUTDOWN_WATCHDOG_MS);

  try {
    await windDown();
  } catch (err) {
    // A manager that rejects must not strand the app in a half-quit state.
    log.error('[App] Wind-down failed:', err);
  } finally {
    clearTimeout(watchdog);
    shutdownSettled = true;
  }

  app.quit();
});

app.on('browser-window-created', () => {
  updateTabMenuItems();
});
