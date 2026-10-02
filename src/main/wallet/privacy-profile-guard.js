/** Authenticated local inventory, not rollback protection. A moved profile or
 * a missing initialized store requires recovery instead of an empty journal.
 * The key deliberately excludes the path so a moved marker is recognizable.
 */
const fs = require('fs');
const path = require('path');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('crypto');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const STORES = [
  'wallet-ppv2-experiment',
  'wallet-ppv2-relays',
  'wallet-private-submissions',
  'wallet-railgun-accounts',
];
const RAILGUN_FILE = new RegExp(
  '^wallet-railgun-accounts/account-[0-9a-f]{64}/(?:[0-9a-f]{64}\\.json|' +
    '(?:source|public)\\.sqlite|railgun-cache-[0-9a-f]{64}/(?:wallet\\.sqlite|[0-9a-f]{64}\\.json))$'
);

function createPrivacyProfileGuard({ handle, profile, seed }) {
  const context = getPrivacyContext(handle);
  const profileId = createHash('sha256')
    .update(JSON.stringify([profile.id, profile.userDataDir]))
    .digest('hex');
  if (profileId !== context.profileId)
    throw privacyError('PRIVATE_PROFILE_MOVED', 'Privacy profile requires recovery');
  const key = createHmac('sha256', seed)
    .update('Freedom privacy inventory v1\0')
    .update(profile.id)
    .digest();
  context.signal.addEventListener('abort', () => key.fill(0), { once: true });
  const marker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
  const fail = (code = 'PRIVATE_PROFILE_INVENTORY_INVALID') =>
    privacyError(code, 'Privacy inventory requires recovery');
  const validName = (name) =>
    typeof name === 'string' &&
    (STORES.some((dir) => new RegExp(`^${dir}/[0-9a-f]{64}\\.json$`).test(name)) ||
      RAILGUN_FILE.test(name));
  const mac = (state) => createHmac('sha256', key).update(JSON.stringify(state)).digest();
  function write(state) {
    getPrivacyContext(handle);
    fs.mkdirSync(profile.userDataDir, { recursive: true, mode: 0o700 });
    const temporary = `${marker}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ state, mac: mac(state).toString('hex') }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, marker);
    if (process.platform !== 'win32') {
      const parent = fs.openSync(profile.userDataDir, 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
  }
  function read() {
    getPrivacyContext(handle);
    try {
      if (!fs.existsSync(marker)) {
        if (
          STORES.some((dir) => {
            const location = path.join(profile.userDataDir, dir);
            return fs.existsSync(location) && fs.readdirSync(location).length > 0;
          })
        )
          throw fail('PRIVATE_PROFILE_INVENTORY_MISSING');
        const state = { version: 1, profileId, files: [] };
        write(state);
        return state;
      }
      if (fs.statSync(marker).size > 1024 * 1024) throw fail();
      const record = JSON.parse(fs.readFileSync(marker, 'utf8')),
        state = record.state;
      if (
        !state ||
        state.version !== 1 ||
        !Array.isArray(state.files) ||
        state.files.length > 4096 ||
        !state.files.every(validName) ||
        new Set(state.files).size !== state.files.length ||
        !/^[0-9a-f]{64}$/.test(record.mac) ||
        !timingSafeEqual(Buffer.from(record.mac, 'hex'), mac(state))
      )
        throw fail();
      if (state.profileId !== profileId) throw fail('PRIVATE_PROFILE_MOVED');
      if (state.files.some((file) => !fs.existsSync(path.join(profile.userDataDir, file))))
        throw fail('PRIVATE_PROFILE_STORE_MISSING');
      return state;
    } catch (error) {
      if (error.code?.startsWith('PRIVATE_') || error.code?.startsWith('PRIVACY_')) throw error;
      throw fail();
    }
  }
  function name(file) {
    const relative = path.relative(profile.userDataDir, file).split(path.sep).join('/');
    if (!validName(relative)) throw fail();
    return relative;
  }
  read();
  return Object.freeze({
    assert(file) {
      name(file);
      read();
    },
    // Called only after this store has authenticated an existing file or has
    // durably written a new file. A crash before inventory update is repairable.
    remember(file) {
      const relative = name(file),
        state = read();
      if (!fs.existsSync(file)) throw fail('PRIVATE_PROFILE_STORE_MISSING');
      if (!state.files.includes(relative)) {
        state.files.push(relative);
        write(state);
      }
    },
  });
}

module.exports = { createPrivacyProfileGuard };
