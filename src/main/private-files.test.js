const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensurePrivateDir, writePrivateFileSync, restrictMode } = require('./private-files');

const posix = process.platform === 'win32' ? describe.skip : describe;
const modeOf = (target) => fs.statSync(target).mode & 0o777;

posix('private files (K-3)', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-files-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates directories owner-only, parents included', () => {
    const dir = path.join(root, 'a', 'b');
    expect(ensurePrivateDir(dir)).toBe(dir);
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(path.join(root, 'a'))).toBe(0o700);
  });

  test('narrows an existing directory an older build made 0755', () => {
    const dir = path.join(root, 'ant-data');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  test('writes files owner-only, and narrows an existing file first', () => {
    const file = path.join(root, 'config.yaml');
    writePrivateFileSync(file, 'password: one\n');
    expect(modeOf(file)).toBe(0o600);

    fs.chmodSync(file, 0o644);
    writePrivateFileSync(file, 'password: two\n');
    expect(modeOf(file)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('password: two\n');
  });

  test('restrictMode leaves owner-only and missing paths alone', () => {
    const file = path.join(root, 'key');
    fs.writeFileSync(file, 'x', { mode: 0o400 });
    expect(restrictMode(file, 0o600)).toBe(false);
    expect(modeOf(file)).toBe(0o400);
    expect(restrictMode(path.join(root, 'missing'), 0o600)).toBe(false);
  });
});
