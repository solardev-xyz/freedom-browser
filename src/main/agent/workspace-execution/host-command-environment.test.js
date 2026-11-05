'use strict';

const os = require('os');
const path = require('path');
const {
  captureHostCommandEnvironment,
  capturedPath,
  mergePaths,
} = require('./host-command-environment');

describe('host command environment', () => {
  test('extracts a bounded absolute PATH from noisy login-shell output', () => {
    expect(
      capturedPath(
        'profile output\n__FREEDOM_USER_PATH_BEGIN_7D3D3A0C__/custom/bin:/usr/bin__FREEDOM_USER_PATH_END_7D3D3A0C__\nprompt'
      )
    ).toBe('/custom/bin:/usr/bin');
    expect(capturedPath('profile output without markers')).toBeNull();
    expect(
      capturedPath('__FREEDOM_USER_PATH_BEGIN_7D3D3A0C__relative__FREEDOM_USER_PATH_END_7D3D3A0C__')
    ).toBeNull();
  });

  test('merges shell and inherited paths without duplicates or relative entries', () => {
    expect(mergePaths('/custom/bin:/usr/bin:relative', '/usr/bin:/bin')).toBe(
      ['/custom/bin', '/usr/bin', '/bin'].join(path.delimiter)
    );
  });

  test('captures only PATH from the configured login shell with bounded execution', async () => {
    const run = jest.fn(async (_shell, _args, options) => ({
      exitCode: 0,
      stdout:
        'welcome\n__FREEDOM_USER_PATH_BEGIN_7D3D3A0C__/custom/bin:/usr/bin__FREEDOM_USER_PATH_END_7D3D3A0C__',
      options,
    }));

    const environment = await captureHostCommandEnvironment({
      platform: process.platform === 'win32' ? 'darwin' : process.platform,
      environment: { PATH: '/usr/bin:/bin', SECRET: 'not-returned' },
      userInfo: { shell: process.execPath, homedir: os.tmpdir() },
      run,
    });

    expect(environment).toEqual({
      PATH: ['/custom/bin', '/usr/bin', '/bin'].join(path.delimiter),
      source: 'login_shell',
    });
    expect(environment.SECRET).toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-ilc', expect.stringContaining('"$PATH"')]),
      expect.objectContaining({
        detached: true,
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 128 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  });

  test('falls back to the inherited process PATH when capture fails closed', async () => {
    const environment = await captureHostCommandEnvironment({
      platform: process.platform === 'win32' ? 'linux' : process.platform,
      environment: { PATH: '/usr/bin:/bin' },
      userInfo: { shell: process.execPath, homedir: os.tmpdir() },
      run: async () => ({ exitCode: 1, stdout: 'profile failed' }),
    });

    expect(environment).toEqual({ PATH: '/usr/bin:/bin', source: 'process' });
  });
});
