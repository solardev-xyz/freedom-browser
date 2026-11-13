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

  test("this profile's default IPFS directory as a symlink exempts nothing of another profile", () => {
    // work/ipfs-data is a symlink to another profile's directory, whose
    // freedom-ipfs entry is in turn a symlink to that profile's identity.
    fs.mkdirSync(path.join(records.home.dir, 'identity'), { recursive: true });
    fs.symlinkSync(records.home.dir, path.join(records.work.dir, 'ipfs-data'));
    fs.symlinkSync(
      path.join(records.home.dir, 'identity'),
      path.join(records.home.dir, 'freedom-ipfs')
    );
    expect(grant.ipfsGrantRefusal(path.join(records.work.dir, 'ipfs-data', 'freedom-ipfs'))).toBe(
      "the grant lies inside another profile's directory"
    );
    // Refused outright, even with the grant elsewhere.
    expect(grant.ipfsGrantRefusal(path.join(tempRoot, 'elsewhere', 'freedom-ipfs'))).toBe(
      "the service's own default directory resolves into a protected root (is another profile's directory)"
    );
  });

  test("this profile's default IPFS directory as a symlink into the default profile reaches none of its storage", () => {
    fs.symlinkSync(appRoot, path.join(records.work.dir, 'ipfs-data'));
    fs.symlinkSync(
      path.join(appRoot, 'Local Storage', 'leveldb'),
      path.join(appRoot, 'freedom-ipfs')
    );
    expect(grant.ipfsGrantRefusal(path.join(records.work.dir, 'ipfs-data', 'freedom-ipfs'))).toBe(
      "the grant lies inside another profile's browser storage"
    );
    expect(grant.ipfsGrantRefusal(path.join(tempRoot, 'elsewhere', 'freedom-ipfs'))).toMatch(
      /^the service's own default directory resolves into a protected root/
    );
  });

  test('a default IPFS directory that is a symlink out of every profile still passes', () => {
    const elsewhere = path.join(tempRoot, 'bigger-disk', 'ipfs-data');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(records.work.dir, 'ipfs-data'));
    expect(
      grant.ipfsGrantRefusal(path.join(records.work.dir, 'ipfs-data', 'freedom-ipfs'))
    ).toBeNull();
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

describe('a profile outside the catalog: --profile-dir, a test user-data directory', () => {
  test.each(['profile-dir', 'test-user-data'])(
    'a %s profile has its userData directory and its browser storage protected too',
    (source) => {
      const userDataDir = path.join(tempRoot, 'Elsewhere');
      fs.mkdirSync(path.join(userDataDir, 'Local Storage'), { recursive: true });
      const grant = loadGrant({ source, appRoot: userDataDir, userDataDir });
      // Its ordinary IPFS directory passes.
      expect(
        grant.ipfsGrantRefusal(path.join(userDataDir, 'ipfs-data', 'freedom-ipfs'))
      ).toBeNull();
      expect(grant.ipfsGrantRefusal(path.join(userDataDir, 'Local Storage', 'x'))).toBe(
        "the grant lies inside this profile's browser storage"
      );
      expect(grant.ipfsGrantRefusal(path.join(userDataDir, 'IndexedDB'))).toBe(
        "the grant is this profile's browser storage"
      );
      expect(grant.ipfsGrantRefusal(path.join(userDataDir, 'identity'))).toBe(
        "the grant is this profile's identity directory"
      );
      expect(grant.ipfsGrantRefusal(userDataDir)).toMatch(/^the grant contains this profile's/);
    }
  );

  test("an override puts this profile's directories where it says", () => {
    const identity = path.join(tempRoot, 'elsewhere', 'identity');
    process.env.FREEDOM_IDENTITY_DATA = identity;
    const userDataDir = path.join(tempRoot, 'legacy');
    const grant = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    expect(grant.ipfsGrantRefusal(path.join(identity, 'x'))).toBe(
      "the grant lies inside this profile's identity directory"
    );
  });
});

describe('names that begin with two dots are ordinary names', () => {
  test('the rule sees through `..vault` both ways', () => {
    const { relation } = jest.requireActual('./service-grant');
    const root = path.join(tempRoot, 'a');
    expect(relation(path.join(root, '..vault'), root)).toBe('inside');
    expect(relation(root, path.join(root, '..vault'))).toBe('contains');
    expect(relation(path.join(root, '..vault', 'x'), path.join(root, '..vault'))).toBe('inside');
    // A real parent is outside.
    expect(relation(tempRoot, root)).toBe('contains');
    expect(relation(path.join(tempRoot, 'b'), root)).toBeNull();
    expect(relation(path.join(tempRoot, '..b'), root)).toBeNull();
  });

  test('a grant holding an identity directory named `..vault`, or inside one, is refused', () => {
    const outside = path.join(tempRoot, 'outside');
    const userDataDir = path.join(tempRoot, 'legacy');
    process.env.FREEDOM_IDENTITY_DATA = path.join(outside, 'freedom-ipfs', '..vault');
    let grant = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    expect(grant.ipfsGrantRefusal(path.join(outside, 'freedom-ipfs'))).toBe(
      "the grant contains this profile's identity directory"
    );
    process.env.FREEDOM_IDENTITY_DATA = path.join(outside, '..vault');
    grant = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    expect(grant.ipfsGrantRefusal(path.join(outside, '..vault', 'freedom-ipfs'))).toBe(
      "the grant lies inside this profile's identity directory"
    );
  });
});

describe('what the grant holds: regular files, directories and symlinks only', () => {
  function profileDir() {
    const userDataDir = path.join(tempRoot, 'Elsewhere');
    const identity = path.join(userDataDir, 'identity');
    fs.mkdirSync(identity, { recursive: true });
    fs.writeFileSync(path.join(identity, 'vault.json'), '{"vault":true}');
    const grant = path.join(userDataDir, 'ipfs-data', 'freedom-ipfs');
    fs.mkdirSync(grant, { recursive: true });
    return { userDataDir, identity, grant };
  }

  test("a hard link to this profile's vault inside the grant is refused", () => {
    const { userDataDir, identity, grant } = profileDir();
    fs.linkSync(path.join(identity, 'vault.json'), path.join(grant, 'vault.json'));
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    expect(check.ipfsGrantRefusal(grant)).toBe(
      'the grant holds a hard link to a file with a name outside it'
    );
  });

  test('a grant as the service leaves it passes: files, a directory, a symlink out', () => {
    const { userDataDir, grant } = profileDir();
    fs.writeFileSync(path.join(grant, 'freedom-ipfs.sqlite3'), 'db');
    fs.writeFileSync(path.join(grant, 'freedom-ipfs.sqlite3-wal'), 'wal');
    fs.mkdirSync(path.join(grant, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(grant, 'sub', 'deeper', 'file'), 'x');
    // A symlink isn't followed: the kernel resolves it at each open.
    fs.symlinkSync(path.join(userDataDir, 'identity'), path.join(grant, 'out'));
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    expect(check.ipfsGrantRefusal(grant)).toBeNull();
    // Nothing to walk yet: a grant that doesn't exist.
    fs.rmSync(grant, { recursive: true });
    expect(check.ipfsGrantRefusal(grant)).toBeNull();
  });

  test('an entry that cannot be read refuses, failing closed', () => {
    const { userDataDir, grant } = profileDir();
    fs.writeFileSync(path.join(grant, 'secret'), 'x');
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    const lstat = fs.lstatSync;
    jest.spyOn(fs, 'lstatSync').mockImplementation((entry, ...rest) => {
      if (String(entry).endsWith('secret')) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return lstat(entry, ...rest);
    });
    expect(check.ipfsGrantRefusal(grant)).toBe("the grant holds an entry that can't be read");
  });

  test('the walk is bounded: more entries or deeper than its bounds refuses', () => {
    const { grantContentRefusal } = jest.requireActual('./service-grant');
    const dir = path.join(tempRoot, 'walk');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    for (const name of ['1', '2', '3']) fs.writeFileSync(path.join(dir, name), name);
    expect(grantContentRefusal([dir])).toBeNull();
    expect(grantContentRefusal([dir], { maxEntries: 3 })).toBe(
      'the grant holds more than 3 entries to check'
    );
    expect(grantContentRefusal([dir], { maxDepth: 1 })).toBe(
      'the grant is deeper than 1 levels to check'
    );
  });
});

describe('Unicode names on a case-insensitive volume', () => {
  const UNCOMPARABLE =
    "a path holds a name that doesn't exist yet and isn't ASCII, which this volume's case folding can't be compared by";

  function overrides(identity, ipfs) {
    const outside = path.join(tempRoot, 'outside');
    process.env.FREEDOM_IDENTITY_DATA = path.join(outside, identity, 'freedom-ipfs');
    process.env.FREEDOM_IPFS_DATA = path.join(outside, ipfs);
    const userDataDir = path.join(tempRoot, 'legacy');
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    return { outside, check };
  }

  test('Σ and ς, which such a volume folds to one name, are refused before either exists', () => {
    const { outside, check } = overrides('Σ', 'ς');
    expect(
      check.ipfsGrantRefusal(path.join(outside, 'ς', 'freedom-ipfs'), { foldCase: true })
    ).toBe(UNCOMPARABLE);
    // A case-sensitive volume compares them as the names they are.
    expect(
      check.ipfsGrantRefusal(path.join(outside, 'ς', 'freedom-ipfs'), { foldCase: false })
    ).toBeNull();
  });

  test('an ASCII case alias is compared, and refused as the root it aliases', () => {
    const { outside, check } = overrides('S', 's');
    expect(
      check.ipfsGrantRefusal(path.join(outside, 's', 'freedom-ipfs'), { foldCase: true })
    ).toBe("the grant is this profile's identity directory");
  });

  test('a non-ASCII name that exists is resolved, so only missing ones count', () => {
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(path.join(outside, 'Café'), { recursive: true });
    process.env.FREEDOM_IPFS_DATA = path.join(outside, 'Café');
    const userDataDir = path.join(tempRoot, 'legacy');
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    expect(
      check.ipfsGrantRefusal(path.join(outside, 'Café', 'freedom-ipfs'), { foldCase: true })
    ).toBeNull();
  });
});

describe('special files and dangling symlinks', () => {
  function profileDir() {
    const userDataDir = path.join(tempRoot, 'Elsewhere');
    const grant = path.join(userDataDir, 'ipfs-data', 'freedom-ipfs');
    fs.mkdirSync(grant, { recursive: true });
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    return { userDataDir, grant, check };
  }
  const SPECIAL =
    'the grant holds a special file (a FIFO, a socket or a device), a channel outside it';

  test('a FIFO already in the grant is refused', () => {
    const { grant, check } = profileDir();
    require('child_process').execFileSync('mkfifo', [path.join(grant, 'channel')]);
    expect(check.ipfsGrantRefusal(grant)).toBe(SPECIAL);
  });

  test('a socket already in the grant is refused', async () => {
    const { grant, check } = profileDir();
    const server = require('net').createServer();
    await new Promise((resolve) => server.listen(path.join(grant, 'control.sock'), resolve));
    try {
      expect(check.ipfsGrantRefusal(grant)).toBe(SPECIAL);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("a protected root that is a symlink to a name in the grant that doesn't exist yet is refused", () => {
    // identity -> the grant's future-identity, absent: once the service
    // made it, the vault would be written into the grant. It is compared
    // by its target, which lies inside the grant.
    const { userDataDir, grant, check } = profileDir();
    fs.symlinkSync(path.join(grant, 'future-identity'), path.join(userDataDir, 'identity'));
    expect(check.ipfsGrantRefusal(grant)).toBe(
      "the grant contains this profile's identity directory"
    );
    // The same through a relative link, and through a second dangling link.
    fs.unlinkSync(path.join(userDataDir, 'identity'));
    fs.symlinkSync('hop', path.join(userDataDir, 'identity'));
    fs.symlinkSync(path.join('ipfs-data', 'freedom-ipfs', 'later'), path.join(userDataDir, 'hop'));
    expect(check.ipfsGrantRefusal(grant)).toBe(
      "the grant contains this profile's identity directory"
    );
  });

  test("Chromium's singleton links, symlinks to names that don't exist, don't refuse a grant", () => {
    // Every running profile's directory holds SingletonLock -> <host>-<pid>
    // and SingletonCookie -> <number>, which never resolve. Split into its
    // entries, the profile's directory makes them roots, compared by their
    // targets: beside the grant, not in it.
    const { userDataDir, grant, check } = profileDir();
    fs.symlinkSync('runner-4242', path.join(userDataDir, 'SingletonLock'));
    fs.symlinkSync('8051712915417346451', path.join(userDataDir, 'SingletonCookie'));
    expect(check.ipfsGrantRefusal(grant)).toBeNull();
    // A grant whose own path is such a link is compared by its target too.
    const elsewhere = path.join(tempRoot, 'Spare');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(path.join(elsewhere, 'later'), path.join(tempRoot, 'spare-link'));
    expect(check.ipfsGrantRefusal(path.join(tempRoot, 'spare-link', 'freedom-ipfs'))).toBeNull();
    fs.symlinkSync(path.join(userDataDir, 'identity'), path.join(tempRoot, 'identity-link'));
    expect(check.ipfsGrantRefusal(path.join(tempRoot, 'identity-link', 'freedom-ipfs'))).toBe(
      "the grant lies inside this profile's identity directory"
    );
  });

  test('a grant reached through a symlink that loops is refused too', () => {
    const { userDataDir, check } = profileDir();
    const loop = path.join(userDataDir, 'loop');
    fs.symlinkSync(loop, loop);
    expect(check.ipfsGrantRefusal(path.join(loop, 'freedom-ipfs'))).toBe(
      "a path holds a symlink that can't be followed: a loop, or too many links"
    );
    // Two links naming each other, neither existing otherwise.
    fs.symlinkSync('pong', path.join(userDataDir, 'ping'));
    fs.symlinkSync('ping', path.join(userDataDir, 'pong'));
    expect(check.ipfsGrantRefusal(path.join(userDataDir, 'ping', 'freedom-ipfs'))).toBe(
      "a path holds a symlink that can't be followed: a loop, or too many links"
    );
  });

  test('the walk reads one entry at a time: with a bound of 1, it visits one name', () => {
    const { grantContentRefusal } = jest.requireActual('./service-grant');
    const dir = path.join(tempRoot, 'many');
    fs.mkdirSync(dir);
    for (let i = 0; i < 64; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x');
    const opendir = fs.opendirSync;
    let reads = 0;
    let closed = 0;
    jest.spyOn(fs, 'opendirSync').mockImplementation((...args) => {
      const handle = opendir(...args);
      const readSync = handle.readSync.bind(handle);
      const closeSync = handle.closeSync.bind(handle);
      handle.readSync = () => {
        reads += 1;
        return readSync();
      };
      handle.closeSync = () => {
        closed += 1;
        return closeSync();
      };
      return handle;
    });
    const lstat = jest.spyOn(fs, 'lstatSync');
    expect(grantContentRefusal([dir], { maxEntries: 1 })).toBe(
      'the grant holds more than 1 entries to check'
    );
    // The directory and its first name are checked; the second name only
    // counted, then refused.
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(reads).toBe(2);
    expect(closed).toBe(1);
  });
});

describe('names Win32 may read as others, on any OS (`win32`, path.win32)', () => {
  // service-grant.win32.test.js runs the same against NTFS junctions on
  // CI's Windows runner.
  const WIN32_NAME =
    "a path holds a name Windows may read as another (a trailing period or space, a stream, a device's name, or a short name that doesn't exist yet), which can't be compared";

  /** A profile before freedom-ipfsd's first start: `ipfs-data` made, the
   * grant in it not yet. With `override`, FREEDOM_IPFS_DATA puts the IPFS
   * data elsewhere, so the grant is outside the default `ipfs-data`. */
  function fresh({ override = false } = {}) {
    const userDataDir = path.join(tempRoot, 'Elsewhere');
    const ipfsData = override
      ? path.join(tempRoot, 'IpfsOverride')
      : path.join(userDataDir, 'ipfs-data');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(ipfsData, { recursive: true });
    if (override) process.env.FREEDOM_IPFS_DATA = ipfsData;
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    return { userDataDir, ipfsData, grant: path.join(ipfsData, 'freedom-ipfs'), check };
  }

  test("a fresh profile's grant passes: none of its names, present or not yet, is an alias", () => {
    const { grant, check } = fresh();
    expect(check.ipfsGrantRefusal(grant, { win32: true })).toBeNull();
  });

  test.each(['freedom-ipfs.', 'freedom-ipfs ', 'freedom-ipfs. .'])(
    'a dangling identity link to %j, Win32 aliases of the grant, is refused before the grant exists',
    (name) => {
      // Once freedom-ipfsd made freedom-ipfs, Win32 would open the link's
      // target as it: the vault in the grant. Compared as written, it is
      // a sibling.
      for (const override of [false, true]) {
        fs.rmSync(path.join(tempRoot, 'Elsewhere'), { recursive: true, force: true });
        const { userDataDir, ipfsData, grant, check } = fresh({ override });
        fs.symlinkSync(path.join(ipfsData, name), path.join(userDataDir, 'identity'));
        expect(fs.existsSync(grant)).toBe(false);
        expect(check.ipfsGrantRefusal(grant, { win32: true })).toBe(WIN32_NAME);
        // On a POSIX volume the name is its own. In ipfs-data, the link is
        // still refused, as a root inside the service's own default
        // directory; with the grant moved out of it, nothing else refuses it.
        expect(check.ipfsGrantRefusal(grant, { win32: false })).toBe(
          override
            ? null
            : "the service's own default directory resolves into a protected root (contains this profile's identity directory)"
        );
      }
    }
  );

  test.each([
    'FREEDO~1',
    'freedom-ipfs:vault',
    'freedom-ipfs::$INDEX_ALLOCATION',
    'NUL',
    'nul.txt',
    'con .log',
    'COM1',
    'LPT³',
    'CONOUT$',
    'freedom-ipfs?',
  ])('a dangling identity link to %j, a short name, a stream or a device, is refused', (name) => {
    const { userDataDir, ipfsData, grant, check } = fresh({ override: true });
    fs.symlinkSync(path.join(ipfsData, name), path.join(userDataDir, 'identity'));
    expect(check.ipfsGrantRefusal(grant, { win32: true })).toBe(WIN32_NAME);
    expect(check.ipfsGrantRefusal(grant, { win32: false, foldCase: false })).toBeNull();
  });

  test('a name with a trailing period is refused where it exists too; a `~` only where it does not', () => {
    // A name that exists is resolved, but a literal `spare.` (made through
    // `\\?\`) is one Win32 opens as `spare`.
    const { check } = fresh();
    fs.mkdirSync(path.join(tempRoot, 'spare.'));
    expect(
      check.ipfsGrantRefusal(path.join(tempRoot, 'spare.', 'freedom-ipfs'), { win32: true })
    ).toBe(WIN32_NAME);
    // A long name may hold a `~`: it exists, so it was resolved as itself.
    fs.mkdirSync(path.join(tempRoot, 'Spare~1'));
    expect(
      check.ipfsGrantRefusal(path.join(tempRoot, 'Spare~1', 'freedom-ipfs'), { win32: true })
    ).toBeNull();
    expect(
      check.ipfsGrantRefusal(path.join(tempRoot, 'Spare~2', 'freedom-ipfs'), { win32: true })
    ).toBe(WIN32_NAME);
  });

  /** `target`, a Win32 path, as resolveParts would split it with its last
   * `missing` names not existing yet. */
  function win32Parts(target, missing) {
    const resolved = path.win32.resolve(target);
    const { root } = path.win32.parse(resolved);
    const names = resolved.slice(root.length).split('\\').filter(Boolean);
    const at = names.length - missing;
    return { real: path.win32.join(root, ...names.slice(0, at)), rest: names.slice(at) };
  }

  test.each([
    ['C:\\Users\\me\\ipfs-data\\freedom-ipfs.', 1, true],
    ['C:\\Users\\me\\ipfs-data\\freedom-ipfs ', 1, true],
    // A trailing separator hides no period, and is no name itself.
    ['C:/Users/me/ipfs-data/freedom-ipfs./', 1, true],
    ['C:\\Users\\me\\ipfs-data\\freedom-ipfs\\', 1, false],
    ['C:\\Users\\me\\ipfs-data\\freedom-ipfs\\.\\', 1, false],
    ['C:\\Users\\me\\ipfs-data\\freedom-ipfs:vault', 1, true],
    ['C:\\Users\\me\\ipfs-data\\freedom-ipfs::$INDEX_ALLOCATION', 1, true],
    ['C:\\Users\\me\\vault:secret\\freedom-ipfs', 1, true],
    ['C:\\Users\\me\\ipfs-data\\FREEDO~1', 1, true],
    ['C:\\Users\\me~work\\ipfs-data\\freedom-ipfs', 1, false],
    ['C:\\Users\\me~work\\ipfs-data\\freedom-ipfs', 3, true],
    ['C:\\Users\\me\\ipfs-data\\NUL', 1, true],
    ['C:\\Users\\me\\ipfs-data\\nul.txt', 1, true],
    ['C:\\Users\\me\\ipfs-data\\con .log', 1, true],
    ['C:\\Users\\me\\ipfs-data\\COM¹', 1, true],
    ['C:\\Users\\me\\AUX\\freedom-ipfs', 1, true],
    ['C:\\Users\\me\\ipfs-data\\COM10', 1, false],
    ['C:\\Users\\me\\ipfs-data\\nullable', 1, false],
    ['C:\\Users\\me\\ipfs-data\\console.log', 1, false],
    ['C:\\Users\\me\\Local Storage\\leveldb', 2, false],
    ['\\\\server\\share\\me\\ipfs-data\\freedom-ipfs', 1, false],
  ])('path.win32: %j with %i missing names is an alias: %s', (target, missing, alias) => {
    const { win32Uncomparable } = jest.requireActual('./service-grant');
    expect(win32Uncomparable(win32Parts(target, missing))).toBe(alias);
  });

  test.each([
    [['C:\\Users\\me\\ipfs-data\\freedom-ipfs', '\\\\localhost\\C$\\Users\\me\\identity'], true],
    [['C:\\Users\\me\\identity', '\\\\?\\C:\\Users\\me\\identity'], true],
    [['C:\\Users\\me\\identity', '\\\\.\\NUL'], true],
    [['\\\\srv\\share\\me\\a', '\\\\10.0.0.5\\share\\me\\b'], true],
    [['\\\\srv\\share\\me\\a', '\\\\SRV\\Share\\me\\b'], false],
    [['C:\\Users\\me\\a', 'D:\\data\\b', 'c:\\Users\\me\\c'], false],
  ])('path.win32: the roots of %j are mixed with a share or device: %s', (reals, mixed) => {
    const { win32MixedRoots } = jest.requireActual('./service-grant');
    expect(win32MixedRoots(reals, true)).toBe(mixed);
  });
});

describe('one path, checked and given (`win32`, path.win32, on any OS)', () => {
  // service-grant.win32.test.js runs the drive-relative case on Windows
  // itself, with distinct current directories on two drives and a child in
  // the real scrubbed environment.
  const DRIVE_RELATIVE =
    "a path is relative to a drive's current directory (`C:name`), which a service may resolve from another";
  const OVERRIDES = [
    'FREEDOM_IDENTITY_DATA',
    'FREEDOM_BEE_DATA',
    'FREEDOM_ANT_DATA',
    'FREEDOM_IPFS_DATA',
    'MYOTIS_DATA_DIR',
    'FREEDOM_TOR_DATA',
    'FREEDOM_RADICLE_DATA',
  ];

  /** A `--profile-dir` profile, no override set, and its grant where
   * freedom-ipfsd's is by default. */
  function profile() {
    for (const name of OVERRIDES) delete process.env[name];
    const userDataDir = path.join(tempRoot, 'Elsewhere');
    fs.mkdirSync(path.join(userDataDir, 'ipfs-data'), { recursive: true });
    const check = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    return { check, grant: path.join(userDataDir, 'ipfs-data', 'freedom-ipfs') };
  }

  test.each([
    ['C:ipfs-data', true],
    ['c:ipfs-data\\freedom-ipfs', true],
    ['C:..\\ipfs-data', true],
    ['Z:.', true],
    ['C:', true],
    ['C:\\ipfs-data', false],
    ['C:/ipfs-data', false],
    ['\\ipfs-data', false],
    ['ipfs-data', false],
    ['\\\\server\\share\\ipfs-data', false],
    ['\\\\?\\C:\\ipfs-data', false],
    ['/home/me/C:ipfs-data', false],
  ])("path.win32: %j is relative to a drive's current directory: %s", (target, relative) => {
    const { win32DriveRelative } = jest.requireActual('./service-grant');
    expect(win32DriveRelative(target)).toBe(relative);
    // Such a path is no absolute one, and path.win32 resolves it from the
    // drive's current directory, a process's own.
    if (relative) expect(path.win32.isAbsolute(target)).toBe(false);
  });

  test.each([
    // The service's own: no root shows it, and the grant main passes is
    // already resolved, so only the override as written can tell.
    ['FREEDOM_IPFS_DATA', 'C:ipfs-data'],
    // A root: freedom-cored is handed the identity directory.
    ['FREEDOM_IDENTITY_DATA', 'C:ipfs-data\\freedom-ipfs'],
    ['MYOTIS_DATA_DIR', 'D:..\\myotis'],
    ['FREEDOM_RADICLE_DATA', 'c:radicle'],
  ])('path.win32: %s=%j is refused as written, before anything is resolved', (name, value) => {
    const { check, grant } = profile();
    expect(check.ipfsGrantRefusal(grant, { win32: true })).toBeNull();
    process.env[name] = value;
    expect(check.ipfsGrantRefusal(grant, { win32: true })).toBe(DRIVE_RELATIVE);
    // Off Windows it is an ordinary relative name, resolved once from main's
    // directory, as every consumer gets it (profile-paths).
    expect(check.ipfsGrantRefusal(grant, { win32: false, foldCase: false })).toBeNull();
  });

  test('path.win32: a drive-relative grant or root is refused before it is resolved', () => {
    const { grantRefusal } = jest.requireActual('./service-grant');
    const identity = { name: "this profile's identity directory", dir: path.join(tempRoot, 'id') };
    const grant = path.join(tempRoot, 'ipfs-data', 'freedom-ipfs');
    expect(grantRefusal([grant], [identity], { win32: true })).toBeNull();
    expect(grantRefusal(['C:ipfs-data\\freedom-ipfs'], [identity], { win32: true })).toBe(
      DRIVE_RELATIVE
    );
    expect(grantRefusal([grant], [{ name: identity.name, dir: 'C:id' }], { win32: true })).toBe(
      DRIVE_RELATIVE
    );
    const { check } = profile();
    expect(check.ipfsGrantRefusal('C:ipfs-data\\freedom-ipfs', { win32: true })).toBe(
      DRIVE_RELATIVE
    );
  });

  test('a grant that is not absolute is refused, on any OS: the service would resolve it again', () => {
    const { check, grant } = profile();
    expect(check.ipfsGrantRefusal(grant, { win32: false })).toBeNull();
    expect(
      check.ipfsGrantRefusal(path.relative(process.cwd(), grant) || '.', { win32: false })
    ).toBe("a grant isn't an absolute path, which a service may resolve from another directory");
  });
});

describe('hard links whose names are all inside the grants', () => {
  const { grantContentRefusal } = jest.requireActual('./service-grant');
  const OUTSIDE = 'the grant holds a hard link to a file with a name outside it';

  test('two names wholly inside the grant pass', () => {
    const grant = path.join(tempRoot, 'grant');
    fs.mkdirSync(path.join(grant, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(grant, 'a'), 'a');
    fs.linkSync(path.join(grant, 'a'), path.join(grant, 'sub', 'b'));
    expect(grantContentRefusal([grant])).toBeNull();
  });

  test('what libgit2 leaves when it is killed between link and unlink passes, so the service restarts', () => {
    // p_rename: link(tmp, final), then unlink(tmp). Killed between them,
    // the object has both names, inside the home.
    const home = path.join(tempRoot, 'radicle-home');
    const objects = path.join(home, 'storage', 'rad', 'objects');
    fs.mkdirSync(path.join(objects, 'ab'), { recursive: true });
    const tmp = path.join(objects, 'tmp_object_git2_a1B2c3');
    fs.writeFileSync(tmp, 'blob');
    fs.linkSync(tmp, path.join(objects, 'ab', 'cdef0123456789'));
    expect(fs.statSync(tmp).nlink).toBe(2);
    expect(grantContentRefusal([home])).toBeNull();
  });

  test('a file with a name outside the grants is refused, however many names are inside', () => {
    const grant = path.join(tempRoot, 'grant');
    fs.mkdirSync(grant, { recursive: true });
    const outside = path.join(tempRoot, 'vault.json');
    fs.writeFileSync(outside, 'secret');
    fs.linkSync(outside, path.join(grant, 'one'));
    fs.linkSync(outside, path.join(grant, 'two'));
    expect(grantContentRefusal([grant])).toBe(OUTSIDE);
  });

  test("names are counted across all of a service's grants, and each directory once", () => {
    const home = path.join(tempRoot, 'home');
    const other = path.join(tempRoot, 'HOME');
    fs.mkdirSync(path.join(home, 'sub'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(home, 'sub', 'object'), 'x');
    fs.linkSync(path.join(home, 'sub', 'object'), path.join(other, 'object'));
    // Both names granted: passes. Either grant alone: the other name is
    // outside it.
    expect(grantContentRefusal([home, other])).toBeNull();
    expect(grantContentRefusal([home])).toBe(OUTSIDE);
    expect(grantContentRefusal([other])).toBe(OUTSIDE);
    // A grant inside another is walked once: its names aren't counted
    // twice, so a name outside isn't hidden.
    expect(grantContentRefusal([home, path.join(home, 'sub')])).toBe(OUTSIDE);
  });

  test('one name in each of three grants passes only counted across them all', () => {
    const grants = ['a', 'b', 'c'].map((name) => path.join(tempRoot, `grant-${name}`));
    for (const grant of grants) fs.mkdirSync(grant, { recursive: true });
    fs.writeFileSync(path.join(grants[0], 'object'), 'x');
    fs.linkSync(path.join(grants[0], 'object'), path.join(grants[1], 'object'));
    fs.linkSync(path.join(grants[0], 'object'), path.join(grants[2], 'object'));
    expect(fs.statSync(path.join(grants[0], 'object')).nlink).toBe(3);
    expect(grantContentRefusal(grants)).toBeNull();
    expect(grantContentRefusal(grants.slice(0, 2))).toBe(OUTSIDE);
  });

  test('two names in one grant and a third in another pass only counted across both', () => {
    const first = path.join(tempRoot, 'first');
    const second = path.join(tempRoot, 'second');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(second, 'one'), 'x');
    fs.linkSync(path.join(second, 'one'), path.join(second, 'two'));
    fs.linkSync(path.join(second, 'one'), path.join(first, 'three'));
    expect(grantContentRefusal([first, second])).toBeNull();
    expect(grantContentRefusal([second])).toBe(OUTSIDE);
  });
});

// freedom-radicled's grants (design 0010, step 7, "Radicle"; design 0008,
// "Spawn and lock"): the Radicle home and the service's own HOME,
// `<userData>/radicled-home`, checked and walked together.
describe('freedom-radicled: the Radicle home with its HOME', () => {
  const { execFileSync, spawnSync } = require('child_process');
  const OUTSIDE = 'the grant holds a hard link to a file with a name outside it';
  const SPECIAL =
    'the grant holds a special file (a FIFO, a socket or a device), a channel outside it';
  const PACKAGED = { packaged: true };
  const DEV = { packaged: false, checkoutHash: 'abcd1234' };

  /** The service's HOME of the profile kept in `dir`. */
  const ownHome = (dir) => path.join(dir, 'radicled-home');

  /** The layouts 0010 names: packaged, with the default profile at the app
   * root, and a development build, with the short homes beside it. */
  function layout(build) {
    if (build === 'packaged') {
      const appRoot = path.join(tempRoot, 'Freedom');
      const records = catalog(appRoot, ['default', 'work', 'home'], PACKAGED);
      const homes = path.join(appRoot, 'R');
      return { appRoot, records, homes, options: PACKAGED };
    }
    const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-abcd1234');
    const records = catalog(appRoot, ['default', 'work', 'home'], DEV);
    const homes = path.join(tempRoot, 'Freedom Dev', 'R', 'abcd1234');
    return { appRoot, records, homes, options: DEV };
  }

  /** A Radicle home as the service leaves it, with its HOME made. */
  function populate(home, own) {
    fs.mkdirSync(path.join(home, 'storage', 'rad', 'objects', 'ab'), { recursive: true });
    fs.mkdirSync(path.join(home, 'node'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '{}');
    fs.writeFileSync(path.join(home, 'node', 'node.db'), 'db');
    fs.writeFileSync(path.join(home, 'node', 'node.db-wal'), 'wal');
    fs.writeFileSync(path.join(home, 'storage', 'rad', 'objects', 'ab', 'cdef'), 'object');
    fs.mkdirSync(own, { recursive: true });
  }

  describe.each([
    ['packaged', 'work', 'a named profile'],
    ['packaged', 'default', 'the default profile, at the app root'],
    ['development', 'work', 'a named profile'],
    ['development', 'default', 'the default profile'],
  ])('%s build, %s in use (%s)', (build, id) => {
    let appRoot;
    let records;
    let homes;
    let grant;
    let me;

    beforeEach(() => {
      let options;
      ({ appRoot, records, homes, options } = layout(build));
      me = records[id];
      grant = loadGrant(activeProfile(appRoot, me, options));
    });

    test('<appRoot>/R/<slot> and <userData>/radicle-data pass, with the service HOME, before and once made', () => {
      const shortHome = path.join(homes, String(me.slot));
      const legacy = path.join(me.dir, 'radicle-data');
      expect(grant.radicleGrantRefusal(shortHome, ownHome(me.dir))).toBeNull();
      expect(grant.radicleGrantRefusal(legacy, ownHome(me.dir))).toBeNull();
      populate(shortHome, ownHome(me.dir));
      populate(legacy, ownHome(me.dir));
      expect(grant.radicleGrantRefusal(shortHome, ownHome(me.dir))).toBeNull();
      expect(grant.radicleGrantRefusal(legacy, ownHome(me.dir))).toBeNull();
      // freedom-ipfsd's own directory still passes beside them.
      expect(grant.ipfsGrantRefusal(path.join(me.dir, 'ipfs-data', 'freedom-ipfs'))).toBeNull();
    });

    test("another profile's Radicle home, short or in its directory, and its HOME are refused", () => {
      const other = records[id === 'work' ? 'home' : 'work'];
      const own = ownHome(me.dir);
      expect(grant.radicleGrantRefusal(path.join(homes, String(other.slot)), own)).toBe(
        "the grant is another profile's Radicle home"
      );
      expect(grant.radicleGrantRefusal(path.join(homes, String(other.slot), 'x'), own)).toBe(
        "the grant lies inside another profile's Radicle home"
      );
      expect(grant.radicleGrantRefusal(path.join(other.dir, 'radicle-data'), own)).toBe(
        "the grant lies inside another profile's directory"
      );
      expect(grant.radicleGrantRefusal(ownHome(other.dir), own)).toBe(
        "the grant lies inside another profile's directory"
      );
      // The directory of the short homes holds every profile's.
      expect(grant.radicleGrantRefusal(homes, own)).toMatch(/^the grant contains /);
    });

    test('the app root, this profile directory, its other components and the lock directory are refused', () => {
      const own = ownHome(me.dir);
      expect(grant.radicleGrantRefusal(appRoot, own)).toMatch(/^the grant contains /);
      expect(grant.radicleGrantRefusal(me.dir, own)).toMatch(/^the grant contains /);
      expect(grant.radicleGrantRefusal(path.join(me.dir, 'identity'), own)).toBe(
        "the grant is this profile's identity directory"
      );
      expect(grant.radicleGrantRefusal(path.join(me.dir, 'ipfs-data'), own)).toBe(
        "the grant is this profile's IPFS data directory"
      );
      expect(grant.radicleGrantRefusal(path.join(me.dir, 'IndexedDB', 'x'), own)).toBe(
        "the grant lies inside this profile's browser storage"
      );
      const locks = path.join(tempRoot, 'AppData', 'Freedom', 'locks');
      expect(grant.radicleGrantRefusal(path.join(locks, 'radicle'), own)).toBe(
        'the grant lies inside the lock directory'
      );
      // The HOME is checked as a grant of its own.
      const home = path.join(homes, String(me.slot));
      expect(grant.radicleGrantRefusal(home, path.join(me.dir, 'identity'))).toBe(
        "the grant is this profile's identity directory"
      );
    });

    // The import's working copy (design 0010, D5; plan B14): read only,
    // beside the two grants, and checked against the same roots and them.
    test("the import's working copy: one outside every root passes; one in a protected root, the home or the HOME is refused", () => {
      const home = path.join(homes, String(me.slot));
      const grants = { home, ownHome: ownHome(me.dir) };
      populate(home, grants.ownHome);
      const clone = path.join(tempRoot, 'tmp', 'freedom-github-bridge-x', 'repo');
      fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
      expect(grant.radicleSourceRefusal(clone, grants)).toBeNull();
      // Where the add-on's import clones today: inside this profile's
      // directory, which the working copy, cloned, exists in.
      const inProfile = path.join(me.dir, 'tmp', 'github-bridge-x', 'repo');
      fs.mkdirSync(path.join(inProfile, '.git'), { recursive: true });
      expect(grant.radicleSourceRefusal(inProfile, grants)).toBe(
        "the working copy lies inside this profile's data"
      );
      expect(grant.radicleSourceRefusal(path.join(home, 'storage'), grants)).toBe(
        "the working copy lies inside this profile's Radicle home"
      );
      expect(grant.radicleSourceRefusal(grants.ownHome, grants)).toBe(
        'the working copy is the Radicle service home'
      );
      const other = records[id === 'work' ? 'home' : 'work'];
      expect(grant.radicleSourceRefusal(path.join(other.dir, 'repo'), grants)).toBe(
        "the working copy lies inside another profile's directory"
      );
      // A repository holding Freedom's data, as one at the user's home would.
      expect(grant.radicleSourceRefusal(tempRoot, grants)).toMatch(/^the working copy contains /);
      expect(grant.radicleSourceRefusal('repo', grants)).toMatch(/isn't an absolute path/);
    });

    test("the import's protected roots: resolved, without this profile's Radicle home and HOME, which the process adds", () => {
      const roots = grant.radicleImportRoots();
      const real = (p) => path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
      expect(roots).toEqual([...new Set(roots)]);
      expect(roots).toContain(path.join(tempRoot, 'AppData', 'Freedom', 'locks'));
      expect(roots).toContain(real(path.join(me.dir, 'identity')));
      const other = records[id === 'work' ? 'home' : 'work'];
      expect(roots).toContain(path.join(homes, String(other.slot)));
      expect(roots).not.toContain(path.join(homes, String(me.slot)));
      expect(roots).not.toContain(ownHome(me.dir));
      expect(roots).not.toContain(path.join(me.dir, 'radicle-data'));
      for (const root of roots) expect(path.isAbsolute(root)).toBe(true);
    });
  });

  describe('a packaged build, a named profile in use', () => {
    let appRoot;
    let records;
    let grant;
    let home;
    let own;

    beforeEach(() => {
      ({ appRoot, records } = layout('packaged'));
      grant = loadGrant(activeProfile(appRoot, records.work, PACKAGED));
      home = path.join(appRoot, 'R', String(records.work.slot));
      own = ownHome(records.work.dir);
    });

    test("the default profile's Radicle data and its HOME are refused, present or not yet made", () => {
      expect(grant.radicleGrantRefusal(path.join(appRoot, 'radicle-data'), own)).toBe(
        "the grant is another profile's Radicle data directory"
      );
      expect(grant.radicleGrantRefusal(path.join(appRoot, 'radicled-home'), own)).toBe(
        "the grant is another profile's Radicle service home"
      );
      fs.mkdirSync(path.join(appRoot, 'radicled-home'));
      expect(grant.radicleGrantRefusal(path.join(appRoot, 'radicled-home', 'x'), own)).toBe(
        "the grant lies inside another profile's Radicle service home"
      );
      expect(grant.radicleGrantRefusal(path.join(appRoot, 'Local Storage'), own)).toBe(
        "the grant is another profile's browser storage"
      );
    });

    test("freedom-ipfsd's roots are what they were: either HOME, once made, is a profile's data to it", () => {
      fs.mkdirSync(own);
      fs.mkdirSync(path.join(appRoot, 'radicled-home'));
      expect(grant.ipfsGrantRefusal(own)).toBe("the grant is this profile's data");
      expect(grant.ipfsGrantRefusal(path.join(appRoot, 'radicled-home'))).toBe(
        "the grant is another profile's data"
      );
      // Nothing of the service's HOME is named among freedom-ipfsd's roots,
      // and nothing of this profile's is exempted from them.
      const ipfsRoots = grant.protectedRoots({ own: ['ipfs'] });
      expect(ipfsRoots.some((root) => /Radicle service home/.test(root.name))).toBe(false);
      expect(ipfsRoots).toContainEqual({ name: "this profile's data", dir: own });
      expect(grant.protectedRoots({ own: ['radicle', 'radicledHome'] })).not.toContainEqual(
        expect.objectContaining({ dir: own })
      );
    });

    test('FREEDOM_RADICLE_DATA inside or containing a protected root is refused, through a symlink and a case alias', () => {
      const identity = path.join(records.work.dir, 'identity');
      fs.mkdirSync(identity, { recursive: true });
      const check = (override, options) => {
        process.env.FREEDOM_RADICLE_DATA = override;
        return loadGrant(activeProfile(appRoot, records.work, PACKAGED)).radicleGrantRefusal(
          path.resolve(override),
          own,
          options
        );
      };
      expect(check(path.join(identity, 'radicle'))).toBe(
        "the grant lies inside this profile's identity directory"
      );
      expect(check(records.work.dir)).toMatch(/^the grant contains this profile's/);
      expect(check(path.join(tempRoot, 'AppData'))).toBe('the grant contains the lock directory');
      expect(check(path.join(appRoot, 'R', String(records.home.slot), 'radicle'))).toBe(
        "the grant lies inside another profile's Radicle home"
      );
      expect(check(path.join(appRoot, 'IndexedDB'))).toBe(
        "the grant is another profile's browser storage"
      );
      fs.symlinkSync(identity, path.join(tempRoot, 'innocent'));
      expect(check(path.join(tempRoot, 'innocent', 'radicle'))).toBe(
        "the grant lies inside this profile's identity directory"
      );
      fs.symlinkSync(path.join(appRoot, 'R'), path.join(tempRoot, 'homes'));
      expect(check(path.join(tempRoot, 'homes', String(records.home.slot)))).toBe(
        "the grant is another profile's Radicle home"
      );
      // On a case-insensitive volume (folded, as on macOS and Windows).
      expect(check(path.join(records.work.dir, 'IDENTITY', 'radicle'), { foldCase: true })).toBe(
        "the grant lies inside this profile's identity directory"
      );
      // An override elsewhere passes: it is the profile's Radicle home.
      expect(check(path.join(tempRoot, 'elsewhere', 'radicle'))).toBeNull();
    });

    test('a home or a HOME that is a symlink into a protected root is refused', () => {
      fs.mkdirSync(path.join(appRoot, 'R'), { recursive: true });
      fs.symlinkSync(path.join(appRoot, 'identity'), home);
      expect(grant.radicleGrantRefusal(home, own)).toBe(
        "the grant is another profile's identity directory"
      );
      fs.unlinkSync(home);
      fs.mkdirSync(path.join(records.home.dir, 'identity'), { recursive: true });
      fs.symlinkSync(path.join(records.home.dir, 'identity'), own);
      expect(grant.radicleGrantRefusal(home, own)).toBe(
        "the grant lies inside another profile's directory"
      );
      // This profile's own default directories exempt nothing through a
      // link: one into another profile is refused even with the grants
      // elsewhere.
      fs.unlinkSync(own);
      fs.symlinkSync(records.home.dir, path.join(records.work.dir, 'radicle-data'));
      expect(grant.radicleGrantRefusal(home, own)).toBe(
        "the service's own default directory resolves into a protected root (is another profile's directory)"
      );
    });
  });

  test('a --profile-dir or test profile: <userData>/radicle-data passes with its HOME', () => {
    for (const source of ['profile-dir', 'test-user-data']) {
      const userDataDir = path.join(tempRoot, source);
      fs.mkdirSync(path.join(userDataDir, 'Local Storage'), { recursive: true });
      const grant = loadGrant({ source, appRoot: userDataDir, userDataDir });
      const home = path.join(userDataDir, 'radicle-data');
      populate(home, ownHome(userDataDir));
      expect(grant.radicleGrantRefusal(home, ownHome(userDataDir))).toBeNull();
      expect(grant.radicleGrantRefusal(path.join(userDataDir, 'Local Storage'), home)).toBe(
        "the grant is this profile's browser storage"
      );
    }
  });

  describe('what the grants hold', () => {
    let userDataDir;
    let home;
    let own;
    let grant;

    beforeEach(() => {
      userDataDir = path.join(tempRoot, 'Elsewhere');
      home = path.join(userDataDir, 'radicle-data');
      own = ownHome(userDataDir);
      populate(home, own);
      fs.mkdirSync(path.join(userDataDir, 'identity'));
      fs.writeFileSync(path.join(userDataDir, 'identity', 'vault.json'), '{"vault":true}');
      grant = loadGrant({ source: 'profile-dir', appRoot: userDataDir, userDataDir });
    });

    test('a hard link out of either grant is refused; one name in each passes', () => {
      const vault = path.join(userDataDir, 'identity', 'vault.json');
      fs.linkSync(vault, path.join(home, 'storage', 'vault'));
      expect(grant.radicleGrantRefusal(home, own)).toBe(OUTSIDE);
      fs.unlinkSync(path.join(home, 'storage', 'vault'));
      fs.linkSync(vault, path.join(own, '.gitconfig'));
      expect(grant.radicleGrantRefusal(home, own)).toBe(OUTSIDE);
      fs.unlinkSync(path.join(own, '.gitconfig'));
      // Names counted across both grants.
      fs.linkSync(path.join(home, 'config.json'), path.join(own, 'config.json'));
      expect(grant.radicleGrantRefusal(home, own)).toBeNull();
    });

    test('what libgit2 leaves when it is killed between link and unlink passes', () => {
      const objects = path.join(home, 'storage', 'rad', 'objects');
      const tmp = path.join(objects, 'tmp_object_git2_a1B2c3');
      fs.writeFileSync(tmp, 'blob');
      fs.linkSync(tmp, path.join(objects, 'ab', '0123456789'));
      expect(grant.radicleGrantRefusal(home, own)).toBeNull();
    });

    test("a FIFO in the HOME, or a socket at the node's control socket, is refused", async () => {
      execFileSync('mkfifo', [path.join(own, 'channel')]);
      expect(grant.radicleGrantRefusal(home, own)).toBe(SPECIAL);
      fs.unlinkSync(path.join(own, 'channel'));
      expect(grant.radicleGrantRefusal(home, own)).toBeNull();
      // The add-on's node listens at `node/control.sock`; the service's
      // doesn't. A socket file there, live or left by a crash, is refused.
      const server = require('net').createServer();
      await new Promise((resolve) =>
        server.listen(path.join(home, 'node', 'control.sock'), resolve)
      );
      try {
        expect(grant.radicleGrantRefusal(home, own)).toBe(SPECIAL);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    // git's local clone (`git clone <path>`, and libgit2's `git_clone` of a
    // local path) hard-links the source's objects on one filesystem: the
    // walk refuses a home with one, in either direction.
    const hasGit = spawnSync('git', ['--version']).status === 0;
    const gitTest = hasGit ? test : test.skip;
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'init.defaultBranch=main',
          ...args,
        ],
        {
          env: { ...process.env, HOME: tempRoot, GIT_CONFIG_NOSYSTEM: '1' },
          stdio: 'ignore',
        }
      );
    function repository(dir) {
      git('init', '-q', dir);
      fs.writeFileSync(path.join(dir, 'README'), 'readme');
      git('-C', dir, 'add', 'README');
      git('-C', dir, 'commit', '-q', '-m', 'first');
    }

    gitTest("git's local clone into the home is refused; one with --no-hardlinks passes", () => {
      const source = path.join(tempRoot, 'working-copy');
      repository(source);
      const clone = path.join(home, 'storage', 'clone');
      git('clone', '-q', '--bare', source, clone);
      expect(grant.radicleGrantRefusal(home, own)).toBe(OUTSIDE);
      fs.rmSync(clone, { recursive: true });
      git('clone', '-q', '--bare', '--no-hardlinks', source, clone);
      expect(grant.radicleGrantRefusal(home, own)).toBeNull();
    });

    gitTest("git's local clone out of the home's storage is refused too", () => {
      const stored = path.join(home, 'storage', 'repo');
      repository(stored);
      expect(grant.radicleGrantRefusal(home, own)).toBeNull();
      git('clone', '-q', stored, path.join(tempRoot, 'checkout'));
      expect(grant.radicleGrantRefusal(home, own)).toBe(OUTSIDE);
    });
  });
});
