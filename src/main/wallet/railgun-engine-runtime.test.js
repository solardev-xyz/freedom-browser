const fs = require('fs'),
  path = require('path'),
  os = require('os');
const { createHash } = require('crypto');
jest.mock('./railgun-engine-manifest.json', () => ({ size: 0, sha256: '' }));
const manifest = require('./railgun-engine-manifest.json');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
let directory, archive;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-engine-runtime-'));
  archive = path.join(directory, 'railgun-engine.asar');
  const bytes = Buffer.from('public runtime fixture');
  fs.writeFileSync(archive, bytes);
  manifest.size = bytes.length;
  manifest.sha256 = createHash('sha256').update(bytes).digest('hex');
});
test('only exact pinned container bytes are accepted', () => {
  expect(verifyRailgunEngineRuntime(archive)).toBe(fs.realpathSync(archive));
  fs.writeFileSync(archive, Buffer.alloc(manifest.size, 1));
  expect(() => verifyRailgunEngineRuntime(archive)).toThrow('could not be authenticated');
});
test.each(['relative', 'extension', 'symlink', 'unpacked', 'truncated', 'missing'])(
  'refuses %s containers',
  (mode) => {
    let filename = archive;
    if (mode === 'relative') filename = 'railgun-engine.asar';
    if (mode === 'extension') filename = path.join(directory, 'prover.js');
    if (mode === 'symlink') {
      filename = path.join(directory, 'link.asar');
      fs.symlinkSync(archive, filename);
    }
    if (mode === 'unpacked') fs.mkdirSync(archive + '.unpacked');
    if (mode === 'truncated') fs.truncateSync(archive, 1);
    if (mode === 'missing') filename = path.join(directory, 'missing.asar');
    expect(() => verifyRailgunEngineRuntime(filename)).toThrow('could not be authenticated');
  }
);
