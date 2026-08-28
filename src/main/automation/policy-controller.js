'use strict';

const { OPERATIONS } = require('./contract/operations');

const OPERATION_CLASSES = Object.freeze({
  [OPERATIONS.LIST_TABS]: 'observe',
  [OPERATIONS.CREATE_TAB]: 'control',
  [OPERATIONS.GET_TAB]: 'observe',
  [OPERATIONS.FOCUS_TAB]: 'control',
  [OPERATIONS.CLOSE_TAB]: 'control',
  [OPERATIONS.SNAPSHOT]: 'observe',
  [OPERATIONS.SCREENSHOT]: 'observe',
  [OPERATIONS.WAIT]: 'observe',
  [OPERATIONS.NAVIGATE]: 'navigate',
  [OPERATIONS.CLICK]: 'interact',
  [OPERATIONS.TYPE]: 'interact',
  [OPERATIONS.SELECT]: 'interact',
  [OPERATIONS.PRESS]: 'interact',
  [OPERATIONS.UPLOAD]: 'transfer',
  [OPERATIONS.DOWNLOAD]: 'transfer',
  [OPERATIONS.WALLET_ACTION]: 'interact',
  [OPERATIONS.WALLET_TRANSFER]: 'privileged',
  [OPERATIONS.NODE_STATUS]: 'observe',
  [OPERATIONS.NODE_REQUEST]: 'privileged',
  [OPERATIONS.NODE_DIAGNOSTICS]: 'observe',
  [OPERATIONS.APP_DIAGNOSTICS]: 'observe',
  [OPERATIONS.LIST_DOWNLOADS]: 'observe',
  [OPERATIONS.STOP_LOADING]: 'control',
});

class AutomationPolicyController {
  constructor({ allowedClasses = [] } = {}) {
    this.allowedClasses = new Set(allowedClasses);
  }

  async authorize({ operation }) {
    const operationClass = OPERATION_CLASSES[operation];
    if (!operationClass || !this.allowedClasses.has(operationClass)) {
      return {
        allowed: false,
        reason: `Automation operation class is not enabled: ${operationClass || 'unknown'}`,
      };
    }
    return { allowed: true, operationClass };
  }
}

function createInitialAutomationPolicy() {
  // The kernel has no external transport in WP1. This explicit allowlist
  // enables the vertical spike while ensuring every call already crosses the
  // policy boundary. Later work replaces these class-wide grants with
  // capability manifests, origin scopes, and approval decisions.
  return new AutomationPolicyController({
    allowedClasses: ['observe', 'navigate', 'interact', 'control', 'transfer', 'privileged'],
  });
}

module.exports = {
  OPERATION_CLASSES,
  AutomationPolicyController,
  createInitialAutomationPolicy,
};
