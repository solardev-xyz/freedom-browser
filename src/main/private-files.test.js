const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const {
  ensurePrivateDir,
  openPrivateDir,
  withPrivateDir,
  repairPrivateDir,
  readPrivateFile,
  repairPrivateFile,
  writePrivateFileSync,
  UnsafePrivatePathError,
  _setFdBindingForTests,
  _setDirOpsByPathForTests,
} = require('./private-files');

const posix = process.platform === 'win32' ? describe.skip : describe;
const modeOf = (target) => fs.statSync(target).mode & 0o777;

posix('private files (K-3)', () => {
  let root;
  let outside;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-files-'));
    // Something a planted link could point at.
    outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'not yours');
    fs.chmodSync(outside, 0o644);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const outsideUntouched = () => {
    expect(fs.readFileSync(outside, 'utf8')).toBe('not yours');
    expect(modeOf(outside)).toBe(0o644);
  };

  test('creates directories owner-only, parents included', () => {
    const dir = path.join(root, 'a', 'b');
    expect(ensurePrivateDir(dir)).toBe(dir);
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(path.join(root, 'a'))).toBe(0o700);
  });

  test('narrows an existing directory an older build made 0755', () => {
    const dir = path.join(root, 'ant-data');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  test('refuses a directory name that is a link, and leaves its target alone', () => {
    const target = path.join(root, 'elsewhere');
    fs.mkdirSync(target);
    fs.chmodSync(target, 0o755);
    const link = path.join(root, 'keys');
    fs.symlinkSync(target, link);
    expect(() => ensurePrivateDir(link)).toThrow(UnsafePrivatePathError);
    expect(repairPrivateDir(link)).toBe(false);
    expect(modeOf(target)).toBe(0o755);
  });

  test('writes files owner-only through a fresh temp file', () => {
    const file = path.join(root, 'config.yaml');
    writePrivateFileSync(file, 'password: one\n');
    expect(modeOf(file)).toBe(0o600);

    fs.chmodSync(file, 0o644);
    writePrivateFileSync(file, 'password: two\n');
    expect(modeOf(file)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('password: two\n');
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a write over a link replaces the link, never its target', () => {
    const link = path.join(root, 'swarm.key');
    fs.symlinkSync(outside, link);
    writePrivateFileSync(link, 'secret');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe('secret');
    expect(modeOf(link)).toBe(0o600);
    outsideUntouched();
  });

  test('reads and repairs never follow a link', () => {
    const link = path.join(root, 'radicle');
    fs.symlinkSync(outside, link);
    expect(() => readPrivateFile(link)).toThrow(UnsafePrivatePathError);
    expect(repairPrivateFile(link)).toBe(false);
    outsideUntouched();
  });

  test('reads repair the mode first, through the same descriptor', () => {
    const file = path.join(root, 'rpc-api-keys.json');
    fs.writeFileSync(file, '{"a":1}');
    fs.chmodSync(file, 0o644);
    expect(readPrivateFile(file).toString()).toBe('{"a":1}');
    expect(modeOf(file)).toBe(0o600);
    expect(readPrivateFile(path.join(root, 'missing'))).toBeNull();
  });

  test('repairs leave owner-only, missing and non-file paths alone', () => {
    const file = path.join(root, 'key');
    fs.writeFileSync(file, 'x', { mode: 0o400 });
    expect(repairPrivateFile(file)).toBe(true);
    expect(modeOf(file)).toBe(0o400);
    expect(repairPrivateFile(path.join(root, 'missing'))).toBe(false);
    const dir = path.join(root, 'a-directory');
    fs.mkdirSync(dir);
    expect(repairPrivateFile(dir)).toBe(false);
    expect(() => readPrivateFile(dir)).toThrow('not a regular file');
  });
});

// How a handle binds its opens, per platform (private-files.js):
//  - Linux: /proc/self/fd/<fd>/<name> resolves in the held directory;
//  - Linux without /proc: every entry is refused rather than opened by path;
//  - macOS: O_NOFOLLOW_ANY refuses a link anywhere in the path.
// Windows has the before-and-after check alone (#963), so the directory-swap
// tests do not run there.
const SWAP_MODES = {
  linux: [
    ['Linux, bound through /proc', 'bound'],
    ['Linux without /proc: refused', 'refused'],
  ],
  darwin: [['macOS, O_NOFOLLOW_ANY', 'nofollow-any']],
}[process.platform];
const eachSwapMode = SWAP_MODES
  ? describe.each(SWAP_MODES)
  : describe.skip.each([['no binding on this platform', 'none']]);

posix('managed directory handles (K-3)', () => {
  let root;
  let data;
  let outsideDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-dir-'));
    data = path.join(root, 'ant-data');
    fs.mkdirSync(path.join(data, 'keys'), { recursive: true, mode: 0o700 });
    // What a planted directory link could point at.
    outsideDir = path.join(root, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'swarm.key'), 'not yours');
    fs.chmodSync(path.join(outsideDir, 'swarm.key'), 0o644);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    _setFdBindingForTests(true);
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const outsideUntouched = () => {
    expect(fs.readdirSync(outsideDir)).toEqual(['swarm.key']);
    expect(fs.readFileSync(path.join(outsideDir, 'swarm.key'), 'utf8')).toBe('not yours');
    expect(modeOf(path.join(outsideDir, 'swarm.key'))).toBe(0o644);
  };
  // keys/ moved aside (the handle still holds it) and a link to outside
  // put in its place.
  const swapKeysForLink = () => {
    fs.renameSync(path.join(data, 'keys'), path.join(data, 'keys.held'));
    fs.symlinkSync(outsideDir, path.join(data, 'keys'));
  };
  const keysIsLink = () => fs.lstatSync(path.join(data, 'keys')).isSymbolicLink();

  test('binds to the descriptor on Linux', () => {
    withPrivateDir(data, (dir) => {
      expect(dir.bound).toBe(process.platform === 'linux');
      expect(dir.openDir('keys').bound).toBe(process.platform === 'linux');
    });
  });

  test('opening narrows the data directory and keys/ an older build made 0755', () => {
    fs.chmodSync(data, 0o755);
    fs.chmodSync(path.join(data, 'keys'), 0o755);
    withPrivateDir(data, (dir) => dir.openDir('keys', { create: false }));
    expect(modeOf(data)).toBe(0o700);
    expect(modeOf(path.join(data, 'keys'))).toBe(0o700);
  });

  test('a managed directory that is a link is refused, and nothing is opened through it', () => {
    fs.rmSync(path.join(data, 'keys'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(data, 'keys'));
    withPrivateDir(data, (dir) => {
      expect(() => dir.openDir('keys', { create: false })).toThrow('symbolic link');
      expect(() => dir.openDir('keys')).toThrow('symbolic link');
    });
    expect(() => openPrivateDir(path.join(data, 'keys'))).toThrow(UnsafePrivatePathError);
    outsideUntouched();
  });

  test('a missing directory is null without create, and made 0700 with it', () => {
    withPrivateDir(data, (dir) => {
      expect(dir.openDir('radicle', { create: false })).toBeNull();
      expect(modeOf(dir.openDir('radicle').path)).toBe(0o700);
    });
    expect(openPrivateDir(path.join(root, 'missing'), { create: false })).toBeNull();
  });

  test('reads, writes, repairs and removes go through the handle', () => {
    withPrivateDir(data, (dir) => {
      const keys = dir.openDir('keys');
      keys.write('swarm.key', 'secret');
      expect(modeOf(path.join(data, 'keys', 'swarm.key'))).toBe(0o600);
      keys.write('radicle.pub', 'public', { mode: 0o644 });
      expect(modeOf(path.join(data, 'keys', 'radicle.pub'))).toBe(0o644);
      fs.chmodSync(path.join(data, 'keys', 'swarm.key'), 0o644);
      expect(keys.read('swarm.key').toString()).toBe('secret');
      expect(modeOf(path.join(data, 'keys', 'swarm.key'))).toBe(0o600);
      expect(keys.repair('swarm.key')).toBe(true);
      expect(keys.read('missing')).toBeNull();
      expect(keys.remove('radicle.pub')).toBe(true);
      expect(keys.remove('radicle.pub')).toBe(false);
    });
    expect(fs.readdirSync(path.join(data, 'keys'))).toEqual(['swarm.key']);
  });

  test('names are plain file names', () => {
    withPrivateDir(data, (dir) => {
      for (const name of ['', '.', '..', '../outside', 'keys/swarm.key']) {
        expect(() => dir.read(name)).toThrow(TypeError);
        expect(() => dir.write(name, 'x')).toThrow(TypeError);
      }
    });
  });

  test('withPrivateDir closes what it opened once an async use settles', async () => {
    let held;
    let keys;
    await withPrivateDir(data, async (dir) => {
      held = dir;
      keys = dir.openDir('keys');
      await new Promise((resolve) => setImmediate(resolve));
      expect(held.closed).toBe(false);
    });
    expect(held.closed).toBe(true);
    expect(keys.closed).toBe(true);
    expect(() => keys.read('swarm.key')).toThrow('closed');
    await expect(
      withPrivateDir(data, async () => {
        throw new Error('use failed');
      })
    ).rejects.toThrow('use failed');
  });

  eachSwapMode('%s', (_label, mode) => {
    // Refused: the handles were opened bound, and the binding is gone by
    // the time they are used.
    const afterOpen = () => {
      if (mode === 'refused') _setFdBindingForTests(false);
    };
    // keys/ as it now stands: moved aside by a swap, or where it was.
    const keysContents = () =>
      fs.readdirSync(
        path.join(data, fs.existsSync(path.join(data, 'keys.held')) ? 'keys.held' : 'keys')
      );

    // keys/ put back where it was: what a swap-and-restore around one open
    // leaves for the checks after it.
    const restoreKeys = () => {
      fs.unlinkSync(path.join(data, 'keys'));
      fs.renameSync(path.join(data, 'keys.held'), path.join(data, 'keys'));
    };
    const outsideNow = () => ({
      names: fs.readdirSync(outsideDir),
      content: fs.readFileSync(path.join(outsideDir, 'swarm.key'), 'utf8'),
      mode: modeOf(path.join(outsideDir, 'swarm.key')),
    });
    const UNTOUCHED = { names: ['swarm.key'], content: 'not yours', mode: 0o644 };
    // Spy on the open of `suffix` and run `around(open)` in its place.
    const aroundOpen = (suffix, around) => {
      const realOpen = fs.openSync;
      jest
        .spyOn(fs, 'openSync')
        .mockImplementation((target, ...rest) =>
          String(target).endsWith(suffix) && !keysIsLink()
            ? around(() => realOpen(target, ...rest))
            : realOpen(target, ...rest)
        );
    };

    test('keys/ swapped for a link across an await: no read, repair or write goes through it', async () => {
      await withPrivateDir(data, async (dir) => {
        const keys = dir.openDir('keys');
        expect(keys.bound).toBe(process.platform === 'linux');
        afterOpen();
        await new Promise((resolve) => setImmediate(resolve));
        swapKeysForLink();
        expect(() => keys.write('swarm.key', 'secret')).toThrow('replaced while in use');
        expect(() => keys.read('swarm.key')).toThrow('replaced while in use');
        expect(keys.repair('swarm.key')).toBe(false);
        expect(() => keys.openDir('sub')).toThrow('replaced while in use');
      });
      outsideUntouched();
      expect(fs.readdirSync(path.join(data, 'keys.held'))).toEqual([]);
    });

    test('the data directory swapped under a held keys/ is refused too', () => {
      withPrivateDir(data, (dir) => {
        const keys = dir.openDir('keys');
        afterOpen();
        fs.renameSync(data, path.join(root, 'ant-data.held'));
        fs.mkdirSync(data, { mode: 0o700 });
        fs.symlinkSync(outsideDir, path.join(data, 'keys'));
        expect(() => keys.write('swarm.key', 'secret')).toThrow('replaced while in use');
      });
      outsideUntouched();
      expect(fs.readdirSync(path.join(root, 'ant-data.held', 'keys'))).toEqual([]);
    });

    test('a swap at the temp file open, left in place, leaves nothing outside', () => {
      withPrivateDir(data, (dir) => {
        const keys = dir.openDir('keys');
        afterOpen();
        aroundOpen('.tmp', (open) => {
          swapKeysForLink();
          return open();
        });
        expect(() => keys.write('swarm.key', 'secret')).toThrow(UnsafePrivatePathError);
      });
      outsideUntouched();
      expect(keysContents()).toEqual([]);
    });

    test('a swap at a read open, left in place, opens nothing it then uses', () => {
      fs.writeFileSync(path.join(data, 'keys', 'swarm.key'), 'mine', { mode: 0o600 });
      withPrivateDir(data, (dir) => {
        const keys = dir.openDir('keys');
        afterOpen();
        aroundOpen('swarm.key', (open) => {
          swapKeysForLink();
          return open();
        });
        expect(() => keys.read('swarm.key')).toThrow(UnsafePrivatePathError);
      });
      outsideUntouched();
    });

    // Review R3-M1: keys/ is a link only while the open runs, and restored
    // before any check after it, so the path checks alone pass. Guaranteed
    // on Linux (bound, or refused without /proc) and on macOS.
    test('a swap-and-restore around a read open never reads or narrows the outside file', () => {
      fs.writeFileSync(path.join(data, 'keys', 'swarm.key'), 'mine', { mode: 0o600 });
      let during = null;
      let result;
      withPrivateDir(data, (dir) => {
        const keys = dir.openDir('keys');
        afterOpen();
        aroundOpen('swarm.key', (open) => {
          swapKeysForLink();
          try {
            return open();
          } finally {
            during = outsideNow();
            restoreKeys();
          }
        });
        try {
          result = keys.read('swarm.key').toString();
        } catch (err) {
          result = err;
        }
      });
      if (mode === 'bound') {
        // The open resolved in the held directory: our own file.
        expect(result).toBe('mine');
      } else {
        expect(result).toBeInstanceOf(UnsafePrivatePathError);
      }
      if (mode !== 'refused') expect(during).toEqual(UNTOUCHED);
      expect(outsideNow()).toEqual(UNTOUCHED);
    });

    test('a swap-and-restore around the temp file open never leaves the key outside', () => {
      let during = null;
      let outcome;
      withPrivateDir(data, (dir) => {
        const keys = dir.openDir('keys');
        afterOpen();
        aroundOpen('.tmp', (open) => {
          swapKeysForLink();
          try {
            return open();
          } finally {
            during = outsideNow();
            restoreKeys();
          }
        });
        try {
          keys.write('swarm.key', 'secret');
          outcome = 'written';
        } catch (err) {
          outcome = err;
        }
      });
      const inside = fs.readdirSync(path.join(data, 'keys'));
      if (mode === 'bound') {
        // The temp file was made in the held directory and renamed there.
        expect(outcome).toBe('written');
        expect(inside).toEqual(['swarm.key']);
        expect(fs.readFileSync(path.join(data, 'keys', 'swarm.key'), 'utf8')).toBe('secret');
      } else {
        expect(outcome).toBeInstanceOf(UnsafePrivatePathError);
        expect(inside).toEqual([]);
      }
      if (mode !== 'refused') expect(during).toEqual(UNTOUCHED);
      expect(outsideNow()).toEqual(UNTOUCHED);
    });
  });

  (process.platform === 'linux' ? test : test.skip)(
    'Linux without /proc: a handle refuses every entry, and nothing is opened by path',
    () => {
      _setFdBindingForTests(false);
      const realOpen = fs.openSync;
      const opened = [];
      jest.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        opened.push(String(target));
        return realOpen(target, ...rest);
      });
      withPrivateDir(data, (dir) => {
        expect(dir.bound).toBe(false);
        expect(() => dir.openDir('keys')).toThrow('no /proc/self/fd binding');
        expect(() => dir.read('config.yaml')).toThrow('no /proc/self/fd binding');
        expect(() => dir.write('config.yaml', 'secret')).toThrow('no /proc/self/fd binding');
      });
      expect(() => readPrivateFile(path.join(data, 'config.yaml'))).toThrow(
        'no /proc/self/fd binding'
      );
      // Only the directory itself was opened.
      expect(opened.every((target) => target === data)).toBe(true);
      expect(fs.readdirSync(data)).toEqual(['keys']);
    }
  );
});

// #946 review R2-M2: listing a held directory and removing an empty
// directory in it go through the handle. Bound (Linux), they stay on the
// held directory; by path (macOS, Windows, and Linux here through the test
// seam), a swap before or after is refused (#963).
posix('directory listing and removal through a handle (K-3)', () => {
  let root;
  let data;
  let outsideDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-dir-ops-'));
    data = path.join(root, 'ant-data');
    fs.mkdirSync(path.join(data, 'run', 'h-held'), { recursive: true, mode: 0o700 });
    outsideDir = path.join(root, 'outside');
    // What a swapped-in link could point at: a directory with the same
    // child, not empty, so a removal by path cannot take it either.
    fs.mkdirSync(path.join(outsideDir, 'h-held'), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'h-held', 'keep'), 'not yours');
    fs.writeFileSync(path.join(outsideDir, 'other'), 'not yours');
  });
  afterEach(() => {
    _setDirOpsByPathForTests(false);
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  // run/ moved aside (the handle still holds it), a link to outside in its place.
  const swapRunForLink = () => {
    fs.renameSync(path.join(data, 'run'), path.join(data, 'run.held'));
    fs.symlinkSync(outsideDir, path.join(data, 'run'));
  };
  const outsideUntouched = () => {
    expect(fs.readdirSync(outsideDir).sort()).toEqual(['h-held', 'other']);
    expect(fs.readdirSync(path.join(outsideDir, 'h-held'))).toEqual(['keep']);
  };
  // Run `swap` at the start of the next call to fs[fnName], then the call.
  const swapAt = (fnName, swap) => {
    const real = fs[fnName];
    let done = false;
    jest.spyOn(fs, fnName).mockImplementation((...args) => {
      if (!done) {
        done = true;
        swap();
      }
      return real(...args);
    });
  };

  const modes = [
    ...(process.platform === 'linux' ? [['bound to the descriptor (Linux)', false]] : []),
    ['by path, bracketed', true],
  ];
  describe.each(modes)('%s', (_label, byPath) => {
    beforeEach(() => _setDirOpsByPathForTests(byPath));

    test('a swap between the check and the listing never lists the replacement', () => {
      withPrivateDir(data, (dir) => {
        const run = dir.openDir('run');
        swapAt('readdirSync', swapRunForLink);
        let names;
        try {
          names = run.entries();
        } catch (err) {
          expect(err).toBeInstanceOf(UnsafePrivatePathError);
        }
        // Refused, or the held directory's own names.
        if (byPath) expect(names).toBeUndefined();
        if (names !== undefined) expect(names).toEqual(['h-held']);
      });
      outsideUntouched();
    });

    test('a swap between the check and the removal never removes outside', () => {
      withPrivateDir(data, (dir) => {
        const run = dir.openDir('run');
        swapAt('rmdirSync', swapRunForLink);
        let removed;
        try {
          removed = run.removeDir('h-held');
        } catch (err) {
          expect(err.code === 'ENOTEMPTY' || err instanceof UnsafePrivatePathError).toBe(true);
        }
        // Bound, the held directory's own child went; by path, refused.
        if (!byPath) expect(fs.existsSync(path.join(data, 'run.held', 'h-held'))).toBe(false);
        if (byPath) expect(removed).toBeUndefined();
      });
      outsideUntouched();
    });
  });

  test('a link at the name is refused, never its target removed', () => {
    fs.symlinkSync(path.join(outsideDir, 'h-held'), path.join(data, 'run', 'h-link'));
    fs.rmSync(path.join(outsideDir, 'h-held', 'keep'));
    withPrivateDir(data, (dir) => {
      const run = dir.openDir('run');
      expect(() => run.removeDir('h-link')).toThrow(/ENOTDIR/);
      expect(run.removeDir('h-held')).toBe(true);
      expect(run.removeDir('h-held')).toBe(false);
      expect(run.entries()).toEqual(['h-link']);
    });
    expect(fs.existsSync(path.join(outsideDir, 'h-held'))).toBe(true);
  });
});

// Review R3-M2. Windows has no O_NOFOLLOW: an ordinary open there follows a
// link to its target, so the name is lstat'ed first and the opened object
// must be the one lstat saw. Runs on every platform, Windows included.
describe('a link at the final file name (K-3)', () => {
  let root;
  let outside;
  let file;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-final-'));
    outside = path.join(root, 'outside.key');
    fs.writeFileSync(outside, 'not yours');
    file = path.join(root, 'swarm.key');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const outsideContent = () => fs.readFileSync(outside, 'utf8');

  test('is refused by reads and repairs, and replaced, not followed, by a write', () => {
    fs.symlinkSync(outside, file, 'file');
    expect(() => readPrivateFile(file)).toThrow(UnsafePrivatePathError);
    expect(repairPrivateFile(file)).toBe(false);
    withPrivateDir(root, (dir) => {
      expect(() => dir.read('swarm.key')).toThrow(UnsafePrivatePathError);
      expect(dir.repair('swarm.key')).toBe(false);
    });
    expect(outsideContent()).toBe('not yours');

    writePrivateFileSync(file, 'secret');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('secret');
    expect(outsideContent()).toBe('not yours');
  });

  test('a link swapped in between the lstat and the open is refused before any I/O', () => {
    fs.writeFileSync(file, 'mine');
    const realOpen = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
      if (String(target).endsWith('swarm.key') && !fs.lstatSync(target).isSymbolicLink()) {
        fs.rmSync(target);
        fs.symlinkSync(outside, target, 'file');
      }
      return realOpen(target, ...rest);
    });
    expect(() => readPrivateFile(file)).toThrow(UnsafePrivatePathError);
    expect(outsideContent()).toBe('not yours');
  });
});

posix('a FIFO at a private name (K-3)', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-fifo-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('is refused at once, never waited on for a writer', () => {
    const fifo = path.join(root, 'rpc-api-keys.json');
    execFileSync('mkfifo', [fifo]);
    // In a child: an open that waited for a writer would hang this worker.
    const script = `
      const path = require('path');
      const files = require(${JSON.stringify(require.resolve('./private-files'))});
      const target = process.argv[1];
      const out = {};
      try { files.readPrivateFile(target); out.read = 'read'; } catch (err) { out.read = err.message; }
      out.repair = files.repairPrivateFile(target);
      try {
        files.withPrivateDir(path.dirname(target), (dir) => dir.read(path.basename(target)));
        out.handle = 'read';
      } catch (err) { out.handle = err.message; }
      process.stdout.write(JSON.stringify(out));
    `;
    const result = spawnSync(process.execPath, ['-e', script, fifo], {
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      read: expect.stringContaining('not a regular file'),
      repair: false,
      handle: expect.stringContaining('not a regular file'),
    });
    expect(fs.statSync(fifo).isFIFO()).toBe(true);
  });
});
