'use strict';

const crypto = require('crypto');
const { AutomationError, ERROR_CODES } = require('./contract/errors');

const REQUIRED_ADAPTER_METHODS = [
  'getState',
  'navigate',
  'snapshot',
  'click',
  'type',
  'screenshot',
  'wait',
  'stopLoading',
];

function defaultTabIdFactory() {
  return `tab_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('Automation page adapter must be an object');
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`Automation page adapter is missing ${method}()`);
    }
  }
}

class PageRegistry {
  constructor({ tabIdFactory = defaultTabIdFactory } = {}) {
    this.tabIdFactory = tabIdFactory;
    this.entries = new Map();
    this.tabsByAdapter = new WeakMap();
  }

  register(adapter, metadata = {}) {
    validateAdapter(adapter);
    const existingTabId = this.tabsByAdapter.get(adapter);
    if (existingTabId) return existingTabId;

    const tabId = this.tabIdFactory();
    if (typeof tabId !== 'string' || !tabId || this.entries.has(tabId)) {
      throw new Error('Automation tab ID factory returned an invalid or duplicate ID');
    }

    const onDestroyed = () => this.unregister(tabId);
    if (typeof adapter.on === 'function') adapter.on('destroyed', onDestroyed);
    this.entries.set(tabId, {
      tabId,
      adapter,
      kind: metadata.kind || 'unknown',
      onDestroyed,
    });
    this.tabsByAdapter.set(adapter, tabId);
    return tabId;
  }

  unregister(tabId) {
    const entry = this.entries.get(tabId);
    if (!entry) return false;
    if (typeof entry.adapter.off === 'function') {
      entry.adapter.off('destroyed', entry.onDestroyed);
    }
    this.tabsByAdapter.delete(entry.adapter);
    this.entries.delete(tabId);
    return true;
  }

  require(tabId) {
    const entry = this.entries.get(tabId);
    if (!entry) {
      throw new AutomationError(ERROR_CODES.TAB_NOT_FOUND, `Automation tab not found: ${tabId}`);
    }
    return entry;
  }

  list() {
    return [...this.entries.values()].map((entry) => ({
      tabId: entry.tabId,
      kind: entry.kind,
      ...entry.adapter.getState(),
    }));
  }
}

module.exports = {
  PageRegistry,
};
