/**
 * Radicle COB (collaborative object) write service.
 *
 * Backend for the window.radicle provider's signing-tier methods. Writes
 * go directly through the in-process libradicle addon and its COB stores.
 */

const embedded = require('../radicle-embedded');
const { validateAndNormalizeRid } = require('../radicle-manager');

// COB ids as returned by the CLI / accepted by it (full or truncated hex).
const COB_ID_RE = /^[0-9a-f]{6,40}$/;

const LIMITS = {
  maxTitleBytes: 200,
  maxBodyBytes: 65536,
  maxLabelBytes: 100,
  maxLabels: 10,
};

class CobValidationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'CobValidationError';
    this.reason = reason;
  }
}

function requireRid(rid) {
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) throw new CobValidationError('invalid_rid', 'Invalid Radicle repository ID');
  return fullRid;
}

function requireCobId(id, reason) {
  if (typeof id !== 'string' || !COB_ID_RE.test(id)) {
    throw new CobValidationError(reason, 'Invalid collaborative object id');
  }
  return id;
}

function requireText(value, { field, reason, maxBytes, allowEmpty = false }) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new CobValidationError(reason, `${field} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new CobValidationError('payload_too_large', `${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function nativeError(err) {
  if (/announce refs failed/i.test(err.message)) err.reason = 'announce_failed';
  else err.reason = /not found/i.test(err.message) ? 'repo_not_found' : 'native_failed';
  return err;
}

/**
 * Open an issue. @returns {Promise<{id: string}>}
 */
async function createIssue({ rid, title, description, labels } = {}) {
  const fullRid = requireRid(rid);
  requireText(title, { field: 'title', reason: 'invalid_title', maxBytes: LIMITS.maxTitleBytes });
  requireText(description, {
    field: 'description',
    reason: 'invalid_body',
    maxBytes: LIMITS.maxBodyBytes,
  });

  let normalizedLabels = [];
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length > LIMITS.maxLabels) {
      throw new CobValidationError('invalid_labels', 'labels must be an array (max 10)');
    }
    for (const label of labels) {
      requireText(label, {
        field: 'label',
        reason: 'invalid_labels',
        maxBytes: LIMITS.maxLabelBytes,
      });
    }
    normalizedLabels = labels;
  }

  try {
    return await embedded.createIssue(fullRid, title, description, normalizedLabels);
  } catch (err) {
    throw nativeError(err);
  }
}

/**
 * Comment on an issue. @returns {Promise<{id: string}>}
 */
async function commentIssue({ rid, issueId, body, replyTo } = {}) {
  const fullRid = requireRid(rid);
  requireCobId(issueId, 'invalid_id');
  requireText(body, { field: 'body', reason: 'invalid_body', maxBytes: LIMITS.maxBodyBytes });

  if (replyTo !== undefined) {
    requireCobId(replyTo, 'invalid_id');
  }

  try {
    return await embedded.commentIssue(fullRid, issueId, body, replyTo);
  } catch (err) {
    throw nativeError(err);
  }
}

const ISSUE_STATES = new Set(['open', 'closed', 'solved']);

/**
 * Transition issue state. @returns {Promise<{id: string, state: string}>}
 */
async function editIssueState({ rid, issueId, state } = {}) {
  const fullRid = requireRid(rid);
  requireCobId(issueId, 'invalid_id');
  if (!ISSUE_STATES.has(state)) {
    throw new CobValidationError('invalid_state', "state must be 'open', 'closed' or 'solved'");
  }

  try {
    return await embedded.editIssueState(fullRid, issueId, state);
  } catch (err) {
    throw nativeError(err);
  }
}

/**
 * Comment on a patch revision. The patch id doubles as the first revision's
 * id, so callers without a specific revision can pass the patch id.
 * @returns {Promise<{id: string}>}
 */
async function commentPatch({ rid, patchId, body, revisionId } = {}) {
  const fullRid = requireRid(rid);
  requireCobId(patchId, 'invalid_id');
  const target = revisionId !== undefined ? requireCobId(revisionId, 'invalid_id') : patchId;
  requireText(body, { field: 'body', reason: 'invalid_body', maxBytes: LIMITS.maxBodyBytes });

  try {
    return await embedded.commentPatch(fullRid, target, body);
  } catch (err) {
    throw nativeError(err);
  }
}

/**
 * The user's Radicle identity. Memoized while the node is running.
 * @returns {Promise<{did, nid, alias}>}
 */
let identityCache = null;
/** Invalidate the memoized identity (e.g. after an alias change). */
function clearIdentityCache() {
  identityCache = null;
}
async function getIdentity() {
  if (identityCache) return identityCache;
  try {
    identityCache = await embedded.identity();
    return identityCache;
  } catch (err) {
    throw nativeError(err);
  }
}

module.exports = {
  createIssue,
  commentIssue,
  editIssueState,
  commentPatch,
  getIdentity,
  clearIdentityCache,
  CobValidationError,
  LIMITS,
};
