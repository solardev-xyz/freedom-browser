const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const https = require('https');
const IPC = require('../shared/ipc-channels');
const { success, failure, validateNonEmptyString } = require('./ipc-contract');
const {
  getRadicleDataPath,
  getCurrentStatus,
  isDisabledForProfile,
  STATUS,
} = require('./radicle-manager');
const embedded = require('./radicle-embedded');
const { createProfileTempDir } = require('./profile-paths');

const execFileAsync = promisify(execFile);

// Track active temp directories for cleanup on quit
const activeTempDirs = new Set();
const bridgeMapCache = new Map();
let bridgeMapLoaded = false;
const GITHUB_BRIDGE_MAP_FILE = 'github-bridge-map.json';

function normalizeRid(rid) {
  if (!validateNonEmptyString(rid)) return null;
  return rid.startsWith('rad:') ? rid.slice(4) : rid;
}

function extractGitHubRepoFromUrl(url) {
  if (!validateNonEmptyString(url)) return null;
  const match = url.trim().match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/
  );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
  };
}

function toBridgeRepoKey(owner, repo) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function getBridgeMapPath() {
  return path.join(getRadicleDataPath(), GITHUB_BRIDGE_MAP_FILE);
}

function loadBridgeMap() {
  if (bridgeMapLoaded) return;
  bridgeMapLoaded = true;

  const mapPath = getBridgeMapPath();
  if (!fs.existsSync(mapPath)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    for (const [repoKey, rid] of Object.entries(parsed || {})) {
      if (validateNonEmptyString(repoKey) && validateNonEmptyString(rid)) {
        bridgeMapCache.set(repoKey, normalizeRid(rid));
      }
    }
  } catch (err) {
    console.warn('[GitHubBridge] Failed to load bridge map:', err.message);
  }
}

function persistBridgeMap() {
  try {
    const mapPath = getBridgeMapPath();
    fs.writeFileSync(mapPath, JSON.stringify(Object.fromEntries(bridgeMapCache), null, 2));
  } catch (err) {
    console.warn('[GitHubBridge] Failed to persist bridge map:', err.message);
  }
}

function rememberBridge(owner, repo, rid) {
  const normalizedRid = normalizeRid(rid);
  if (!validateNonEmptyString(owner) || !validateNonEmptyString(repo) || !normalizedRid) return;

  loadBridgeMap();
  bridgeMapCache.set(toBridgeRepoKey(owner, repo), normalizedRid);
  persistBridgeMap();
}

function lookupBridge(owner, repo) {
  if (!validateNonEmptyString(owner) || !validateNonEmptyString(repo)) return null;
  loadBridgeMap();
  return bridgeMapCache.get(toBridgeRepoKey(owner, repo)) || null;
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function cleanupTempDir(tempDir) {
  if (!tempDir) return;

  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[GitHubBridge] Cleanup failed:', err.message);
  } finally {
    activeTempDirs.delete(tempDir);
  }
}

/**
 * Validate a GitHub repository URL.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   github.com/owner/repo
 *   owner/repo (shorthand)
 */
function validateGitHubUrl(url) {
  if (!validateNonEmptyString(url)) {
    return {
      valid: false,
      ...failure('INVALID_URL', 'Please enter a GitHub repository URL', { field: 'url' }),
    };
  }
  const input = url.trim().replace(/\/+$/, '');

  // Try full URL: https://github.com/owner/repo or github.com/owner/repo
  const fullMatch = input.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
  );
  if (fullMatch) {
    return {
      ...success(),
      valid: true,
      owner: fullMatch[1],
      repo: fullMatch[2],
      cloneUrl: `https://github.com/${fullMatch[1]}/${fullMatch[2]}.git`,
    };
  }

  // Try shorthand: owner/repo
  const shortMatch = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (shortMatch) {
    return {
      ...success(),
      valid: true,
      owner: shortMatch[1],
      repo: shortMatch[2],
      cloneUrl: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git`,
    };
  }

  return {
    valid: false,
    ...failure(
      'INVALID_URL_FORMAT',
      'Invalid GitHub URL. Expected: https://github.com/owner/repo or owner/repo',
      { field: 'url', value: input }
    ),
  };
}

/**
 * Check if git is available on the system.
 */
async function checkGitAvailable() {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 5000 });
    return { available: true, version: stdout.trim() };
  } catch {
    return { available: false, error: 'Git is not installed or not found in PATH' };
  }
}

/**
 * Check if the native Radicle bridge is ready.
 */
function checkRadicleBridgeAvailable() {
  if (!embedded.isAvailable()) {
    return {
      available: false,
      code: 'RADICLE_ADDON_MISSING',
      error: 'Native Radicle addon not found',
    };
  }
  if (getCurrentStatus().status !== STATUS.RUNNING) {
    return {
      available: false,
      code: 'RADICLE_NOT_RUNNING',
      error: 'Radicle node is not running',
    };
  }
  return { available: true };
}

/**
 * Verify GitHub network reachability (best-effort prerequisite check).
 */
function checkNetworkAccess() {
  return new Promise((resolve) => {
    const req = https.request(
      'https://github.com/',
      { method: 'HEAD', timeout: 5000 },
      (res) => {
        res.resume();
        resolve({
          available: res.statusCode >= 200 && res.statusCode < 500,
        });
      }
    );

    req.on('error', () => {
      resolve({
        available: false,
        error: 'Network unavailable. Could not reach GitHub.',
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({
        available: false,
        error: 'Network check timed out while reaching GitHub.',
      });
    });
    req.end();
  });
}

async function checkImportPrerequisites() {
  const gitCheck = await checkGitAvailable();
  if (!gitCheck.available) {
    return {
      ...failure('GIT_UNAVAILABLE', gitCheck.error),
      step: 'checking-git',
    };
  }

  const radicleCheck = checkRadicleBridgeAvailable();
  if (!radicleCheck.available) {
    return {
      ...failure(radicleCheck.code, radicleCheck.error),
      step: 'checking-radicle',
    };
  }

  const networkCheck = await checkNetworkAccess();
  if (!networkCheck.available) {
    return {
      ...failure('NETWORK_UNAVAILABLE', networkCheck.error),
      step: 'checking-network',
    };
  }

  return success({
    gitVersion: gitCheck.version,
  });
}

async function checkExistingBridge(url) {
  const parsed = extractGitHubRepoFromUrl(url);
  if (!parsed) {
    return failure('INVALID_URL_FORMAT', 'Invalid GitHub repository URL');
  }

  const knownRid = lookupBridge(parsed.owner, parsed.repo);
  if (knownRid) {
    return success({ bridged: true, rid: knownRid });
  }

  const marker = `github.com/${parsed.owner}/${parsed.repo}`.toLowerCase();
  let repos;
  try {
    repos = await embedded.listRepos();
  } catch {
    return success({ bridged: false });
  }
  for (const repo of repos) {
    const description = repo?.description || '';
    if (description.toLowerCase().includes(marker)) {
      const rid = normalizeRid(repo?.rid || '');
      if (rid) {
        rememberBridge(parsed.owner, parsed.repo, rid);
        return success({ bridged: true, rid });
      }
    }
  }

  return success({ bridged: false });
}

function getFriendlyImportError(err, fallbackMessage) {
  const lower = fallbackMessage.toLowerCase();

  if (
    lower.includes('enotfound')
    || lower.includes('eai_again')
    || lower.includes('timed out')
    || lower.includes('could not resolve host')
    || lower.includes('connection refused')
    || lower.includes('failed to connect')
  ) {
    return {
      code: 'NETWORK_UNAVAILABLE',
      message: 'Network unavailable. Please check your internet connection and try again.',
    };
  }

  if (lower.includes('repository not found')) {
    return {
      code: 'REPOSITORY_NOT_FOUND',
      message: 'GitHub repository not found or not accessible.',
    };
  }

  if (err.killed && lower.includes('timed out')) {
    return {
      code: 'IMPORT_TIMEOUT',
      message: 'Import timed out. Please try again.',
    };
  }

  return {
    code: 'IMPORT_FAILED',
    message: fallbackMessage,
  };
}

/**
 * Fetch repository description from GitHub API (best-effort).
 */
function fetchGitHubDescription(owner, repo) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers: { 'User-Agent': 'Freedom-Browser' }, timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.description || '');
          } catch {
            resolve('');
          }
        });
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

/**
 * Import a public GitHub repository into Radicle.
 *
 * Steps: validate → check git → clone → native Radicle import.
 * Progress events are sent to the caller via IPC.
 */
async function importGitHubRepo(url, sender) {
  const sendProgress = (data) => {
    if (sender && !sender.isDestroyed()) {
      sender.send(IPC.GITHUB_BRIDGE_PROGRESS, data);
    }
  };

  let clonePath = null;
  let prereqStep = 'checking-prereqs';

  try {
    // Step 1: Validate URL
    sendProgress({ step: 'validating', message: 'Validating GitHub URL...' });
    const validation = validateGitHubUrl(url);
    if (!validation.valid) {
      return failure(
        validation.error.code,
        validation.error.message,
        validation.error.details,
        { step: 'validating' }
      );
    }

    // Step 2: Check native Radicle and network prerequisites
    sendProgress({ step: 'checking-prereqs', message: 'Checking prerequisites...' });
    const prereqCheck = await checkImportPrerequisites();
    if (!prereqCheck.success) {
      return failure(
        prereqCheck.error.code,
        prereqCheck.error.message,
        prereqCheck.error.details,
        { step: prereqCheck.step || prereqStep }
      );
    }

    // Step 4: Clone
    sendProgress({ step: 'cloning', message: `Cloning ${validation.owner}/${validation.repo}...` });
    clonePath = createProfileTempDir('github-bridge');
    activeTempDirs.add(clonePath);

    const repoDir = path.join(clonePath, validation.repo);
    await execFileAsync('git', ['clone', validation.cloneUrl, repoDir], {
      timeout: 300000, // 5 minutes
    });

    // Step 5: Detect default branch
    let defaultBranch = 'main';
    try {
      const { stdout: branchOut } = await execFileAsync(
        'git', ['symbolic-ref', '--short', 'HEAD'],
        { cwd: repoDir, timeout: 5000 }
      );
      defaultBranch = branchOut.trim() || 'main';
    } catch {
      // Fall back to 'main'
    }

    // Step 6: Fetch description from GitHub API (best-effort)
    const description = await fetchGitHubDescription(validation.owner, validation.repo);

    // Step 7: import directly into the in-process Radicle storage.
    sendProgress({ step: 'initializing', message: 'Initializing Radicle project...' });
    const { rid } = await embedded.importRepo(
      repoDir,
      validation.repo,
      description || `Imported from github.com/${validation.owner}/${validation.repo}`,
      defaultBranch
    );
    const normalizedRid =
      typeof rid === 'string' && /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(rid)
        ? rid
        : null;
    if (!normalizedRid) {
      throw new Error('Native Radicle import returned an invalid repository ID');
    }

    sendProgress({ step: 'success', message: 'Repository seeded successfully!' });
    console.log(
      `[GitHubBridge] Success: ${validation.owner}/${validation.repo} -> ${normalizedRid}`
    );
    rememberBridge(validation.owner, validation.repo, normalizedRid);

    return {
      ...success(),
      rid: normalizedRid.slice(4),
      name: validation.repo,
      owner: validation.owner,
      description,
    };
  } catch (err) {
    console.error('[GitHubBridge] Import failed:', err.message);

    const stderrStr = stripAnsi(err.stderr?.toString() || '');
    const fallbackMessage = stderrStr || stripAnsi(err.message);
    const ridMatch = fallbackMessage.match(/rad:z[a-zA-Z0-9]+/);
    const ridFromError = ridMatch ? ridMatch[0].slice(4) : null;
    const parsed = extractGitHubRepoFromUrl(url);
    const alreadyBridged = /already (exists|initialized)|already a radicle project|project exists/i.test(
      fallbackMessage
    );

    if (alreadyBridged) {
      if (parsed && ridFromError) {
        rememberBridge(parsed.owner, parsed.repo, ridFromError);
      }
      return failure(
        'ALREADY_BRIDGED',
        'This GitHub repository is already bridged to Radicle.',
        ridFromError ? { rid: ridFromError } : undefined,
        {
          step: 'initializing',
          rid: ridFromError || (parsed ? lookupBridge(parsed.owner, parsed.repo) : null),
        }
      );
    }

    const friendlyError = getFriendlyImportError(err, fallbackMessage);

    sendProgress({ step: 'error', message: friendlyError.message });

    return failure(friendlyError.code, friendlyError.message);
  } finally {
    cleanupTempDir(clonePath);
  }
}

/**
 * Clean up any remaining temp directories (called on app quit).
 */
function cleanupTempDirs() {
  for (const dir of activeTempDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('[GitHubBridge] Cleaned up temp dir:', dir);
      }
    } catch (err) {
      console.warn('[GitHubBridge] Failed to cleanup:', dir, err.message);
    }
  }
  activeTempDirs.clear();
}

/**
 * Register IPC handlers for the GitHub bridge.
 */
function registerGithubBridgeIpc() {
  console.log('[GitHubBridge] Registering IPC handlers');
  const radicleDisabledFailure = () =>
    failure('RADICLE_DISABLED', 'Radicle is disabled for this profile');
  const ensureRadicleEnabled = () => !isDisabledForProfile();

  ipcMain.handle(IPC.GITHUB_BRIDGE_IMPORT, async (event, url) => {
    if (!ensureRadicleEnabled()) {
      return radicleDisabledFailure();
    }
    if (!validateNonEmptyString(url)) {
      return failure('INVALID_URL', 'Missing GitHub URL', { field: 'url' });
    }
    return await importGitHubRepo(url, event.sender);
  });

  ipcMain.handle(IPC.GITHUB_BRIDGE_CHECK_GIT, async () => {
    return await checkGitAvailable();
  });

  ipcMain.handle(IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES, async () => {
    if (!ensureRadicleEnabled()) {
      return radicleDisabledFailure();
    }
    return await checkImportPrerequisites();
  });

  ipcMain.handle(IPC.GITHUB_BRIDGE_VALIDATE_URL, (_event, url) => {
    return validateGitHubUrl(url);
  });

  ipcMain.handle(IPC.GITHUB_BRIDGE_CHECK_EXISTING, async (_event, url) => {
    if (!ensureRadicleEnabled()) {
      return radicleDisabledFailure();
    }
    if (!validateNonEmptyString(url)) {
      return failure('INVALID_URL', 'Missing GitHub URL', { field: 'url' });
    }
    return await checkExistingBridge(url);
  });
}

module.exports = {
  registerGithubBridgeIpc,
  cleanupTempDirs,
  validateGitHubUrl,
};
