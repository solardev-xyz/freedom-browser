jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('./myotis-process', () => ({ supervisorPath: () => '/trusted/helper', childEnvironment: () => ({ ELECTRON_RUN_AS_NODE: '1' }) }));
const { execFile } = require('child_process');
const { recoverOwner } = require('./ownership-recovery');

test.each([null, 11])('accepts native terminal result %s', async (code) => {
  execFile.mockImplementation((_file, _args, _options, callback) => callback(code === null ? null : { code }));
  await expect(recoverOwner('/data/chain')).resolves.toBeUndefined();
  expect(execFile).toHaveBeenLastCalledWith('/trusted/helper', ['--recover-owner', '/data/chain', expect.any(String)],
    expect.objectContaining({ timeout: 5000, windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } }), expect.any(Function));
});
test.each([10, 12, 'ENOENT', 'ETIMEDOUT'])('classifies native result %s', async (code) => {
  execFile.mockImplementation((_file, _args, _options, callback) => callback({ code }));
  await expect(recoverOwner('/data/chain')).rejects.toMatchObject({ code: code === 10 ? 'CHECKPOINT_REBOOT_REQUIRED' : 'CHECKPOINT_OWNERSHIP' });
});
