'use strict';

const { AutomationController } = require('./automation-controller');
const { createInitialAutomationPolicy } = require('./policy-controller');
const { WebContentsPageAdapter } = require('./adapters/web-contents-page-adapter');

function createAutomationRuntime(options = {}) {
  const controller =
    options.controller ||
    new AutomationController({
      policyController: options.policyController || createInitialAutomationPolicy(),
      ...options.controllerOptions,
    });
  const adapters = new WeakMap();

  function registerWebContents(webContents, metadata = {}) {
    const existing = adapters.get(webContents);
    if (existing) return existing.tabId;

    const adapter = new WebContentsPageAdapter(webContents, { kind: metadata.kind });
    const tabId = controller.registerPage(adapter, metadata);
    const registration = { adapter, tabId };
    adapters.set(webContents, registration);
    adapter.once('destroyed', () => {
      controller.unregisterPage(tabId);
      adapters.delete(webContents);
    });
    return tabId;
  }

  function attachToHostWebContents(hostWebContents) {
    if (!hostWebContents || typeof hostWebContents.on !== 'function') {
      throw new TypeError('attachToHostWebContents requires host WebContents');
    }
    const onAttached = (_event, guestWebContents) => {
      registerWebContents(guestWebContents, { kind: 'desktop' });
    };
    hostWebContents.on('did-attach-webview', onAttached);
    return () => hostWebContents.off?.('did-attach-webview', onAttached);
  }

  return {
    controller,
    registerWebContents,
    attachToHostWebContents,
  };
}

const defaultRuntime = createAutomationRuntime();

module.exports = {
  createAutomationRuntime,
  automationController: defaultRuntime.controller,
  registerAutomationWebContents: defaultRuntime.registerWebContents,
  attachAutomationToHostWebContents: defaultRuntime.attachToHostWebContents,
};
