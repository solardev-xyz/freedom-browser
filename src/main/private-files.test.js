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

// A managed directory handle binds through /proc/self/fd on Linux, and
// through the before-and-after check alone on macOS and Windows: the swap
// tests run both ways where both exist.
const bindings =
  process.platform === 'linux'
    ? [
        ['bound to the descriptor', true],
        ['checked by path alone', false],
      ]
    : [['checked by path alone', false]];

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

  describe.each(bindings)('%s', (_label, bound) => {
    beforeEach(() => _setFdBindingForTests(bound));

    test('keys/ swapped for a link across an await: no read, repair or write goes through it', async () => {
      await withPrivateDir(data, async (dir) => {
        const keys = dir.openDir('keys');
        expect(keys.bound).toBe(bound);
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
        fs.renameSync(data, path.join(root, 'ant-data.held'));
        fs.mkdirSync(data, { mode: 0o700 });
        fs.symlinkSync(outsideDir, path.join(data, 'keys'));
        expect(() => keys.write('swarm.key', 'secret')).toThrow('replaced while in use');
      });
      outsideUntouched();
      expect(fs.readdirSync(path.join(root, 'ant-data.held', 'keys'))).toEqual([]);
    });

    test('a swap between the check and the temp file leaves nothing outside', () => {
      const realOpen = fs.openSync;
      withPrivateDir(data, (dir) => {
        const keys = dir.openDir('keys');
        jest.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
          if (String(target).endsWith('.tmp') && !keysIsLink()) swapKeysForLink();
          return realOpen(target, ...rest);
        });
        expect(() => keys.write('swarm.key', 'secret')).toThrow('replaced while in use');
      });
      // Bound, the temp file was made in the held directory; path-checked,
      // through the link. Either way it is gone and nothing was renamed.
      outsideUntouched();
      expect(fs.readdirSync(path.join(data, 'keys.held'))).toEqual([]);
    });

    test('a swap between the check and a read opens nothing it then uses', () => {
      fs.writeFileSync(path.join(data, 'keys', 'swarm.key'), 'mine', { mode: 0o600 });
      const realOpen = fs.openSync;
      withPrivateDir(data, (dir) => {
        const keys = dir.openDir('keys');
        jest.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
          if (String(target).endsWith('swarm.key') && !keysIsLink()) swapKeysForLink();
          return realOpen(target, ...rest);
        });
        expect(() => keys.read('swarm.key')).toThrow('replaced while in use');
      });
      // Path-checked, the outside file was opened, but neither narrowed
      // nor read before the check refused it.
      outsideUntouched();
    });
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
