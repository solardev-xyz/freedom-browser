/**
 * Main's check before it spawns a confined service (freedom-core design
 * 0010, step 7): a grant may not be, contain, or lie inside a protected
 * root, compared as canonical paths. Real directories in a temp root, with
 * the profile modules mocked to point into it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let tempRoot;

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-service-grant-')));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  jest.resetModules();
});

const COMPONENTS = {
  identity: 'identity',
  bee: 'bee-data',
  ant: 'ant-data',
  ipfs: 'ipfs-data',
  myotis: 'myotis',
  tor: 'tor-data',
  radicle: 'radicle-data',
};

/** A profile's component directories under `root`, as profile-paths lays
 * them out, with `overrides` for this profile's. */
function componentDirs(root, overrides = {}, radicleHomes = null) {
  const dirs = {};
  for (const [component, name] of Object.entries(COMPONENTS)) {
    dirs[component] = overrides[component] ?? path.join(root, name);
  }
  dirs.radicleHomes = radicleHomes;
  return dirs;
}

/**
 * service-grant with its profile modules mocked: the active profile at
 * `userDataDir` in `appRoot` (a catalog profile unless `source` says
 * otherwise), the catalog listing `profiles`, and this profile's component
 * `overrides`.
 */
function loadGrant({ appRoot, userDataDir, profiles = [], overrides = {}, source = 'catalog' }) {
  jest.doMock('./profile-resolver', () => ({
    getActiveProfile: () => ({ source, appRoot, userDataDir }),
  }));
  jest.doMock('./profile-paths', () => ({
    getComponentDataDirs: (dir = null) =>
      dir ? componentDirs(dir) : componentDirs(userDataDir, overrides, path.join(appRoot, 'R')),
  }));
  jest.doMock('./profile-catalog', () => ({
    listProfileUserDataDirs: () => [userDataDir, ...profiles],
  }));
  jest.doMock('./service-locks', () => ({ getLockDir: () => path.join(appRoot, '..', 'locks') }));
  return require('./service-grant');
}

describe('canonical paths', () => {
  test('resolves symlinks through the longest existing prefix, and keeps the rest', () => {
    const { canonical } = require('./service-grant');
    const real = path.join(tempRoot, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tempRoot, 'alias'));
    expect(canonical(path.join(tempRoot, 'alias', 'not', 'yet'), { foldCase: false })).toBe(
      path.join(real, 'not', 'yet')
    );
    expect(canonical(path.join(tempRoot, 'alias', '..', 'real'), { foldCase: false })).toBe(real);
  });

  test('folds case when asked, as on macOS and Windows', () => {
    const { canonical } = require('./service-grant');
    expect(canonical(path.join(tempRoot, 'Bee-Data'), { foldCase: true })).toBe(
      path.join(tempRoot, 'bee-data').toLowerCase()
    );
    expect(canonical(path.join(tempRoot, 'Bee-Data'), { foldCase: false })).toBe(
      path.join(tempRoot, 'Bee-Data')
    );
  });
});

describe('the rule', () => {
  test('a grant that is, contains, or lies inside a root is refused, naming the root, never a path', () => {
    const { grantRefusal } = require('./service-grant');
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
    expect(grantRefusal([path.join(tempRoot, 'ipfs')], roots)).toBeNull();
    // A root with no directory protects nothing.
    expect(grantRefusal([tempRoot], [{ name: 'none', dir: null }])).toBeNull();
  });

  test('a symlink alias or a case alias cannot widen a grant over a root', () => {
    const { grantRefusal } = require('./service-grant');
    const root = path.join(tempRoot, 'identity');
    fs.mkdirSync(root);
    fs.symlinkSync(root, path.join(tempRoot, 'innocent'));
    const roots = [{ name: 'the identity directory', dir: root }];
    expect(grantRefusal([path.join(tempRoot, 'innocent', 'x')], roots)).toBe(
      'the grant lies inside the identity directory'
    );
    expect(grantRefusal([path.join(tempRoot, 'IDENTITY')], roots, { foldCase: true })).toBe(
      'the grant is the identity directory'
    );
  });

  test('each grant of a list is checked', () => {
    const { grantRefusal } = require('./service-grant');
    const roots = [{ name: 'the lock directory', dir: path.join(tempRoot, 'locks') }];
    expect(
      grantRefusal([path.join(tempRoot, 'ipfs'), path.join(tempRoot, 'locks', 'x')], roots)
    ).toMatch(/lock directory/);
  });
});

describe("freedom-ipfsd's grant", () => {
  function layout() {
    const appRoot = path.join(tempRoot, 'Freedom');
    const userDataDir = path.join(appRoot, 'Profiles', 'work');
    const other = path.join(appRoot, 'Profiles', 'home');
    return {
      appRoot,
      userDataDir,
      other,
      dataDir: path.join(userDataDir, 'ipfs-data', 'freedom-ipfs'),
    };
  }

  test("this profile's own IPFS data directory is the grant, and passes", () => {
    const { appRoot, userDataDir, other, dataDir } = layout();
    const { ipfsGrantRefusal } = loadGrant({ appRoot, userDataDir, profiles: [other] });
    expect(ipfsGrantRefusal(dataDir)).toBeNull();
  });

  test.each([
    ['identity', "this profile's identity directory"],
    ['bee', "this profile's Bee data directory"],
    ['tor', "this profile's Tor data directory"],
    ['radicle', "this profile's Radicle data directory"],
  ])('an override that puts IPFS data in the %s directory is refused', (component, name) => {
    const { appRoot, userDataDir } = layout();
    const { ipfsGrantRefusal } = loadGrant({ appRoot, userDataDir });
    const inside = path.join(userDataDir, COMPONENTS[component], 'freedom-ipfs');
    expect(ipfsGrantRefusal(inside)).toBe(`the grant lies inside ${name}`);
  });

  test("a grant over this profile's whole userData directory, the lock directory, or the Radicle homes is refused", () => {
    const { appRoot, userDataDir } = layout();
    const { ipfsGrantRefusal } = loadGrant({ appRoot, userDataDir });
    expect(ipfsGrantRefusal(userDataDir)).toMatch(/^the grant contains this profile's/);
    expect(ipfsGrantRefusal(path.join(appRoot, '..', 'locks', 'x'))).toBe(
      'the grant lies inside the lock directory'
    );
    expect(ipfsGrantRefusal(path.join(appRoot, 'R', '1'))).toBe(
      "the grant lies inside this profile's Radicle homes directory"
    );
  });

  test("another profile's whole userData directory is protected", () => {
    const { appRoot, userDataDir, other } = layout();
    const { ipfsGrantRefusal } = loadGrant({ appRoot, userDataDir, profiles: [other] });
    // Not only its components: any directory of it.
    expect(ipfsGrantRefusal(path.join(other, 'downloads', 'ipfs'))).toBe(
      "the grant lies inside another profile's directory"
    );
    expect(ipfsGrantRefusal(path.join(appRoot, 'Profiles'))).toMatch(/contains/);
  });

  test("the default profile, whose root holds this one's, has its components protected instead", () => {
    const { appRoot, userDataDir, dataDir } = layout();
    const { ipfsGrantRefusal } = loadGrant({ appRoot, userDataDir, profiles: [appRoot] });
    // Its whole root would hold every grant: this profile's own passes.
    expect(ipfsGrantRefusal(dataDir)).toBeNull();
    expect(ipfsGrantRefusal(path.join(appRoot, 'identity', 'x'))).toBe(
      "the grant lies inside another profile's identity directory"
    );
    expect(ipfsGrantRefusal(path.join(appRoot, 'ipfs-data'))).toBe(
      "the grant is another profile's IPFS data directory"
    );
  });

  test('a profile outside the catalog has its own components and the lock directory protected', () => {
    const { appRoot, userDataDir, other, dataDir } = layout();
    const { ipfsGrantRefusal } = loadGrant({
      appRoot,
      userDataDir,
      profiles: [other],
      source: 'legacy',
    });
    expect(ipfsGrantRefusal(dataDir)).toBeNull();
    expect(ipfsGrantRefusal(path.join(userDataDir, 'identity'))).toMatch(/identity/);
    expect(ipfsGrantRefusal(path.join(other, 'x'))).toBeNull();
  });
});
