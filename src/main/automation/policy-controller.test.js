'use strict';

const { OPERATIONS } = require('./contract/operations');
const { createInitialAutomationPolicy, OPERATION_CLASSES } = require('./policy-controller');

describe('AutomationPolicyController', () => {
  test('does not give the legacy wallet action alias privileged click authority', async () => {
    expect(OPERATION_CLASSES[OPERATIONS.WALLET_ACTION]).toBe('interact');
    await expect(
      createInitialAutomationPolicy().authorize({ operation: OPERATIONS.WALLET_ACTION })
    ).resolves.toEqual({ allowed: true, operationClass: 'interact' });
  });
});
