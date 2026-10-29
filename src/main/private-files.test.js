const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensurePrivateDir,
  repairPrivateDir,
  readPrivateFile,
  repairPrivateFile,
  writePrivateFileSync,
  UnsafePrivatePathError,
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
