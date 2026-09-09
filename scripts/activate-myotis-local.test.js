// Pure local-import orchestration; no real file, addon, build or network access.
jest.mock('fs', () => ({ mkdirSync: jest.fn(), openSync: jest.fn(() => 7), writeSync: jest.fn((_fd, _buffer, _offset, count) => count),
  writeFileSync: jest.fn(), fsyncSync: jest.fn(), closeSync: jest.fn() }));
jest.mock('../src/main/myotis/myotis-artifact', () => ({
  expectedArtifact: jest.fn(() => ({ sourceCommit: 'pinned', abi: 25 })),
  readPinnedBytes: jest.fn((_file, _target, consume) => consume(Buffer.from('tiny fixture'))),
}));
const fs = require('fs');
const artifact = require('../src/main/myotis/myotis-artifact');
const { activateLocal } = require('./activate-myotis-local');
afterEach(() => jest.clearAllMocks());
test('copies only verified local chunks into exclusive files and emits provenance after verification', () => {
  activateLocal(['--target', 'linux-x64', '--file', '/owned/addon.node']);
  expect(artifact.readPinnedBytes).toHaveBeenCalledWith('/owned/addon.node', 'linux-x64', expect.any(Function));
  expect(fs.openSync).toHaveBeenCalledWith(expect.stringContaining('myotis-bin/linux-x64/myotis-node.node'), 'wx', 0o600);
  expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('myotis-artifact.json'), expect.stringContaining('pinned'), { flag: 'wx', mode: 0o600 });
});
test('bad hash leaves no trusted manifest and never deletes partial evidence', () => {
  artifact.readPinnedBytes.mockImplementationOnce(() => { throw new Error('hash mismatch'); });
  expect(() => activateLocal(['--target', 'linux-x64', '--file', '/owned/bad.node'])).toThrow('hash');
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.closeSync).toHaveBeenCalledWith(7);
});
test('rejects URL/relative input before any output', () => {
  expect(() => activateLocal(['--target', 'linux-x64', '--file', 'https://example/addon.node'])).toThrow('absolute local');
  expect(fs.openSync).not.toHaveBeenCalled();
});
