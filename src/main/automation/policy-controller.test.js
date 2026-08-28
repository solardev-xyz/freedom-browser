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

  test('classifies node status as read-only observation', async () => {
    expect(OPERATION_CLASSES[OPERATIONS.NODE_STATUS]).toBe('observe');
    await expect(
      createInitialAutomationPolicy().authorize({ operation: OPERATIONS.NODE_STATUS })
    ).resolves.toEqual({ allowed: true, operationClass: 'observe' });
  });

  test('classifies raw diagnostics as observation while execution still requires disclosure', () => {
    expect(OPERATION_CLASSES[OPERATIONS.NODE_DIAGNOSTICS]).toBe('observe');
    expect(OPERATION_CLASSES[OPERATIONS.APP_DIAGNOSTICS]).toBe('observe');
  });
});
