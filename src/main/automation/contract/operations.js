'use strict';

const { invalidArgument } = require('./errors');
const {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  OPERATIONS,
} = require('../../../shared/automation-operations');

const OPERATION_SET = new Set(Object.values(OPERATIONS));
const TAB_OPERATIONS = new Set([
  OPERATIONS.GET_TAB,
  OPERATIONS.FOCUS_TAB,
  OPERATIONS.CLOSE_TAB,
  OPERATIONS.NAVIGATE,
  OPERATIONS.SNAPSHOT,
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.PRESS,
  OPERATIONS.SCREENSHOT,
  OPERATIONS.WAIT,
  OPERATIONS.STOP_LOADING,
]);
const ALLOWED_NAVIGATION_SCHEMES = new Set(['http:', 'https:', 'bzz:', 'ipfs:', 'ipns:']);
const WAIT_CONDITIONS = new Set(['load', 'navigation', 'text', 'url']);
const PRESS_KEYS = Object.freeze([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
  'Space',
]);
const PRESS_KEY_SET = new Set(PRESS_KEYS);

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
  if (!ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol)) {
    throw invalidArgument(`Navigation to ${parsed.protocol} URLs is not allowed`, {
      field: 'url',
      protocol: parsed.protocol,
    });
  }
  if (parsed.username || parsed.password) {
    throw invalidArgument('Navigation URLs must not contain embedded credentials', {
      field: 'url',
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

  if (operation === OPERATIONS.CREATE_TAB) {
    normalized.url = validateNavigationUrl(input.url);
    if (input.openerTabId !== undefined) {
      normalized.openerTabId = requireString(input.openerTabId, 'openerTabId').trim();
    }
  }

  if (
    operation === OPERATIONS.CLICK ||
    operation === OPERATIONS.TYPE ||
    operation === OPERATIONS.SELECT ||
    operation === OPERATIONS.PRESS
  ) {
    normalized.ref = requireString(input.ref, 'ref').trim();
  }

  if (operation === OPERATIONS.TYPE) {
    normalized.text = requireString(input.text, 'text', { allowEmpty: true });
    normalized.replace = input.replace !== false;
  }

  if (operation === OPERATIONS.SELECT) {
    normalized.value = requireString(input.value, 'value', { allowEmpty: true });
  }

  if (operation === OPERATIONS.PRESS) {
    normalized.key = requireString(input.key, 'key').trim();
    if (!PRESS_KEY_SET.has(normalized.key)) {
      throw invalidArgument(`key must be one of: ${PRESS_KEYS.join(', ')}`, { field: 'key' });
    }
  }

  if (operation === OPERATIONS.WAIT) {
    normalized.condition = requireString(input.condition, 'condition').trim();
    if (!WAIT_CONDITIONS.has(normalized.condition)) {
      throw invalidArgument('condition must be one of: load, navigation, text, url', {
        field: 'condition',
      });
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
      throw invalidArgument(`timeoutMs must be an integer between 1 and ${MAX_WAIT_TIMEOUT_MS}`, {
        field: 'timeoutMs',
      });
    }
    normalized.timeoutMs = timeoutMs;
    if (normalized.condition === 'text') {
      normalized.text = requireString(input.text, 'text');
    }
    if (normalized.condition === 'url') {
      normalized.url = validateNavigationUrl(input.url);
    }
    if (normalized.condition === 'navigation') {
      if (!Number.isInteger(input.sinceNavigationId) || input.sinceNavigationId < 0) {
        throw invalidArgument('sinceNavigationId must be a non-negative integer', {
          field: 'sinceNavigationId',
        });
      }
      normalized.sinceNavigationId = input.sinceNavigationId;
    }
  }

  return normalized;
}

module.exports = {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  OPERATIONS,
  PRESS_KEYS,
  validateOperationInput,
};
