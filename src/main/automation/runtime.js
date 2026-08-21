'use strict';

const crypto = require('crypto');
const { AutomationController } = require('./automation-controller');
const { createInitialAutomationPolicy } = require('./policy-controller');
const { WebContentsPageAdapter } = require('./adapters/web-contents-page-adapter');
const { AutomationError, ERROR_CODES } = require('./contract/errors');
const IPC = require('../../shared/ipc-channels');

const DEFAULT_DESKTOP_NAVIGATION_TIMEOUT_MS = 330_000;

function defaultNavigationRequestIdFactory() {
  return `nav_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

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
  const navigationRequestIdFactory =
    options.navigationRequestIdFactory || defaultNavigationRequestIdFactory;
  const desktopNavigationTimeoutMs =
    options.desktopNavigationTimeoutMs || DEFAULT_DESKTOP_NAVIGATION_TIMEOUT_MS;

  async function navigateDesktopTab(tabId, url) {
    const binding = desktopBindingsByAutomationTab.get(tabId);
    if (!binding) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The desktop tab is not ready for controlled navigation',
        { retryable: true, suggestedAction: 'Wait for the tab to finish attaching and retry' }
      );
    }
    await binding.requestNavigation(url);
  }

  async function stopDesktopTab(tabId, webContents) {
    const binding = desktopBindingsByAutomationTab.get(tabId);
    if (binding) {
      binding.stopLoading();
    } else {
      webContents.stop?.();
    }
  }

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

    let tabId;
    const adapter = new WebContentsPageAdapter(webContents, {
      kind: metadata.kind,
      ...(metadata.kind === 'desktop' && {
        navigate: (url) => navigateDesktopTab(tabId, url),
        stopLoading: () => stopDesktopTab(tabId, webContents),
      }),
    });
    tabId = controller.registerPage(adapter, metadata);
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
    const pendingNavigationRequests = new Map();
    desktopBindingsByHost.set(hostWebContents, bindingsByRendererTab);

    const settleNavigationRequest = (request, error = null) => {
      if (!pendingNavigationRequests.delete(request.requestId)) return;
      clearTimeout(request.timeout);
      request.cleanup();
      if (error) request.reject(error);
      else request.resolve();
    };

    const requestNavigation = (guestWebContents, rendererTabId, url) =>
      new Promise((resolve, reject) => {
        const requestId = navigationRequestIdFactory();
        let acknowledged = false;
        let navigationStarted = false;
        let navigationCompleted = false;
        const request = {
          requestId,
          guestWebContents,
          resolve,
          reject,
          timeout: null,
          cleanup: () => {},
        };
        const completeWhenReady = () => {
          if (acknowledged && navigationCompleted) settleNavigationRequest(request);
        };
        const onStarted = (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame !== false && isInPlace !== true) navigationStarted = true;
        };
        const onStopped = () => {
          if (!navigationStarted) return;
          navigationCompleted = true;
          completeWhenReady();
        };
        const onInPage = (_event, _url, isMainFrame) => {
          if (isMainFrame === false) return;
          navigationCompleted = true;
          completeWhenReady();
        };
        const onFailed = (_event, _code, description, _url, isMainFrame) => {
          if (isMainFrame === false || !navigationStarted) return;
          settleNavigationRequest(
            request,
            new AutomationError(
              ERROR_CODES.NAVIGATION_FAILED,
              description || 'The desktop tab failed to navigate',
              { retryable: true }
            )
          );
        };
        const onDestroyed = () => {
          settleNavigationRequest(
            request,
            new AutomationError(ERROR_CODES.TAB_NOT_FOUND, 'The desktop tab was closed')
          );
        };
        request.cleanup = () => {
          guestWebContents.off?.('did-start-navigation', onStarted);
          guestWebContents.off?.('did-stop-loading', onStopped);
          guestWebContents.off?.('did-navigate-in-page', onInPage);
          guestWebContents.off?.('did-fail-load', onFailed);
          guestWebContents.off?.('destroyed', onDestroyed);
        };
        request.acknowledge = (ok) => {
          if (!ok) {
            settleNavigationRequest(
              request,
              new AutomationError(
                ERROR_CODES.NAVIGATION_FAILED,
                'The browser chrome rejected controlled navigation',
                { retryable: true }
              )
            );
            return;
          }
          acknowledged = true;
          completeWhenReady();
        };
        guestWebContents.on?.('did-start-navigation', onStarted);
        guestWebContents.on?.('did-stop-loading', onStopped);
        guestWebContents.on?.('did-navigate-in-page', onInPage);
        guestWebContents.on?.('did-fail-load', onFailed);
        guestWebContents.on?.('destroyed', onDestroyed);
        request.timeout = setTimeout(() => {
          try {
            hostWebContents.send(IPC.AUTOMATION_STOP_LOADING, { rendererTabId });
          } catch {
            guestWebContents.stop?.();
          }
          settleNavigationRequest(
            request,
            new AutomationError(
              ERROR_CODES.NAVIGATION_FAILED,
              'Timed out waiting for desktop navigation',
              { retryable: true }
            )
          );
        }, desktopNavigationTimeoutMs);
        pendingNavigationRequests.set(requestId, request);

        try {
          hostWebContents.send(IPC.AUTOMATION_NAVIGATE, { requestId, rendererTabId, url });
        } catch (error) {
          settleNavigationRequest(
            request,
            new AutomationError(
              ERROR_CODES.NAVIGATION_FAILED,
              'The browser chrome could not receive controlled navigation',
              { retryable: true, cause: error }
            )
          );
        }
      });
    const stopNavigation = (guestWebContents, rendererTabId) => {
      try {
        hostWebContents.send(IPC.AUTOMATION_STOP_LOADING, { rendererTabId });
      } catch {
        guestWebContents.stop?.();
      }
      for (const request of [...pendingNavigationRequests.values()]) {
        if (request.guestWebContents !== guestWebContents) continue;
        settleNavigationRequest(
          request,
          new AutomationError(ERROR_CODES.USER_CANCELLED, 'Desktop navigation was cancelled', {
            retryable: true,
          })
        );
      }
    };
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
        requestNavigation: (url) => requestNavigation(guestWebContents, rendererTabId, url),
        stopLoading: () => stopNavigation(guestWebContents, rendererTabId),
      });
    };
    const onNavigationResult = (event, payload = {}) => {
      if (event?.sender !== hostWebContents) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      const request = pendingNavigationRequests.get(payload.requestId);
      if (!request || typeof payload.ok !== 'boolean') return;
      request.acknowledge(payload.ok);
    };
    hostWebContents.on('did-attach-webview', onAttached);
    ipcMain?.on?.(IPC.AUTOMATION_BIND_TAB, onBindTab);
    ipcMain?.on?.(IPC.AUTOMATION_NAVIGATE_RESULT, onNavigationResult);
    return () => {
      hostWebContents.off?.('did-attach-webview', onAttached);
      ipcMain?.off?.(IPC.AUTOMATION_BIND_TAB, onBindTab);
      ipcMain?.off?.(IPC.AUTOMATION_NAVIGATE_RESULT, onNavigationResult);
      for (const request of [...pendingNavigationRequests.values()]) {
        settleNavigationRequest(
          request,
          new AutomationError(ERROR_CODES.TAB_NOT_FOUND, 'The browser window was closed')
        );
      }
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
