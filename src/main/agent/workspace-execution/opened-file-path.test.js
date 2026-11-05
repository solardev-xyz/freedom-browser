'use strict';

const os = require('node:os');
const path = require('node:path');

jest.mock('./windows-sandbox-runtime', () => ({
  resolveWindowsSandbox: jest.fn(async () => ({ executablePath: 'helper.exe' })),
}));
jest.mock('./windows-sandbox-process', () => ({
  runWindowsSandbox: jest.fn(async () => ({
    terminal: { exitCode: 0 },
    stdout: Buffer.from('hello').toString('base64'),
  })),
}));

const { resolveWindowsSandbox } = require('./windows-sandbox-runtime');
const { runWindowsSandbox } = require('./windows-sandbox-process');
const { readWindowsWorkspaceFile } = require('./opened-file-path');

describe('readWindowsWorkspaceFile', () => {
  beforeEach(() => jest.clearAllMocks());

  test("defaults to the executor's sandbox home and the bundled helpers", async () => {
    const bytes = await readWindowsWorkspaceFile('C:\\ws', 'hello.txt', 1024);
    expect(bytes.toString()).toBe('hello');
    expect(resolveWindowsSandbox).toHaveBeenCalledWith({});
    expect(runWindowsSandbox.mock.calls[0][1]).toMatchObject({
      operation: 'read-file',
      workspace: 'C:\\ws',
      readPath: 'hello.txt',
      home: path.join(process.env.LOCALAPPDATA || os.homedir(), 'FreedomBrowser', 'Sandbox'),
    });
  });

  test('uses the same home and helper directory as the executor it qualifies', async () => {
    // qualify-windows-workspace.js --home X --runtime Y must read through X's
    // accounts with Y's helpers, like every other check in that run.
    await readWindowsWorkspaceFile('C:\\ws', 'hello.txt', 1024, {
      home: 'D:\\other-home',
      directory: 'D:\\install\\windows-workspace',
    });
    expect(resolveWindowsSandbox).toHaveBeenCalledWith({
      home: 'D:\\other-home',
      directory: 'D:\\install\\windows-workspace',
    });
    expect(runWindowsSandbox.mock.calls[0][1].home).toBe('D:\\other-home');
  });
});
