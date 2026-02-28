const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');
const IPC = require('../shared/ipc-channels');
const { success, failure, validateNonEmptyString } = require('./ipc-contract');
const { getRadicleBinaryPath, getRadicleDataPath, getActivePort } = require('./radicle-manager');
const { loadSettings } = require('./settings-store');

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

function fetchLocalRepos(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/repos?show=all`, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve([]);
        return;
      }
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const repos = JSON.parse(raw);
          resolve(Array.isArray(repos) ? repos : []);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

function fetchLocalRepoRemotes(port, rid) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/api/v1/repos/rad:${rid}/remotes`,
      { timeout: 3000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve([]);
          return;
        }
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const remotes = JSON.parse(raw);
            resolve(Array.isArray(remotes) ? remotes : []);
          } catch {
            resolve([]);
          }
        });
      }
    );

    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

function fetchGitHubRepoInfo(owner, repo) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers: { 'User-Agent': 'Freedom-Browser' }, timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function fetchGitHubHeadSha(owner, repo, branch) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      { headers: { 'User-Agent': 'Freedom-Browser' }, timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(typeof parsed?.sha === 'string' ? parsed.sha : null);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function findLegacyBridgeByHeadMatch(port, owner, repo, repos) {
  const ghRepo = await fetchGitHubRepoInfo(owner, repo);
  const defaultBranch = ghRepo?.default_branch;
  if (!validateNonEmptyString(defaultBranch)) return null;

  const githubHeadSha = await fetchGitHubHeadSha(owner, repo, defaultBranch);
  if (!validateNonEmptyString(githubHeadSha)) return null;

  const targetName = repo.toLowerCase();
  const exactNameCandidates = repos.filter((item) => {
    const localName = (item?.payloads?.['xyz.radicle.project']?.data?.name || item?.name || '').toLowerCase();
    return localName === targetName;
  });
  const candidates = exactNameCandidates.length > 0 ? exactNameCandidates : repos;

  for (const candidate of candidates) {
    const rid = normalizeRid(candidate?.rid || '');
    if (!rid) continue;

    const remotes = await fetchLocalRepoRemotes(port, rid);
    const hasMatchingHead = remotes.some((remote) => {
      const heads = remote?.heads || {};
      return Object.values(heads).some((sha) => sha === githubHeadSha);
    });

    if (hasMatchingHead) {
      return rid;
    }
  }

  return null;
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
 * Check if required Radicle bridge binaries are available.
 */
function checkRadicleBridgeAvailable() {
  const radPath = getRadicleBinaryPath('rad');
  const gitRemoteRadPath = getRadicleBinaryPath('git-remote-rad');

  if (!fs.existsSync(radPath)) {
    return {
      available: false,
      code: 'RADICLE_CLI_MISSING',
      error: 'Radicle CLI (rad) not found',
    };
  }

  if (!fs.existsSync(gitRemoteRadPath)) {
    return {
      available: false,
      code: 'GIT_REMOTE_RAD_MISSING',
      error: 'Radicle Git bridge (git-remote-rad) not found',
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

  // Best-effort detection for pre-map imports where the source URL was used
  // in the fallback project description.
  const port = getActivePort();
  if (!port) return success({ bridged: false });

  const marker = `github.com/${parsed.owner}/${parsed.repo}`.toLowerCase();
  const repos = await fetchLocalRepos(port);
  for (const repo of repos) {
    const description = repo?.payloads?.['xyz.radicle.project']?.data?.description || '';
    if (description.toLowerCase().includes(marker)) {
      const rid = normalizeRid(repo?.rid || '');
      if (rid) {
        rememberBridge(parsed.owner, parsed.repo, rid);
        return success({ bridged: true, rid });
      }
    }
  }

  const legacyRid = await findLegacyBridgeByHeadMatch(port, parsed.owner, parsed.repo, repos);
  if (legacyRid) {
    rememberBridge(parsed.owner, parsed.repo, legacyRid);
    return success({ bridged: true, rid: legacyRid });
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

  if (lower.includes('git-remote-rad') && lower.includes('not found')) {
    return {
      code: 'GIT_REMOTE_RAD_MISSING',
      message: 'Radicle Git bridge (git-remote-rad) is not available.',
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
 * Build environment object for rad / git-remote-rad commands.
 */
function getRadicleEnv() {
  const radBinDir = path.dirname(getRadicleBinaryPath('git-remote-rad'));
  return {
    ...process.env,
    RAD_HOME: getRadicleDataPath(),
    RAD_PASSPHRASE: '',
    PATH: `${radBinDir}${path.delimiter}${process.env.PATH}`,
  };
}

/**
 * Import a public GitHub repository into Radicle.
 *
 * Steps: validate → check git → clone → detect branch → rad init → git push rad
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

    // Step 2: Check CLI and network prerequisites
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

    const radPath = getRadicleBinaryPath('rad');
    const radicleEnv = getRadicleEnv();

    // Step 4: Clone
    sendProgress({ step: 'cloning', message: `Cloning ${validation.owner}/${validation.repo}...` });
    clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-bridge-'));
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

    // Step 7: rad init
    sendProgress({ step: 'initializing', message: 'Initializing Radicle project...' });
    const initArgs = [
      'init',
      '--name', validation.repo,
      '--description', description || `Imported from github.com/${validation.owner}/${validation.repo}`,
      '--default-branch', defaultBranch,
      '--public',
      '--no-confirm',
    ];

    const { stdout: initOut, stderr: initErr } = await execFileAsync(
      radPath, initArgs,
      { cwd: repoDir, env: radicleEnv, timeout: 60000 }
    );

    // Parse RID from output
    const ridMatch = (initOut + initErr).match(/rad:z[a-zA-Z0-9]+/);
    const rid = ridMatch ? ridMatch[0] : null;

    if (!rid) {
      console.warn('[GitHubBridge] Could not parse RID from rad init output:', initOut, initErr);
    }

    // Step 8: Push all branches
    sendProgress({ step: 'pushing', message: 'Pushing to Radicle network...' });
    await execFileAsync('git', ['push', 'rad', '--all'], {
      cwd: repoDir,
      env: radicleEnv,
      timeout: 300000, // 5 minutes
    });

    // Step 9: Push tags (best-effort)
    try {
      await execFileAsync('git', ['push', 'rad', '--tags'], {
        cwd: repoDir,
        env: radicleEnv,
        timeout: 120000, // 2 minutes
      });
    } catch (tagErr) {
      console.warn('[GitHubBridge] Tag push failed (non-critical):', tagErr.message);
    }

    sendProgress({ step: 'success', message: 'Repository seeded successfully!' });
    console.log(`[GitHubBridge] Success: ${validation.owner}/${validation.repo} -> ${rid}`);
    if (rid) {
      rememberBridge(validation.owner, validation.repo, rid);
    }

    return {
      ...success(),
      rid: rid ? rid.replace('rad:', '') : null,
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
    failure('RADICLE_DISABLED', 'Radicle integration is disabled. Enable it in Settings > Experimental');
  const ensureRadicleEnabled = () => loadSettings().enableRadicleIntegration === true;

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
