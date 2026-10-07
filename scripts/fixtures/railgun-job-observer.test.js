const path = require('path');
const mockLocate = jest.fn();
jest.mock(
  '@freedom/railgun-kohaku-adapter/host/execution',
  () => ({ getRailgunExecutionJob: (...args) => mockLocate(...args) }),
  { virtual: true }
);
const { observeRailgunJob, isRailgunWalletJob } = require('./railgun-job-observer');
const names = {
  'spending-public': 'identity',
  'viewing-identity': 'identity',
  'spending-sign': 'spend-sign',
  'wallet-viewing': 'wallet',
  'private-prepare': 'private-prepare',
  'private-operate': 'private-operate',
  'private-recover': 'private-recover',
  'private-receive': 'private-receive',
  'private-verify': 'private-verify',
};
beforeEach(() => {
  mockLocate.mockReset();
  mockLocate.mockImplementation((job) => '/installed/railgun-' + names[job] + '-job.js');
});
test.each(Object.keys(names))('observes %s without changing any original options', (job) => {
  const options = Object.freeze({ executionJob: job, input: JSON.stringify({ purpose: job }) });
  const name = 'railgun-' + names[job] + '-job.js';
  expect(observeRailgunJob(options)).toEqual({
    route: 'kernel',
    executionJob: job,
    filename: '/installed/' + name,
    name,
  });
  expect(isRailgunWalletJob(options, name)).toBe(true);
  expect(isRailgunWalletJob(options, 'railgun-public-job.js')).toBe(false);
  expect(Object.isFrozen(observeRailgunJob(options))).toBe(true);
  expect(Object.keys(options)).toEqual(['executionJob', 'input']);
});
test.each(['filename', 'binaryKey'])('refuses even an undefined extra %s', (field) => {
  expect(() => observeRailgunJob({ executionJob: 'private-verify', [field]: undefined })).toThrow();
  expect(mockLocate).not.toHaveBeenCalled();
});
test.each(['unknown', '', '__proto__', null, 1])('refuses non-enum %s before location', (job) => {
  expect(() => observeRailgunJob({ executionJob: job })).toThrow();
  expect(mockLocate).not.toHaveBeenCalled();
});
test('refuses an identity purpose mismatch and a changed installed basename', () => {
  expect(() =>
    observeRailgunJob({ executionJob: 'viewing-identity', input: '{"purpose":"spending-public"}' })
  ).toThrow();
  mockLocate.mockReturnValue('/installed/railgun-private-prepare-job.js');
  expect(() => observeRailgunJob({ executionJob: 'private-verify' })).toThrow();
});
test.each(Object.values(names))('never counts a legacy %s as the new route', (name) => {
  expect(() => observeRailgunJob({ filename: '/anywhere/railgun-' + name + '-job.js' })).toThrow();
});
test('legacy matching retains full wallet-path identity', () => {
  const filename = path.resolve(__dirname, '../../src/main/wallet/railgun-public-job.js');
  expect(observeRailgunJob({ filename }).route).toBe('legacy');
  expect(isRailgunWalletJob({ filename }, 'railgun-public-job.js')).toBe(true);
  expect(
    isRailgunWalletJob({ filename: '/shadow/railgun-public-job.js' }, 'railgun-public-job.js')
  ).toBe(false);
  expect(mockLocate).not.toHaveBeenCalled();
});

describe('main-observed installed target evidence', () => {
  const fs = require('fs');
  const os = require('os');
  let root, packageRoot, cache, locate, recorder, source;
  const packageName = 'node_modules/@freedom/railgun-kohaku-adapter';
  function file(name, content = '// public synthetic source\n') {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    return filename;
  }
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-target-evidence-')));
    packageRoot = path.join(root, packageName);
    for (const name of [
      'src/main/wallet/railgun-process.js',
      'src/main/wallet/railgun-kernel-entry.js',
      'src/main/wallet/railgun-process-entry.js',
      ...[
        'package.json',
        'host-execution.cjs',
        'host-bootstrap.cjs',
        'src/execution/job-locations.js',
        'src/execution/host-bindings.js',
        'src/execution/railgun-process-guards.js',
        'src/execution/railgun-private-operate-job.js',
      ].map((name) => packageName + '/' + name),
    ])
      file(name);
    const entry = path.join(packageRoot, 'host-execution.cjs');
    cache = { [entry]: { filename: entry } };
    locate = jest.fn(() => path.join(packageRoot, 'src/execution/railgun-private-operate-job.js'));
    const req = (name) =>
      name === '@freedom/railgun-kohaku-adapter/host/execution'
        ? { getRailgunExecutionJob: locate }
        : require(name);
    req.resolve = () => entry;
    req.cache = cache;
    source = fs.readFileSync(require.resolve('./railgun-job-observer'), 'utf8');
    const module = { exports: {} };
    new Function('require', 'module', '__dirname', source)(
      req,
      module,
      path.join(root, 'scripts/fixtures')
    );
    recorder = module.exports.createRailgunJobEvidence();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test('pins the fixed installed target without touching options, key or broker', () => {
    const options = Object.freeze({ executionJob: 'private-operate', broker: Object.freeze({}) });
    const target = recorder.observe(options);
    expect(target).toEqual({
      route: 'kernel',
      executionJob: 'private-operate',
      path: packageName + '/src/execution/railgun-private-operate-job.js',
      bytes: 27,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.isFrozen(target)).toBe(true);
    const report = recorder.report();
    expect(report).toMatchObject({
      scope: 'main-observed-installed-job-targets',
      utilityModuleCacheObserved: false,
      historicalExecutionCoverage: false,
      packageRoot: packageName,
      targets: [target],
    });
    expect(report.bootstrapPins).toHaveLength(9);
    expect(report.mainPackageCache).toHaveLength(1);
    expect(options.broker).toEqual({});
    expect(locate).toHaveBeenCalledTimes(1);
  });
  test('records a confined legacy fixture explicitly, never as a kernel job', () => {
    const filename = file('scripts/fixtures/railgun-poi-test-job.js');
    expect(recorder.observe({ filename })).toMatchObject({
      route: 'legacy',
      executionJob: null,
      path: 'scripts/fixtures/railgun-poi-test-job.js',
    });
    expect(locate).not.toHaveBeenCalled();
  });
  test('rejects a same-named installed job in a foreign root', () => {
    locate.mockReturnValue('/foreign/railgun-private-operate-job.js');
    expect(() => recorder.observe({ executionJob: 'private-operate' })).toThrow();
  });
  test('rejects a copied target symlink escape', () => {
    const target = path.join(packageRoot, 'src/execution/railgun-private-operate-job.js');
    const outside = file('outside.js');
    fs.unlinkSync(target);
    fs.symlinkSync(outside, target);
    expect(() => recorder.observe({ executionJob: 'private-operate' })).toThrow();
  });
  test('refuses target or bootstrap bytes changed after observation', () => {
    const target = recorder.observe({ executionJob: 'private-operate' });
    fs.appendFileSync(path.join(root, target.path), '// changed');
    expect(() => recorder.report()).toThrow();
  });
  test.each([
    'foreign-root',
    'alias',
    'job',
    'archive-runtime',
    'utility-bootstrap',
    'missing-entry',
  ])('refuses main cache %s evidence', (kind) => {
    const entry = path.join(packageRoot, 'host-execution.cjs');
    if (kind === 'missing-entry') delete cache[entry];
    else {
      const name =
        kind === 'foreign-root'
          ? '/foreign/' + packageName + '/host-execution.cjs'
          : kind === 'alias'
            ? path.join(packageRoot, 'alias.cjs')
            : kind === 'job'
              ? path.join(packageRoot, 'src/execution/railgun-private-operate-job.js')
              : kind === 'archive-runtime'
                ? path.join(packageRoot, 'src/execution/railgun-engine-runtime.js')
                : path.join(packageRoot, 'host-bootstrap.cjs');
      cache[name] = { filename: kind === 'alias' ? entry : name };
    }
    expect(() => recorder.report()).toThrow();
  });
  test('each native qualifier records targets on the original closure and publishes bounded evidence', () => {
    for (const name of ['partial-controller', 'proof-recovery']) {
      const text = fs.readFileSync(
        path.join(__dirname, '..', 'qualify-railgun-' + name + '.js'),
        'utf8'
      );
      expect(text).toContain('const target = kernelEvidence.observe(options);');
      expect(text).toMatch(/childResults\.push\(\{[^}]*target,[^}]*\.\.\.(value|result) \}\)/);
      expect(text).toContain('kernelEvidence: kernelEvidence.report(),');
      expect(text).toContain('return task;');
    }
  });
});
