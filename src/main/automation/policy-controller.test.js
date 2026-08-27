'use strict';

const { OPERATIONS } = require('./contract/operations');
const { createInitialAutomationPolicy, OPERATION_CLASSES } = require('./policy-controller');

describe('AutomationPolicyController', () => {
  test('routes wallet actions through the privileged operation class', async () => {
    expect(OPERATION_CLASSES[OPERATIONS.WALLET_ACTION]).toBe('privileged');
    await expect(
      createInitialAutomationPolicy().authorize({ operation: OPERATIONS.WALLET_ACTION })
    ).resolves.toEqual({ allowed: true, operationClass: 'privileged' });
  });
});
