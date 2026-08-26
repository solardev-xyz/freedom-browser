/**
 * Vaughan provider session-token resolution.
 *
 * The Vaughan provider (ws://127.0.0.1:8745) writes a per-run bearer token to
 * `<dataDir>/vaughan-cli/provider.session` (mode 0600) and requires it from
 * clients it cannot otherwise attest — the same model Vaughan's own dApp
 * browser launcher uses. Named wallet profiles keep their token at
 * `<dataDir>/vaughan-cli/profiles/<name>/provider.session`.
 *
 * The token is read at call time and never cached or logged: restarting
 * Vaughan rotates the token and Freedom picks the new one up on the next
 * request. VAUGHAN_PROVIDER_SESSION_TOKEN overrides file lookup, matching the
 * env var Vaughan's launcher honors. Returns null when no token exists yet —
 * older Vaughan builds accept tokenless loopback clients, so absence is not
 * an error here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_TOKEN = 'VAUGHAN_PROVIDER_SESSION_TOKEN';
const APP_DIR = 'vaughan-cli';
const TOKEN_FILE = 'provider.session';

function dataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function readTokenFile(file) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch (_) {
    return null;
  }
}

function resolveSessionToken() {
  const fromEnv = (process.env[ENV_TOKEN] || '').trim();
  if (fromEnv) {
    return fromEnv;
  }

  const base = path.join(dataDir(), APP_DIR);
  const fromDefault = readTokenFile(path.join(base, TOKEN_FILE));
  if (fromDefault) {
    return fromDefault;
  }

  // Named profiles: newest token wins — the running provider is most likely
  // the one whose session file was written most recently.
  const profilesDir = path.join(base, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(profilesDir, entry.name, TOKEN_FILE);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue;
    }
    if (best && stat.mtimeMs <= best.mtimeMs) {
      continue;
    }
    const token = readTokenFile(file);
    if (token) {
      best = { token, mtimeMs: stat.mtimeMs };
    }
  }
  return best ? best.token : null;
}

module.exports = { resolveSessionToken, ENV_TOKEN };
