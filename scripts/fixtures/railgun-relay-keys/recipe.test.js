const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const verified = require('../railgun-relay-wire/inputs');
const campaign = require('./campaign');
const { main } = require('../../qualify-railgun-relay-keys');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-keys-recipe-test-'));
const nobleInput = 'engineDependencies:@noble/ed25519/lib/index.js';
const fakeManifest = () => ({ roots: {}, graphInputs: [nobleInput] });
function marker(build) {
  fs.writeFileSync(
    path.join(build, 'upstream.cjs'),
    "require('node:fs').writeFileSync(__dirname + '/IMPORTED', 'marker-only'); throw new Error('MARKER_IMPORT');"
  );
}
afterEach(() => jest.restoreAllMocks());
test('CLI and fixture import load no generated crypto or build tool', () => {
  const entry = path.resolve(__dirname, '../../qualify-railgun-relay-keys.js');
  const script = `require(${JSON.stringify(entry)}); const bad=Object.keys(require.cache).filter(p=>/upstream\\.cjs|@noble|esbuild|@babel/.test(p)); if(bad.length) throw new Error(JSON.stringify(bad));`;
  expect(() => execFileSync(process.execPath, ['-e', script])).not.toThrow();
});
test.each([
  [],
  ['prepare'],
  ['run'],
  ['check', '--build', 'a', '--build', 'b'],
  ['run', '--build', 'a', '--build-sha256', '0'.repeat(64), '--unknown', 'c'],
  ['run', '--build', 'a', '--build-sha256', '0'.repeat(64), '--output', ''],
  ['check', '--build', 'a', '--build-sha256', '0'.repeat(64), '--output', 'c'],
])('CLI rejects malformed fields %#', async (...argv) => {
  const spy = jest.spyOn(campaign, 'verifyKeyBuild');
  await expect(main(argv)).rejects.toThrow();
  expect(spy).not.toHaveBeenCalled();
});
test('real malformed digest check refuses without marker import', async () => {
  const build = temp();
  marker(build);
  await expect(main(['check', '--build', build, '--build-sha256', 'bad'])).rejects.toThrow(
    'Reviewed build manifest'
  );
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('real digest mismatch precedes manifest parse and bundle import', async () => {
  const build = temp();
  marker(build);
  fs.writeFileSync(path.join(build, 'build.json'), '{invalid');
  await expect(
    main([
      'run',
      '--build',
      build,
      '--build-sha256',
      '0'.repeat(64),
      '--output',
      path.join(temp(), 'output'),
    ])
  ).rejects.toThrow('Build manifest digest mismatch');
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('failed build verification does not create output or import marker', async () => {
  const build = temp(),
    output = path.join(temp(), 'output');
  marker(build);
  jest.spyOn(verified, 'verifyBuild').mockImplementation(() => {
    throw new Error('INPUT_REFUSED');
  });
  await expect(campaign.run(build, '0'.repeat(64), output)).rejects.toThrow('INPUT_REFUSED');
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('missing pinned Noble graph input refuses before output/import', async () => {
  const build = temp(),
    output = path.join(temp(), 'output');
  marker(build);
  jest.spyOn(verified, 'verifyBuild').mockReturnValue({ roots: {}, graphInputs: [] });
  await expect(campaign.run(build, '0'.repeat(64), output)).rejects.toThrow(
    'Pinned Noble input absent'
  );
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('wrong Noble source pin refuses before output/import', async () => {
  const build = temp(),
    output = path.join(temp(), 'output');
  marker(build);
  jest.spyOn(verified, 'verifyBuild').mockReturnValue(fakeManifest());
  const original = verified.pins.files[nobleInput];
  try {
    verified.pins.files[nobleInput] = { ...original, sha256: '0'.repeat(64) };
    await expect(campaign.run(build, '0'.repeat(64), output)).rejects.toThrow();
  } finally {
    verified.pins.files[nobleInput] = original;
  }
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('existing output refuses before marker and preserves existing bytes', async () => {
  const build = temp(),
    output = temp();
  marker(build);
  fs.writeFileSync(path.join(output, 'keep'), 'unchanged');
  jest.spyOn(verified, 'verifyBuild').mockReturnValue(fakeManifest());
  await expect(campaign.run(build, '0'.repeat(64), output)).rejects.toThrow(
    'Output already exists'
  );
  expect(fs.readFileSync(path.join(output, 'keep'), 'utf8')).toBe('unchanged');
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('prepared build cannot contain the new output', async () => {
  const build = temp();
  marker(build);
  jest.spyOn(verified, 'verifyBuild').mockReturnValue(fakeManifest());
  await expect(campaign.run(build, '0'.repeat(64), path.join(build, 'output'))).rejects.toThrow(
    'Output overlaps input'
  );
  expect(fs.existsSync(path.join(build, 'output'))).toBe(false);
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('key source directory cannot contain the new output', async () => {
  const build = temp();
  marker(build);
  jest.spyOn(verified, 'verifyBuild').mockReturnValue(fakeManifest());
  const output = path.join(__dirname, 'uncreated-key-output-' + process.pid);
  await expect(campaign.run(build, '0'.repeat(64), output)).rejects.toThrow(
    'Output overlaps input'
  );
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('check verifies only and never imports marker', async () => {
  const build = temp();
  marker(build);
  const spy = jest.spyOn(verified, 'verifyBuild').mockReturnValue(fakeManifest());
  await expect(
    main(['check', '--build', build, '--build-sha256', '0'.repeat(64)])
  ).resolves.toEqual({ verified: true, generatedCryptoExecuted: false });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('admitted structural seam reaches only marker import after fresh output creation', async () => {
  const build = temp(),
    output = path.join(temp(), 'output');
  marker(build);
  jest.spyOn(verified, 'verifyBuild').mockReturnValue(fakeManifest());
  await expect(campaign.run(build, '0'.repeat(64), output)).rejects.toThrow('MARKER_IMPORT');
  expect(fs.existsSync(output)).toBe(true);
  expect(fs.readFileSync(path.join(build, 'IMPORTED'), 'utf8')).toBe('marker-only');
  expect(fs.existsSync(path.join(output, 'report.json'))).toBe(false);
});
test('key recipe pins do not enter the unchanged wire recipe', () => {
  const wireBefore = verified.recipePins(),
    keyPins = campaign.recipePins();
  expect(Object.keys(wireBefore)).toHaveLength(11);
  expect(Object.keys(keyPins)).toHaveLength(5);
  expect(Object.keys(wireBefore).some((name) => name.includes('railgun-relay-keys'))).toBe(false);
  expect(verified.recipePins()).toEqual(wireBefore);
});
