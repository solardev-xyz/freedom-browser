jest.mock('./ppv2-runtime-manifest', () => ({ size: 12,
  sha256: require('crypto').createHash('sha256').update('reviewed sdk').digest('hex') }));
jest.mock('./ppv2-session', () => ({ PPV2_CANDIDATE: { sdk: 'reviewed', kohaku: 'reviewed' } }));
const fs = require('fs'), os = require('os'), path = require('path');
const { verifyPPv2Runtime, loadPPv2Runtime, assertPPv2Candidate, assertPPv2RuntimeEntries } = require('./ppv2-runtime');
let archive;
const failure = { code: 'PRIVATE_PPV2_RUNTIME_INVALID' };
beforeEach(() => {
  archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-runtime-')), 'runtime.asar');
  fs.writeFileSync(archive, 'reviewed sdk');
});
afterEach(() => jest.restoreAllMocks());

test('verifies the actual container and rejects replacement despite a prior successful check', () => {
  expect(verifyPPv2Runtime(archive)).toBe(fs.realpathSync(archive));
  fs.writeFileSync(archive, 'modified sdk');
  expect(() => verifyPPv2Runtime(archive)).toThrow(expect.objectContaining(failure));
});

test.each(['sidecar', 'symlink', 'directory', 'size', 'relative', 'extension'])('rejects %s runtime inputs', (kind) => {
  if (kind === 'sidecar') fs.mkdirSync(`${archive}.unpacked`);
  if (kind === 'symlink') { const link = `${archive}.link.asar`; fs.symlinkSync(archive, link); archive = link; }
  if (kind === 'directory') { archive = `${archive}.dir.asar`; fs.mkdirSync(archive); }
  if (kind === 'size') fs.appendFileSync(archive, 'extra');
  if (kind === 'relative') archive = 'runtime.asar';
  if (kind === 'extension') archive = path.dirname(archive);
  expect(() => verifyPPv2Runtime(archive)).toThrow(expect.objectContaining(failure));
});

test('does not return a verified handle when the container changes during hashing', () => {
  const read = fs.readSync;
  jest.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
    const result = read(...args); fs.writeFileSync(archive, 'modified sdk'); return result;
  });
  expect(() => verifyPPv2Runtime(archive)).toThrow(expect.objectContaining(failure));
});

test('candidate identity cannot be copied or mixed with another prover closure', () => {
  const canonical = fs.realpathSync(archive);
  const plugin = path.join(canonical, 'plugin.cjs');
  jest.doMock(plugin, () => ({ createPPv2Plugin() {}, createPPv2Broadcaster() {}, inspectRegistration() {}, inspectChange() {} }), { virtual: true });
  const readFile = fs.readFileSync;
  jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...args) => filename === path.join(canonical, 'candidate.json')
    ? JSON.stringify({ sdk: 'reviewed', kohaku: 'reviewed' }) : readFile(filename, ...args));
  const runtime = loadPPv2Runtime(archive);
  expect(Object.isFrozen(runtime.candidate)).toBe(true);
  expect(() => assertPPv2Candidate(runtime.candidate, { sdkEntry: runtime.sdkEntry, ragequitProverEntry: runtime.proverEntry })).not.toThrow();
  expect(() => assertPPv2Candidate({ ...runtime.candidate })).toThrow(expect.objectContaining(failure));
  expect(() => assertPPv2Candidate(runtime.candidate, { sdkEntry: '/another/sdk.cjs' })).toThrow(expect.objectContaining(failure));
  expect(() => assertPPv2RuntimeEntries({ sdkEntry: runtime.sdkEntry, proverEntry: runtime.proverEntry })).not.toThrow();
  expect(() => assertPPv2RuntimeEntries({ sdkEntry: runtime.sdkEntry, proverEntry: '/another/serial-prover.cjs' })).toThrow(expect.objectContaining(failure));
  fs.writeFileSync(archive, 'modified sdk');
  expect(() => assertPPv2Candidate(runtime.candidate)).toThrow(expect.objectContaining(failure));
});

test('rejects the archive before executing its plugin', () => {
  const execute = jest.fn();
  jest.doMock(path.join(fs.realpathSync(archive), 'plugin.cjs'), () => { execute(); return {}; }, { virtual: true });
  fs.writeFileSync(archive, 'modified sdk');
  expect(() => loadPPv2Runtime(archive)).toThrow(expect.objectContaining(failure));
  expect(execute).not.toHaveBeenCalled();
});

test('application references to external PPv2 runtime entries stay in the verified loader', () => {
  const root = path.resolve(__dirname, '..');
  const files = fs.readdirSync(root, { recursive: true }).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));
  const references = files.filter((name) => /['"`]([^'"`]*\/)?(?:plugin|sdk|serial-prover|abis)\.cjs/.test(fs.readFileSync(path.join(root, name), 'utf8')));
  expect(references.map((name) => name.split(path.sep).join('/'))).toEqual(['wallet/ppv2-runtime.js']);
});
