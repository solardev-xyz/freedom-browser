'use strict';

const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const { originScopeForUrl } = require('../automation/origin-scoped-controller');

const ACTIVITY_EFFECTS = Object.freeze({
  OBSERVED: 'observed',
  CHANGED: 'changed',
  MANAGED: 'managed',
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
  } else if (origin) {
    const originCopy = {
      [OPERATIONS.CREATE_TAB]: ['Opening', 'Opened'],
      [OPERATIONS.GET_TAB]: ['Checking', 'Checked'],
      [OPERATIONS.FOCUS_TAB]: ['Switching to', 'Switched to'],
      [OPERATIONS.CLOSE_TAB]: ['Closing', 'Closed'],
      [OPERATIONS.SNAPSHOT]: ['Reading', 'Read'],
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

  return Object.freeze({
    intent,
    label,
    effect: copy.effect,
    ...(origin && { origin }),
    ...(boundedString(receipt.pageId, 160) && { pageId: receipt.pageId.slice(0, 160) }),
    ...(pageCount !== null && { pageCount }),
    ...(artifact && { artifact }),
    ...(upload && { upload }),
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
  const artifacts = Array.isArray(result?.artifacts)
    ? result.artifacts.map(normalizeArtifact).filter(Boolean).slice(0, 100)
    : [];

  return Object.freeze({
    ...(pageId && { pageId }),
    ...(origin && { origin }),
    ...(pageCount !== null && { pageCount }),
    ...(artifact && { artifact }),
    ...(upload && { upload }),
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
  const failed = items.filter(
    (item) =>
      item?.status === 'failed' &&
      item?.errorCode !== ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER &&
      item?.errorCode !== ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER
  );
  const changed = succeeded.filter((item) => normalizedEffect(item) === ACTIVITY_EFFECTS.CHANGED);
  const observed = succeeded.filter((item) => normalizedEffect(item) === ACTIVITY_EFFECTS.OBSERVED);
  const pageIds = new Set(succeeded.map((item) => item?.pageId || item?.origin).filter(Boolean));
  const artifacts = succeeded.map((item) => availableArtifact(item?.artifact)).filter(Boolean);
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
    approvals,
  });
  const browserActionCopy = `${counts.successful} successful browser ${counts.successful === 1 ? 'action' : 'actions'}${counts.pages ? ` across ${counts.pages} ${counts.pages === 1 ? 'page' : 'pages'}` : ''}`;
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
    if (observed.length) {
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
  return Object.freeze({
    kind: 'recovery',
    verification: counts.successful ? 'partial' : 'none',
    tone: 'danger',
    headline: 'Agent stopped before completion',
    detail: `${errorExplanation(failureCode)} ${browserState}${destinationNote}`,
    destinations,
    nextStep: retryNeedsReview
      ? 'Review the Agent tabs, then tell Agent what to continue or redo.'
      : 'You can safely try the task again.',
    retrySafety: retryNeedsReview ? 'review' : 'safe',
    counts,
  });
}

module.exports = {
  ACTIVITY_EFFECTS,
  activityProgress,
  buildAgentOutcome,
  createToolReceipt,
  errorExplanation,
  normalizeArtifact,
  normalizeUpload,
};
