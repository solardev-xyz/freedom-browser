const fs = require('fs');
const os = require('os');
const path = require('path');

let mockUserData = null;
jest.mock('electron', () => ({
  app: {
    getPath: (name) => {
      if (name === 'userData') return mockUserData;
      if (name === 'appData') return require('path').dirname(mockUserData);
      throw new Error(`unexpected getPath(${name})`);
    },
    isPackaged: false,
  },
  ipcMain: { handle: jest.fn(), on: jest.fn() },
}));

const {
  MOVED_ENTRIES,
  getFreedomDataDir,
  getFreedomDataPath,
  profileLayout,
  resolveFreedomRoot,
} = require('./freedom-root');

function profileDir(t) {
  return fs.mkdtempSync(path.join(t, 'profile-'));
}

function markMoved(dir) {
  fs.mkdirSync(path.join(dir, 'freedom'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'freedom', 'layout.json'),
    JSON.stringify({ version: 1, moved_at: '2026-11-13T00:00:00.000Z', by: 'test' })
  );
}

describe("a profile's Freedom root (0013, the reader release)", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-root-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the root layout: the profile directory itself', () => {
    const dir = profileDir(tmp);
    expect(resolveFreedomRoot(dir)).toBe(dir);
    expect(profileLayout(dir)).toBe('root');
    // `freedom/` alone, without the marker, isn't the moved layout.
    fs.mkdirSync(path.join(dir, 'freedom'));
    expect(resolveFreedomRoot(dir)).toBe(dir);
    expect(profileLayout(dir)).toBe('root');
  });

  test('the moved layout: freedom/ once its marker is there', () => {
    const dir = profileDir(tmp);
    markMoved(dir);
    expect(resolveFreedomRoot(dir)).toBe(path.join(dir, 'freedom'));
    expect(profileLayout(dir)).toBe('freedom');
  });

  test("a move's journal is pending, before its marker and after", () => {
    const before = profileDir(tmp);
    fs.mkdirSync(path.join(before, 'freedom'));
    fs.writeFileSync(path.join(before, 'freedom', '.move.json'), '{"version":1,"entries":[]}');
    expect(profileLayout(before)).toBe('pending');
    expect(resolveFreedomRoot(before)).toBe(before);

    const after = profileDir(tmp);
    markMoved(after);
    fs.writeFileSync(path.join(after, 'freedom', '.move.json'), '{"version":1,"entries":[]}');
    expect(profileLayout(after)).toBe('pending');
  });

  test("this process's root is resolved once per profile", () => {
    const dir = profileDir(tmp);
    mockUserData = dir;
    expect(getFreedomDataDir()).toBe(dir);
    // The layout can't change while main holds the profile: not read again.
    markMoved(dir);
    expect(getFreedomDataDir()).toBe(dir);
    // Another profile directory (tests only) is resolved afresh.
    const moved = profileDir(tmp);
    markMoved(moved);
    mockUserData = moved;
    expect(getFreedomDataDir()).toBe(path.join(moved, 'freedom'));
    expect(getFreedomDataPath('settings.json')).toBe(path.join(moved, 'freedom', 'settings.json'));
  });

  test("main's path getters resolve the Freedom root; the shell's entries stay at the root", () => {
    jest.isolateModules(() => {
      const dir = profileDir(tmp);
      markMoved(dir);
      mockUserData = dir;
      const paths = require('./profile-paths');
      const freedom = path.join(dir, 'freedom');
      expect(paths.getIdentityDataDir()).toBe(path.join(freedom, 'identity'));
      expect(paths.getAntDataDir()).toBe(path.join(freedom, 'ant-data'));
      expect(paths.getBeeDataDir()).toBe(path.join(freedom, 'bee-data'));
      expect(paths.getIpfsDataDir()).toBe(path.join(freedom, 'ipfs-data'));
      expect(paths.getTorDataDir()).toBe(path.join(freedom, 'tor-data'));
      expect(paths.getMyotisDataDir()).toBe(path.join(freedom, 'myotis'));
      expect(paths.getQuickUnlockCredentialPath()).toBe(
        path.join(freedom, 'identity', 'quick-unlock.dat')
      );
      // The shell's and the agent's entries, and crash reports, stay put.
      expect(paths.getProfileCrashDir()).toBe(path.join(dir, 'crash-reports'));
      expect(paths.getAgentDataDir()).toBe(path.join(dir, 'agent'));
      expect(paths.getRadicledHomeDir()).toBe(path.join(dir, 'radicled-home'));

      const dirs = paths.getComponentDataDirs();
      expect(dirs.identity).toBe(path.join(freedom, 'identity'));
      expect(dirs.ipfs).toBe(path.join(freedom, 'ipfs-data'));
      // A non-catalog radicle-data/ isn't moved (its socket path's limit).
      expect(dirs.radicle).toBe(path.join(dir, 'radicle-data'));

      // Another profile's, each resolved by its own layout.
      const other = profileDir(tmp);
      const otherDirs = paths.getComponentDataDirs(other);
      expect(otherDirs.identity).toBe(path.join(other, 'identity'));
      expect(otherDirs.tor).toBe(path.join(other, 'tor-data'));
    });
  });

  // Every store of a moved entry goes through the resolver: no module joins
  // userData with one of MOVED_ENTRIES' names itself.
  test("no main module builds a moved entry's path from userData", () => {
    const root = path.join(__dirname);
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
        const text = fs.readFileSync(full, 'utf8');
        const joins = text.match(/path\.join\(\s*app\.getPath\('userData'\),\s*[^)]*\)/g) || [];
        for (const join of joins) {
          if (MOVED_ENTRIES.some((name) => join.includes(`'${name}'`))) offenders.push(`${full}: ${join}`);
          const constant = join.match(/,\s*([A-Z_]+)\s*\)$/)?.[1];
          if (constant) {
            const value = text.match(new RegExp(`const ${constant} = '([^']+)'`))?.[1];
            if (value && MOVED_ENTRIES.includes(value)) offenders.push(`${full}: ${join}`);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
