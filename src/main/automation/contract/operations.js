'use strict';

const { invalidArgument } = require('./errors');

const OPERATIONS = Object.freeze({
  LIST_TABS: 'browser_list_tabs',
  GET_TAB: 'browser_get_tab',
  NAVIGATE: 'browser_navigate',
  SNAPSHOT: 'browser_snapshot',
  CLICK: 'browser_click',
  TYPE: 'browser_type',
  SCREENSHOT: 'browser_screenshot',
  STOP_LOADING: 'browser_stop_loading',
});

const OPERATION_SET = new Set(Object.values(OPERATIONS));
const TAB_OPERATIONS = new Set([
  OPERATIONS.GET_TAB,
  OPERATIONS.NAVIGATE,
  OPERATIONS.SNAPSHOT,
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SCREENSHOT,
  OPERATIONS.STOP_LOADING,
]);
const BLOCKED_NAVIGATION_SCHEMES = new Set(['data:', 'file:', 'javascript:']);

function requireObject(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidArgument('Operation input must be an object');
  }
  return input;
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw invalidArgument(`${field} must be a${allowEmpty ? '' : ' non-empty'} string`, {
      field,
    });
  }
  return value;
}

function validateNavigationUrl(value) {
  const url = requireString(value, 'url').trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidArgument('url must be an absolute URL', { field: 'url' });
  }
  if (BLOCKED_NAVIGATION_SCHEMES.has(parsed.protocol)) {
    throw invalidArgument(`Navigation to ${parsed.protocol} URLs is not allowed`, {
      field: 'url',
      protocol: parsed.protocol,
    });
  }
  return url;
}

function validateOperationInput(operation, rawInput) {
  if (!OPERATION_SET.has(operation)) {
    throw invalidArgument(`Unknown automation operation: ${String(operation)}`, {
      field: 'operation',
    });
  }

  const input = requireObject(rawInput);
  const normalized = {};

  if (TAB_OPERATIONS.has(operation)) {
    normalized.tabId = requireString(input.tabId, 'tabId').trim();
  }

  if (operation === OPERATIONS.NAVIGATE) {
    normalized.url = validateNavigationUrl(input.url);
  }

  if (operation === OPERATIONS.CLICK || operation === OPERATIONS.TYPE) {
    normalized.ref = requireString(input.ref, 'ref').trim();
  }

  if (operation === OPERATIONS.TYPE) {
    normalized.text = requireString(input.text, 'text', { allowEmpty: true });
    normalized.replace = input.replace !== false;
  }

  return normalized;
}

module.exports = {
  OPERATIONS,
  validateOperationInput,
};
