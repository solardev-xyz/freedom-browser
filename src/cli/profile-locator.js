'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliError } = require('./errors');
const { EXIT_CODES } = require('./exit-codes');

const MAX_CATALOG_BYTES = 1024 * 1024;
const PROFILE_REGISTRY_FILE = 'profile-registry.json';

function sanitizeProfileId(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input || input === '.' || input === '..' || input.includes('/') || input.includes('\\')) {
    throw new CliError('INVALID_PROFILE', `Invalid profile id: ${String(value)}`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const id = input.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) {
    throw new CliError('INVALID_PROFILE', `Invalid profile id: ${String(value)}`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return id;
}

function defaultAppDataDir(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function checkoutId(repoRoot) {
  const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return `freedom-browser-${hash}`;
}

function readCatalog(appRoot) {
  const catalogPath = path.join(appRoot, PROFILE_REGISTRY_FILE);
  let stat;
  try {
    stat = fs.lstatSync(catalogPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new CliError('PROFILE_CATALOG_UNREADABLE', 'Unable to read the profile catalog', {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      cause: error,
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CATALOG_BYTES) {
    throw new CliError('PROFILE_CATALOG_UNSAFE', 'Refusing to read an unsafe profile catalog', {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
    });
  }
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (catalog?.version !== 1 || !Array.isArray(catalog.profiles)) throw new Error('bad schema');
    return catalog;
  } catch (error) {
    throw new CliError('PROFILE_CATALOG_INVALID', 'The profile catalog is invalid', {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      cause: error,
    });
  }
}

function locateProfile(options = {}) {
  const env = options.env || process.env;
  if (env.FREEDOM_TEST_USER_DATA) {
    const userDataDir = path.resolve(env.FREEDOM_TEST_USER_DATA);
    return { id: 'test', userDataDir, appRoot: userDataDir, source: 'test-user-data' };
  }
  if (options.profileDir) {
    const userDataDir = path.resolve(options.profileDir);
    return {
      id: sanitizeProfileId(path.basename(userDataDir) || 'default'),
      userDataDir,
      appRoot: userDataDir,
      source: 'profile-dir',
    };
  }

  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const appRoot = path.resolve(
    options.appRoot ||
      env.FREEDOM_APP_ROOT ||
      env.FREEDOM_DEV_HOME ||
      path.join(defaultAppDataDir(options.platform, env), 'Freedom Dev', checkoutId(repoRoot))
  );
  const id = sanitizeProfileId(options.profile || env.FREEDOM_PROFILE || 'automation');
  const catalog = readCatalog(appRoot);
  const record = catalog?.profiles.find((candidate) => candidate?.id === id);
  const userDataDir = record?.dir
    ? path.resolve(record.dir)
    : path.join(appRoot, 'Profiles', id);
  return { id, userDataDir, appRoot, source: record ? 'catalog' : 'derived' };
}

module.exports = {
  checkoutId,
  defaultAppDataDir,
  locateProfile,
  readCatalog,
  sanitizeProfileId,
};
