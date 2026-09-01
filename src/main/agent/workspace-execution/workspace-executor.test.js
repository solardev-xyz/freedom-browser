'use strict';

const { BubblewrapExecutor } = require('./bubblewrap-backend');
const { SeatbeltExecutor } = require('./seatbelt-backend');
const { createWorkspaceExecutor } = require('./workspace-executor');

describe('backend-neutral workspace executor selection', () => {
  test('selects a backend without requiring callers to import platform implementations', () => {
    expect(createWorkspaceExecutor({ platform: 'darwin' })).toBeInstanceOf(SeatbeltExecutor);
    expect(createWorkspaceExecutor({ platform: 'linux' })).toBeInstanceOf(BubblewrapExecutor);
  });

  test('returns structured capabilities and receipts on unsupported platforms', async () => {
    const executor = createWorkspaceExecutor({ platform: 'win32' });
    await expect(executor.detectCapabilities()).resolves.toMatchObject({
      backend: 'unavailable',
      available: false,
      denial: { code: 'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE' },
    });
    await expect(executor.execute()).resolves.toMatchObject({
      backend: 'unavailable',
      state: 'sandbox_denied',
      terminationGuarantee: 'not_applicable',
      error: { code: 'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE' },
    });
  });
});
