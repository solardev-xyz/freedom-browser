/**
 * Main's check before it spawns a confined service (freedom-core design
 * 0010, step 7): a grant may not be, contain, or lie inside a protected
 * root, compared as canonical paths. Real catalogs and directories in a
 * temporary root, the real profile-paths and profile-catalog modules, and
 * the active profile as profile-resolver would give it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

let tempRoot;
let savedEnv;

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-service-grant-')));
  savedEnv = { ...process.env };
  for (const name of ['FREEDOM_IPFS_DATA', 'FREEDOM_RADICLE_DATA', 'FREEDOM_IDENTITY_DATA']) {
    delete process.env[name];
  }
});

afterEach(() => {
  process.env = savedEnv;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  jest.restoreAllMocks();
});

/**
 * A catalog in `appRoot` with the profiles `ids`, the default one kept at
 * the app root itself when `packaged`, as profile-resolver lays them out.
 * Returns each profile's record.
 */
function catalog(appRoot, ids, { packaged, checkoutHash = null }) {
  const { ensureProfile } = jest.requireActual('./profile-catalog');
  fs.mkdirSync(appRoot, { recursive: true });
  const options = {
    checkoutHash,
    dev: !packaged,
    defaultProfileDir: packaged ? appRoot : path.join(appRoot, 'Profiles', 'default'),
  };
  const records = {};
  for (const id of ids) records[id] = ensureProfile(appRoot, id, options).record;
  return records;
}

/** service-grant as main loads it, with `active` the profile in use. */
function loadGrant(active) {
  const app = createAppMock({
    userDataDir: active.userDataDir,
    appPaths: { appData: path.join(tempRoot, 'AppData') },
  });
  return loadMainModule(require.resolve('./service-grant'), {
    app,
    extraMocks: {
      [require.resolve('./profile-resolver')]: () => ({ getActiveProfile: () => active }),
    },
  }).mod;
}

/** The active catalog profile `record` of `appRoot`. */
function activeProfile(appRoot, record, { packaged, checkoutHash = null }) {
  return {
    source: 'catalog',
    appRoot,
    userDataDir: record.dir,
    isDev: !packaged,
    checkoutHash,
    metadata: { slot: record.slot },
  };
}

describe('canonical paths and the rule', () => {
  test('resolves symlinks through the longest existing prefix, and keeps the rest', () => {
    const { canonical } = jest.requireActual('./service-grant');
    const real = path.join(tempRoot, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tempRoot, 'alias'));
    expect(canonical(path.join(tempRoot, 'alias', 'not', 'yet'), { foldCase: false })).toBe(
      path.join(real, 'not', 'yet')
    );
    expect(canonical(path.join(tempRoot, 'Bee-Data'), { foldCase: true })).toBe(
      path.join(tempRoot, 'bee-data').toLowerCase()
    );
  });

  test('a grant that is, contains, or lies inside a root is refused, naming the root, never a path', () => {
    const { grantRefusal } = jest.requireActual('./service-grant');
    const root = path.join(tempRoot, 'identity');
    const roots = [{ name: "this profile's identity directory", dir: root }];
    expect(grantRefusal([root], roots)).toBe("the grant is this profile's identity directory");
    expect(grantRefusal([path.join(root, 'sub')], roots)).toBe(
      "the grant lies inside this profile's identity directory"
    );
    expect(grantRefusal([tempRoot], roots)).toBe(
      "the grant contains this profile's identity directory"
    );
    expect(grantRefusal([path.join(tempRoot, 'identity-other')], roots)).toBeNull();
    // Each grant of a list is checked.
    expect(grantRefusal([path.join(tempRoot, 'ok'), path.join(root, 'x')], roots)).toMatch(
      /identity/
    );
  });
});

describe('a packaged build: the default profile in the app data root, a named profile in use', () => {
  const PACKAGED = { packaged: true };
  let appRoot;
  let records;
  let grant;

  beforeEach(() => {
    appRoot = path.join(tempRoot, 'Freedom');
    records = catalog(appRoot, ['default', 'work', 'home'], PACKAGED);
    // What the default profile's browser and Radicle have written.
    fs.mkdirSync(path.join(appRoot, 'Local Storage', 'leveldb'), { recursive: true });
    fs.mkdirSync(path.join(appRoot, 'identity'), { recursive: true });
    fs.mkdirSync(path.join(appRoot, 'R', String(records.home.slot)), { recursive: true });
    grant = loadGrant(activeProfile(appRoot, records.work, PACKAGED));
  });

  test("this profile's own IPFS data directory passes, and so does its own Radicle home for Radicle", () => {
    expect(
      grant.ipfsGrantRefusal(path.join(records.work.dir, 'ipfs-data', 'freedom-ipfs'))
    ).toBeNull();
    const home = path.join(appRoot, 'R', String(records.work.slot));
    expect(grant.grantRefusal([home], grant.protectedRoots({ own: ['radicle'] }))).toBeNull();
    // Radicle's grant may not take the IPFS data directory, nor another home.
    expect(
      grant.grantRefusal(
        [path.join(records.work.dir, 'ipfs-data')],
        grant.protectedRoots({ own: ['radicle'] })
      )
    ).toBe("the grant is this profile's IPFS data directory");
    expect(
      grant.grantRefusal(
        [path.join(appRoot, 'R', String(records.home.slot))],
        grant.protectedRoots({ own: ['radicle'] })
      )
    ).toBe("the grant is another profile's Radicle home");
  });

  test("another profile's short Radicle home, outside its userData directory, is refused", () => {
    const home = path.join(appRoot, 'R', String(records.home.slot));
    expect(grant.ipfsGrantRefusal(home)).toBe("the grant is another profile's Radicle home");
    expect(grant.ipfsGrantRefusal(path.join(home, 'storage'))).toBe(
      "the grant lies inside another profile's Radicle home"
    );
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'R'))).toMatch(/^the grant contains /);
    // The default profile's home too, created or not.
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'R', String(records.default.slot), 'x'))).toBe(
      "the grant lies inside another profile's Radicle home"
    );
  });

  test("the default profile's browser storage is refused, present or not yet created", () => {
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'Local Storage', 'leveldb'))).toBe(
      "the grant lies inside another profile's browser storage"
    );
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'IndexedDB', 'x'))).toBe(
      "the grant lies inside another profile's browser storage"
    );
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'Service Worker'))).toBe(
      "the grant is another profile's browser storage"
    );
  });

  test("a symlink alias or a case alias of the default profile's storage is refused", () => {
    fs.symlinkSync(path.join(appRoot, 'Local Storage'), path.join(tempRoot, 'innocent'));
    expect(grant.ipfsGrantRefusal(path.join(tempRoot, 'innocent', 'x'))).toBe(
      "the grant lies inside another profile's browser storage"
    );
    // On a case-insensitive volume (folded, as on macOS and Windows).
    expect(
      grant.ipfsGrantRefusal(path.join(appRoot, 'LOCAL STORAGE', 'x'), { foldCase: true })
    ).toBe("the grant lies inside another profile's browser storage");
    // A case alias of another profile's home, too.
    const home = path.join(appRoot, 'r', String(records.home.slot), 'x');
    expect(grant.ipfsGrantRefusal(home, { foldCase: true })).toBe(
      "the grant lies inside another profile's Radicle home"
    );
  });

  test("the default profile's identity and node directories, and anything else it holds, are refused", () => {
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'identity', 'x'))).toBe(
      "the grant lies inside another profile's identity directory"
    );
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'bee-data'))).toBe(
      "the grant is another profile's Bee data directory"
    );
    fs.writeFileSync(path.join(appRoot, 'history.sqlite'), '');
    fs.mkdirSync(path.join(appRoot, 'wallet'));
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'wallet', 'x'))).toBe(
      "the grant lies inside another profile's data"
    );
  });

  test("another named profile is protected whole, and the directory holding the profiles can't be granted", () => {
    expect(grant.ipfsGrantRefusal(path.join(records.home.dir, 'downloads'))).toBe(
      "the grant lies inside another profile's directory"
    );
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'Profiles'))).toMatch(/^the grant contains /);
    expect(grant.ipfsGrantRefusal(appRoot)).toMatch(/^the grant contains /);
  });

  test("this profile's other directories and the lock directory are refused", () => {
    expect(grant.ipfsGrantRefusal(path.join(records.work.dir, 'Local Storage', 'x'))).toBe(
      "the grant lies inside this profile's browser storage"
    );
    expect(grant.ipfsGrantRefusal(path.join(records.work.dir, 'identity'))).toBe(
      "the grant is this profile's identity directory"
    );
    expect(grant.ipfsGrantRefusal(records.work.dir)).toMatch(/^the grant contains this profile's/);
    expect(grant.ipfsGrantRefusal(path.join(tempRoot, 'AppData', 'Freedom', 'locks', 'x'))).toBe(
      'the grant lies inside the lock directory'
    );
    const home = path.join(appRoot, 'R', String(records.work.slot));
    expect(grant.ipfsGrantRefusal(home)).toBe("the grant is this profile's Radicle home");
  });

  test('a directory it must list and cannot fails the check closed', () => {
    const readdir = fs.readdirSync;
    jest.spyOn(fs, 'readdirSync').mockImplementation((dir, ...rest) => {
      if (dir === appRoot) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readdir(dir, ...rest);
    });
    expect(() =>
      grant.ipfsGrantRefusal(path.join(records.work.dir, 'ipfs-data', 'freedom-ipfs'))
    ).toThrow('denied');
  });
});

describe('a packaged build with the default profile in use', () => {
  const PACKAGED = { packaged: true };

  test('its own IPFS directory passes; its storage and the named profiles are refused', () => {
    const appRoot = path.join(tempRoot, 'Freedom');
    const records = catalog(appRoot, ['default', 'work'], PACKAGED);
    const grant = loadGrant(activeProfile(appRoot, records.default, PACKAGED));
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'ipfs-data', 'freedom-ipfs'))).toBeNull();
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'Local Storage', 'x'))).toBe(
      "the grant lies inside this profile's browser storage"
    );
    expect(grant.ipfsGrantRefusal(path.join(records.work.dir, 'x'))).toBe(
      "the grant lies inside another profile's directory"
    );
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'R', String(records.work.slot), 'x'))).toBe(
      "the grant lies inside another profile's Radicle home"
    );
  });
});

describe('a development build: Radicle homes beside the app root', () => {
  const DEV = { packaged: false, checkoutHash: 'abcd1234' };

  test("another profile's home under R/<checkout>/<slot> is refused; this profile's directories pass", () => {
    const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcd1234');
    const records = catalog(appRoot, ['default', 'work', 'home'], DEV);
    const homes = path.join(tempRoot, 'Freedom Dev', 'R', 'abcd1234');
    const grant = loadGrant(activeProfile(appRoot, records.work, DEV));

    expect(
      grant.ipfsGrantRefusal(path.join(records.work.dir, 'ipfs-data', 'freedom-ipfs'))
    ).toBeNull();
    expect(
      grant.grantRefusal(
        [path.join(homes, String(records.work.slot))],
        grant.protectedRoots({ own: ['radicle'] })
      )
    ).toBeNull();
    expect(grant.ipfsGrantRefusal(path.join(homes, String(records.home.slot), 'x'))).toBe(
      "the grant lies inside another profile's Radicle home"
    );
    expect(grant.ipfsGrantRefusal(path.join(homes, String(records.default.slot)))).toBe(
      "the grant is another profile's Radicle home"
    );
    // The default profile is a named directory here: whole.
    expect(grant.ipfsGrantRefusal(path.join(records.default.dir, 'Local Storage'))).toBe(
      "the grant lies inside another profile's directory"
    );
    // The catalog's own directory, beside the profiles.
    expect(grant.ipfsGrantRefusal(path.join(appRoot, 'profile-registry.json'))).toBe(
      "the grant is the app data directory's data"
    );
  });
});

describe('a profile outside the catalog', () => {
  test('has its own components and the lock directory protected', () => {
    const userDataDir = path.join(tempRoot, 'legacy');
    const grant = loadGrant({ source: 'legacy', userDataDir });
    expect(grant.ipfsGrantRefusal(path.join(userDataDir, 'ipfs-data', 'freedom-ipfs'))).toBeNull();
    expect(grant.ipfsGrantRefusal(path.join(userDataDir, 'identity'))).toBe(
      "the grant is this profile's identity directory"
    );
  });

  test("an override puts this profile's directories where it says", () => {
    const identity = path.join(tempRoot, 'elsewhere', 'identity');
    process.env.FREEDOM_IDENTITY_DATA = identity;
    const grant = loadGrant({ source: 'legacy', userDataDir: path.join(tempRoot, 'legacy') });
    expect(grant.ipfsGrantRefusal(path.join(identity, 'x'))).toBe(
      "the grant lies inside this profile's identity directory"
    );
  });
});
