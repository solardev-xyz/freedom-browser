'use strict';

const fs = require('fs');
const { workspaceGitCommand } = require('./workspace-git-command');
const { ManagedWorkspaceHistory } = require('./managed-workspace-history');

describe('installed Git availability', () => {
  test('does not launch the macOS installer shim or search unrelated host paths', () => {
    const accessible = jest.fn(() => false);
    expect(workspaceGitCommand('darwin', accessible)).toBe(null);
    expect(accessible.mock.calls).toEqual([['/Library/Developer/CommandLineTools/usr/bin/git']]);
    expect(workspaceGitCommand('linux', () => true)).toBe('/usr/bin/git');
    expect(workspaceGitCommand('win32', () => true)).toBe(null);
  });

  test('missing Git produces an explicit history-unavailable result before reading project metadata', async () => {
    const access = jest.spyOn(fs, 'accessSync').mockImplementation(() => {
      throw new Error('Unavailable');
    });
    try {
      await expect(
        new ManagedWorkspaceHistory('/not-a-real-workspace').list()
      ).rejects.toMatchObject({
        code: 'WORKSPACE_HISTORY_UNAVAILABLE',
        message: expect.stringContaining('Project editing remains available'),
      });
    } finally {
      access.mockRestore();
    }
  });
});
