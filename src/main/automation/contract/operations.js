'use strict';

const { invalidArgument } = require('./errors');
const { boundedJsonStructure } = require('./page-tool-schema');
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
  OPERATIONS.LIST_FRAMES,
  OPERATIONS.READ_FRAME,
  OPERATIONS.TARGET_POINT,
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.LIST_PAGE_TOOLS,
  OPERATIONS.CALL_PAGE_TOOL,
  OPERATIONS.GET_DIALOG,
  OPERATIONS.HANDLE_DIALOG,
  OPERATIONS.PRESS,
  OPERATIONS.SCROLL,
  OPERATIONS.UPLOAD,
  OPERATIONS.DOWNLOAD,
  OPERATIONS.WALLET_ACTION,
  OPERATIONS.SCREENSHOT,
  OPERATIONS.WAIT,
  OPERATIONS.STOP_LOADING,
]);
const ALLOWED_NAVIGATION_SCHEMES = new Set([
  'http:',
  'https:',
  'bzz:',
  'ipfs:',
  'ipns:',
  'freedom-preview:',
]);
const WAIT_CONDITIONS = new Set(['load', 'navigation', 'text', 'url', 'element']);
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

function validateWorkspacePublicationPath(value) {
  const relativePath = requireString(value, 'workspacePath').trim();
  if (relativePath === '.') return relativePath;
  const normalized = validateRelativePublicationPath(relativePath, 'workspacePath');
  if (normalized.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    throw invalidArgument('workspacePath must remain outside protected workspace metadata', {
      field: 'workspacePath',
    });
  }
  return normalized;
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

  if (operation === OPERATIONS.TARGET_POINT) {
    normalized.captureRef = requireString(input.captureRef, 'captureRef');
    if (!/^capture_[a-f0-9-]{36}$/.test(normalized.captureRef))
      throw invalidArgument('captureRef must come from browser_screenshot');
    for (const field of ['x', 'y']) {
      if (!Number.isFinite(input[field]) || input[field] < 0 || input[field] >= 1)
        throw invalidArgument(`${field} must be a normalized full-image coordinate from 0 up to 1`);
      normalized[field] = input[field];
    }
  }

  if (operation === OPERATIONS.READ_FRAME) {
    normalized.frameRef = requireString(input.frameRef, 'frameRef').trim();
    if (!/^frame_[a-f0-9-]{36}$/.test(normalized.frameRef))
      throw invalidArgument('frameRef must come from browser_list_frames');
    for (const field of ['query', 'textQuery']) {
      if (input[field] === undefined) continue;
      normalized[field] = requireString(input[field], field).trim();
      if (normalized[field].length > 200)
        throw invalidArgument(`${field} cannot exceed 200 characters`);
    }
    for (const field of ['elementOffset', 'textOffset']) {
      if (input[field] === undefined) continue;
      if (!Number.isSafeInteger(input[field]) || input[field] < 0 || input[field] > 1_000_000)
        throw invalidArgument(`${field} must be an integer from 0 to 1000000`);
      normalized[field] = input[field];
    }
  }

  if (operation === OPERATIONS.SNAPSHOT) {
    if (input.documentId !== undefined) {
      normalized.documentId = requireString(input.documentId, 'documentId');
      if (normalized.documentId.length > 80) throw invalidArgument('documentId is too long');
    }
    for (const field of ['query', 'textQuery']) {
      if (input[field] === undefined) continue;
      normalized[field] = requireString(input[field], field).trim();
      if (normalized[field].length > 200)
        throw invalidArgument(`${field} cannot exceed 200 characters`);
    }
    for (const field of ['elementOffset', 'textOffset', 'navigationId']) {
      if (input[field] === undefined) continue;
      if (
        !Number.isSafeInteger(input[field]) ||
        input[field] < 0 ||
        (field !== 'navigationId' && input[field] > 1_000_000)
      ) {
        throw invalidArgument(`${field} must be a non-negative integer within its limit`, {
          field,
        });
      }
      normalized[field] = input[field];
    }
    if (
      (normalized.elementOffset > 0 || normalized.textOffset > 0) &&
      (normalized.navigationId === undefined || normalized.documentId === undefined)
    ) {
      throw invalidArgument(
        'Snapshot continuation requires the previous documentId and navigationId'
      );
    }
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
    operation === OPERATIONS.SCROLL ||
    operation === OPERATIONS.UPLOAD ||
    operation === OPERATIONS.DOWNLOAD ||
    operation === OPERATIONS.WALLET_ACTION
  ) {
    normalized.ref = requireString(input.ref, 'ref').trim();
  }

  if (
    [
      OPERATIONS.CLICK,
      OPERATIONS.TYPE,
      OPERATIONS.SELECT,
      OPERATIONS.PRESS,
      OPERATIONS.SCROLL,
    ].includes(operation) &&
    input.intent !== undefined
  ) {
    normalized.intent = requireString(input.intent, 'intent').trim();
    if (normalized.intent.length > MAX_INTERACTION_INTENT_LENGTH) {
      throw invalidArgument(`intent cannot exceed ${MAX_INTERACTION_INTENT_LENGTH} characters`, {
        field: 'intent',
      });
    }
  }

  if (operation === OPERATIONS.TYPE) {
    normalized.text = requireString(input.text, 'text', { allowEmpty: true });
    normalized.replace = input.replace !== false;
  }

  if (operation === OPERATIONS.SELECT) {
    if ((input.value === undefined) === (input.values === undefined))
      throw invalidArgument('Select requires exactly one value or values array');
    if (input.values !== undefined) {
      if (!Array.isArray(input.values) || input.values.length > 100 ||
          input.values.some((value) => typeof value !== 'string' || value.length > 2000) ||
          new Set(input.values).size !== input.values.length)
        throw invalidArgument('values must contain up to 100 distinct option values of at most 2000 characters');
      normalized.values = [...input.values];
    } else {
      normalized.value = requireString(input.value, 'value', { allowEmpty: true });
      if (normalized.value.length > 2000) throw invalidArgument('Option value is too long');
    }
  }

  if (operation === OPERATIONS.CALL_PAGE_TOOL) {
    normalized.toolRef = requireString(input.toolRef, 'toolRef');
    if (!/^page_tool_[a-f0-9-]{36}_\d{1,2}$/.test(normalized.toolRef))
      throw invalidArgument('Use a toolRef from browser_list_page_tools');
    const args = requireObject(input.arguments);
    if (!boundedJsonStructure(args)) throw invalidArgument('Page tool arguments are too deeply nested or contain too many values');
    let encoded;
    try {
      encoded = JSON.stringify(args, (_key, value) => {
        if (typeof value === 'function' || typeof value === 'symbol' ||
            typeof value === 'undefined' || (typeof value === 'number' && !Number.isFinite(value)))
          throw new Error('Non-JSON argument');
        return value;
      });
    } catch { throw invalidArgument('Page tool arguments must be a JSON object'); }
    if (encoded.length > 8192) throw invalidArgument('Page tool arguments exceed 8192 characters');
    normalized.arguments = JSON.parse(encoded);
  }

  if (operation === OPERATIONS.HANDLE_DIALOG) {
    normalized.dialogRef = requireString(input.dialogRef, 'dialogRef');
    if (!/^dialog_[a-f0-9-]{36}$/.test(normalized.dialogRef)) throw invalidArgument('Use an observed dialogRef');
    if (typeof input.accept !== 'boolean') throw invalidArgument('accept must be a boolean');
    normalized.accept = input.accept;
    if (input.promptText !== undefined) {
      normalized.promptText = requireString(input.promptText, 'promptText', { allowEmpty: true });
      if (!input.accept || normalized.promptText.length > 120 || containsControlCharacters(normalized.promptText))
        throw invalidArgument('Prompt text requires accept and must be at most 120 characters without control characters');
    }
  }

  if (operation === OPERATIONS.SCROLL) {
    normalized.direction = requireString(input.direction, 'direction').trim();
    if (!['up', 'down', 'left', 'right'].includes(normalized.direction)) {
      throw invalidArgument('direction must be up, down, left, or right', { field: 'direction' });
    }
    normalized.pages = input.pages ?? 1;
    if (!Number.isFinite(normalized.pages) || normalized.pages < 0.1 || normalized.pages > 3) {
      throw invalidArgument('pages must be a number between 0.1 and 3', { field: 'pages' });
    }
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
      throw invalidArgument('condition must be one of: load, navigation, text, url, element', {
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
    if (normalized.condition === 'element') {
      normalized.ref = requireString(input.ref, 'ref').trim();
      normalized.state = requireString(input.state, 'state').trim();
      if (
        ![
          'visible',
          'hidden',
          'enabled',
          'disabled',
          'checked',
          'unchecked',
          'expanded',
          'collapsed',
        ].includes(normalized.state)
      ) {
        throw invalidArgument(
          'state must be visible, hidden, enabled, disabled, checked, unchecked, expanded, or collapsed',
          { field: 'state' }
        );
      }
    }
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
      throw invalidArgument(
        `maxBytes must be an integer between 1024 and ${MAX_DIAGNOSTIC_BYTES}`,
        {
          field: 'maxBytes',
        }
      );
    }
  }

  if (operation === OPERATIONS.SWARM_PUBLISH) {
    const hasResourceId = input.resourceId !== undefined;
    const hasText = input.text !== undefined;
    const hasWorkspacePath = input.workspacePath !== undefined;
    if ([hasResourceId, hasText, hasWorkspacePath].filter(Boolean).length !== 1) {
      throw invalidArgument(
        'Swarm publication requires exactly one resourceId, workspacePath, or text field',
        {
          field: 'resourceId',
        }
      );
    }
    if (hasResourceId) {
      normalized.resourceId = requireString(input.resourceId, 'resourceId').trim();
      if (!ATTACHMENT_RESOURCE_ID.test(normalized.resourceId)) {
        throw invalidArgument('resourceId must identify an attached file or folder', {
          field: 'resourceId',
        });
      }
    } else if (hasWorkspacePath) {
      normalized.workspacePath = validateWorkspacePublicationPath(input.workspacePath);
    } else {
      normalized.text = requireString(input.text, 'text');
      if (Buffer.byteLength(normalized.text, 'utf8') > MAX_SWARM_PUBLISH_TEXT_BYTES) {
        throw invalidArgument(`text cannot exceed ${MAX_SWARM_PUBLISH_TEXT_BYTES} UTF-8 bytes`, {
          field: 'text',
        });
      }
      normalized.contentType =
        input.contentType === undefined
          ? 'text/plain; charset=utf-8'
          : requireString(input.contentType, 'contentType').trim();
      if (
        normalized.contentType.length > 255 ||
        containsControlCharacters(normalized.contentType)
      ) {
        throw invalidArgument('contentType must be a bounded media type', {
          field: 'contentType',
        });
      }
    }
    if (input.indexDocument !== undefined) {
      if (!hasResourceId && !hasWorkspacePath) {
        throw invalidArgument('indexDocument can only be used with a folder publication', {
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
