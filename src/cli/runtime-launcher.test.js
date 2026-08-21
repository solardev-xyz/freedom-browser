'use strict';

const { waitForRuntime } = require('./runtime-launcher');

describe('Freedom CLI runtime launcher', () => {
  const profile = {
    id: 'automation',
    userDataDir: '/tmp/freedom-cli-locked-profile',
  };

  test('preserves the runtime profile-lock exit contract', async () => {
    await expect(
      waitForRuntime(profile, { child: { exitCode: 11, signalCode: null } })
    ).rejects.toMatchObject({
      code: 'PROFILE_LOCKED',
      exitCode: 11,
      details: { profileId: 'automation' },
    });
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
