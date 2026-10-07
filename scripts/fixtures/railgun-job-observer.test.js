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
