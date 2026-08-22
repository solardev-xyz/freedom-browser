'use strict';

const { CliError } = require('./errors');
const { waitForRuntime } = require('./runtime-launcher');

describe('Freedom CLI runtime launcher', () => {
  const profile = {
    id: 'automation',
    userDataDir: '/tmp/freedom-cli-locked-profile',
  };

  test('preserves the runtime profile-lock exit contract', async () => {
    const connectRuntime = jest
      .fn()
      .mockRejectedValue(new CliError('RUNTIME_UNAVAILABLE', 'not running', { exitCode: 10 }));
    await expect(
      waitForRuntime(profile, {
        child: { exitCode: 11, signalCode: null },
        connectRuntime,
        startCollisionGraceMs: 0,
      })
    ).rejects.toMatchObject({
      code: 'PROFILE_LOCKED',
      exitCode: 11,
      details: { profileId: 'automation' },
    });
    expect(connectRuntime).toHaveBeenCalledTimes(1);
  });

  test('attaches to the winning runtime after a concurrent start loses the profile lock', async () => {
    const connection = { status: { state: 'ready' } };
    const connectRuntime = jest
      .fn()
      .mockRejectedValueOnce(
        new CliError('RUNTIME_UNAVAILABLE', 'still starting', { exitCode: 10 })
      )
      .mockResolvedValueOnce(connection);

    await expect(
      waitForRuntime(profile, {
        child: { exitCode: 11, signalCode: null },
        connectRuntime,
        startCollisionGraceMs: 100,
        startPollMs: 1,
      })
    ).resolves.toBe(connection);
    expect(connectRuntime).toHaveBeenCalledTimes(2);
  });

  test('reports other early runtime exits as unavailable', async () => {
    await expect(
      waitForRuntime(profile, { child: { exitCode: 1, signalCode: null } })
    ).rejects.toMatchObject({
      code: 'RUNTIME_START_FAILED',
      exitCode: 10,
      details: { runtimeExitCode: 1 },
    });
  });
});
