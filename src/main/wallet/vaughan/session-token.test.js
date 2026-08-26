const fs = require('fs');
const os = require('os');
const path = require('path');

let mockHome;

jest.mock('os', () => {
  const real = jest.requireActual('os');
  return {
    ...real,
    homedir: () => mockHome,
  };
});

const { resolveSessionToken, ENV_TOKEN } = require('./session-token');

function platformDataDir(home) {
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return path.join(home, '.local', 'share');
}

describe('resolveSessionToken', () => {
  let savedEnv;

  beforeEach(() => {
    mockHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vaughan-session-'));
    savedEnv = {
      token: process.env[ENV_TOKEN],
      xdg: process.env.XDG_DATA_HOME,
      appdata: process.env.APPDATA,
    };
    delete process.env[ENV_TOKEN];
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      [ENV_TOKEN]: savedEnv.token,
      XDG_DATA_HOME: savedEnv.xdg,
      APPDATA: savedEnv.appdata,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(mockHome, { recursive: true, force: true });
  });

  function writeToken(rel, token) {
    const file = path.join(platformDataDir(mockHome), 'vaughan-cli', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token);
    return file;
  }

  test('returns null when no token exists anywhere', () => {
    expect(resolveSessionToken()).toBeNull();
  });

  test('env override wins over files', () => {
    writeToken('provider.session', 'file-token');
    process.env[ENV_TOKEN] = ' env-token ';
    expect(resolveSessionToken()).toBe('env-token');
  });

  test('reads and trims the default profile token', () => {
    writeToken('provider.session', '  default-token\n');
    expect(resolveSessionToken()).toBe('default-token');
  });

  test('default profile beats named profiles', () => {
    writeToken('provider.session', 'default-token');
    writeToken(path.join('profiles', 'work', 'provider.session'), 'profile-token');
    expect(resolveSessionToken()).toBe('default-token');
  });

  test('newest named profile wins when there is no default token', () => {
    const older = writeToken(path.join('profiles', 'old', 'provider.session'), 'old-token');
    writeToken(path.join('profiles', 'new', 'provider.session'), 'new-token');
    // Backdate the older profile so mtime ordering is deterministic.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    expect(resolveSessionToken()).toBe('new-token');
  });

  test('skips empty token files', () => {
    writeToken('provider.session', '   \n');
    writeToken(path.join('profiles', 'work', 'provider.session'), 'profile-token');
    expect(resolveSessionToken()).toBe('profile-token');
  });
});
