// Set app name early, before electron-log initializes (it uses app name for log path)
const { app } = require('electron');
const appName = process.platform === 'linux' ? 'freedom' : 'Freedom';

// Suppress Electron security warnings in development (CSP handles security in production)
if (!app.isPackaged) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

app.name = appName;
app.setName(appName);

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

const { BrowserWindow, session } = require('electron');
const path = require('path');
const { registerBaseIpcHandlers } = require('./ipc-handlers');
const { registerRequestRewriter } = require('./request-rewriter');
const { registerSettingsIpc, loadSettings } = require('./settings-store');
const { registerBookmarksIpc } = require('./bookmarks-store');
const { registerHistoryIpc, closeDb: closeHistoryDb } = require('./history');
const { registerFaviconsIpc } = require('./favicons');
const { registerEnsIpc } = require('./ens-resolver');
const { registerBeeIpc, stopBee, startBee, setUseInjectedIdentity: setBeeInjectedIdentity } = require('./bee-manager');
const { registerIpfsIpc, stopIpfs, startIpfs, setUseInjectedIdentity: setIpfsInjectedIdentity } = require('./ipfs-manager');
const { registerRadicleIpc, stopRadicle, startRadicle, setUseInjectedIdentity: setRadicleInjectedIdentity } = require('./radicle-manager');
const { registerIdentityIpc, hasVault, isBeeIdentityInjected, isIpfsIdentityInjected, isRadicleIdentityInjected } = require('./identity-manager');
const { registerQuickUnlockIpc } = require('./quick-unlock');
const { registerWalletIpc } = require('./wallet/wallet-ipc');
const { registerChainRegistryIpc } = require('./chain-registry');
const { registerRpcManagerIpc } = require('./wallet/rpc-manager');
const { registerDappPermissionsIpc } = require('./wallet/dapp-permissions');
const { registerGithubBridgeIpc, cleanupTempDirs } = require('./github-bridge');
const { registerServiceRegistryIpc } = require('./service-registry');
const { createMainWindow, setWindowTitle, getMainWindows } = require('./windows/mainWindow');
const { migrateUserData } = require('./migrate-user-data');
const { initUpdater } = require('./updater');
const { setupApplicationMenu, updateTabMenuItems } = require('./menu');
const { registerWebContentsHandlers } = require('./webcontents-setup');

app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');

const crashDir = path.join(__dirname, 'crash-reports');
app.setPath('crashDumps', crashDir);

function allowInteractivePermissions(targetSession) {
  if (!targetSession || !targetSession.setPermissionRequestHandler) {
    return;
  }
  targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'pointerLock' || permission === 'fullscreen') {
      log.info(`[permissions] granting ${permission} for`, webContents.getURL());
      callback(true);
      return;
    }
    callback(false);
  });
}

async function bootstrap() {
  // Migrate user data from old "Freedom Browser" directory if needed
  // This must run before any modules access userData
  migrateUserData();

  const defaultSession = session.defaultSession;
  await defaultSession.clearCache();
  registerBaseIpcHandlers({
    onSetTitle: setWindowTitle,
    onNewWindow: createMainWindow,
  });
  registerSettingsIpc();
  registerBookmarksIpc();
  registerHistoryIpc();
  registerFaviconsIpc();
  registerEnsIpc();
  registerBeeIpc();
  registerIpfsIpc();
  registerRadicleIpc();
  registerGithubBridgeIpc();
  registerServiceRegistryIpc();
  registerIdentityIpc();
  registerQuickUnlockIpc();
  registerWalletIpc();
  registerChainRegistryIpc();
  registerRpcManagerIpc();
  registerDappPermissionsIpc();
  registerRequestRewriter(defaultSession);
  allowInteractivePermissions(defaultSession);
  registerWebContentsHandlers();
  setupApplicationMenu();

  // Check identity vault and key status
  // Three scenarios:
  // 1. Vault exists + keys injected → use derived keys, start nodes
  // 2. No vault + keys exist → user skipped onboarding, use random keys, start nodes
  // 3. No vault + no keys → true first run, defer to onboarding wizard
  let vaultExists = false;
  let keysExist = false;
  try {
    vaultExists = await hasVault();
    keysExist = isBeeIdentityInjected() || isIpfsIdentityInjected() || isRadicleIdentityInjected();

    if (vaultExists) {
      log.info('[App] Identity vault found, enabling injected identity mode');
      setBeeInjectedIdentity(true);
      setIpfsInjectedIdentity(true);
      setRadicleInjectedIdentity(true);
    } else if (keysExist) {
      log.info('[App] No vault but keys exist - user previously skipped onboarding');
      // Don't enable injected identity mode - these are random keys, not derived
    } else {
      log.info('[App] No vault and no keys - waiting for onboarding');
    }
  } catch (err) {
    log.error('[App] Failed to check vault status:', err.message);
  }

  const settings = loadSettings();

  // Start nodes automatically if:
  // - Vault exists and keys are injected (completed onboarding), OR
  // - No vault but keys exist (skipped onboarding, using random keys)
  // If no vault AND no keys, defer to onboarding wizard (renderer handles this)
  if (vaultExists || keysExist) {
    if (settings.startBeeAtLaunch && isBeeIdentityInjected()) {
      startBee();
    }
    if (settings.startIpfsAtLaunch && isIpfsIdentityInjected()) {
      startIpfs();
    }
    if (settings.startRadicleAtLaunch && isRadicleIdentityInjected()) {
      startRadicle();
    }
  } else {
    log.info('[App] Deferring node startup until onboarding completes');
  }
  if (settings.startRadicleAtLaunch) {
    startRadicle();
  }

  const mainWindow = createMainWindow();

  // Initialize auto-updater (pass menu update callback)
  initUpdater(mainWindow, setupApplicationMenu);

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

app.on('before-quit', async (event) => {
  if (isQuitting) return;

  event.preventDefault();
  isQuitting = true;

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

  // Close history database
  log.info('[App] Closing history database...');
  closeHistoryDb();

  // Clean up any GitHub bridge temp directories
  cleanupTempDirs();

  log.info('[App] Waiting for Bee, IPFS, and Radicle to stop...');
  await Promise.all([stopBee(), stopIpfs(), stopRadicle()]);
  log.info('[App] All processes stopped, quitting...');


  app.quit();
});

app.on('browser-window-created', () => {
  updateTabMenuItems();
});
