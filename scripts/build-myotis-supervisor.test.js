jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(), mkdirSync: jest.fn() }));
const { execFileSync } = require('child_process');
const fs = require('fs');
const { buildForTargets } = require('./build-myotis-supervisor');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform));

test('mac packaging compiles both requested architectures before preflight', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  buildForTargets('mac', ['arm64', 'x64']);
  expect(execFileSync).toHaveBeenCalledTimes(2);
  expect(execFileSync.mock.calls[0][1]).toEqual(expect.arrayContaining(['-arch', 'arm64']));
  expect(execFileSync.mock.calls[1][1]).toEqual(expect.arrayContaining(['-arch', 'x86_64']));
});

test('foreign targets require a supplied helper and never acquire a compiler', () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  fs.existsSync.mockReturnValue(false);
  expect(() => buildForTargets('win', ['x64'])).toThrow('No compiler is downloaded');
  expect(execFileSync).not.toHaveBeenCalled();
  fs.existsSync.mockReturnValue(true);
  expect(() => buildForTargets('win', ['x64'])).not.toThrow();
  expect(execFileSync).not.toHaveBeenCalled();
});
