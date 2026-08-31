'use strict';

const { invalidArgument } = require('./errors');
const {
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  DEFAULT_DIAGNOSTIC_MAX_LINES,
  DEFAULT_WAIT_TIMEOUT_MS,
  DIAGNOSTIC_SERVICES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_LINES,
  MAX_NODE_REQUEST_BODY_BYTES,
  MAX_NODE_RESPONSE_BYTES,
  MAX_SWARM_PUBLISH_TEXT_BYTES,
  MAX_WAIT_TIMEOUT_MS,
  NODE_LIFECYCLE_SERVICES,
  NODE_REQUEST_SERVICES,
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
  OPERATIONS.UPLOAD,
  OPERATIONS.DOWNLOAD,
  OPERATIONS.WALLET_ACTION,
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
const DIAGNOSTIC_SERVICE_SET = new Set(DIAGNOSTIC_SERVICES);
const NODE_REQUEST_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const NODE_REQUEST_METHOD_SET = new Set(NODE_REQUEST_METHODS);
const NODE_REQUEST_SERVICE_SET = new Set(NODE_REQUEST_SERVICES);
const NODE_LIFECYCLE_SERVICE_SET = new Set(NODE_LIFECYCLE_SERVICES);
const NODE_LIFECYCLE_ACTIONS = Object.freeze(['start', 'stop', 'restart']);
const NODE_LIFECYCLE_ACTION_SET = new Set(NODE_LIFECYCLE_ACTIONS);
const NODE_REQUEST_HEADER_NAME = /^[a-z0-9][a-z0-9-]*$/;
const BLOCKED_NODE_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'referer',
]);
const MAX_INTERACTION_INTENT_LENGTH = 240;
const ATTACHMENT_RESOURCE_ID = /^(?:attachment|folder)_[a-f0-9]{20}$/;
const SWARM_PUBLICATION_NAME_MAX_LENGTH = 240;

function validateRelativePublicationPath(value, field) {
  const relativePath = requireString(value, field).trim();
  const segments = relativePath.split('/');
  if (
    relativePath.length > 1_024 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    containsControlCharacters(relativePath) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw invalidArgument(`${field} must be a safe relative path`, { field });
  }
  return relativePath;
}

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

function containsControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
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
    operation === OPERATIONS.PRESS ||
    operation === OPERATIONS.UPLOAD ||
    operation === OPERATIONS.DOWNLOAD ||
    operation === OPERATIONS.WALLET_ACTION
  ) {
    normalized.ref = requireString(input.ref, 'ref').trim();
  }

  if (
    [OPERATIONS.CLICK, OPERATIONS.TYPE, OPERATIONS.SELECT, OPERATIONS.PRESS].includes(operation) &&
    input.intent !== undefined
  ) {
    normalized.intent = requireString(input.intent, 'intent').trim();
    if (normalized.intent.length > MAX_INTERACTION_INTENT_LENGTH) {
      throw invalidArgument(
        `intent cannot exceed ${MAX_INTERACTION_INTENT_LENGTH} characters`,
        { field: 'intent' }
      );
    }
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

  if (operation === OPERATIONS.WALLET_TRANSFER) {
    normalized.recipient = requireString(input.recipient, 'recipient').trim();
    normalized.amount = requireString(input.amount, 'amount').trim();
    normalized.asset = requireString(input.asset, 'asset').trim();
    if (normalized.recipient.length > 255) {
      throw invalidArgument('recipient cannot exceed 255 characters', { field: 'recipient' });
    }
    if (normalized.amount.length > 80) {
      throw invalidArgument('amount cannot exceed 80 characters', { field: 'amount' });
    }
    if (normalized.asset.length > 80) {
      throw invalidArgument('asset cannot exceed 80 characters', { field: 'asset' });
    }
    if (input.chainId !== undefined) {
      if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) {
        throw invalidArgument('chainId must be a positive integer', { field: 'chainId' });
      }
      normalized.chainId = input.chainId;
    }
    if (input.walletIndex !== undefined) {
      if (!Number.isSafeInteger(input.walletIndex) || input.walletIndex < 0) {
        throw invalidArgument('walletIndex must be a non-negative integer', {
          field: 'walletIndex',
        });
      }
      normalized.walletIndex = input.walletIndex;
    }
  }

  if (operation === OPERATIONS.NODE_REQUEST) {
    normalized.service = requireString(input.service, 'service').trim();
    if (!NODE_REQUEST_SERVICE_SET.has(normalized.service)) {
      throw invalidArgument(`service must be one of: ${NODE_REQUEST_SERVICES.join(', ')}`, {
        field: 'service',
      });
    }
    normalized.transport = requireString(input.transport, 'transport').trim();
    const expectedTransport = normalized.service === 'ipfs' ? 'gateway' : 'http';
    if (normalized.transport !== expectedTransport) {
      throw invalidArgument(`transport must be ${expectedTransport} for ${normalized.service}`, {
        field: 'transport',
      });
    }
    const request = requireObject(input.request);
    const method = requireString(request.method, 'request.method').trim().toUpperCase();
    if (!NODE_REQUEST_METHOD_SET.has(method)) {
      throw invalidArgument(`request.method must be one of: ${NODE_REQUEST_METHODS.join(', ')}`, {
        field: 'request.method',
      });
    }
    if (normalized.service === 'ipfs' && !['GET', 'HEAD'].includes(method)) {
      throw invalidArgument('IPFS native gateway requests support only GET and HEAD', {
        field: 'request.method',
      });
    }
    const path = requireString(request.path, 'request.path').trim();
    if (
      path.length > 2_048 ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      containsControlCharacters(path)
    ) {
      throw invalidArgument('request.path must be a bounded absolute API path', {
        field: 'request.path',
      });
    }
    const headers = {};
    if (request.headers !== undefined) {
      const rawHeaders = requireObject(request.headers);
      const entries = Object.entries(rawHeaders);
      if (entries.length > 32) {
        throw invalidArgument('request.headers cannot contain more than 32 fields', {
          field: 'request.headers',
        });
      }
      for (const [rawName, rawValue] of entries) {
        const name = rawName.trim().toLowerCase();
        if (
          !NODE_REQUEST_HEADER_NAME.test(name) ||
          BLOCKED_NODE_REQUEST_HEADERS.has(name) ||
          name.startsWith('sec-') ||
          name.startsWith('proxy-')
        ) {
          throw invalidArgument(`request header is not allowed: ${rawName}`, {
            field: 'request.headers',
          });
        }
        const value = requireString(rawValue, `request.headers.${rawName}`, {
          allowEmpty: true,
        });
        if (value.length > 4_096 || /[\r\n]/.test(value)) {
          throw invalidArgument(`request header value is invalid: ${rawName}`, {
            field: 'request.headers',
          });
        }
        headers[name] = value;
      }
    }
    let body;
    if (request.body !== undefined) {
      body = requireString(request.body, 'request.body', { allowEmpty: true });
      if (Buffer.byteLength(body, 'utf8') > MAX_NODE_REQUEST_BODY_BYTES) {
        throw invalidArgument(
          `request.body cannot exceed ${MAX_NODE_REQUEST_BODY_BYTES} UTF-8 bytes`,
          { field: 'request.body' }
        );
      }
      if (method === 'GET' || method === 'HEAD') {
        throw invalidArgument(`${method} node requests cannot include a body`, {
          field: 'request.body',
        });
      }
    }
    normalized.request = {
      method,
      path,
      ...(Object.keys(headers).length && { headers }),
      ...(body !== undefined && { body }),
    };
  }

  if (operation === OPERATIONS.NODE_OPERATION_STATUS) {
    if (input.operationId !== undefined) {
      normalized.operationId = requireString(input.operationId, 'operationId').trim();
      if (!/^node_op_[a-f0-9]{24}$/.test(normalized.operationId)) {
        throw invalidArgument('operationId must be a Freedom node operation ID', {
          field: 'operationId',
        });
      }
    }
  }

  if (operation === OPERATIONS.NODE_LIFECYCLE) {
    normalized.service = requireString(input.service, 'service').trim();
    if (!NODE_LIFECYCLE_SERVICE_SET.has(normalized.service)) {
      throw invalidArgument(`service must be one of: ${NODE_LIFECYCLE_SERVICES.join(', ')}`, {
        field: 'service',
      });
    }
    normalized.action = requireString(input.action, 'action').trim();
    if (!NODE_LIFECYCLE_ACTION_SET.has(normalized.action)) {
      throw invalidArgument(`action must be one of: ${NODE_LIFECYCLE_ACTIONS.join(', ')}`, {
        field: 'action',
      });
    }
  }

  if (operation === OPERATIONS.NODE_DIAGNOSTICS || operation === OPERATIONS.APP_DIAGNOSTICS) {
    if (operation === OPERATIONS.NODE_DIAGNOSTICS) {
      normalized.service = requireString(input.service, 'service').trim();
      if (!DIAGNOSTIC_SERVICE_SET.has(normalized.service)) {
        throw invalidArgument(`service must be one of: ${DIAGNOSTIC_SERVICES.join(', ')}`, {
          field: 'service',
        });
      }
    }
    normalized.maxLines = input.maxLines ?? DEFAULT_DIAGNOSTIC_MAX_LINES;
    if (
      !Number.isSafeInteger(normalized.maxLines) ||
      normalized.maxLines < 1 ||
      normalized.maxLines > MAX_DIAGNOSTIC_LINES
    ) {
      throw invalidArgument(`maxLines must be an integer between 1 and ${MAX_DIAGNOSTIC_LINES}`, {
        field: 'maxLines',
      });
    }
    normalized.maxBytes = input.maxBytes ?? DEFAULT_DIAGNOSTIC_MAX_BYTES;
    if (
      !Number.isSafeInteger(normalized.maxBytes) ||
      normalized.maxBytes < 1_024 ||
      normalized.maxBytes > MAX_DIAGNOSTIC_BYTES
    ) {
      throw invalidArgument(`maxBytes must be an integer between 1024 and ${MAX_DIAGNOSTIC_BYTES}`, {
        field: 'maxBytes',
      });
    }
  }

  if (operation === OPERATIONS.SWARM_PUBLISH) {
    const hasResourceId = input.resourceId !== undefined;
    const hasText = input.text !== undefined;
    if (hasResourceId === hasText) {
      throw invalidArgument('Swarm publication requires exactly one resourceId or text field', {
        field: 'resourceId',
      });
    }
    if (hasResourceId) {
      normalized.resourceId = requireString(input.resourceId, 'resourceId').trim();
      if (!ATTACHMENT_RESOURCE_ID.test(normalized.resourceId)) {
        throw invalidArgument('resourceId must identify an attached file or folder', {
          field: 'resourceId',
        });
      }
    } else {
      normalized.text = requireString(input.text, 'text');
      if (Buffer.byteLength(normalized.text, 'utf8') > MAX_SWARM_PUBLISH_TEXT_BYTES) {
        throw invalidArgument(
          `text cannot exceed ${MAX_SWARM_PUBLISH_TEXT_BYTES} UTF-8 bytes`,
          { field: 'text' }
        );
      }
      normalized.name = requireString(input.name, 'name').trim();
      if (
        normalized.name.length > SWARM_PUBLICATION_NAME_MAX_LENGTH ||
        containsControlCharacters(normalized.name)
      ) {
        throw invalidArgument(
          `name cannot exceed ${SWARM_PUBLICATION_NAME_MAX_LENGTH} characters or contain controls`,
          { field: 'name' }
        );
      }
      normalized.contentType =
        input.contentType === undefined
          ? 'text/plain; charset=utf-8'
          : requireString(input.contentType, 'contentType').trim();
      if (normalized.contentType.length > 255 || containsControlCharacters(normalized.contentType)) {
        throw invalidArgument('contentType must be a bounded media type', {
          field: 'contentType',
        });
      }
    }
    if (input.indexDocument !== undefined) {
      if (!hasResourceId) {
        throw invalidArgument('indexDocument can only be used with an attached folder', {
          field: 'indexDocument',
        });
      }
      normalized.indexDocument = validateRelativePublicationPath(
        input.indexDocument,
        'indexDocument'
      );
    }
  }

  if (operation === OPERATIONS.SWARM_PUBLICATION_STATUS && input.publicationId !== undefined) {
    normalized.publicationId = requireString(input.publicationId, 'publicationId').trim();
    if (!/^swarm_pub_[a-f0-9]{24}$/.test(normalized.publicationId)) {
      throw invalidArgument('publicationId must be a Freedom Swarm publication ID', {
        field: 'publicationId',
      });
    }
  }

  return normalized;
}

module.exports = {
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  DEFAULT_DIAGNOSTIC_MAX_LINES,
  DEFAULT_WAIT_TIMEOUT_MS,
  DIAGNOSTIC_SERVICES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_LINES,
  MAX_NODE_REQUEST_BODY_BYTES,
  MAX_NODE_RESPONSE_BYTES,
  MAX_SWARM_PUBLISH_TEXT_BYTES,
  MAX_WAIT_TIMEOUT_MS,
  NODE_LIFECYCLE_ACTIONS,
  NODE_LIFECYCLE_SERVICES,
  NODE_REQUEST_METHODS,
  NODE_REQUEST_SERVICES,
  OPERATIONS,
  PRESS_KEYS,
  validateOperationInput,
};
