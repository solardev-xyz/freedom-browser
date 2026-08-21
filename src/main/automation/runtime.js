'use strict';

const { AutomationController } = require('./automation-controller');
const { createInitialAutomationPolicy } = require('./policy-controller');
const { WebContentsPageAdapter } = require('./adapters/web-contents-page-adapter');
const IPC = require('../../shared/ipc-channels');

function defaultIsPrivateWebContents(webContents) {
  return require('../private/private-windows').isPrivateWebContents(webContents);
}

function createAutomationRuntime(options = {}) {
  const controller =
    options.controller ||
    new AutomationController({
      policyController: options.policyController || createInitialAutomationPolicy(),
      ...options.controllerOptions,
    });
  const adapters = new WeakMap();
  const desktopBindingsByHost = new WeakMap();
  const desktopBindingsByAutomationTab = new Map();
  const isPrivateWebContents = options.isPrivateWebContents || defaultIsPrivateWebContents;

  function registerWebContents(webContents, metadata = {}) {
    try {
      if (isPrivateWebContents(webContents)) return null;
    } catch {
      // Privacy classification is an eligibility gate. If it cannot be
      // evaluated reliably, keep the page outside the automation context.
      return null;
    }
    const existing = adapters.get(webContents);
    if (existing) return existing.tabId;

    const adapter = new WebContentsPageAdapter(webContents, { kind: metadata.kind });
    const tabId = controller.registerPage(adapter, metadata);
    const registration = { adapter, tabId };
    adapters.set(webContents, registration);
    const onCreatedWindow = (...args) => {
      const childWindow = args.find((value) => value?.webContents);
      if (childWindow?.webContents) {
        registerWebContents(childWindow.webContents, { kind: 'popup', openerTabId: tabId });
      }
    };
    webContents.on?.('did-create-window', onCreatedWindow);
    adapter.once('destroyed', () => {
      webContents.off?.('did-create-window', onCreatedWindow);
      const desktopBinding = desktopBindingsByAutomationTab.get(tabId);
      if (desktopBinding) {
        desktopBinding.bindingsByRendererTab.delete(desktopBinding.rendererTabId);
      }
      desktopBindingsByAutomationTab.delete(tabId);
      controller.unregisterPage(tabId);
      adapters.delete(webContents);
    });
    return tabId;
  }

  function attachToHostWebContents(hostWebContents, { ipcMain } = {}) {
    if (!hostWebContents || typeof hostWebContents.on !== 'function') {
      throw new TypeError('attachToHostWebContents requires host WebContents');
    }
    const guestsById = new Map();
    const bindingsByRendererTab = new Map();
    desktopBindingsByHost.set(hostWebContents, bindingsByRendererTab);
    const onAttached = (_event, guestWebContents) => {
      const tabId = registerWebContents(guestWebContents, { kind: 'desktop' });
      if (!tabId) return;
      if (Number.isInteger(guestWebContents.id)) {
        const guestWebContentsId = guestWebContents.id;
        guestsById.set(guestWebContentsId, guestWebContents);
        guestWebContents.once?.('destroyed', () => guestsById.delete(guestWebContentsId));
      }
    };
    const onBindTab = (event, payload = {}) => {
      if (event?.sender !== hostWebContents) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const { rendererTabId, guestWebContentsId } = payload;
      if (!Number.isSafeInteger(rendererTabId) || rendererTabId < 1) return;
      if (!Number.isSafeInteger(guestWebContentsId) || guestWebContentsId < 1) return;
      const guestWebContents = guestsById.get(guestWebContentsId);
      if (!guestWebContents) return;
      try {
        if (guestWebContents.hostWebContents !== hostWebContents) return;
      } catch {
        return;
      }
      const registration = adapters.get(guestWebContents);
      if (!registration) return;

      const previousBinding = desktopBindingsByAutomationTab.get(registration.tabId);
      if (previousBinding) {
        previousBinding.bindingsByRendererTab.delete(previousBinding.rendererTabId);
      }
      const replacedTabId = bindingsByRendererTab.get(rendererTabId);
      if (replacedTabId && replacedTabId !== registration.tabId) {
        desktopBindingsByAutomationTab.delete(replacedTabId);
      }
      bindingsByRendererTab.set(rendererTabId, registration.tabId);
      desktopBindingsByAutomationTab.set(registration.tabId, {
        hostWebContents,
        rendererTabId,
        bindingsByRendererTab,
      });
    };
    hostWebContents.on('did-attach-webview', onAttached);
    ipcMain?.on?.(IPC.AUTOMATION_BIND_TAB, onBindTab);
    return () => {
      hostWebContents.off?.('did-attach-webview', onAttached);
      ipcMain?.off?.(IPC.AUTOMATION_BIND_TAB, onBindTab);
      for (const automationTabId of bindingsByRendererTab.values()) {
        desktopBindingsByAutomationTab.delete(automationTabId);
      }
      desktopBindingsByHost.delete(hostWebContents);
    };
  }

  function automationTabIdForRenderer(hostWebContents, rendererTabId) {
    return desktopBindingsByHost.get(hostWebContents)?.get(rendererTabId) || null;
  }

  function desktopBindingForAutomationTab(tabId) {
    const binding = desktopBindingsByAutomationTab.get(tabId);
    if (!binding) return null;
    return { hostWebContents: binding.hostWebContents, rendererTabId: binding.rendererTabId };
  }

  return {
    controller,
    registerWebContents,
    attachToHostWebContents,
    automationTabIdForRenderer,
    desktopBindingForAutomationTab,
  };
}

const defaultRuntime = createAutomationRuntime();

module.exports = {
  createAutomationRuntime,
  automationController: defaultRuntime.controller,
  registerAutomationWebContents: defaultRuntime.registerWebContents,
  attachAutomationToHostWebContents: defaultRuntime.attachToHostWebContents,
  automationTabIdForRenderer: defaultRuntime.automationTabIdForRenderer,
  desktopBindingForAutomationTab: defaultRuntime.desktopBindingForAutomationTab,
};
