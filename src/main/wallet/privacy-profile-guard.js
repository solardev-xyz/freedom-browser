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
    '(?:source|public)\\.sqlite|railgun-public-[0-9a-f]{64}/(?:(?:source|public|txid-[0-9a-f]{64})\\.sqlite|[0-9a-f]{64}\\.json)|railgun-cache-[0-9a-f]{64}/(?:wallet\\.sqlite|[0-9a-f]{64}\\.json))$'
);

// Fixed existing-only callers never receive inventory mutation methods.
function createPrivacyProfileGuard(options) {
  return createProfileGuard(options, false);
}
// Fixed internal main-process callers only; this is not an authority issuer.
function readRegisteredPrivacyProfileFile(options) {
  const { file, maximumBytes } = options;
  const guard = createProfileGuard(options, true);
  try {
    return guard.readRegistered(file, maximumBytes);
  } finally {
    guard.close();
  }
}
// The trusted profile directory and every descendant component must be real,
// existing files/directories. This is not an atomic filesystem snapshot or
// protection against rollback by another process with filesystem access.
function existingPath(root, file) {
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    throw new Error('path');
  let current = root;
  const parts = relative.split(path.sep);
  for (let i = 0; i <= parts.length; i++) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('path');
    if (i === parts.length) return stat;
    current = path.join(current, parts[i]);
  }
}
function readExistingFile(root, file, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8 * 1024 * 1024)
    throw new Error('size');
  const before = existingPath(root, file);
  if (before.size > maximumBytes) throw new Error('size');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maximumBytes
    )
      throw new Error('path');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0,
      amount;
    do {
      amount = fs.readSync(fd, bytes, count, bytes.length - count, null);
      count += amount;
    } while (amount && count < bytes.length);
    const after = fs.fstatSync(fd),
      current = existingPath(root, file);
    if (
      count !== opened.size ||
      [after, current].some(
        (stat) =>
          stat.dev !== opened.dev ||
          stat.ino !== opened.ino ||
          stat.size !== opened.size ||
          stat.mtimeMs !== opened.mtimeMs ||
          stat.ctimeMs !== opened.ctimeMs
      )
    )
      throw new Error('changed');
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}
function createProfileGuard({ handle, profile, seed }, existingOnly) {
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
  const close = () => {
    key.fill(0);
    context.signal.removeEventListener('abort', close);
  };
  context.signal.addEventListener('abort', close, { once: true });
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
  function readInventory(createMissing) {
    getPrivacyContext(handle);
    try {
      let serialized;
      if (existingOnly) {
        try {
          serialized = readExistingFile(profile.userDataDir, marker, 1024 * 1024).toString('utf8');
        } catch (error) {
          if (error.code === 'ENOENT') throw fail('PRIVATE_PROFILE_INVENTORY_MISSING');
          throw error;
        }
      } else {
        if (!fs.existsSync(marker)) {
          if (!createMissing) throw fail('PRIVATE_PROFILE_INVENTORY_MISSING');
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
        serialized = fs.readFileSync(marker, 'utf8');
      }
      const record = JSON.parse(serialized),
        state = record.state;
      if (existingOnly) getPrivacyContext(handle);
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
      if (existingOnly) {
        for (const file of state.files) {
          try {
            existingPath(profile.userDataDir, path.join(profile.userDataDir, file));
          } catch (error) {
            if (error.code === 'ENOENT') throw fail('PRIVATE_PROFILE_STORE_MISSING');
            throw error;
          }
        }
      } else if (state.files.some((file) => !fs.existsSync(path.join(profile.userDataDir, file))))
        throw fail('PRIVATE_PROFILE_STORE_MISSING');
      return state;
    } catch (error) {
      if (error.code?.startsWith('PRIVATE_') || error.code?.startsWith('PRIVACY_')) throw error;
      throw fail();
    }
  }
  const read = () => readInventory(true);
  const readExisting = () => readInventory(false);
  function name(file) {
    const relative = path.relative(profile.userDataDir, file).split(path.sep).join('/');
    if (!validName(relative)) throw fail();
    return relative;
  }
  try {
    if (existingOnly) readExisting();
    else read();
  } catch (error) {
    close();
    throw error;
  }
  if (existingOnly)
    return Object.freeze({
      close,
      readRegistered(file, maximumBytes) {
        try {
          if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail();
          const relative = name(file),
            state = readExisting();
          if (!state.files.includes(relative)) throw fail();
          const bytes = readExistingFile(profile.userDataDir, file, maximumBytes);
          if (JSON.stringify(readExisting()) !== JSON.stringify(state)) throw fail();
          getPrivacyContext(handle);
          return bytes;
        } catch (error) {
          if (error.code?.startsWith('PRIVATE_') || error.code?.startsWith('PRIVACY_')) throw error;
          throw fail();
        }
      },
    });
  return Object.freeze({
    assert(file) {
      name(file);
      read();
    },
    // Completed-only restoration must not adopt an unregistered store or
    // recreate a missing inventory. Membership is checked against each read.
    assertRegistered(file) {
      if (typeof file !== 'string') throw fail();
      const relative = name(file),
        state = readExisting();
      if (!state.files.includes(relative)) throw fail();
      getPrivacyContext(handle);
    },
    // Called only after this store has authenticated an existing file or has
    // durably written a new file. A crash before inventory update is repairable.
    remember(file) {
      const relative = name(file),
        state = read();
      if (!fs.existsSync(file)) throw fail('PRIVATE_PROFILE_STORE_MISSING');
      if (!state.files.includes(relative)) {
        if (state.files.length >= 4096) throw fail('PRIVATE_PROFILE_INVENTORY_FULL');
        state.files.push(relative);
        write(state);
      }
    },
  });
}

module.exports = { createPrivacyProfileGuard, readRegisteredPrivacyProfileFile };
