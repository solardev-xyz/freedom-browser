const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const IPC = require('../shared/ipc-channels');
const { getRadicleBinaryPath, getRadicleDataPath } = require('./radicle-manager');

const execFileAsync = promisify(execFile);

// Track active temp directories for cleanup on quit
const activeTempDirs = new Set();

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
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
  const input = (url || '').trim().replace(/\/+$/, '');
  if (!input) {
    return { valid: false, error: 'Please enter a GitHub repository URL' };
  }

  // Try full URL: https://github.com/owner/repo or github.com/owner/repo
  const fullMatch = input.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
  );
  if (fullMatch) {
    return {
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
      valid: true,
      owner: shortMatch[1],
      repo: shortMatch[2],
      cloneUrl: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git`,
    };
  }

  return {
    valid: false,
    error: 'Invalid GitHub URL. Expected: https://github.com/owner/repo or owner/repo',
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

  try {
    // Step 1: Validate URL
    sendProgress({ step: 'validating', message: 'Validating GitHub URL...' });
    const validation = validateGitHubUrl(url);
    if (!validation.valid) {
      return { success: false, error: validation.error, step: 'validating' };
    }

    // Step 2: Check git is available
    sendProgress({ step: 'checking-git', message: 'Checking git availability...' });
    const gitCheck = await checkGitAvailable();
    if (!gitCheck.available) {
      return { success: false, error: gitCheck.error, step: 'checking-git' };
    }

    // Step 3: Check rad binary exists
    const radPath = getRadicleBinaryPath('rad');
    if (!fs.existsSync(radPath)) {
      return { success: false, error: 'Radicle CLI (rad) not found', step: 'checking-radicle' };
    }

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

    // Step 10: Cleanup
    try {
      fs.rmSync(clonePath, { recursive: true, force: true });
    } catch (cleanErr) {
      console.warn('[GitHubBridge] Cleanup failed:', cleanErr.message);
    }
    activeTempDirs.delete(clonePath);

    sendProgress({ step: 'success', message: 'Repository seeded successfully!' });
    console.log(`[GitHubBridge] Success: ${validation.owner}/${validation.repo} -> ${rid}`);

    return {
      success: true,
      rid: rid ? rid.replace('rad:', '') : null,
      name: validation.repo,
      owner: validation.owner,
      description,
    };
  } catch (err) {
    console.error('[GitHubBridge] Import failed:', err.message);

    const stderrStr = stripAnsi(err.stderr?.toString() || '');
    const errorMsg = stderrStr || stripAnsi(err.message);

    sendProgress({ step: 'error', message: errorMsg });

    // Cleanup temp dir on error
    if (clonePath && fs.existsSync(clonePath)) {
      try {
        fs.rmSync(clonePath, { recursive: true, force: true });
      } catch (cleanErr) {
        console.warn('[GitHubBridge] Error cleanup failed:', cleanErr.message);
      }
      activeTempDirs.delete(clonePath);
    }

    return { success: false, error: errorMsg };
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

  ipcMain.handle(IPC.GITHUB_BRIDGE_IMPORT, async (event, url) => {
    return await importGitHubRepo(url, event.sender);
  });

  ipcMain.handle(IPC.GITHUB_BRIDGE_CHECK_GIT, async () => {
    return await checkGitAvailable();
  });

  ipcMain.handle(IPC.GITHUB_BRIDGE_VALIDATE_URL, (_event, url) => {
    return validateGitHubUrl(url);
  });
}

module.exports = {
  registerGithubBridgeIpc,
  cleanupTempDirs,
  validateGitHubUrl,
};
