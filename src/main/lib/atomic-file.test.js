const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-file');

let dir;
let target;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-file-'));
  target = path.join(dir, 'store.json');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const temps = () => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));

describe('writeFileAtomicSync', () => {
  test('writes a new file, and replaces an existing one whole', () => {
    writeFileAtomicSync(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1}');
    writeFileAtomicSync(target, '{\n  "b": "é"\n}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{\n  "b": "é"\n}');
    expect(temps()).toEqual([]);
  });

  test('a temp file beside the target, fsynced, then renamed over it: never written in place', () => {
    const opens = jest.spyOn(fs, 'openSync');
    const writes = jest.spyOn(fs, 'writeFileSync');
    const syncs = jest.spyOn(fs, 'fsyncSync');
    const renames = jest.spyOn(fs, 'renameSync');
    fs.writeFileSync(target, 'old');
    writes.mockClear();

    writeFileAtomicSync(target, 'new');

    expect(renames).toHaveBeenCalledTimes(1);
    const [from, to] = renames.mock.calls[0];
    expect(to).toBe(target);
    expect(path.dirname(from)).toBe(dir);
    expect(path.basename(from)).toMatch(/^store\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
    // Made exclusively, so a name already there fails instead of being written through.
    expect(opens).toHaveBeenCalledWith(from, 'wx', 0o600);
    for (const [file] of opens.mock.calls) expect(file).not.toBe(target);
    for (const [file] of writes.mock.calls) expect(file).not.toBe(target);
    // The temp file's data reached the disk before the rename.
    expect(syncs.mock.invocationCallOrder[0]).toBeLessThan(renames.mock.invocationCallOrder[0]);
    expect(fs.readFileSync(target, 'utf-8')).toBe('new');
  });

  (process.platform === 'win32' ? test.skip : test)('the new file is owner-only (0600)', () => {
    fs.writeFileSync(target, 'old', { mode: 0o644 });
    writeFileAtomicSync(target, 'new');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  test('a failed rename leaves the target as it was, removes the temp file and throws', () => {
    fs.writeFileSync(target, 'old');
    jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(() => writeFileAtomicSync(target, 'new')).toThrow('EPERM');
    expect(fs.readFileSync(target, 'utf-8')).toBe('old');
    expect(temps()).toEqual([]);
  });

  test('a failed write of the temp file leaves the target as it was, and throws', () => {
    fs.writeFileSync(target, 'old');
    jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    expect(() => writeFileAtomicSync(target, 'new')).toThrow('EIO');
    expect(fs.readFileSync(target, 'utf-8')).toBe('old');
    expect(temps()).toEqual([]);
  });

  test('a missing directory fails the write, with nothing made', () => {
    const missing = path.join(dir, 'gone', 'store.json');
    expect(() => writeFileAtomicSync(missing, '{}')).toThrow();
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  (process.platform === 'win32' ? test.skip : test)(
    'a link at the target is replaced, never written through',
    () => {
      const elsewhere = path.join(dir, 'elsewhere.json');
      fs.writeFileSync(elsewhere, 'theirs');
      fs.symlinkSync(elsewhere, target);
      writeFileAtomicSync(target, 'mine');
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(target, 'utf-8')).toBe('mine');
      expect(fs.readFileSync(elsewhere, 'utf-8')).toBe('theirs');
    }
  );
});
