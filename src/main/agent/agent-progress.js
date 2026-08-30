'use strict';

const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const { originScopeForUrl } = require('../automation/origin-scoped-controller');
const {
  classifyProviderFailure,
  providerFailurePresentation,
  providerRetryCount,
} = require('./provider-failure');

const ACTIVITY_EFFECTS = Object.freeze({
  OBSERVED: 'observed',
  CHANGED: 'changed',
  MANAGED: 'managed',
});

const ATTACHMENT_OPERATIONS = Object.freeze({
  LIST: 'attachment_list',
  READ: 'attachment_read',
});

const OPERATION_PROGRESS = Object.freeze({
  [OPERATIONS.LIST_TABS]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Checking Agent tabs',
    completed: 'Checked Agent tabs',
  },
  [OPERATIONS.CREATE_TAB]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Opening a new page',
    completed: 'Opened a new page',
  },
  [OPERATIONS.GET_TAB]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Checking the current page',
    completed: 'Checked the current page',
  },
  [OPERATIONS.FOCUS_TAB]: {
    effect: ACTIVITY_EFFECTS.MANAGED,
    intent: 'Switching pages',
    completed: 'Switched pages',
  },
  [OPERATIONS.CLOSE_TAB]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Closing a page',
    completed: 'Closed a page',
  },
  [OPERATIONS.SNAPSHOT]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Reading the current page',
    completed: 'Read the current page',
  },
  [OPERATIONS.SCREENSHOT]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Looking at the current page',
    completed: 'Looked at the current page',
  },
  [OPERATIONS.NAVIGATE]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Navigating to another page',
    completed: 'Navigated to another page',
  },
  [OPERATIONS.CLICK]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Clicking on the current page',
    completed: 'Clicked on the current page',
  },
  [OPERATIONS.TYPE]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Entering information on the current page',
    completed: 'Entered information on the current page',
  },
  [OPERATIONS.SELECT]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Changing a selection on the current page',
    completed: 'Changed a selection on the current page',
  },
  [OPERATIONS.PRESS]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Using the keyboard on the current page',
    completed: 'Used the keyboard on the current page',
  },
  [OPERATIONS.DOWNLOAD]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Downloading a file',
    completed: 'Downloaded a file',
  },
  [OPERATIONS.UPLOAD]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Choosing a file to share',
    completed: 'Attached a file to the page',
  },
  [OPERATIONS.WALLET_ACTION]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Waiting for a wallet request',
    completed: 'Completed a wallet request',
  },
  [OPERATIONS.WALLET_TRANSFER]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Preparing a wallet transfer',
    completed: 'Sent wallet funds',
  },
  [OPERATIONS.NODE_STATUS]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Checking Freedom nodes',
    completed: 'Checked Freedom nodes',
  },
  [OPERATIONS.NODE_REQUEST]: {
    effect: ACTIVITY_EFFECTS.MANAGED,
    intent: 'Requesting a Freedom node',
    completed: 'Requested a Freedom node',
  },
  [OPERATIONS.NODE_OPERATION_STATUS]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Checking a node operation',
    completed: 'Checked a node operation',
  },
  [OPERATIONS.NODE_LIFECYCLE]: {
    effect: ACTIVITY_EFFECTS.CHANGED,
    intent: 'Changing a Freedom node',
    completed: 'Changed a Freedom node',
  },
  [OPERATIONS.NODE_DIAGNOSTICS]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Inspecting node diagnostics',
    completed: 'Inspected node diagnostics',
  },
  [OPERATIONS.APP_DIAGNOSTICS]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Inspecting Freedom diagnostics',
    completed: 'Inspected Freedom diagnostics',
  },
  [OPERATIONS.LIST_DOWNLOADS]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Checking task downloads',
    completed: 'Checked task downloads',
  },
  [OPERATIONS.WAIT]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Waiting for the current page',
    completed: 'Waited for the current page',
  },
  [OPERATIONS.STOP_LOADING]: {
    effect: ACTIVITY_EFFECTS.MANAGED,
    intent: 'Stopping page loading',
    completed: 'Stopped page loading',
  },
  [ATTACHMENT_OPERATIONS.LIST]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Inspecting attached sources',
    completed: 'Inspected attached sources',
  },
  [ATTACHMENT_OPERATIONS.READ]: {
    effect: ACTIVITY_EFFECTS.OBSERVED,
    intent: 'Reading an attached source',
    completed: 'Read an attached source',
  },
});

const ERROR_LABELS = Object.freeze({
  [ERROR_CODES.INVALID_ARGUMENT]: 'The browser action was not valid.',
  [ERROR_CODES.TAB_NOT_FOUND]: 'The page is no longer open.',
  [ERROR_CODES.NAVIGATION_FAILED]: 'The page could not be opened.',
  [ERROR_CODES.WAIT_TIMEOUT]: 'The expected page state did not appear in time.',
  [ERROR_CODES.STALE_ELEMENT_REFERENCE]: 'The page changed before the action could run.',
  [ERROR_CODES.ELEMENT_NOT_FOUND]: 'The page element is no longer available.',
  [ERROR_CODES.ELEMENT_NOT_INTERACTABLE]: 'The page element could not be used.',
  [ERROR_CODES.APPROVAL_REQUIRED]: 'This action still needs approval.',
  [ERROR_CODES.POLICY_DENIED]: 'Freedom blocked this browser action.',
  [ERROR_CODES.USER_CANCELLED]: 'The browser action was not applied.',
  [ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER]: 'The user cancelled file selection.',
  [ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER]: 'The user cancelled the download.',
  [ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER]: 'The user declined the wallet request.',
  [ERROR_CODES.CAPABILITY_UNAVAILABLE]: 'This browser capability is unavailable.',
  [ERROR_CODES.INTERNAL_ERROR]: 'The browser action failed unexpectedly.',
  SESSION_START_FAILED: 'The agent session could not start.',
  PROVIDER_ERROR: 'The model connection failed.',
  MODEL_OUTPUT_LIMIT: 'The model reached its output limit.',
  AGENT_RESUME_SCOPE_CHANGED: 'The browser workspace changed before Agent could continue.',
  TAB_UNAVAILABLE: 'The browser workspace is unavailable.',
  RUN_FAILED: 'The agent run ended unexpectedly.',
});
const CONFIRMED_NOT_APPLIED_ERRORS = new Set([
  ERROR_CODES.INVALID_ARGUMENT,
  ERROR_CODES.TAB_NOT_FOUND,
  ERROR_CODES.STALE_ELEMENT_REFERENCE,
  ERROR_CODES.ELEMENT_NOT_FOUND,
  ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
  ERROR_CODES.APPROVAL_REQUIRED,
  ERROR_CODES.POLICY_DENIED,
  ERROR_CODES.USER_CANCELLED,
  ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER,
  ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER,
  ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER,
  ERROR_CODES.CAPABILITY_UNAVAILABLE,
]);

function boundedString(value, maxLength) {
  return typeof value === 'string' && value ? value.slice(0, maxLength) : '';
}

function normalizeArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  const artifactId = boundedString(value.artifactId, 80);
  // eslint-disable-next-line no-control-regex
  const filename = boundedString(value.filename, 255).replace(/[\u0000-\u001f\u007f]/g, '');
  if (!/^artifact_[a-f0-9]{20}$/.test(artifactId) || !filename) return null;
  const bytes = Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? value.bytes : 0;
  const state = ['in_progress', 'completed', 'cancelled', 'interrupted'].includes(value.state)
    ? value.state
    : 'interrupted';
  const sourceOrigin = originScopeForUrl(value.sourceOrigin) || '';
  return Object.freeze({
    artifactId,
    filename,
    ...(boundedString(value.mimeType, 200) && { mimeType: value.mimeType.slice(0, 200) }),
    bytes,
    state,
    ...(sourceOrigin && { sourceOrigin }),
    location: value.location === 'chosen_location' ? 'chosen_location' : 'downloads',
    available: value.available === true,
  });
}

function availableArtifact(value) {
  const artifact = normalizeArtifact(value);
  return artifact?.state === 'completed' && artifact.available ? artifact : null;
}

function normalizeUpload(value) {
  if (!value || typeof value !== 'object') return null;
  // eslint-disable-next-line no-control-regex
  const filename = boundedString(value.filename, 255).replace(/[\u0000-\u001f\u007f]/g, '');
  if (!filename || value.state !== 'attached') return null;
  const bytes = Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? value.bytes : 0;
  return Object.freeze({
    filename,
    bytes,
    ...(boundedString(value.mimeType, 200) && { mimeType: value.mimeType.slice(0, 200) }),
    state: 'attached',
  });
}

function normalizeWalletReceipt(value) {
  if (value?.action !== 'broadcast') return null;
  const transactionHash = boundedString(value.transactionHash, 100);
  if (!transactionHash) return null;
  return Object.freeze({
    action: 'broadcast',
    transactionHash,
    ...(boundedString(value.paymentId, 100) && { paymentId: value.paymentId.slice(0, 100) }),
    ...(Number.isSafeInteger(value.chainId) && value.chainId > 0
      ? { chainId: value.chainId }
      : {}),
    ...(boundedString(value.recipient, 80) && { recipient: value.recipient.slice(0, 80) }),
    ...(boundedString(value.amount, 100) && { amount: value.amount.slice(0, 100) }),
    ...(boundedString(value.asset, 80) && { asset: value.asset.slice(0, 80) }),
  });
}

function normalizeNodeStatusReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = ['total', 'ready', 'active', 'disabled', 'attention'];
  const normalized = {};
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > 100) return null;
    normalized[field] = value[field];
  }
  if (
    normalized.ready > normalized.total ||
    normalized.active > normalized.total ||
    normalized.disabled > normalized.total ||
    normalized.attention > normalized.total
  ) {
    return null;
  }
  return Object.freeze(normalized);
}

function normalizeDiagnosticReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  const scope = value.scope === 'node' ? 'node' : value.scope === 'app' ? 'app' : null;
  if (!scope) return null;
  if (
    !Number.isSafeInteger(value.lineCount) ||
    value.lineCount < 0 ||
    value.lineCount > 400 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > 65_536
  ) {
    return null;
  }
  const service = boundedString(value.service, 40);
  if (scope === 'node' && !service) return null;
  return Object.freeze({
    scope,
    ...(service && { service }),
    lineCount: value.lineCount,
    bytes: value.bytes,
    truncated: value.truncated === true,
  });
}

function normalizeNodeRequestReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  const service = boundedString(value.service, 40);
  const method = boundedString(value.method, 12);
  const path = boundedString(value.path, 2_048);
  const effects = new Set([
    'read',
    'reversible_admin',
    'persistent_change',
    'financial',
    'destructive',
    'unknown',
  ]);
  const states = new Set(['not_dispatched', 'in_flight', 'responded', 'delivery_uncertain']);
  const operationId = boundedString(value.operationId, 160);
  const state = boundedString(value.state, 40);
  const retrySafety = value.retrySafety === 'safe' ? 'safe' : 'unsafe';
  if (
    !['ant', 'radicle', 'ipfs'].includes(service) ||
    !method ||
    !path ||
    !effects.has(value.effect) ||
    !/^node_op_[a-f0-9]{24}$/.test(operationId) ||
    !states.has(state)
  ) {
    return null;
  }
  if (
    state === 'responded' &&
    (!Number.isInteger(value.status) ||
      value.status < 100 ||
      value.status > 599 ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > 65_536)
  ) {
    return null;
  }
  return Object.freeze({
    operationId,
    state,
    retrySafety,
    service,
    method,
    path,
    effect: value.effect,
    ...(state === 'responded' && { status: value.status, bytes: value.bytes }),
  });
}

function normalizeNodeLifecycleReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  const service = boundedString(value.service, 40);
  const action = boundedString(value.action, 12);
  const beforeState = boundedString(value.beforeState, 40);
  const afterState = boundedString(value.afterState, 40);
  if (
    !['ant', 'ipfs', 'radicle', 'tor', 'myotis-ethereum', 'myotis-gnosis'].includes(service) ||
    !['start', 'stop', 'restart'].includes(action) ||
    !beforeState ||
    !afterState ||
    value.verified !== true
  ) {
    return null;
  }
  return Object.freeze({ service, action, beforeState, afterState, verified: true });
}

function normalizeAttachmentReceipt(value, operation) {
  if (!value || typeof value !== 'object') return null;
  if (![ATTACHMENT_OPERATIONS.LIST, ATTACHMENT_OPERATIONS.READ].includes(operation)) {
    return null;
  }
  const action = operation === ATTACHMENT_OPERATIONS.READ ? 'read' : 'list';
  const resourceId = boundedString(value.resourceId, 160);
  const validResourceId = /^(?:attachment|folder)_[a-f0-9]{20}$/.test(resourceId);
  const resourceKind = value.resourceKind === 'folder' ? 'folder' : value.resourceKind === 'file' ? 'file' : null;
  const safeName = (candidate) => {
    const name = boundedString(candidate, 240);
    return name && !name.includes('/') && !name.includes('\\') ? name : '';
  };
  const name = safeName(value.name);
  const folderName = safeName(value.folderName);
  const candidatePath = boundedString(value.relativePath, 512);
  const pathParts = candidatePath.split(/[\\/]+/);
  const relativePath =
    candidatePath &&
    !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(candidatePath) &&
    !pathParts.includes('..')
      ? candidatePath
      : '';
  const resourceCount =
    Number.isSafeInteger(value.resourceCount) && value.resourceCount >= 0
      ? Math.min(value.resourceCount, 10)
      : null;
  const entryCount =
    Number.isSafeInteger(value.entryCount) && value.entryCount >= 0
      ? Math.min(value.entryCount, 200)
      : null;
  const bytesRead =
    Number.isSafeInteger(value.bytesRead) && value.bytesRead >= 0
      ? Math.min(value.bytesRead, 8 * 1024 * 1024)
      : null;
  const offset =
    Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : null;
  if (action === 'read' && (!validResourceId || !resourceKind || !name || bytesRead === null)) {
    return null;
  }
  if (action === 'list' && resourceId && (!validResourceId || resourceKind !== 'folder')) {
    return null;
  }
  if (action === 'list' && !resourceId && resourceCount === null) return null;
  return Object.freeze({
    action,
    ...(validResourceId && { resourceId }),
    ...(resourceKind && { resourceKind }),
    ...(name && { name }),
    ...(folderName && { folderName }),
    ...(relativePath && { relativePath }),
    ...(resourceCount !== null && { resourceCount }),
    ...(entryCount !== null && { entryCount }),
    ...(bytesRead !== null && { bytesRead }),
    ...(offset !== null && { offset }),
    truncated: value.truncated === true,
  });
}

function activityProgress(operation, receipt = {}) {
  const copy = OPERATION_PROGRESS[operation] || {
    effect: ACTIVITY_EFFECTS.MANAGED,
    intent: 'Working in the browser',
    completed: 'Used the browser',
  };
  const origin = originScopeForUrl(receipt.origin) || '';
  const pageCount =
    Number.isSafeInteger(receipt.pageCount) && receipt.pageCount >= 0 ? receipt.pageCount : null;
  let intent = copy.intent;
  let label = copy.completed;
  const artifact = availableArtifact(receipt.artifact);
  const upload = normalizeUpload(receipt.upload);
  const wallet = normalizeWalletReceipt(receipt.wallet);
  const nodeStatus = normalizeNodeStatusReceipt(receipt.nodeStatus);
  const nodeRequest = normalizeNodeRequestReceipt(receipt.nodeRequest);
  const nodeLifecycle = normalizeNodeLifecycleReceipt(receipt.nodeLifecycle);
  const diagnostic = normalizeDiagnosticReceipt(receipt.diagnostic);
  const attachment = normalizeAttachmentReceipt(receipt.attachment, operation);

  if (operation === OPERATIONS.LIST_TABS && pageCount !== null) {
    const pages = `${pageCount} Agent ${pageCount === 1 ? 'tab' : 'tabs'}`;
    intent = `Checking ${pages}`;
    label = `Checked ${pages}`;
  } else if (operation === OPERATIONS.DOWNLOAD && artifact) {
    intent = `Downloading ${artifact.filename}`;
    label = `Downloaded ${artifact.filename}`;
  } else if (operation === OPERATIONS.UPLOAD && upload) {
    intent = `Choosing ${upload.filename}`;
    label = `Attached ${upload.filename}`;
  } else if (operation === OPERATIONS.WALLET_TRANSFER && wallet) {
    intent = `Sending ${wallet.amount || 'funds'}${wallet.asset ? ` ${wallet.asset}` : ''}`;
    label = `Sent ${wallet.amount || 'funds'}${wallet.asset ? ` ${wallet.asset}` : ''}`;
  } else if (operation === OPERATIONS.NODE_STATUS && nodeStatus) {
    const services = `${nodeStatus.total} ${nodeStatus.total === 1 ? 'service' : 'services'}`;
    intent = `Checking ${services}`;
    label = `Checked ${services}`;
  } else if (
    (operation === OPERATIONS.NODE_REQUEST || operation === OPERATIONS.NODE_OPERATION_STATUS) &&
    nodeRequest
  ) {
    intent =
      operation === OPERATIONS.NODE_REQUEST
        ? `Requesting ${nodeRequest.method} ${nodeRequest.path}`
        : `Checking ${nodeRequest.method} ${nodeRequest.path}`;
    label =
      nodeRequest.state === 'responded'
        ? `Requested ${nodeRequest.method} ${nodeRequest.path} — ${nodeRequest.status}`
        : nodeRequest.state === 'in_flight'
          ? `Requested ${nodeRequest.method} ${nodeRequest.path} — still running`
          : `Requested ${nodeRequest.method} ${nodeRequest.path} — outcome uncertain`;
  } else if (operation === OPERATIONS.NODE_LIFECYCLE && nodeLifecycle) {
    intent = `${nodeLifecycle.action === 'restart' ? 'Restarting' : nodeLifecycle.action === 'start' ? 'Starting' : 'Stopping'} ${nodeLifecycle.service}`;
    label = `${nodeLifecycle.action === 'restart' ? 'Restarted' : nodeLifecycle.action === 'start' ? 'Started' : 'Stopped'} ${nodeLifecycle.service} — ${nodeLifecycle.afterState}`;
  } else if (
    (operation === OPERATIONS.NODE_DIAGNOSTICS || operation === OPERATIONS.APP_DIAGNOSTICS) &&
    diagnostic
  ) {
    const subject = diagnostic.scope === 'node' ? diagnostic.service : 'Freedom';
    intent = `Inspecting ${subject} diagnostics`;
    label = `Inspected ${diagnostic.lineCount} diagnostic ${diagnostic.lineCount === 1 ? 'line' : 'lines'}`;
  } else if (operation === ATTACHMENT_OPERATIONS.LIST && attachment) {
    if (attachment.resourceId) {
      const folder = attachment.folderName || attachment.name || 'attached folder';
      intent = `Inspecting ${folder}`;
      label = `Inspected ${folder}`;
    } else {
      const resources = `${attachment.resourceCount} attached ${attachment.resourceCount === 1 ? 'source' : 'sources'}`;
      intent = `Checking ${resources}`;
      label = `Checked ${resources}`;
    }
  } else if (operation === ATTACHMENT_OPERATIONS.READ && attachment) {
    const source = attachment.relativePath || attachment.name;
    intent = `Reading ${source}`;
    label = `Read ${source}`;
  } else if (origin) {
    const originCopy = {
      [OPERATIONS.CREATE_TAB]: ['Opening', 'Opened'],
      [OPERATIONS.GET_TAB]: ['Checking', 'Checked'],
      [OPERATIONS.FOCUS_TAB]: ['Switching to', 'Switched to'],
      [OPERATIONS.CLOSE_TAB]: ['Closing', 'Closed'],
      [OPERATIONS.SNAPSHOT]: ['Reading', 'Read'],
      [OPERATIONS.SCREENSHOT]: ['Looking at', 'Looked at'],
      [OPERATIONS.NAVIGATE]: ['Navigating to', 'Navigated to'],
      [OPERATIONS.CLICK]: ['Clicking on', 'Clicked on'],
      [OPERATIONS.TYPE]: ['Entering information on', 'Entered information on'],
      [OPERATIONS.SELECT]: ['Changing a selection on', 'Changed a selection on'],
      [OPERATIONS.PRESS]: ['Using the keyboard on', 'Used the keyboard on'],
      [OPERATIONS.UPLOAD]: ['Choosing a file for', 'Attached a file on'],
      [OPERATIONS.WAIT]: ['Waiting for', 'Waited for'],
      [OPERATIONS.STOP_LOADING]: ['Stopping page loading on', 'Stopped page loading on'],
    }[operation];
    if (originCopy) {
      intent = `${originCopy[0]} ${origin}`;
      label = `${originCopy[1]} ${origin}`;
    }
  }

  const effect =
    (operation === OPERATIONS.NODE_REQUEST || operation === OPERATIONS.NODE_OPERATION_STATUS) &&
    nodeRequest
      ? nodeRequest.effect === 'read'
        ? ACTIVITY_EFFECTS.OBSERVED
        : ACTIVITY_EFFECTS.CHANGED
      : copy.effect;
  return Object.freeze({
    intent,
    label,
    effect,
    ...(origin && { origin }),
    ...(boundedString(receipt.pageId, 160) && { pageId: receipt.pageId.slice(0, 160) }),
    ...(pageCount !== null && { pageCount }),
    ...(artifact && { artifact }),
    ...(upload && { upload }),
    ...(wallet && { wallet }),
    ...(nodeStatus && { nodeStatus }),
    ...(nodeRequest && { nodeRequest }),
    ...(nodeLifecycle && { nodeLifecycle }),
    ...(diagnostic && { diagnostic }),
    ...(attachment && { attachment }),
  });
}

function createToolReceipt(operation, options = {}) {
  const envelope = options.envelope;
  const result = envelope?.result;
  const resultTab = result?.tab;
  const pageId = boundedString(
    resultTab?.tabId || envelope?.tabId || result?.activeTabId || options.pageId,
    160
  );
  const origin =
    originScopeForUrl(resultTab?.url) ||
    originScopeForUrl(result?.url) ||
    originScopeForUrl(options.origin) ||
    (operation === OPERATIONS.CREATE_TAB || operation === OPERATIONS.NAVIGATE
      ? originScopeForUrl(options.requestedUrl)
      : null);
  const pageCount =
    operation === OPERATIONS.LIST_TABS && Array.isArray(result?.tabs) ? result.tabs.length : null;
  const artifact = availableArtifact(result?.artifact);
  const upload = normalizeUpload(result?.upload);
  const wallet = normalizeWalletReceipt(result?.wallet);
  const nodeStatus = normalizeNodeStatusReceipt(result?.summary);
  const nodeRequest = normalizeNodeRequestReceipt(result?.summary);
  const nodeLifecycle = normalizeNodeLifecycleReceipt(result?.summary);
  const diagnostic = normalizeDiagnosticReceipt(result?.summary);
  const artifacts = Array.isArray(result?.artifacts)
    ? result.artifacts.map(normalizeArtifact).filter(Boolean).slice(0, 100)
    : [];

  return Object.freeze({
    ...(pageId && { pageId }),
    ...(origin && { origin }),
    ...(pageCount !== null && { pageCount }),
    ...(artifact && { artifact }),
    ...(upload && { upload }),
    ...(wallet && { wallet }),
    ...(nodeStatus && { nodeStatus }),
    ...(nodeRequest && { nodeRequest }),
    ...(nodeLifecycle && { nodeLifecycle }),
    ...(diagnostic && { diagnostic }),
    ...(artifacts.length && { artifacts }),
  });
}

function normalizedEffect(item) {
  if (Object.values(ACTIVITY_EFFECTS).includes(item?.effect)) return item.effect;
  return OPERATION_PROGRESS[item?.operation]?.effect || ACTIVITY_EFFECTS.MANAGED;
}

function errorExplanation(code) {
  return ERROR_LABELS[code] || 'The agent stopped before it could finish.';
}

function buildAgentOutcome(activity, status, error) {
  const items = Array.isArray(activity) ? activity : [];
  const succeeded = items.filter((item) => item?.status === 'succeeded');
  const cancelledDownloads = items.filter(
    (item) => item?.errorCode === ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER
  );
  const cancelledUploads = items.filter(
    (item) => item?.errorCode === ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER
  );
  const declinedWalletRequests = items.filter(
    (item) => item?.errorCode === ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER
  );
  const failed = items.filter(
    (item) =>
      item?.status === 'failed' &&
      item?.errorCode !== ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER &&
      item?.errorCode !== ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER &&
      item?.errorCode !== ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER
  );
  const changed = succeeded.filter((item) => normalizedEffect(item) === ACTIVITY_EFFECTS.CHANGED);
  const observed = succeeded.filter((item) => normalizedEffect(item) === ACTIVITY_EFFECTS.OBSERVED);
  const pageIds = new Set(succeeded.map((item) => item?.pageId || item?.origin).filter(Boolean));
  const artifacts = succeeded.map((item) => availableArtifact(item?.artifact)).filter(Boolean);
  const walletTransfers = succeeded
    .map((item) => normalizeWalletReceipt(item?.wallet))
    .filter(Boolean);
  const nodeChecks = succeeded
    .filter((item) => item?.operation === OPERATIONS.NODE_STATUS)
    .map((item) => normalizeNodeStatusReceipt(item?.nodeStatus))
    .filter(Boolean);
  const nodeRequests = succeeded
    .filter((item) =>
      [OPERATIONS.NODE_REQUEST, OPERATIONS.NODE_OPERATION_STATUS].includes(item?.operation)
    )
    .map((item) => normalizeNodeRequestReceipt(item?.nodeRequest))
    .filter(Boolean);
  const nodeLifecycles = succeeded
    .filter((item) => item?.operation === OPERATIONS.NODE_LIFECYCLE)
    .map((item) => normalizeNodeLifecycleReceipt(item?.nodeLifecycle))
    .filter(Boolean);
  const diagnostics = succeeded
    .filter((item) =>
      [OPERATIONS.NODE_DIAGNOSTICS, OPERATIONS.APP_DIAGNOSTICS].includes(item?.operation)
    )
    .map((item) => normalizeDiagnosticReceipt(item?.diagnostic))
    .filter(Boolean);
  const attachmentObservations = succeeded
    .filter((item) =>
      [ATTACHMENT_OPERATIONS.LIST, ATTACHMENT_OPERATIONS.READ].includes(item?.operation)
    )
    .map((item) => normalizeAttachmentReceipt(item?.attachment, item.operation))
    .filter(Boolean);
  const attachmentReads = [
    ...new Map(
      attachmentObservations
        .filter((item) => item.action === 'read')
        .map((item) => [
          `${item.resourceId}:${item.relativePath || item.name}`,
          item,
        ])
    ).values(),
  ];
  const nonBrowserObservations = new Set([
    OPERATIONS.NODE_STATUS,
    OPERATIONS.NODE_REQUEST,
    OPERATIONS.NODE_OPERATION_STATUS,
    OPERATIONS.NODE_LIFECYCLE,
    OPERATIONS.NODE_DIAGNOSTICS,
    OPERATIONS.APP_DIAGNOSTICS,
    ATTACHMENT_OPERATIONS.LIST,
    ATTACHMENT_OPERATIONS.READ,
  ]);
  const browserSucceeded = succeeded.filter(
    (item) => !nonBrowserObservations.has(item?.operation)
  );
  const browserObserved = observed.filter((item) => !nonBrowserObservations.has(item?.operation));
  const uncertainChanges = items.filter((item) => {
    if (normalizedEffect(item) !== ACTIVITY_EFFECTS.CHANGED || item?.status === 'succeeded') {
      return false;
    }
    return item.status === 'running' || !CONFIRMED_NOT_APPLIED_ERRORS.has(item.errorCode);
  });
  const approvals = Object.freeze({
    requested: items.filter((item) => item?.approval).length,
    approved: items.filter((item) => item?.approval === 'approved').length,
    declined: items.filter((item) => item?.approval === 'declined').length,
    withdrawn: items.filter((item) => item?.approval === 'withdrawn').length,
  });
  const destinations = [
    ...new Set(
      items
        .filter((item) => item?.approval === 'approved')
        .map((item) => originScopeForUrl(item?.destinationOrigin))
        .filter(Boolean)
    ),
  ].slice(0, 20);
  const lastChangeIndex = items.findLastIndex(
    (item) => item?.status === 'succeeded' && normalizedEffect(item) === ACTIVITY_EFFECTS.CHANGED
  );
  const changedPageId =
    lastChangeIndex >= 0 ? items[lastChangeIndex]?.pageId || items[lastChangeIndex]?.origin : null;
  const resultObserved =
    lastChangeIndex >= 0 &&
    items.slice(lastChangeIndex + 1).some((item) => {
      if (item?.status !== 'succeeded' || normalizedEffect(item) !== ACTIVITY_EFFECTS.OBSERVED) {
        return false;
      }
      if (item.operation === OPERATIONS.LIST_TABS || !changedPageId) return true;
      return (item.pageId || item.origin) === changedPageId;
    });
  const counts = Object.freeze({
    successful: succeeded.length,
    failed: failed.length,
    changed: changed.length,
    observed: observed.length,
    pages: pageIds.size,
    ...(artifacts.length && { artifacts: artifacts.length }),
    ...(cancelledDownloads.length && { cancelledDownloads: cancelledDownloads.length }),
    ...(cancelledUploads.length && { cancelledUploads: cancelledUploads.length }),
    ...(declinedWalletRequests.length && {
      declinedWalletRequests: declinedWalletRequests.length,
    }),
    ...(walletTransfers.length && { walletTransfers: walletTransfers.length }),
    ...(nodeChecks.length && { nodeChecks: nodeChecks.length }),
    ...(nodeRequests.length && { nodeRequests: nodeRequests.length }),
    ...(nodeLifecycles.length && { nodeLifecycles: nodeLifecycles.length }),
    ...(diagnostics.length && { diagnostics: diagnostics.length }),
    ...(attachmentReads.length && { attachmentReads: attachmentReads.length }),
    ...(attachmentObservations.length && {
      attachmentObservations: attachmentObservations.length,
    }),
    approvals,
  });
  const browserActionCopy = `${browserSucceeded.length} successful browser ${browserSucceeded.length === 1 ? 'action' : 'actions'}${counts.pages ? ` across ${counts.pages} ${counts.pages === 1 ? 'page' : 'pages'}` : ''}`;
  const recoveryNote = counts.failed
    ? ` Agent recovered from ${counts.failed} failed browser ${counts.failed === 1 ? 'action' : 'actions'}.`
    : '';
  const approvalNote = approvals.approved
    ? ` ${approvals.approved} browser ${approvals.approved === 1 ? 'action was' : 'actions were'} approved by the user.`
    : approvals.declined
      ? ` ${approvals.declined} browser ${approvals.declined === 1 ? 'action was' : 'actions were'} declined by the user.`
      : '';
  const destinationNote = destinations.length
    ? ` Approved ${destinations.length === 1 ? 'destination' : 'destinations'}: ${destinations.join(', ')}.`
    : '';

  if (status === 'completed') {
    if (artifacts.length) {
      return Object.freeze({
        kind: 'completed',
        verification: 'artifact_available',
        tone: 'success',
        headline: artifacts.length === 1 ? 'File downloaded' : 'Files downloaded',
        detail: `Freedom verified ${artifacts.length} downloaded ${artifacts.length === 1 ? 'file' : 'files'} and recorded ${browserActionCopy}.${approvalNote}${recoveryNote}`,
        artifacts,
        destinations,
        counts,
      });
    }
    if (cancelledDownloads.length) {
      return Object.freeze({
        kind: 'completed',
        verification: 'download_cancelled',
        tone: 'neutral',
        headline: cancelledDownloads.length === 1 ? 'Download cancelled' : 'Downloads cancelled',
        detail:
          cancelledDownloads.length === 1
            ? 'You stopped the transfer. Freedom did not record a completed file.'
            : `You stopped ${cancelledDownloads.length} transfers. Freedom did not record completed files for them.`,
        destinations,
        counts,
      });
    }
    if (cancelledUploads.length) {
      return Object.freeze({
        kind: 'completed',
        verification: 'file_selection_cancelled',
        tone: 'neutral',
        headline: 'File selection cancelled',
        detail:
          cancelledUploads.length === 1
            ? 'You closed the file picker. Freedom did not attach a file.'
            : `You cancelled ${cancelledUploads.length} file selections. Freedom did not attach files for them.`,
        destinations,
        counts,
      });
    }
    if (declinedWalletRequests.length) {
      return Object.freeze({
        kind: 'completed',
        verification: 'wallet_declined',
        tone: 'neutral',
        headline: 'Wallet request declined',
        detail:
          declinedWalletRequests.length === 1
            ? 'You declined the wallet request. Freedom did not sign or broadcast it.'
            : `You declined ${declinedWalletRequests.length} wallet requests. Freedom did not sign or broadcast them.`,
        destinations,
        counts,
      });
    }
    if (walletTransfers.length) {
      const wallet = walletTransfers.at(-1);
      const transfer = `${wallet.amount || 'Funds'}${wallet.asset ? ` ${wallet.asset}` : ''}`;
      return Object.freeze({
        kind: 'completed',
        verification: 'wallet_broadcast',
        tone: 'success',
        headline: 'Wallet transfer broadcast',
        detail: `${transfer} was sent through Freedom Wallet on chain ${wallet.chainId}. Transaction: ${wallet.transactionHash}.`,
        wallet,
        destinations,
        counts,
      });
    }
    if (diagnostics.length && !changed.length && !browserObserved.length) {
      const diagnostic = diagnostics.at(-1);
      const subject = diagnostic.scope === 'node' ? diagnostic.service : 'Freedom';
      return Object.freeze({
        kind: 'completed',
        verification: 'diagnostics_inspected',
        tone: 'success',
        headline: 'Diagnostics inspected',
        detail: `Agent inspected ${diagnostic.lineCount} bounded raw diagnostic ${diagnostic.lineCount === 1 ? 'line' : 'lines'} from ${subject}${diagnostic.truncated ? '; the requested evidence was truncated at Freedom’s limit' : ''}.`,
        diagnostic,
        destinations,
        counts,
      });
    }
    if (nodeChecks.length && !changed.length && !browserObserved.length) {
      const nodeStatus = nodeChecks.at(-1);
      const readiness = `${nodeStatus.ready} ready, ${nodeStatus.disabled} disabled`;
      const attention = nodeStatus.attention
        ? `, ${nodeStatus.attention} ${nodeStatus.attention === 1 ? 'needs' : 'need'} attention`
        : '';
      return Object.freeze({
        kind: 'completed',
        verification: 'nodes_inspected',
        tone: nodeStatus.attention ? 'caution' : 'success',
        headline: 'Node status checked',
        detail: `Freedom checked ${nodeStatus.total} integrated services: ${readiness}${attention}.`,
        nodeStatus,
        destinations,
        counts,
      });
    }
    if (nodeRequests.length && !browserObserved.length) {
      const nodeRequest = nodeRequests.at(-1);
      if (nodeRequest.state === 'in_flight') {
        return Object.freeze({
          kind: 'completed',
          verification: 'node_request_in_flight',
          tone: 'caution',
          headline: 'Node request still running',
          detail: `${nodeRequest.service} is still processing ${nodeRequest.method} ${nodeRequest.path}. Freedom operation ${nodeRequest.operationId} remains in flight; unsafe requests must not be repeated.`,
          nodeRequest,
          destinations,
          counts,
        });
      }
      if (nodeRequest.state === 'delivery_uncertain') {
        const detail =
          nodeRequest.retrySafety === 'safe'
            ? `Freedom did not receive a complete response for ${nodeRequest.method} ${nodeRequest.path}. Operation ${nodeRequest.operationId} is safe to retry because it was classified as read-only.`
            : `Freedom attempted ${nodeRequest.method} ${nodeRequest.path} but lost observability before receiving a response. Operation ${nodeRequest.operationId} may have reached ${nodeRequest.service}; do not retry it without reconciliation.`;
        return Object.freeze({
          kind: 'completed',
          verification: 'node_delivery_uncertain',
          tone: 'caution',
          headline: 'Node outcome uncertain',
          detail,
          nodeRequest,
          destinations,
          counts,
        });
      }
      return Object.freeze({
        kind: 'completed',
        verification: 'node_response_received',
        tone: nodeRequest.status >= 400 ? 'caution' : 'success',
        headline: 'Node request completed',
        detail: `${nodeRequest.service} returned ${nodeRequest.status} for ${nodeRequest.method} ${nodeRequest.path}. Freedom classified its effect as ${nodeRequest.effect.replaceAll('_', ' ')}.`,
        nodeRequest,
        destinations,
        counts,
      });
    }
    if (nodeLifecycles.length && !browserObserved.length) {
      const lifecycle = nodeLifecycles.at(-1);
      return Object.freeze({
        kind: 'completed',
        verification: 'node_lifecycle_verified',
        tone: 'success',
        headline: 'Node state verified',
        detail: `Freedom verified ${lifecycle.service} changed from ${lifecycle.beforeState} to ${lifecycle.afterState} after ${lifecycle.action}.`,
        nodeLifecycle: lifecycle,
        destinations,
        counts,
      });
    }
    if (attachmentObservations.length && !changed.length && !browserObserved.length) {
      const folderNames = [
        ...new Set(
          attachmentObservations
            .map((item) => item.folderName)
            .filter(Boolean)
        ),
      ];
      const detail = attachmentReads.length
        ? `Freedom recorded reads from ${attachmentReads.length} attached ${attachmentReads.length === 1 ? 'file' : 'files'}${folderNames.length === 1 ? ` in the shared folder “${folderNames[0]}”` : ''}. This confirms the sources were accessed, not that every model conclusion is correct.`
        : 'Freedom inspected the user-shared attachment inventory. This confirms the sources were accessed, not that every model conclusion is correct.';
      return Object.freeze({
        kind: 'completed',
        verification: 'attachments_inspected',
        tone: 'success',
        headline: 'Attached sources inspected',
        detail,
        destinations,
        counts,
      });
    }
    if (resultObserved) {
      return Object.freeze({
        kind: 'completed',
        verification: 'result_observed',
        tone: 'success',
        headline: 'Result checked in the browser',
        detail: `Freedom recorded ${browserActionCopy} and observed the page after the last change.${approvalNote}${destinationNote}${recoveryNote}`,
        destinations,
        counts,
      });
    }
    if (changed.length) {
      return Object.freeze({
        kind: 'completed',
        verification: 'actions_recorded',
        tone: 'caution',
        headline: 'Browser actions recorded',
        detail: `Freedom recorded ${browserActionCopy}, but Agent did not recheck the page after its last change.${approvalNote}${destinationNote}${recoveryNote}`,
        destinations,
        counts,
      });
    }
    if (browserObserved.length) {
      return Object.freeze({
        kind: 'completed',
        verification: 'browser_observed',
        tone: 'success',
        headline: 'Browser state inspected',
        detail: `Freedom recorded ${browserActionCopy}. No browser change was made.${approvalNote}${destinationNote}${recoveryNote}`,
        destinations,
        counts,
      });
    }
    if (!items.length) {
      return Object.freeze({
        kind: 'completed',
        verification: 'not_applicable',
        tone: 'neutral',
        destinations,
        counts,
      });
    }
    return Object.freeze({
      kind: 'completed',
      verification: 'model_only',
      tone: 'caution',
      headline: 'Agent-reported result',
      detail: 'Freedom did not record browser evidence for this response.',
      destinations,
      counts,
    });
  }

  let browserState = 'Freedom did not verify any browser changes.';
  if (uncertainChanges.length) {
    browserState = 'Freedom cannot confirm whether the interrupted browser action was applied.';
  } else if (counts.changed) {
    browserState = `${counts.changed} earlier browser ${counts.changed === 1 ? 'change remains' : 'changes remain'} in place.`;
  }
  const retryNeedsReview = counts.changed > 0 || uncertainChanges.length > 0;
  if (status === 'cancelled') {
    return Object.freeze({
      kind: 'interrupted',
      verification: counts.successful ? 'partial' : 'none',
      tone: 'neutral',
      headline: 'Run stopped',
      detail: `${browserState}${destinationNote}`,
      destinations,
      counts,
    });
  }
  if (status === 'interrupted') {
    const interruptionDetail = uncertainChanges.length
      ? `${browserState}${destinationNote}`
      : `${browserState}${destinationNote} Freedom cannot confirm where the task stopped.`;
    return Object.freeze({
      kind: 'recovery',
      verification: counts.successful ? 'partial' : 'none',
      tone: 'caution',
      headline: 'Previous run was interrupted',
      detail: interruptionDetail,
      destinations,
      nextStep: 'Review the Agent tabs, then ask Agent to continue.',
      retrySafety: retryNeedsReview ? 'review' : 'safe',
      counts,
    });
  }

  const lastFailed = failed.at(-1);
  const failureCode = error?.code || lastFailed?.errorCode;
  const providerPresentation =
    failureCode === 'PROVIDER_ERROR'
      ? providerFailurePresentation(
          classifyProviderFailure(error?.providerFailure || error?.message),
          { retryCount: error?.retryCount || providerRetryCount(error?.message) }
        )
      : null;
  const pendingNodeRequest = nodeRequests.findLast((request) => request.state === 'in_flight');
  const uncertainNodeRequest = nodeRequests.findLast(
    (request) => request.state === 'delivery_uncertain'
  );
  const unresolvedNodeRequest = pendingNodeRequest || uncertainNodeRequest;
  if (providerPresentation && unresolvedNodeRequest) {
    const stillRunning = unresolvedNodeRequest.state === 'in_flight';
    return Object.freeze({
      kind: 'recovery',
      verification: 'node_operation_unresolved',
      tone: 'caution',
      headline: stillRunning
        ? 'Model disconnected; node request still running'
        : 'Model disconnected; node outcome uncertain',
      detail: `${providerPresentation.terminalMessage} ${unresolvedNodeRequest.service} ${stillRunning ? 'is still processing' : 'may have received'} ${unresolvedNodeRequest.method} ${unresolvedNodeRequest.path}. Freedom operation ${unresolvedNodeRequest.operationId} must be reconciled before any repeat.`,
      nodeRequest: unresolvedNodeRequest,
      destinations,
      nextStep: 'Continue this conversation so Agent can check the existing node operation.',
      retrySafety: 'review',
      counts,
    });
  }
  const failureExplanation = providerPresentation?.terminalMessage || errorExplanation(failureCode);
  return Object.freeze({
    kind: 'recovery',
    verification: counts.successful ? 'partial' : 'none',
    tone: 'danger',
    headline: 'Agent stopped before completion',
    detail: `${failureExplanation} ${browserState}${destinationNote}`,
    destinations,
    nextStep: retryNeedsReview
      ? 'Review the Agent tabs, then tell Agent what to continue or redo.'
      : providerPresentation?.nextStep || 'You can safely try the task again.',
    retrySafety: retryNeedsReview ? 'review' : 'safe',
    counts,
  });
}

module.exports = {
  ACTIVITY_EFFECTS,
  ATTACHMENT_OPERATIONS,
  activityProgress,
  buildAgentOutcome,
  createToolReceipt,
  errorExplanation,
  normalizeArtifact,
  normalizeAttachmentReceipt,
  normalizeDiagnosticReceipt,
  normalizeNodeRequestReceipt,
  normalizeNodeLifecycleReceipt,
  normalizeNodeStatusReceipt,
  normalizeUpload,
  normalizeWalletReceipt,
};
