const fs = require('fs'),
  path = require('path'),
  os = require('os');
const { createHash } = require('crypto');
jest.mock('./railgun-prover-manifest.json', () => ({ size: 0, sha256: '' }));
const manifest = require('./railgun-prover-manifest.json');
const {
  verifyRailgunProverRuntime,
  loadRailgunProverRuntime,
} = require('./railgun-prover-runtime');
let directory, archive;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-prover-runtime-'));
  archive = path.join(directory, 'railgun-prover.asar');
  const bytes = Buffer.from('public runtime fixture');
  fs.writeFileSync(archive, bytes);
  manifest.size = bytes.length;
  manifest.sha256 = createHash('sha256').update(bytes).digest('hex');
});
test('only exact pinned container bytes are accepted', () => {
  expect(verifyRailgunProverRuntime(archive)).toBe(fs.realpathSync(archive));
  fs.writeFileSync(archive, Buffer.alloc(manifest.size, 1));
  expect(() => verifyRailgunProverRuntime(archive)).toThrow('could not be authenticated');
});
test('authenticates before executing the serial prover entry', () => {
  const execute = jest.fn(() => ({ verify: true }));
  jest.doMock(path.join(fs.realpathSync(archive), 'serial-prover.cjs'), execute, { virtual: true });
  fs.writeFileSync(archive, Buffer.alloc(manifest.size, 1));
  expect(() => loadRailgunProverRuntime(archive)).toThrow('could not be authenticated');
  expect(execute).not.toHaveBeenCalled();
});
test('loads the authenticated entry through the single runtime loader', () => {
  const execute = jest.fn(() => ({ verify: true }));
  jest.doMock(path.join(fs.realpathSync(archive), 'serial-prover.cjs'), execute, { virtual: true });
  expect(loadRailgunProverRuntime(archive)).toEqual({ verify: true });
  expect(execute).toHaveBeenCalledTimes(1);
});
test.each(['relative', 'extension', 'symlink', 'unpacked', 'truncated', 'missing'])(
  'refuses %s containers',
  (mode) => {
    let filename = archive;
    if (mode === 'relative') filename = 'railgun-prover.asar';
    if (mode === 'extension') filename = path.join(directory, 'prover.js');
    if (mode === 'symlink') {
      filename = path.join(directory, 'link.asar');
      fs.symlinkSync(archive, filename);
    }
    if (mode === 'unpacked') fs.mkdirSync(archive + '.unpacked');
    if (mode === 'truncated') fs.truncateSync(archive, 1);
    if (mode === 'missing') filename = path.join(directory, 'missing.asar');
    expect(() => verifyRailgunProverRuntime(filename)).toThrow('could not be authenticated');
  }
);
