/** Exercise the harness before identity/runtime/network access, using real profile locks. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {
  acquireProfileLock,
  releaseProfileLock,
  isProfileLocked,
} = require('../src/main/profile-lock');
const source = fs.readFileSync(path.join(__dirname, 'qualify-ppv2-session.js'), 'utf8');
async function run(profile) {
  let finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const app = {
    isPackaged: false,
    whenReady: jest.fn(async () => {
      throw new Error('stop before identity access');
    }),
    exit: jest.fn(finish),
  };
  const unexpected = jest.fn((name) => {
    throw new Error(`Unexpected qualification access: ${name}`);
  });
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return { app, safeStorage: {} };
      if (name === '../src/main/profile-lock') return require('../src/main/profile-lock');
      if (name === '../src/main/profile-resolver') return { initializeProfile: () => profile };
      if (name === '../src/main/wallet/ppv2-sepolia-test-step') return { ACTIONS: [] };
      if (['fs', 'path', 'assert/strict', 'crypto'].includes(name)) return require(name);
      return unexpected(name);
    },
    process: {
      argv: [
        'electron',
        'qualification.js',
        path.join(profile.userDataDir, 'unused.asar'),
        profile.userDataDir,
        path.join(profile.userDataDir, 'reports'),
      ],
      env: { FREEDOM_WALLET_TOR_EXPERIMENT: '1' },
      on() {},
    },
    console: { error: jest.fn(), log: jest.fn() },
  });
  expect(await completion).toBe(1);
  expect(unexpected).not.toHaveBeenCalled();
  return app;
}
function profile() {
  return {
    id: 'fixture',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-lock-')),
  };
}
test('qualification refuses an already open profile before identity or network access', async () => {
  const current = profile(),
    lock = acquireProfileLock(current);
  try {
    const app = await run(current);
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(isProfileLocked(current)).toBe(true);
  } finally {
    releaseProfileLock(lock);
  }
});
test('qualification releases its profile lock when setup fails', async () => {
  const current = profile();
  const app = await run(current);
  expect(app.whenReady).toHaveBeenCalledTimes(1);
  expect(isProfileLocked(current)).toBe(false);
});
